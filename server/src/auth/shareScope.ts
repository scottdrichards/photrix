import {
  SEARCH_SOURCES,
  type SearchSource,
  type ShareScope,
} from "../../../shared/filter-contract/src/index.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";
import { FilterCompileError, filterToSQL } from "../indexDatabase/filterToSQL.ts";
import { embedText } from "../imageAnalysis/imageAnalysisWorker.ts";
import { embedTextWithClap } from "../audioProcessing/clapWorker.ts";

const CLIP_MIN_SIMILARITY = Number(
  process.env.PHOTRIX_SEARCH_CLIP_MIN_SIMILARITY ?? 0.18,
);
const CLAP_MIN_SIMILARITY = Number(
  process.env.PHOTRIX_SEARCH_CLAP_MIN_SIMILARITY ?? 0.45,
);
const SEARCH_TIMEOUT_MS = Number(process.env.PHOTRIX_SEARCH_TIMEOUT_MS) || 15_000;
// Resolving a semantic share embeds its query text, which gives the same
// vector every time, so the result can live a while. It used to expire after
// 5 s, and every request in a cold window ran its own embed: a grid's ~100
// concurrent tile requests each queued an ML-worker job behind background work
// and 503'd on SEARCH_TIMEOUT_MS. Concurrent callers now share one in-flight
// resolution.
const SHARE_FILTER_CACHE_TTL_MS = 10 * 60_000;

type CachedFilter = {
  expiresAt: number;
  filter: Promise<FilterElement>;
};

const resolvedShareFilters = new Map<string, CachedFilter>();

const evictExpiredShareFilters = (now: number) => {
  for (const [key, entry] of resolvedShareFilters) {
    if (entry.expiresAt <= now) resolvedShareFilters.delete(key);
  }
};

export class ShareScopeError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} search timed out after ${SEARCH_TIMEOUT_MS}ms`)),
      SEARCH_TIMEOUT_MS,
    );
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

export const normalizeShareSearchSources = (raw: unknown): SearchSource[] | null => {
  if (raw === undefined) {
    return [...SEARCH_SOURCES];
  }
  if (!Array.isArray(raw)) {
    return null;
  }

  const normalized = SEARCH_SOURCES.filter((source) => raw.includes(source));
  return normalized.length > 0 ? normalized : null;
};

export const combineFilters = (conditions: FilterElement[]): FilterElement => {
  const nonEmptyConditions = conditions.filter((condition) => {
    if ("operation" in condition) {
      return condition.conditions.length > 0;
    }
    return Object.keys(condition).length > 0;
  });

  if (nonEmptyConditions.length === 0) {
    return {};
  }
  if (nonEmptyConditions.length === 1) {
    return nonEmptyConditions[0] ?? {};
  }

  return { operation: "and", conditions: nonEmptyConditions };
};

/**
 * Refuses a share whose filter doesn't actually scope anything.
 *
 * Every query ANDs the share filter in, so a share filter that compiles to no
 * WHERE at all (`{}`, a root folder, a clause that can't be compiled) grants the
 * whole library while every `if (shareFilter)` check believes a scope is in
 * force. Compiled strictly, so a clause that would be dropped fails instead.
 */
export const assertShareFilterIsScoped = (filter: FilterElement): void => {
  let where: string;
  try {
    ({ where } = filterToSQL(filter, { strict: true }));
  } catch (error) {
    if (error instanceof FilterCompileError) {
      throw new ShareScopeError(`Invalid share filter: ${error.message}`, 403);
    }
    throw error;
  }
  if (!where) {
    throw new ShareScopeError("This share link has no scope", 403);
  }
};

export const resolveShareFilter = async (
  shareScope: ShareScope<unknown>,
  cacheKey?: string,
): Promise<FilterElement> => {
  const filter = await resolveUncheckedShareFilter(shareScope, cacheKey);
  assertShareFilterIsScoped(filter);
  return filter;
};

const resolveUncheckedShareFilter = async (
  shareScope: ShareScope<unknown>,
  cacheKey?: string,
): Promise<FilterElement> => {
  if (!shareScope.semanticQuery?.trim()) {
    return (shareScope.filter ?? {});
  }
  if (!cacheKey) {
    return resolveSemanticShareFilter(shareScope);
  }

  const now = Date.now();
  const cached = resolvedShareFilters.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.filter;
  }
  evictExpiredShareFilters(now);
  const filter = resolveSemanticShareFilter(shareScope);
  const entry = { expiresAt: now + SHARE_FILTER_CACHE_TTL_MS, filter };
  resolvedShareFilters.set(cacheKey, entry);
  // A failure isn't cached: the next request retries.
  filter.catch(() => {
    if (resolvedShareFilters.get(cacheKey) === entry) resolvedShareFilters.delete(cacheKey);
  });
  return filter;
};

const resolveSemanticShareFilter = async (
  shareScope: ShareScope<unknown>,
): Promise<FilterElement> => {
  const baseFilter = (shareScope.filter ?? {});
  const semanticQuery = shareScope.semanticQuery?.trim() ?? "";
  const searchSources = shareScope.searchSources ?? [...SEARCH_SOURCES];

  try {
    const semanticFilters = await Promise.all(
      searchSources.map(async (source): Promise<FilterElement> => {
        if (source === "image") {
          const queryVector = await withTimeout(embedText(semanticQuery), "clip");
          return {
            semanticImage: {
              queryVector: Array.from(queryVector),
              minSimilarity: CLIP_MIN_SIMILARITY,
            },
          };
        }

        if (source === "audio") {
          const queryVector = await withTimeout(embedTextWithClap(semanticQuery), "clap");
          return {
            semanticAudio: {
              queryVector: Array.from(queryVector),
              minSimilarity: CLAP_MIN_SIMILARITY,
            },
          };
        }

        return { transcriptSearch: { includes: semanticQuery } };
      }),
    );

    const semanticFilter =
      semanticFilters.length === 1
        ? (semanticFilters[0] ?? {})
        : { operation: "or" as const, conditions: semanticFilters };
    return combineFilters([baseFilter, semanticFilter]);
  } catch (error) {
    throw new ShareScopeError(
      error instanceof Error ? error.message : String(error),
      503,
    );
  }
};
