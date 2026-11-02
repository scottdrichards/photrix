import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { attempt } from "../common/result.ts";
import {
  fieldValuesFields,
  viewUrl,
  type FileItem,
  type PhotrixApi,
} from "./photrixApi.ts";

// Metadata fields we ask Photrix to return for file queries. `folder`/`fileName`
// always come back as the identity; these enrich the result for the agent.
const FILE_METADATA = [
  "mimeType",
  "dateTaken",
  "rating",
  "cameraMake",
  "cameraModel",
  "locationLatitude",
  "locationLongitude",
  "dimensionWidth",
  "dimensionHeight",
];
const ON_THIS_DAY_FETCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

const photoSchema = z.object({
  path: z.string().describe("relativePath; pass to get_photo_image."),
  viewUrl: z.string(),
  dateTaken: z.string().optional().describe("YYYY-MM-DD"),
  rating: z.number().optional(),
  camera: z.string().optional(),
  sources: z.array(z.string()).optional().describe("Matching modalities (search only)."),
});
type Photo = z.infer<typeof photoSchema>;

const toPhoto = (
  item: Pick<FileItem, "folder" | "fileName"> &
    Partial<Omit<FileItem, "folder" | "fileName">> & { sources?: string[] },
): Photo => {
  const path = `${item.folder}${item.fileName}`;
  const ms =
    typeof item.dateTaken === "string" ? Date.parse(item.dateTaken) : item.dateTaken;
  return {
    path,
    viewUrl: viewUrl(path),
    dateTaken:
      typeof ms === "number" && !Number.isNaN(ms)
        ? new Date(ms).toISOString().slice(0, 10)
        : undefined,
    rating: item.rating ? Number(item.rating) : undefined,
    camera: [item.cameraMake, item.cameraModel].filter(Boolean).join(" ") || undefined,
    sources: item.sources?.length ? item.sources : undefined,
  };
};

const photoLine = (p: Photo): string =>
  `- ${p.path}${[
    p.dateTaken,
    p.rating && "★".repeat(p.rating),
    p.camera,
    p.sources?.join(", "),
  ]
    .filter(Boolean)
    .join(" · ")
    .replace(/^(.)/, " — $1")}\n  view: ${p.viewUrl}`;

const success = (text: string, data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: data,
});
const failure = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

// Every tool runs through this: a rejected Photrix call becomes an `isError`
// result the agent can read, instead of a protocol-level failure.
const guarded =
  <Args>(run: (args: Args) => Promise<CallToolResult>) =>
  async (args: Args): Promise<CallToolResult> => {
    const result = await attempt(run(args));
    return result.ok ? result.value : failure(result.error.message);
  };

