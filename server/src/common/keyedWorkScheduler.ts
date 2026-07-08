type PendingEntry<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

type WorkEntry<T> = {
  key: string;
  work: (signal: AbortSignal) => Promise<T>;
  waiters: PendingEntry<T>[];
  controller: AbortController;
  state: "queued" | "running";
};

const createAbortError = () =>
  Object.assign(new Error("Request aborted: client disconnected"), {
    name: "AbortError",
  });

export const createKeyedWorkScheduler = (maxConcurrent: number) => {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`maxConcurrent must be a positive integer, got ${maxConcurrent}`);
  }

  let activeCount = 0;
  const workByKey = new Map<string, WorkEntry<unknown>>();
  const pendingStack: WorkEntry<unknown>[] = [];

  const removeWaiter = <T>(entry: WorkEntry<T>, waiter: PendingEntry<T>, error: unknown) => {
    const index = entry.waiters.indexOf(waiter);
    if (index === -1) {
      return;
    }

    entry.waiters.splice(index, 1);
    waiter.cleanup();
    waiter.reject(error);

    if (entry.waiters.length > 0) {
      return;
    }

    if (workByKey.get(entry.key) === entry) {
      workByKey.delete(entry.key);
    }

    if (entry.state === "running") {
      entry.controller.abort();
    }
  };

  const addWaiter = <T>(entry: WorkEntry<T>, signal?: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }

      const waiter: PendingEntry<T> = {
        resolve: (value) => {
          waiter.cleanup();
          resolve(value);
        },
        reject: (error) => {
          waiter.cleanup();
          reject(error);
        },
        cleanup: () => {},
      };

      if (signal) {
        const onAbort = () => {
          removeWaiter(entry, waiter, createAbortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }

      entry.waiters.push(waiter);
    });

  const startPendingWork = () => {
    while (activeCount < maxConcurrent && pendingStack.length > 0) {
      const next = pendingStack.pop();
      if (!next || workByKey.get(next.key) !== next || next.waiters.length === 0) {
        continue;
      }

      activeCount++;
      next.state = "running";

      void next.work(next.controller.signal).then(
        (result) => {
          const waiters = next.waiters as PendingEntry<typeof result>[];
          if (workByKey.get(next.key) === next) {
            workByKey.delete(next.key);
          }
          activeCount--;
          startPendingWork();
          waiters.forEach((waiter) => waiter.resolve(result));
        },
        (error) => {
          const waiters = next.waiters;
          if (workByKey.get(next.key) === next) {
            workByKey.delete(next.key);
          }
          activeCount--;
          startPendingWork();
          waiters.forEach((waiter) => waiter.reject(error));
        },
      );
    }
  };

  return {
    schedule: <T>(
      key: string,
      work: (signal: AbortSignal) => Promise<T>,
      options: { signal?: AbortSignal } = {},
    ): Promise<T> => {
      if (options.signal?.aborted) {
        return Promise.reject(createAbortError());
      }

      const existing = workByKey.get(key);
      if (existing) {
        return addWaiter(existing as WorkEntry<T>, options.signal);
      }

      const entry: WorkEntry<T> = {
        key,
        work,
        waiters: [],
        controller: new AbortController(),
        state: "queued",
      };
      workByKey.set(key, entry as WorkEntry<unknown>);
      pendingStack.push(entry as WorkEntry<unknown>);
      const promise = addWaiter(entry, options.signal);
      startPendingWork();
      return promise;
    },
  };
};
