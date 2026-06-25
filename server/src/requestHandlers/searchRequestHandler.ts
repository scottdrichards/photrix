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

  // Cap how long the whole search waits on any one source. The embedding-based
  // searches depend on Python ML workers that can be slow or wedged (a stuck
  // forward pass, a model still loading, CPU starvation from background work).
  // Without a bound the handler would block on the slowest worker's internal
  // timeout (CLIP 120s, CLAP 10min), so a single slow worker makes the whole
  // request appear to hang. Time the laggards out and return whatever resolved.
  const SEARCH_TIMEOUT_MS = Number(process.env.PHOTRIX_SEARCH_TIMEOUT_MS) || 15_000;
  const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} search timed out after ${SEARCH_TIMEOUT_MS}ms`)),
        SEARCH_TIMEOUT_MS,
      );
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });

  // Run all three searches in parallel; failures in audio workers are non-fatal
  const [clipResult, clapResult, transcriptResult] = await Promise.allSettled([
    withTimeout(
      (async () => {
        const queryVector = await embedText(q);
        return database.semanticSearch(queryVector, dbFilter, limit);
      })(),
      "image",
    ),
    withTimeout(
      (async () => {
        const queryVector = await embedTextWithClap(q);
        return database.audioSemanticSearch(queryVector, dbFilter, limit);
      })(),
      "audio",
    ),
    withTimeout(database.audioTranscriptSearch(q, dbFilter, limit), "transcript"),
  ]);

  type SearchResult = { folder: string; fileName: string; mimeType: string | null; similarity: number; [key: string]: unknown };

  // Fuse the three rankings by reciprocal rank rather than raw score. The
  // sources score on incomparable scales — CLIP image cosine ~0.1-0.3, CLAP
  // cosine ~0.2-0.5, transcript a flat 0.6 — so merging by magnitude let the
  // highest-scaled source (transcript) crowd genuine image matches out of the
  // top-N entirely. Reciprocal Rank Fusion scores each hit by its position
  // within its own already-sorted source (1/(k+rank)), so a top image hit
  // competes fairly with a top transcript hit and a file surfaced by several
  // sources is boosted. The fused value replaces `similarity` in the response;
  // the client orders by it but never displays the raw number.
  const RRF_K = 60;
  const fused = new Map<string, SearchResult>();

  const fuseResults = (results: Array<SearchResult>) => {
    results.forEach((result, index) => {
      const key = `${result.folder}${result.fileName}`;
      const contribution = 1 / (RRF_K + index + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.similarity += contribution;
      } else {
        fused.set(key, { ...result, mimeType: result.mimeType ?? null, similarity: contribution });
      }
    });
  };

  if (clipResult.status === "fulfilled") fuseResults(clipResult.value);
  if (clapResult.status === "fulfilled") fuseResults(clapResult.value);
  if (transcriptResult.status === "fulfilled") fuseResults(transcriptResult.value);

  const items = [...fused.values()].sort((a, b) => b.similarity - a.similarity).slice(0, limit);

  // Only surface a hard failure when there is nothing to show AND both embedding
  // workers failed — otherwise partial results (e.g. transcript matches alone)
  // are still useful and should be returned rather than masked by a 503.
  if (
    items.length === 0 &&
    clipResult.status === "rejected" &&
    clapResult.status === "rejected"
  ) {
    const message =
      clipResult.reason instanceof Error ? clipResult.reason.message : String(clipResult.reason);
    return writeJson(res, 503, {
      error: "Search workers unavailable",
      message,
      hint: "Run: npm --prefix server run clip:python:install",
    });
  }

  writeJson(res, 200, { items, total: items.length, query: q });
};
