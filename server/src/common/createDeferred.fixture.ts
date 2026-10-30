/**
 * A promise plus the functions that settle it, so a test can decide exactly
 * when a mocked async dependency finishes. (`Promise.withResolvers` once the
 * runtime is Node 22.)
 */
export const createDeferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
