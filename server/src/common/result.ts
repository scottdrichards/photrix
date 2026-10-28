import { toError } from "./toError.ts";

/**
 * The outcome of work that can fail, as a value instead of a throw.
 *
 * Prefer this to `try`/`catch` wherever a failure is an expected outcome the
 * caller decides about (a file that may not exist, a probe that may fail): the
 * caller has to look at `ok`, and an unexpected error is still in hand to log,
 * rather than vanishing into a catch block written for the expected one.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: Error };

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

/** True for a filesystem "no such file or directory". */
export const isNotFound = (error: Error): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
