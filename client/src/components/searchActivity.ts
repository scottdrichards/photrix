import { useSyncExternalStore } from "react";
import type { SearchSource, SearchSourceStatus } from "../api";

/**
 * What the current search is doing, shared between the grid that runs it and
 * the search bar that shows its status icon. The two live in different
 * branches of the tree, so this is a tiny external store rather than a context.
 */
export type SearchActivity = {
  /** A semantic query is active in the grid. */
  active: boolean;
  /** Its first page is in flight. */
  searching: boolean;
  /** Per-source outcome of the last completed search, if any. */
  outcome: SearchSourceStatus | null;
  /** Sources the user has enabled for this search. */
  enabledSources: readonly SearchSource[];
  /** Re-runs the same search. Null when there is nothing to retry. */
  retry: (() => void) | null;
};

export const IDLE_SEARCH_ACTIVITY: SearchActivity = {
  active: false,
  searching: false,
  outcome: null,
  enabledSources: [],
  retry: null,
};

let current: SearchActivity = IDLE_SEARCH_ACTIVITY;
const listeners = new Set<() => void>();

export const publishSearchActivity = (next: SearchActivity): void => {
  current = next;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => current;

export const useSearchActivity = (): SearchActivity =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
