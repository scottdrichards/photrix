import { fetchJsonOrThrow } from "./http";
import type { SearchSource } from "./types";

/**
 * How ready the model behind a search source is:
 * - "ready": loaded; that source answers in milliseconds.
 * - "loading": being loaded right now.
 * - "cold": not loaded; the next search has to load it first.
 * - "unavailable": turned off on this server.
 */
export type SearchModelState = "ready" | "loading" | "cold" | "unavailable";

/** What happened to one source in a completed search. */
export type SearchSourceOutcome =
  | { status: "ok"; ms?: number }
  | { status: "skipped" }
  | { status: "failed"; reason: "loading" | "timeout" | "error"; ms?: number };

export type SearchSourceStatus = Partial<Record<SearchSource, SearchSourceOutcome>>;

/**
 * Thrown for a search that came back with nothing because every model-backed
 * source failed (HTTP 503). Carries the per-source outcome so the UI can say
 * *why* rather than just "failed".
 */
export class SearchUnavailableError extends Error {
  readonly sourceStatus: SearchSourceStatus;
  constructor(sourceStatus: SearchSourceStatus) {
    super("Search models unavailable");
    this.name = "SearchUnavailableError";
    this.sourceStatus = sourceStatus;
  }
}

/** Current readiness of each search source's model. Cheap; safe to poll. */
export const fetchSearchStatus = async (
  signal?: AbortSignal,
): Promise<Record<SearchSource, SearchModelState>> => {
  const payload = await fetchJsonOrThrow<{
    sources: Record<SearchSource, SearchModelState>;
  }>("/api/search/status", "fetch search status", { signal });
  return payload.sources;
};
