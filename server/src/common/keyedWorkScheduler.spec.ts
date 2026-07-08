import { describe, expect, it } from "@jest/globals";
import { createKeyedWorkScheduler } from "./keyedWorkScheduler.ts";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("createKeyedWorkScheduler", () => {
  it("runs queued work in LIFO order", async () => {
    const scheduler = createKeyedWorkScheduler(1);
    const started: string[] = [];
    const a = deferred<string>();
    const b = deferred<string>();
    const c = deferred<string>();

    const taskA = scheduler.schedule("a", async () => {
      started.push("a");
      return await a.promise;
    });
    const taskB = scheduler.schedule("b", async () => {
      started.push("b");
      return await b.promise;
    });
    const taskC = scheduler.schedule("c", async () => {
      started.push("c");
      return await c.promise;
    });

    expect(started).toEqual(["a"]);

    a.resolve("A");
    await expect(taskA).resolves.toBe("A");
    expect(started).toEqual(["a", "c"]);

    c.resolve("C");
    await expect(taskC).resolves.toBe("C");
    expect(started).toEqual(["a", "c", "b"]);

    b.resolve("B");
    await expect(taskB).resolves.toBe("B");
  });

  it("caps concurrent work and coalesces duplicate keys", async () => {
    const scheduler = createKeyedWorkScheduler(2);
    const releases = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started: string[] = [];
    let active = 0;
    let peakActive = 0;
    let callCount = 0;

    const scheduleTask = (key: string, gateIndex: number) =>
      scheduler.schedule(key, async () => {
        callCount++;
        started.push(key);
        active++;
        peakActive = Math.max(peakActive, active);
        try {
          return await releases[gateIndex].promise;
        } finally {
          active--;
        }
      });

    const first = scheduleTask("one", 0);
    const second = scheduleTask("two", 1);
    const duplicateSecond = scheduleTask("two", 2);
    const third = scheduleTask("three", 2);

    expect(started).toEqual(["one", "two"]);
    expect(peakActive).toBe(2);
    expect(callCount).toBe(2);

    releases[1].resolve("two");
    await expect(second).resolves.toBe("two");
    await expect(duplicateSecond).resolves.toBe("two");
    expect(started[1]).toBe("two");
    expect(started).toEqual(["one", "two", "three"]);

    releases[2].resolve("three");
    releases[0].resolve("one");
    await expect(third).resolves.toBe("three");
    await expect(first).resolves.toBe("one");
    expect(peakActive).toBe(2);
  });

  it("drops queued work when its only waiter aborts before start", async () => {
    const scheduler = createKeyedWorkScheduler(1);
    const running = deferred<string>();
    const started: string[] = [];

    const first = scheduler.schedule("first", async () => {
      started.push("first");
      return await running.promise;
    });

    const queuedAbort = new AbortController();
    const queued = scheduler.schedule(
      "queued",
      async () => {
        started.push("queued");
        return "queued";
      },
      { signal: queuedAbort.signal },
    );

    queuedAbort.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    running.resolve("done");
    await expect(first).resolves.toBe("done");
    expect(started).toEqual(["first"]);
  });

  it("aborts running work only after the last waiter disconnects", async () => {
    const scheduler = createKeyedWorkScheduler(1);
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const workFinished = deferred<void>();
    let workerSignal: AbortSignal | null = null;

    const first = scheduler.schedule(
      "shared",
      async (signal) => {
        workerSignal = signal;
        await workFinished.promise;
        return "shared-result";
      },
      { signal: firstAbort.signal },
    );
    const second = scheduler.schedule(
      "shared",
      async () => "unreachable",
      { signal: secondAbort.signal },
    );

    expect(workerSignal?.aborted).toBe(false);

    firstAbort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(workerSignal?.aborted).toBe(false);

    secondAbort.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(workerSignal?.aborted).toBe(true);

    workFinished.reject(new Error("stopped"));
  });
});
