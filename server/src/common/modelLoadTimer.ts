/**
 * How long a model load has been running, and how long the last one took.
 * Feedback #162: "a search model is still loading" with nothing else to go on
 * reads like an excuse. Elapsed time against the last load's duration lets the
 * search UI say how far along it is.
 */
export type ModelLoadProgress = {
  /** How long the current load has run; absent when nothing is loading. */
  loadingForMs?: number;
  /** How long the most recent completed load took. */
  lastLoadMs?: number;
};

export const createModelLoadTimer = (now: () => number = Date.now) => {
  let startedAt: number | null = null;
  let lastLoadMs: number | null = null;

  return {
    /** A load began. Ignored while one is already being timed. */
    start: () => {
      if (startedAt === null) startedAt = now();
    },
    /** The model is warm: the time since `start` becomes the last load time. */
    finish: () => {
      if (startedAt === null) return;
      lastLoadMs = now() - startedAt;
      startedAt = null;
    },
    /** The load stopped without a warm model (process exit, nobody waiting). */
    abandon: () => {
      startedAt = null;
    },
    progress: (): ModelLoadProgress => ({
      ...(startedAt !== null ? { loadingForMs: now() - startedAt } : {}),
      ...(lastLoadMs !== null ? { lastLoadMs } : {}),
    }),
  };
};
