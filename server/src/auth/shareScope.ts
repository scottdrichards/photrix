import { Buffer } from "node:buffer";
import { SEARCH_SOURCES, type SearchSource, type ShareScope } from "../../../shared/filter-contract/src/index.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";
import { embedText } from "../imageAnalysis/imageAnalysisWorker.ts";
import { embedTextWithClap } from "../audioProcessing/clapWorker.ts";

const CLIP_MIN_SIMILARITY = Number(process.env.PHOTRIX_SEARCH_CLIP_MIN_SIMILARITY ?? 0.18);
const CLAP_MIN_SIMILARITY = Number(process.env.PHOTRIX_SEARCH_CLAP_MIN_SIMILARITY ?? 0.45);
const SEARCH_TIMEOUT_MS = Number(process.env.PHOTRIX_SEARCH_TIMEOUT_MS) || 15_000;
const SHARE_FILTER_CACHE_TTL_MS = 5_000;

type CachedFilter = {
  expiresAt: number;
  filter: FilterElement;
};

const resolvedShareFilters = new Map<string, CachedFilter>();

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

export const resolveShareFilter = async (
  shareScope: ShareScope<unknown>,
  cacheKey?: string,
): Promise<FilterElement> => {
  if (cacheKey) {
    const cached = resolvedShareFilters.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.filter;
    }
  }

  const baseFilter = (shareScope.filter ?? {}) as FilterElement;
  const semanticQuery = shareScope.semanticQuery?.trim();
  const searchSources = shareScope.searchSources ?? [...SEARCH_SOURCES];

  if (!semanticQuery) {
    return baseFilter;
  }

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
        ? semanticFilters[0] ?? {}
        : { operation: "or" as const, conditions: semanticFilters };
    const resolved = combineFilters([baseFilter, semanticFilter]);

    if (cacheKey) {
      resolvedShareFilters.set(cacheKey, {
        expiresAt: Date.now() + SHARE_FILTER_CACHE_TTL_MS,
        filter: resolved,
      });
    }

    return resolved;
  } catch (error) {
    throw new ShareScopeError(
      error instanceof Error ? error.message : String(error),
      503,
    );
  }
};
