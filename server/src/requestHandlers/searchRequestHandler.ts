import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { embedTextWithClip } from "../imageEmbedding/clipWorker.ts";
import { writeJson } from "../utils.ts";

type Options = { database: IndexDatabase };

export const searchRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database }: Options,
): Promise<void> => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = url.searchParams.get("q")?.trim();

  if (!q) {
    return writeJson(res, 400, { error: "Missing required query parameter 'q'" });
  }

  const rawLimit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 50;

  const path = url.searchParams.get("path") ?? "";
  const includeSubfolders = url.searchParams.get("includeSubfolders") === "true";

  let filterParam: unknown = null;
  const filterParamRaw = url.searchParams.get("filter");
  if (filterParamRaw) {
    try {
      filterParam = JSON.parse(filterParamRaw);
    } catch {
      return writeJson(res, 400, { error: "Invalid filter JSON" });
    }
  }

  const conditions = [
    ...(path || includeSubfolders
      ? [{ folder: { folder: path || "/", recursive: includeSubfolders } }]
      : []),
    ...(filterParam ? [filterParam] : []),
  ];

  const filter =
    conditions.length === 0
      ? {}
      : conditions.length === 1
        ? conditions[0]
        : { operation: "and" as const, conditions };

  let queryVector: Float32Array;
  try {
    queryVector = await embedTextWithClip(q);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return writeJson(res, 503, {
      error: "CLIP worker unavailable",
      message,
      hint: "Run: npm --prefix server run clip:python:install",
    });
  }

  const results = await database.semanticSearch(
    queryVector,
    filter as Parameters<typeof database.semanticSearch>[1],
    limit,
  );

  const items = results.map(({ folder, fileName, mimeType, similarity, ...rest }) => ({
    folder,
    fileName,
    mimeType: mimeType ?? null,
    similarity,
    ...rest,
  }));

  writeJson(res, 200, { items, total: items.length, query: q });
};
