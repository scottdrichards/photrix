import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { ProcessingQueue } from "./processingQueue.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

afterEach(() => {
  jest.useRealTimers();
});

describe("ProcessingQueue", () => {
  it("uses LIFO order for queued userBlocked tasks within same bucket", async () => {
    const queue = new ProcessingQueue(1);
    const order: string[] = [];
    const blocker = deferred<void>();

    const firstPromise = queue.enqueue({
      fn: async () => {
        order.push("first");
        await blocker.promise;
      },
      priority: "userBlocked",
      mediaType: "video",
      sizeBytes: 10,
      durationMilliseconds: 100,
    });

    const secondPromise = queue.enqueue({
      fn: async () => {
        order.push("second");
      },
      priority: "userBlocked",
      mediaType: "video",
      sizeBytes: 10,
      durationMilliseconds: 100,
    });

    const thirdPromise = queue.enqueue({
      fn: async () => {
        order.push("third");
      },
      priority: "userBlocked",
      mediaType: "video",
      sizeBytes: 10,
      durationMilliseconds: 100,
    });

    await wait(10);
    blocker.resolve();

    await Promise.all([firstPromise, secondPromise, thirdPromise]);
    expect(order).toEqual(["first", "third", "second"]);
  });

  it("prioritizes background image tasks over background video tasks", async () => {
    const queue = new ProcessingQueue(1);
    const order: string[] = [];
    const blocker = deferred<void>();

    const blockingTask = queue.enqueue({
      fn: async () => {
        order.push("blocker");
        await blocker.promise;
      },
      priority: "userBlocked",
      mediaType: "image",
      sizeBytes: 10,
    });

    const backgroundVideo = queue.enqueue({
      fn: async () => {
        order.push("video");
      },
      priority: "background",
      mediaType: "video",
      sizeBytes: 10,
      durationMilliseconds: 100,
    });

    const backgroundImage = queue.enqueue({
      fn: async () => {
        order.push("image");
      },
      priority: "background",
      mediaType: "image",
      sizeBytes: 10,
    });

    await wait(10);
    blocker.resolve();

    await Promise.all([blockingTask, backgroundVideo, backgroundImage]);
    expect(order).toEqual(["blocker", "image", "video"]);
  });

  it("reports queue size and processing counts", async () => {
    const queue = new ProcessingQueue(1);
    const blocker = deferred<void>();

    const firstTask = queue.enqueue({
      fn: async () => {
        await blocker.promise;
      },
      priority: "userBlocked",
      mediaType: "image",
      sizeBytes: 10,
    });

    const secondTask = queue.enqueue({
      fn: async () => undefined,
      priority: "background",
      mediaType: "video",
      sizeBytes: 10,
      durationMilliseconds: 120_000,
    });

    await wait(5);
    expect(queue.getProcessing()).toBe(1);
    expect(queue.getQueueSize()).toBe(1);

    blocker.resolve();
    await wait(10);

    await Promise.all([firstTask, secondTask]);

    expect(queue.getProcessing()).toBe(0);
    expect(queue.getQueueSize()).toBe(0);
  });
});
