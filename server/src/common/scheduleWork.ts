type PendingEntry<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const pendingWorkByKey = new Map<string, PendingEntry<unknown>[]>();

/**
 * Schedules work by key. If work is already scheduled for the same key, it adds to the list of waiters for that work
 */
export const scheduleWork = <T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> => {
  const existing = pendingWorkByKey.get(key);
  if (existing) {
    return new Promise<T>((resolve, reject) => {
      (existing as PendingEntry<T>[]).push({ resolve, reject });
    });
  }

  return new Promise<T>((resolve, reject) => {
    pendingWorkByKey.set(key, [{ resolve, reject }] as PendingEntry<unknown>[]);
    // Detach the waiter list and clear the key *before* settling them. Otherwise
    // a caller that arrives in the microtask window between settling and cleanup
    // would attach to a batch that has already fired and hang forever; clearing
    // first makes such a caller schedule fresh work instead.
    work()
      .then((result) => {
        const waiters = pendingWorkByKey.get(key) as PendingEntry<T>[];
        pendingWorkByKey.delete(key);
        waiters.forEach((waiter) => waiter.resolve(result));
      })
      .catch((error) => {
        const waiters = pendingWorkByKey.get(key) as PendingEntry<unknown>[];
        pendingWorkByKey.delete(key);
        waiters.forEach((waiter) => waiter.reject(error));
      });
  });
};