const readOnly = { readOnlyHint: true, openWorldHint: false };
const limitField = (max: number, fallback: number, what: string) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Max ${what}.`);

export const buildPhotrixMcpServer = (api: PhotrixApi): McpServer => {
  const server = new McpServer(
    { name: "photrix", version: "1.1.0" },
    {
      instructions:
        "Query a personal photo library (Photrix). Use search_photos for natural-language/semantic search, list_people / get_person_photos for face recognition, on_this_day for nostalgic picks, and query_photos for structured metadata filters (use list_values to discover valid tags, cameras and lenses). Photos are identified by a relativePath like '/2023/trip/img.jpg'; pass that path to get_photo_image to actually view a picture.",
    },
  );

  server.registerTool(
    "search_photos",
    {
      title: "Search photos",
      description:
        "Natural-language / semantic search across the photo library. Matches on image content (CLIP), audio content of videos (CLAP), and speech transcripts. Returns ranked file paths. Example queries: 'sunset over the ocean', 'birthday cake', 'dog on the beach'.",
      inputSchema: {
        query: z.string().describe("Natural-language description of what to find."),
        limit: limitField(200, 20, "results"),
        folder: z
          .string()
          .optional()
          .describe("Restrict to a folder path, e.g. '/2023'."),
        sources: z
          .array(z.enum(["image", "audio", "transcript"]))
          .optional()
          .describe("Restrict which modalities to search. Defaults to all."),
      },
      outputSchema: { photos: z.array(photoSchema) },
      annotations: readOnly,
    },
    guarded(async ({ query, limit, folder, sources }) => {
      const res = await api.searchPhotos({ q: query, limit, folder, sources });
      const photos = res.items.map(toPhoto);
      return success(
        photos.length
          ? `Found ${photos.length} match(es) for "${query}":\n${photos.map(photoLine).join("\n")}\n\nUse get_photo_image with a path to view one.`
          : `No photos matched "${query}".`,
        { photos },
      );
    }),
  );

  server.registerTool(
    "list_people",
    {
      title: "List people",
      description:
        "List the people the library has recognized via face clustering. Returns each person's id (e.g. 'person-42'), assigned name (if any), photo count, and the year range they appear in. Use the returned id with get_person_photos.",
      inputSchema: {
        onlyNamed: z
          .boolean()
          .default(false)
          .describe("Only return people who have been given a name."),
        limit: limitField(200, 50, "people"),
      },
      outputSchema: {
        people: z.array(
          z.object({
            id: z.string(),
            name: z.string().optional(),
            photoCount: z.number(),
            years: z.string().optional(),
          }),
        ),
        totalPeople: z.number(),
        totalFaces: z.number(),
        pendingFaces: z.number().optional().describe("Faces not yet clustered."),
      },
      annotations: readOnly,
    },
    guarded(async ({ onlyNamed, limit }) => {
      const res = await api.listPeople();
      const people = res.clusters
        .filter((c) => !onlyNamed || c.name?.trim())
        .slice(0, limit)
        .map((c) => ({
          id: c.id,
          name: c.name?.trim() || undefined,
          photoCount: c.count,
          years: c.yearRangeLabel || undefined,
        }));
      const lines = people
        .map(
          (p) =>
            `- ${p.id}: ${p.name ?? "(unnamed)"} — ${p.photoCount} photo(s)${p.years ? `, ${p.years}` : ""}`,
        )
        .join("\n");
      return success(
        people.length
          ? `${people.length} of ${res.totalClusters} people (${res.totalFaces} faces total${res.pendingFaces ? `, ${res.pendingFaces} pending` : ""}):\n${lines}`
          : onlyNamed
            ? "No named people yet. Faces are clustered automatically but names are assigned in the app."
            : "No people have been recognized yet (face clustering may still be running).",
        {
          people,
          totalPeople: res.totalClusters,
          totalFaces: res.totalFaces,
          pendingFaces: res.pendingFaces,
        },
      );
    }),
  );

  server.registerTool(
    "get_person_photos",
    {
      title: "Get a person's photos",
      description:
        "Return the photos a recognized person appears in. Accepts either a person id ('person-42', from list_people) or a name to look up. Returns file paths you can pass to get_photo_image.",
      inputSchema: {
        person: z
          .string()
          .describe("Person id like 'person-42', or a name such as 'Alice'."),
        limit: limitField(200, 30, "photos"),
      },
      outputSchema: {
        person: z.object({
          id: z.string(),
          name: z.string().optional(),
          photoCount: z.number(),
        }),
        photos: z.array(photoSchema),
      },
      annotations: readOnly,
    },
    guarded(async ({ person, limit }) => {
      const clusterId = /^person-\d+$/.test(person)
        ? person
        : (await api.listPeople()).clusters.find(
            (c) => c.name?.trim().toLowerCase() === person.trim().toLowerCase(),
          )?.id;
      if (!clusterId) {
        return failure(
          `No person named "${person}" found. Call list_people to see available people and their ids.`,
        );
      }
      const { cluster } = await api.getPersonPhotos(clusterId);
      if (!cluster) return failure(`Person "${clusterId}" not found.`);
      const photos = [...new Set(cluster.faces.map((f) => f.path).filter(Boolean))]
        .slice(0, limit)
        .map((path) => toPhoto({ folder: "", fileName: path }));
      const name = cluster.name?.trim() || undefined;
      return success(
        `${clusterId}${name ? ` (${name})` : ""} appears in ${cluster.count} photo(s). Showing ${photos.length}:\n${photos.map(photoLine).join("\n")}`,
        { person: { id: clusterId, name, photoCount: cluster.count }, photos },
      );
    }),
  );

  server.registerTool(
    "on_this_day",
    {
      title: "On this day",
      description:
        "Find photos taken on a given month/day across all years in the library — a nostalgic 'on this day' pick. Defaults to today. Results are sorted with highest-rated first, so the top entry is a good highlight.",
      inputSchema: {
        month: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe("Month 1-12. Defaults to today's month."),
        day: z
          .number()
          .int()
          .min(1)
          .max(31)
          .optional()
          .describe("Day of month 1-31. Defaults to today's day."),
        limit: limitField(100, 20, "photos"),
      },
      outputSchema: {
        month: z.number(),
        day: z.number(),
        totalMatches: z.number(),
        photos: z.array(photoSchema),
      },
      annotations: readOnly,
    },
    guarded(async ({ month, day, limit }) => {
      const now = new Date();
      const m = month ?? now.getMonth() + 1;
      const d = day ?? now.getDate();
      const { minDate, maxDate } = await api.getDateRange();
      if (minDate === null || maxDate === null) {
        return success("The library has no dated photos yet.", {
          month: m,
          day: d,
          totalMatches: 0,
          photos: [],
        });
      }
      const startYear = new Date(minDate).getFullYear();
      const endYear = new Date(maxDate).getFullYear();
      const conditions = Array.from({ length: endYear - startYear + 1 }, (_, i) => ({
        dateTaken: {
          min: new Date(startYear + i, m - 1, d).getTime(),
          max: new Date(startYear + i, m - 1, d, 23, 59, 59, 999).getTime(),
        },
      }));
      const res = await api.queryFiles({
        filter: conditions.length === 1 ? conditions[0] : { operation: "or", conditions },
        metadata: FILE_METADATA,
        pageSize: ON_THIS_DAY_FETCH,
      });
      const photos = res.items
        .toSorted((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
        .slice(0, limit)
        .map(toPhoto);
      const truncated =
        res.total > res.items.length
          ? ` (ranked from the first ${res.items.length} of ${res.total})`
          : "";
      return success(
        photos.length
          ? `On ${m}/${d} across ${startYear}–${endYear}, found ${res.total} photo(s). Top ${photos.length} (highest-rated first)${truncated}:\n${photos.map(photoLine).join("\n")}\n\nTip: pass the first path to get_photo_image to show it.`
          : `No photos were taken on ${m}/${d} in any year (${startYear}–${endYear}).`,
        { month: m, day: d, totalMatches: res.total, photos },
      );
    }),
  );

  server.registerTool(
    "query_photos",
    {
      title: "Query photos by metadata",
      description:
        "Structured search over photo metadata: date range, minimum star rating, tag, camera, or folder. Combine any subset. Returns file paths with basic metadata; use `page` to read past the first `limit` results. Use list_values to discover valid tags and cameras.",
      inputSchema: {
        dateFrom: z
          .string()
          .optional()
          .describe("Earliest date (ISO, e.g. '2023-01-01')."),
        dateTo: z.string().optional().describe("Latest date (ISO, e.g. '2023-12-31')."),
        minRating: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Only photos rated at least this many stars."),
        tag: z.string().optional().describe("A tag/keyword the photo must have."),
        cameraMake: z.string().optional().describe("Camera manufacturer, e.g. 'Canon'."),
        folder: z.string().optional().describe("Folder path, e.g. '/2023/trip'."),
        limit: limitField(200, 30, "results per page"),
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("1-based page of `limit` results."),
      },
      outputSchema: { total: z.number(), page: z.number(), photos: z.array(photoSchema) },
      annotations: readOnly,
    },
    guarded(
      async ({ dateFrom, dateTo, minRating, tag, cameraMake, folder, limit, page }) => {
        const from = dateFrom === undefined ? undefined : Date.parse(dateFrom);
        const to = dateTo === undefined ? undefined : Date.parse(dateTo);
        if (Number.isNaN(from)) return failure(`Invalid dateFrom: ${dateFrom}`);
        if (Number.isNaN(to)) return failure(`Invalid dateTo: ${dateTo}`);
        const conditions = [
          folder && { folder: { folder, recursive: true } },
          (from !== undefined || to !== undefined) && {
            dateTaken: {
              min: from,
              // A date-only upper bound includes that whole day.
              max:
                to === undefined
                  ? undefined
                  : to + (dateTo!.length <= 10 ? DAY_MS - 1 : 0),
            },
          },
          minRating && { rating: { min: minRating } },
          tag && { tags: tag },
          cameraMake && { cameraMake },
        ].filter(Boolean);
        const res = await api.queryFiles({
          filter:
            conditions.length > 1 ? { operation: "and", conditions } : conditions[0],
          metadata: FILE_METADATA,
          pageSize: limit,
          page,
        });
        const photos = res.items.map(toPhoto);
        return success(
          photos.length
            ? `${res.total} photo(s) matched (page ${res.page}, showing ${photos.length}):\n${photos.map(photoLine).join("\n")}`
            : "No photos matched those filters.",
          { total: res.total, page: res.page, photos },
        );
      },
    ),
  );

  server.registerTool(
    "list_values",
    {
      title: "List tag / camera / lens values",
      description:
        "List the distinct values (with photo counts) a metadata field takes in the library, optionally filtered by a prefix/substring. Use it to find valid arguments for query_photos (e.g. tags, camera makes).",
      inputSchema: {
        field: z.enum(fieldValuesFields).describe("Which field to list."),
        search: z.string().default("").describe("Only values matching this text."),
        limit: limitField(200, 50, "values"),
      },
      outputSchema: {
        field: z.string(),
        values: z.array(z.object({ value: z.string(), count: z.number() })),
      },
      annotations: readOnly,
    },
    guarded(async ({ field, search, limit }) => {
      const values = await api.listFieldValues({ field, search, limit });
      return success(
        values.length
          ? `${values.length} ${field} value(s):\n${values.map((v) => `- ${v.value} (${v.count})`).join("\n")}`
          : `No ${field} values found.`,
        { field, values },
      );
    }),
  );

  server.registerTool(
    "get_photo_image",
    {
      title: "View a photo",
      description:
        "Fetch an actual photo so you can see it, given its relativePath (from any other tool, e.g. '/2023/trip/img.jpg'). Returns a display-ready image resized to the requested edge. HEIC/RAW are converted to JPEG.",
      inputSchema: {
        path: z.string().describe("The photo's relativePath, e.g. '/2023/trip/img.jpg'."),
        size: z
          .number()
          .int()
          .min(64)
          .max(4096)
          .default(1024)
          .describe("Longest-edge pixel size of the returned image."),
      },
      annotations: readOnly,
    },
    guarded(async ({ path, size }) => {
      const image = await api.fetchImage(path, size);
      return {
        content: [{ type: "image", data: image.base64, mimeType: image.mimeType }],
      };
    }),
  );

  return server;
};
