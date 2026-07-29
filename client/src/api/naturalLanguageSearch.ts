import type { SearchInterpretation } from "../../../shared/filter-contract/src";
import { fetchJsonOrThrow } from "./http";

/**
 * Client-side deadline for the interpretation.
 *
 * The plain search is already running by the time this is called, so the only
 * thing waiting on this request is the chip row. Deliberately longer than the
 * server's own model deadline (PHOTRIX_NL_SEARCH_TIMEOUT_MS, 12s) so a slow
 * model still returns a usable "no interpretation" answer we can cache, rather
 * than being cut off client-side and re-requested on every submit.
 */
const TIMEOUT_MS = 20_000;

const NOT_INTERPRETED: SearchInterpretation = { interpreted: false, reason: "error" };

// Identical queries must not re-hit the model — the search bar re-submits the
// same text constantly (re-focus, Enter twice, back button). Keyed on the exact
// trimmed query; the server caches per UTC day on top of this.
const cache = new Map<string, Promise<SearchInterpretation>>();
const CACHE_MAX_ENTRIES = 50;

/** Test seam. */
export const clearSearchInterpretationCache = () => cache.clear();

/**
 * Ask the server to translate a natural-language query into structured filters.
 *
 * Never rejects: every failure (offline, 4xx/5xx, timeout, no local model) turns
 * into `interpreted: false`, because the caller's fallback is to leave the plain
 * search it already started exactly as it is.
 */
export const interpretSearchQuery = async (
  query: string,
): Promise<SearchInterpretation> => {
  const trimmed = query.trim();
  if (!trimmed) return { interpreted: false, reason: "empty-query" };

  const cached = cache.get(trimmed);
  if (cached) return cached;

  const pending = (async (): Promise<SearchInterpretation> => {
    try {
      return await fetchJsonOrThrow<SearchInterpretation>(
        "/api/search/interpret",
        "interpret search query",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: trimmed }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch {
      // A network-level failure is transient: forget it so the next submit of
      // the same query tries again, unlike a stable "no interpretation" answer.
      cache.delete(trimmed);
      return NOT_INTERPRETED;
    }
  })();

  cache.set(trimmed, pending);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return pending;
};
