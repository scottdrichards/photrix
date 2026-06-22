import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { embedText } from "../imageAnalysis/imageAnalysisWorker.ts";
import { embedTextWithClap } from "../audioProcessing/clapWorker.ts";
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

  const dbFilter = filter as Parameters<typeof database.semanticSearch>[1];

  // Run all three searches in parallel; failures in audio workers are non-fatal
  const [clipResult, clapResult, transcriptResult] = await Promise.allSettled([
    (async () => {
      const queryVector = await embedText(q);
      return database.semanticSearch(queryVector, dbFilter, limit);
    })(),
    (async () => {
      const queryVector = await embedTextWithClap(q);
      return database.audioSemanticSearch(queryVector, dbFilter, limit);
    })(),
    database.audioTranscriptSearch(q, dbFilter, limit),
  ]);

  if (clipResult.status === "rejected" && clapResult.status === "rejected") {
    const message =
      clipResult.reason instanceof Error ? clipResult.reason.message : String(clipResult.reason);
    return writeJson(res, 503, {
      error: "Search workers unavailable",
      message,
      hint: "Run: npm --prefix server run clip:python:install",
    });
  }

  type SearchResult = { folder: string; fileName: string; mimeType: string | null; similarity: number; [key: string]: unknown };

  // Merge results from all sources, deduplicate by path, keep best similarity score
  const byPath = new Map<string, SearchResult>();

  const addResults = (results: Array<SearchResult>) => {
    for (const { folder, fileName, mimeType, similarity, ...rest } of results) {
      const key = `${folder}${fileName}`;
      const existing = byPath.get(key);
      if (!existing || similarity > existing.similarity) {
        byPath.set(key, { folder, fileName, mimeType: mimeType ?? null, similarity, ...rest });
      }
    }
  };

  if (clipResult.status === "fulfilled") addResults(clipResult.value);
  if (clapResult.status === "fulfilled") addResults(clapResult.value);
  if (transcriptResult.status === "fulfilled") addResults(transcriptResult.value);

  const items = [...byPath.values()].sort((a, b) => b.similarity - a.similarity).slice(0, limit);

  writeJson(res, 200, { items, total: items.length, query: q });
};
