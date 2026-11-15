import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  viewUrl,
  type FileItem,
  type PersonCluster,
  type PhotrixApi,
  type SortParam,
} from "./photrixApi.ts";

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

const DAY_MS = 24 * 60 * 60 * 1000;

const asMs = (value: number | string | null | undefined): number | null => {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const VIDEO_EXTENSION = /\.(mp4|mov|m4v|avi|mkv|webm|mts|m2ts|3gp|wmv|mpg|mpeg)$/i;
const isVideoPath = (path: string): boolean => VIDEO_EXTENSION.test(path);

const formatFileLine = (item: FileItem): string => {
  const path = relativePathOf(item);
  const bits: string[] = [];
  if (item.mimeType?.startsWith("video/") || isVideoPath(path)) bits.push("video");
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
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "Showing 21–40 of 373" plus a hint to fetch the next page when there is one. */
const pageFooter = (total: number, page: number, pageSize: number, shown: number) => {
  const first = (page - 1) * pageSize + 1;
  const last = first + shown - 1;
  const more = last < total ? ` Pass page: ${page + 1} for more.` : "";
  return `Showing ${first}–${last} of ${total}.${more}`;
};

/**
 * A dateTaken range from ISO dates. A bare date ('2023-12-31') as the upper
 * bound covers that whole day.
 */
const parseDateRange = (
  dateFrom: string | undefined,
  dateTo: string | undefined,
): { range?: { min?: number; max?: number }; error?: string } => {
  if (!dateFrom && !dateTo) return {};
  const range: { min?: number; max?: number } = {};
  if (dateFrom) {
    const t = Date.parse(dateFrom);
    if (Number.isNaN(t)) return { error: `Invalid dateFrom: ${dateFrom}` };
    range.min = t;
  }
  if (dateTo) {
    const t = Date.parse(dateTo);
    if (Number.isNaN(t)) return { error: `Invalid dateTo: ${dateTo}` };
    range.max = t + (dateTo.length <= 10 ? DAY_MS - 1 : 0);
  }
  return { range };
};

const andAll = (conditions: unknown[]): unknown =>
  conditions.length === 0
    ? undefined
    : conditions.length === 1
      ? conditions[0]
      : { operation: "and", conditions };

const SORTS = {
  newest: "date:desc",
  oldest: "date:asc",
  best: "rating:desc",
} as const satisfies Record<string, SortParam>;
const sortSchema = z
  .enum(["newest", "oldest", "best"])
  .default("newest")
  .describe("Order: newest or oldest first, or best (highest-rated first).");
const pageSchema = z
  .number()
  .int()
  .min(1)
  .default(1)
  .describe("Page of results, starting at 1. Each page holds `limit` items.");

/** Photrix's standard heights; the server snaps any other value up to the next. */
const IMAGE_HEIGHTS = { small: 320, medium: 640, large: 1080 } as const;

const nameOf = (c: PersonCluster) => c.name?.trim() ?? "";
const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Finds a named person from what an agent typed: the exact name, else a name
 * that starts with it ('Alice' for 'Alice Diane Richards'), else one containing
 * every word of it. More than one candidate is reported rather than guessed.
 */
export const resolvePerson = (
  clusters: PersonCluster[],
  query: string,
): { match?: PersonCluster; candidates: PersonCluster[] } => {
  const q = normalize(query);
  const named = clusters.filter((c) => nameOf(c));
  const exact = named.filter((c) => normalize(nameOf(c)) === q);
  if (exact.length) return { match: exact[0], candidates: exact };
  const words = q.split(" ").filter(Boolean);
  const tiers = [
    named.filter((c) => normalize(nameOf(c)).startsWith(q)),
    named.filter((c) => {
      const parts = normalize(nameOf(c)).split(" ");
      return words.every((w) => parts.some((p) => p.startsWith(w)));
    }),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return { match: tier[0], candidates: tier };
    if (tier.length > 1) return { candidates: tier };
  }
  return { candidates: [] };
};

export const buildPhotrixMcpServer = (api: PhotrixApi): McpServer => {
  const {
    fetchImage,
    getDateRange,
    listPeople,
    queryFiles,
    searchPhotos,
  } = api;
  const server = new McpServer(
    { name: "photrix", version: "1.1.0" },
    {
      instructions:
        "Query a personal photo library (Photrix). Use search_photos for natural-language/semantic search, list_people / get_person_photos for face recognition, on_this_day for nostalgic picks, and query_photos for structured metadata filters. Photos are identified by a relativePath like '/2023/trip/img.jpg'; pass that path to get_photo_image to actually view a picture. Listing tools take `page` for more results.",
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
            const video =
              item.mimeType?.startsWith("video/") || isVideoPath(path) ? " (video)" : "";
            const src = item.sources?.length ? ` [${item.sources.join(", ")}]` : "";
            return `${i + 1}. ${path}${video}${src}\n   view: ${viewUrl(path)}`;
          })
          .join("\n");
        return textResult(
          `Found ${res.items.length} match(es) for "${query}":\n${lines}\n\nUse get_photo_image with a path to view one.`,
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "list_people",
    {
      title: "List people",
      description:
        "List the people the library has recognized via face clustering, most-photographed first. Returns each person's id (e.g. 'person-42'), assigned name (if any), and how many faces of them were found. Use the id or name with get_person_photos.",
      inputSchema: {
        onlyNamed: z
          .boolean()
          .default(false)
          .describe("Only return people who have been given a name."),
        name: z
          .string()
          .optional()
          .describe("Only people whose name contains this text (case-insensitive)."),
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
    async ({ onlyNamed, name, limit }) => {
      try {
        const res = await listPeople(true);
        let clusters = res.clusters;
        if (onlyNamed || name) clusters = clusters.filter((c) => nameOf(c));
        if (name) {
          const needle = normalize(name);
          clusters = clusters.filter((c) => normalize(nameOf(c)).includes(needle));
        }
        const matched = clusters.length;
        clusters = clusters.slice(0, limit);
        if (clusters.length === 0) {
          return textResult(
            name
              ? `No named person matches "${name}".`
              : onlyNamed
                ? "No named people yet. Faces are clustered automatically but names are assigned in the app."
                : "No people have been recognized yet (face clustering may still be running).",
          );
        }
        const lines = clusters
          .map((c) => {
            const label = nameOf(c) || "(unnamed)";
            const years = c.yearRangeLabel ? `, ${c.yearRangeLabel}` : "";
            return `- ${c.id}: ${label} — ${c.count} face(s)${years}`;
          })
          .join("\n");
        return textResult(
          `${clusters.length} of ${matched} matching people (library: ${res.totalClusters} people, ${res.totalFaces} faces${res.pendingFaces ? `, ${res.pendingFaces} pending` : ""}):\n${lines}`,
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "get_person_photos",
    {
      title: "Get a person's photos",
      description:
        "Return the photos and videos a recognized person appears in. Accepts a person id ('person-42', from list_people) or a name — a first name or partial name works when it is unambiguous. Optionally narrow by date and choose the order.",
      inputSchema: {
        person: z
          .string()
          .describe("Person id like 'person-42', or a name such as 'Alice'."),
        dateFrom: z.string().optional().describe("Earliest date (ISO, e.g. '2023-01-01')."),
        dateTo: z.string().optional().describe("Latest date (ISO, e.g. '2023-12-31')."),
        sort: sortSchema,
        limit: z.number().int().min(1).max(200).default(30).describe("Max photos."),
        page: pageSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ person, dateFrom, dateTo, sort, limit, page }) => {
      try {
        let clusterId = person.trim();
        let label = "";
        if (!/^person-\d+$/.test(clusterId)) {
          const people = await listPeople(true);
          const { match, candidates } = resolvePerson(people.clusters, person);
          if (!match) {
            return errorResult(
              candidates.length
                ? `"${person}" matches more than one person: ${candidates
                    .slice(0, 10)
                    .map((c) => `${c.id} (${nameOf(c)})`)
                    .join(", ")}. Call again with the id.`
                : `No person named "${person}" found. Call list_people to see available people and their ids.`,
            );
          }
          clusterId = match.id;
          label = ` (${nameOf(match)})`;
        }
        const numericId = Number(clusterId.slice("person-".length));

        const { range, error } = parseDateRange(dateFrom, dateTo);
        if (error) return errorResult(error);
        const res = await queryFiles({
          filter: andAll([
            { faceCluster: [numericId] },
            ...(range ? [{ dateTaken: range }] : []),
          ]),
          metadata: FILE_METADATA,
          pageSize: limit,
          page,
          sort: SORTS[sort],
          includeSubfolders: true,
        });
        if (res.items.length === 0) {
          return textResult(
            page > 1 || range
              ? `No photos of ${clusterId}${label} on that page or in that date range.`
              : `No photos found for ${clusterId}${label}. Check the id with list_people.`,
          );
        }
        const lines = res.items.map(formatFileLine).join("\n");
        return textResult(
          `${clusterId}${label} appears in ${res.total} photo(s)${range ? " in that date range" : ""}:\n${lines}\n\n${pageFooter(res.total, page, limit, res.items.length)}`,
        );
      } catch (err) {
        return errorResult(errorMessage(err));
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
        page: pageSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ month, day, limit, page }) => {
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
          pageSize: limit,
          page,
          sort: SORTS.best,
          includeSubfolders: true,
        });
        if (res.items.length === 0) {
          return textResult(
            page > 1
              ? `No more photos from ${m}/${d}.`
              : `No photos were taken on ${m}/${d} in any year (${startYear}–${endYear}).`,
          );
        }
        const lines = res.items.map(formatFileLine).join("\n");
        return textResult(
          `On ${m}/${d} across ${startYear}–${endYear}, found ${res.total} photo(s), highest-rated first:\n${lines}\n\n${pageFooter(res.total, page, limit, res.items.length)} Pass a path to get_photo_image to show it.`,
        );
      } catch (err) {
        return errorResult(errorMessage(err));
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
        sort: sortSchema,
        limit: z.number().int().min(1).max(200).default(30).describe("Max results."),
        page: pageSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ dateFrom, dateTo, minRating, tag, cameraMake, folder, sort, limit, page }) => {
      try {
        const conditions: unknown[] = [];
        if (folder) conditions.push({ folder: { folder, recursive: true } });
        const { range, error } = parseDateRange(dateFrom, dateTo);
        if (error) return errorResult(error);
        if (range) conditions.push({ dateTaken: range });
        if (minRating) conditions.push({ rating: { min: minRating } });
        if (tag) conditions.push({ tags: tag });
        if (cameraMake) conditions.push({ cameraMake });

        const res = await queryFiles({
          filter: andAll(conditions),
          metadata: FILE_METADATA,
          pageSize: limit,
          page,
          sort: SORTS[sort],
          includeSubfolders: true,
        });
        if (res.items.length === 0) {
          return textResult(
            page > 1 ? "No more photos match those filters." : "No photos matched those filters.",
          );
        }
        const lines = res.items.map(formatFileLine).join("\n");
        return textResult(
          `${res.total} photo(s) matched:\n${lines}\n\n${pageFooter(res.total, page, limit, res.items.length)}`,
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "get_photo_image",
    {
      title: "View a photo",
      description:
        "Fetch an actual photo so you can see it, given its relativePath (from any other tool, e.g. '/2023/trip/img.jpg'). Returns a JPEG scaled to the chosen height: small 320px, medium 640px, large 1080px. HEIC/RAW are converted. For a video, returns a still frame.",
      inputSchema: {
        path: z.string().describe("The photo's relativePath, e.g. '/2023/trip/img.jpg'."),
        size: z
          .enum(["small", "medium", "large"])
          .default("large")
          .describe("Image height: small 320px, medium 640px, large 1080px."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, size }) => {
      try {
        const image = await fetchImage(path, IMAGE_HEIGHTS[size]);
        return {
          content: [
            ...(isVideoPath(path)
              ? [{ type: "text" as const, text: `${path} is a video; this is a still frame.` }]
              : []),
            { type: "image" as const, data: image.base64, mimeType: image.mimeType },
          ],
        };
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  return server;
};
