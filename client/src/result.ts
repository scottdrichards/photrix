/**
 * The outcome of work that can fail, as a value instead of a throw — the
 * client twin of server/src/common/result.ts. Prefer it to try/catch wherever a
 * failure is an expected outcome the caller decides about.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: Error };

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value), { cause: value });

/** Awaits `work` and returns its value or the error it rejected with. Never throws. */
export const attempt = <T>(work: Promise<T>): Promise<Result<T>> =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: toError(error) }),
  );

/** Runs `work` and returns its value or the error it threw. Never throws. */
export const attemptSync = <T>(work: () => T): Result<T> => {
  try {
    return { ok: true, value: work() };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
};
