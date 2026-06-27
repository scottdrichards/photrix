import type http from "node:http";
import {
  SEARCH_SOURCES,
  type SearchSource,
} from "../../../shared/filter-contract/src/index.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { embedText } from "../imageAnalysis/imageAnalysisWorker.ts";
import { embedTextWithClap } from "../audioProcessing/clapWorker.ts";
import { getLogger } from "../observability/logger.ts";
import { writeJson } from "../utils.ts";

const log = getLogger("searchRequestHandler");

// Each embedding source ranks the *whole* library and returns its top-N, so a
// source always contributes results even when nothing genuinely matches the
// query — e.g. "sunset" has no characteristic sound, yet CLAP still hands back
// its least-dissimilar videos as pure noise. Rank fusion then ranks that noise.
// We drop hits below an absolute cosine floor so a modality only contributes
// when it actually matched. Both floors are env-tunable; defaults come from
// measuring real queries (see the `?debug=1` diagnostics on this endpoint).
//
// The floor is a precision/recall knob, not a clean separator: neither model's
// cosine is relevance-calibrated *across* queries. CLIP image scores cluster
// ~0.27-0.29 for essentially any text query, so its floor is kept low — it is
// the primary text->image signal for a photo library and a higher floor would
// discard genuine matches (real "sunset" images score ~0.28). CLAP is biased
// toward precision: its noise can score ~0.40 (sunset) — higher than some real
// matches (dog barking ~0.34) — so a high floor lets CLAP contribute only when
// it is confident (music/waves/laughing ~0.50+) at the cost of weak audio
// recall. Transcript search is a substring match (already a hard relevance
// gate), so it has no floor.
const CLIP_MIN_SIMILARITY = Number(process.env.PHOTRIX_SEARCH_CLIP_MIN_SIMILARITY ?? 0.18);
const CLAP_MIN_SIMILARITY = Number(process.env.PHOTRIX_SEARCH_CLAP_MIN_SIMILARITY ?? 0.45);

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

  const requestStart = Date.now();

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

  // Which modalities to run. Absent `sources` param means all of them (the
  // default); a comma-separated subset lets the client disable sources — both to
  // narrow results and to skip the slow ML workers when debugging one modality.
  const sourcesParam = url.searchParams.get("sources");
  const enabledSources: Set<SearchSource> =
    sourcesParam === null
      ? new Set(SEARCH_SOURCES)
      : new Set(
          sourcesParam
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is SearchSource =>
              (SEARCH_SOURCES as readonly string[]).includes(s),
            ),
        );
  const useImage = enabledSources.has("image");
  const useAudio = enabledSources.has("audio");
  const useTranscript = enabledSources.has("transcript");

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

  // Time each source independently so the latency budget is attributable: which
  // source is the laggard that pushes the request to the timeout ceiling.
  const timings: Record<string, number> = {};
  // Sub-stage timings within a source (e.g. the ML text-embed vs the SQL vector
  // scan) so a slow source can be attributed to the worker or the database. The
  // embed depends on a CPU-contended Python worker; the scan is a brute-force
  // cosine over every image vector — they fail for different reasons and need
  // different fixes, so keep them separately attributable.
  const stageTimings: Record<string, number> = {};
  const timeStage = async <T>(label: string, p: Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await p;
    } finally {
      stageTimings[label] = Date.now() - start;
    }
  };
  const timed = <T>(label: string, p: Promise<T>): Promise<T> => {
    const start = Date.now();
    const record = () => {
      timings[label] = Date.now() - start;
    };
    return withTimeout(p, label).then(
      (v) => {
        record();
        return v;
      },
      (e: unknown) => {
        record();
        throw e;
      },
    );
  };

  type SearchResult = { folder: string; fileName: string; mimeType: string | null; similarity: number; [key: string]: unknown };

  // Run the enabled searches in parallel; failures in audio workers are
  // non-fatal. A disabled source resolves to `[]` without touching its worker,
  // so the slow embedding models are never invoked when their source is off.
  const noResults = Promise.resolve<Array<SearchResult>>([]);
  const [clipResult, clapResult, transcriptResult] = await Promise.allSettled([
    useImage
      ? timed(
          "clip",
          (async () => {
            const queryVector = await timeStage("clipEmbed", embedText(q));
            return timeStage(
              "clipScan",
              database.semanticSearch(queryVector, dbFilter, limit),
            );
          })(),
        )
      : noResults,
    useAudio
      ? timed(
          "clap",
          (async () => {
            const queryVector = await timeStage("clapEmbed", embedTextWithClap(q));
            return timeStage(
              "clapScan",
              database.audioSemanticSearch(queryVector, dbFilter, limit),
            );
          })(),
        )
      : noResults,
    useTranscript
      ? timed("transcript", database.audioTranscriptSearch(q, dbFilter, limit))
      : noResults,
  ]);

  // Apply the per-source relevance floor and record the raw cosine distribution
  // so the floors can be calibrated against real queries. `applyFloor` runs
  // before fusion: results dropped here never enter the ranking at all.
  const diagnostics: Record<string, unknown> = {};
  const applyFloor = (
    label: string,
    enabled: boolean,
    result: PromiseSettledResult<Array<SearchResult>>,
    floor: number,
  ): Array<SearchResult> => {
    if (!enabled) {
      diagnostics[label] = { status: "skipped" };
      return [];
    }
    if (result.status !== "fulfilled") {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      diagnostics[label] = { status: "rejected", ms: timings[label], reason };
      log.warn({
        source: label,
        reason,
        embedMs: stageTimings[`${label}Embed`],
        scanMs: stageTimings[`${label}Scan`],
      }, "search source failed");
      return [];
    }
    const all = result.value;
    const kept = all.filter((r) => r.similarity >= floor);
    const info = {
      status: "fulfilled",
      ms: timings[label],
      embedMs: stageTimings[`${label}Embed`],
      scanMs: stageTimings[`${label}Scan`],
      floor,
      returned: all.length,
      kept: kept.length,
      topSimilarity: all[0]?.similarity,
      keptFloorSimilarity: kept[kept.length - 1]?.similarity,
      droppedTopSimilarity: all[kept.length]?.similarity,
    };
    diagnostics[label] = info;
    log.debug({ source: label, ...info }, "search source scores");
    return kept;
  };

  const clipHits = applyFloor("clip", useImage, clipResult, CLIP_MIN_SIMILARITY);
  const clapHits = applyFloor("clap", useAudio, clapResult, CLAP_MIN_SIMILARITY);
  const transcriptHits =
    useTranscript && transcriptResult.status === "fulfilled" ? transcriptResult.value : [];
  diagnostics.transcript = !useTranscript
    ? { status: "skipped" }
    : transcriptResult.status === "fulfilled"
      ? { status: "fulfilled", ms: timings.transcript, returned: transcriptHits.length }
      : {
          status: "rejected",
          ms: timings.transcript,
          reason:
            transcriptResult.reason instanceof Error
              ? transcriptResult.reason.message
              : String(transcriptResult.reason),
        };

  // Fuse the three rankings by reciprocal rank rather than raw score. The
  // sources score on incomparable scales — CLIP image cosine ~0.1-0.3, CLAP
  // cosine ~0.2-0.5, transcript a flat 0.6 — so merging by magnitude let the
  // highest-scaled source (transcript) crowd genuine image matches out of the
  // top-N entirely. Reciprocal Rank Fusion scores each hit by its position
  // within its own already-sorted source (1/(k+rank)), so a top image hit
  // competes fairly with a top transcript hit and a file surfaced by several
  // sources is boosted. The fused value replaces `similarity` in the response;
  // the client orders by it but never displays the raw number.
  // `sources` records which modalities matched each file so the client can badge
  // a result with where it came from (image content, audio content, transcript).
  // A file surfaced by several sources keeps all of them, in fusion order.
  type FusedResult = SearchResult & { sources: Set<SearchSource> };
  const RRF_K = 60;
  const fused = new Map<string, FusedResult>();

  const fuseResults = (results: Array<SearchResult>, source: SearchSource) => {
    results.forEach((result, index) => {
      const key = `${result.folder}${result.fileName}`;
      const contribution = 1 / (RRF_K + index + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.similarity += contribution;
        existing.sources.add(source);
      } else {
        fused.set(key, {
          ...result,
          mimeType: result.mimeType ?? null,
          similarity: contribution,
          sources: new Set([source]),
        });
      }
    });
  };

  fuseResults(clipHits, "image");
  fuseResults(clapHits, "audio");
  fuseResults(transcriptHits, "transcript");

  const items = [...fused.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .map(({ sources, ...rest }) => ({ ...rest, sources: [...sources] }));

  // Only surface a hard failure when there is nothing to show AND both embedding
  // workers failed — otherwise partial results (e.g. transcript matches alone)
  // are still useful and should be returned rather than masked by a 503.
  if (
    items.length === 0 &&
    useImage &&
    clipResult.status === "rejected" &&
    useAudio &&
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

  log.info(
    { q, items: items.length, ms: Date.now() - requestStart, timings, stageTimings },
    "search complete",
  );

  const debug = url.searchParams.get("debug") === "1";
  writeJson(res, 200, {
    items,
    total: items.length,
    query: q,
    ...(debug ? { _diagnostics: diagnostics } : {}),
  });
};
