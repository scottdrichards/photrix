import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { viewUrl, type FileItem, type PhotrixApi } from "./photrixApi.ts";

const relativePathOf = (item: { folder: string; fileName: string }): string =>
  `${item.folder}${item.fileName}`;

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

const asMs = (value: number | string | null | undefined): number | null => {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const formatFileLine = (item: FileItem): string => {
  const path = relativePathOf(item);
  const bits: string[] = [];
  const ms = asMs(item.dateTaken);
  if (ms !== null) bits.push(new Date(ms).toISOString().slice(0, 10));
  if (typeof item.rating === "number" && item.rating > 0) {
    bits.push(`${"★".repeat(item.rating)}`);
  }
  if (item.cameraMake || item.cameraModel) {
    bits.push([item.cameraMake, item.cameraModel].filter(Boolean).join(" "));
  }
  const meta = bits.length ? ` — ${bits.join(" · ")}` : "";
  return `- ${path}${meta}\n  view: ${viewUrl(path)}`;
};

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errorResult = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

export const buildPhotrixMcpServer = (api: PhotrixApi): McpServer => {
  const {
    fetchImage,
    getDateRange,
    getPersonPhotos,
    listPeople,
    queryFiles,
    searchPhotos,
  } = api;
  const server = new McpServer(
    { name: "photrix", version: "1.0.0" },
    {
      instructions:
        "Query a personal photo library (Photrix). Use search_photos for natural-language/semantic search, list_people / get_person_photos for face recognition, on_this_day for nostalgic picks, and query_photos for structured metadata filters. Photos are identified by a relativePath like '/2023/trip/img.jpg'; pass that path to get_photo_image to actually view a picture.",
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
        limit: z.number().int().min(1).max(200).default(20).describe("Max results."),
        folder: z
          .string()
          .optional()
          .describe(
            "Restrict to a folder path, e.g. '/2023'. Omit to search everything.",
          ),
        sources: z
          .array(z.enum(["image", "audio", "transcript"]))
          .optional()
          .describe("Restrict which modalities to search. Defaults to all."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit, folder, sources }) => {
      try {
        const res = await searchPhotos({
          q: query,
          limit,
          folder,
          includeSubfolders: true,
          sources,
        });
        if (res.items.length === 0) {
          return textResult(`No photos matched "${query}".`);
        }
        const lines = res.items
          .map((item, i) => {
            const path = `${item.folder}${item.fileName}`;
            const src = item.sources?.length ? ` [${item.sources.join(", ")}]` : "";
            return `${i + 1}. ${path}${src}\n   view: ${viewUrl(path)}`;
          })
          .join("\n");
        return textResult(
          `Found ${res.items.length} match(es) for "${query}":\n${lines}\n\nUse get_photo_image with a path to view one.`,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
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
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Max people to list."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ onlyNamed, limit }) => {
      try {
        const res = await listPeople(true);
        let clusters = res.clusters;
        if (onlyNamed) clusters = clusters.filter((c) => c.name && c.name.trim());
        clusters = clusters.slice(0, limit);
        if (clusters.length === 0) {
          return textResult(
            onlyNamed
              ? "No named people yet. Faces are clustered automatically but names are assigned in the app."
              : "No people have been recognized yet (face clustering may still be running).",
          );
        }
        const lines = clusters
          .map((c) => {
            const name = c.name?.trim() ? c.name : "(unnamed)";
            const years = c.yearRangeLabel ? `, ${c.yearRangeLabel}` : "";
            return `- ${c.id}: ${name} — ${c.count} photo(s)${years}`;
          })
          .join("\n");
        return textResult(
          `${clusters.length} of ${res.totalClusters} people (${res.totalFaces} faces total${res.pendingFaces ? `, ${res.pendingFaces} pending` : ""}):\n${lines}`,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
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
        limit: z.number().int().min(1).max(200).default(30).describe("Max photos."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ person, limit }) => {
      try {
        let clusterId = person;
        if (!/^person-\d+$/.test(person)) {
          const people = await listPeople(true);
          const match = people.clusters.find(
            (c) => c.name?.trim().toLowerCase() === person.trim().toLowerCase(),
          );
          if (!match) {
            return errorResult(
              `No person named "${person}" found. Call list_people to see available people and their ids.`,
            );
          }
          clusterId = match.id;
        }
        const detail = await getPersonPhotos(clusterId);
        if (!detail.cluster) {
          return errorResult(`Person "${clusterId}" not found.`);
        }
        const paths = [
          ...new Set(detail.cluster.faces.map((f) => f.path).filter(Boolean)),
        ].slice(0, limit);
        const name = detail.cluster.name?.trim() ? ` (${detail.cluster.name})` : "";
        const lines = paths.map((p) => `- ${p}\n  view: ${viewUrl(p)}`).join("\n");
        return textResult(
          `${clusterId}${name} appears in ${detail.cluster.count} photo(s). Showing ${paths.length}:\n${lines}`,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
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
        limit: z.number().int().min(1).max(100).default(20).describe("Max photos."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ month, day, limit }) => {
      try {
        const now = new Date();
        const m = month ?? now.getMonth() + 1;
        const d = day ?? now.getDate();
        const { minDate, maxDate } = await getDateRange();
        if (minDate === null || maxDate === null) {
          return textResult("The library has no dated photos yet.");
        }
        const startYear = new Date(minDate).getFullYear();
        const endYear = new Date(maxDate).getFullYear();
        const conditions: unknown[] = [];
        for (let y = startYear; y <= endYear; y++) {
          const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
          const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
          conditions.push({ dateTaken: { min: start, max: end } });
        }
        const filter =
          conditions.length === 1 ? conditions[0] : { operation: "or", conditions };
        const res = await queryFiles({
          filter,
          metadata: FILE_METADATA,
          pageSize: 500,
          includeSubfolders: true,
        });
        if (res.items.length === 0) {
          return textResult(
            `No photos were taken on ${m}/${d} in any year (${startYear}–${endYear}).`,
          );
        }
        const sorted = [...res.items].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
        const picks = sorted.slice(0, limit);
        const lines = picks.map(formatFileLine).join("\n");
        return textResult(
          `On ${m}/${d} across ${startYear}–${endYear}, found ${res.items.length} photo(s). Top ${picks.length} (highest-rated first):\n${lines}\n\nTip: pass the first path to get_photo_image to show it.`,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "query_photos",
    {
      title: "Query photos by metadata",
      description:
        "Structured search over photo metadata: date range, minimum star rating, tags, camera, or folder. Combine any subset. Returns file paths with basic metadata.",
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
        limit: z.number().int().min(1).max(200).default(30).describe("Max results."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ dateFrom, dateTo, minRating, tag, cameraMake, folder, limit }) => {
      try {
        const conditions: unknown[] = [];
        if (folder) conditions.push({ folder: { folder, recursive: true } });
        if (dateFrom || dateTo) {
          const range: { min?: number; max?: number } = {};
          if (dateFrom) {
            const t = Date.parse(dateFrom);
            if (Number.isNaN(t)) return errorResult(`Invalid dateFrom: ${dateFrom}`);
            range.min = t;
          }
          if (dateTo) {
            const t = Date.parse(dateTo);
            if (Number.isNaN(t)) return errorResult(`Invalid dateTo: ${dateTo}`);
            // Include the whole day when only a date (no time) was given.
            range.max = t + (dateTo.length <= 10 ? 24 * 60 * 60 * 1000 - 1 : 0);
          }
          conditions.push({ dateTaken: range });
        }
        if (minRating) conditions.push({ rating: { min: minRating } });
        if (tag) conditions.push({ tags: tag });
        if (cameraMake) conditions.push({ cameraMake });

        const filter =
          conditions.length === 0
            ? undefined
            : conditions.length === 1
              ? conditions[0]
              : { operation: "and", conditions };

        const res = await queryFiles({
          filter,
          metadata: FILE_METADATA,
          pageSize: limit,
          includeSubfolders: true,
        });
        if (res.items.length === 0) {
          return textResult("No photos matched those filters.");
        }
        const lines = res.items.slice(0, limit).map(formatFileLine).join("\n");
        return textResult(
          `${res.total} photo(s) matched (showing ${Math.min(limit, res.items.length)}):\n${lines}`,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
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
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, size }) => {
      try {
        const image = await fetchImage(path, size);
        return {
          content: [
            { type: "image" as const, data: image.base64, mimeType: image.mimeType },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
};
