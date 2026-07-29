import { AsyncLocalStorage } from "node:async_hooks";

// Carries the AbortSignal of the HTTP request that (transitively) triggered the
// current async work, so deep layers (AsyncSqlite's read queue) can drop work
// whose client has already disconnected without every intermediate function
// threading a signal parameter through its signature. Work not tied to a
// request (background indexing, ML pipelines) has no store and never aborts.
const requestAbortStorage = new AsyncLocalStorage<AbortSignal>();

export const getRequestAbortSignal = (): AbortSignal | undefined =>
  requestAbortStorage.getStore();

/**
 * Binds `signal` as the ambient abort signal for the remainder of the current
 * async execution. Must be called before the first `await` of the request
 * handler so the whole handler chain inherits it.
 */
export const bindRequestAbortSignal = (signal: AbortSignal): void => {
  requestAbortStorage.enterWith(signal);
};

/**
 * Runs `fn` with `signal` as the ambient abort signal, scoped to that call
 * only (unlike bindRequestAbortSignal, it cannot leak into the caller's
 * context).
 */
export const runWithRequestAbortSignal = <T>(signal: AbortSignal, fn: () => T): T =>
  requestAbortStorage.run(signal, fn);

/**
 * Runs `fn` with no ambient abort signal. Use for work whose result outlives
 * the triggering request (shared caches, memoized loads, chained mutations) —
 * otherwise the first requester's disconnect would poison state that later
 * requests depend on.
 */
export const runWithoutRequestAbortSignal = <T>(fn: () => T): T =>
  requestAbortStorage.exit(fn);

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

export const createAbortError = (
  message = "Request aborted: client disconnected",
): Error => Object.assign(new Error(message), { name: "AbortError" });
