import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { ProcessingQueue } from "./processingQueue.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

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
  it("runs high-priority tasks while paused background waits", async () => {
    jest.useFakeTimers();
    const queue = new ProcessingQueue(1);
    const events: string[] = [];

    queue.pause(80);
    const backgroundPromise = queue.enqueue(async () => {
      events.push("background");
    }, "background");

    await flushMicrotasks();
    expect(events).toEqual([]);

    const highPriorityPromise = queue.enqueue(async () => {
      events.push("userBlocked");
    }, "userBlocked");
    await flushMicrotasks();
    await highPriorityPromise;

    expect(events).toEqual(["userBlocked"]);

    jest.advanceTimersByTime(100);
    await flushMicrotasks();
    await backgroundPromise;
    expect(events).toEqual(["userBlocked", "background"]);
  });

  it("uses LIFO order for queued userBlocked tasks within same bucket", async () => {
    const queue = new ProcessingQueue(1);
    const order: string[] = [];
    const blocker = deferred<void>();

    const firstPromise = queue.enqueue(async () => {
      order.push("first");
      await blocker.promise;
    }, "userBlocked", "video");

    const secondPromise = queue.enqueue(async () => {
      order.push("second");
    }, "userBlocked", "video");

    const thirdPromise = queue.enqueue(async () => {
      order.push("third");
    }, "userBlocked", "video");

    await wait(10);
    blocker.resolve();

    await Promise.all([firstPromise, secondPromise, thirdPromise]);
    expect(order).toEqual(["first", "third", "second"]);
  });

  it("prioritizes background image tasks over background video tasks", async () => {
    const queue = new ProcessingQueue(1);
    const order: string[] = [];
    const blocker = deferred<void>();

    const blockingTask = queue.enqueue(async () => {
      order.push("blocker");
      await blocker.promise;
    }, "userBlocked", "image");

    const backgroundVideo = queue.enqueue(async () => {
      order.push("video");
    }, "background", "video");

    const backgroundImage = queue.enqueue(async () => {
      order.push("image");
    }, "background", "image");

    await wait(10);
    blocker.resolve();

    await Promise.all([blockingTask, backgroundVideo, backgroundImage]);
    expect(order).toEqual(["blocker", "image", "video"]);
  });

  it("tracks conversion status totals and remaining counts", async () => {
    const queue = new ProcessingQueue(1);
    const imageGate = deferred<void>();
    const videoGate = deferred<void>();

    const imageTask = queue.enqueue(async () => {
      await imageGate.promise;
    }, "background", "image");

    const videoTask = queue.enqueue(async () => {
      await videoGate.promise;
    }, "background", "video", { videoSeconds: 120 });

    const during = queue.getConversionStatus();
    expect(during.overall.images.total).toBe(1);
    expect(during.overall.videoSeconds.total).toBe(120);
    expect(during.overall.images.remaining).toBe(1);
    expect(during.overall.videoSeconds.remaining).toBe(120);

    imageGate.resolve();
    await wait(10);
    videoGate.resolve();

    await Promise.all([imageTask, videoTask]);

    const done = queue.getConversionStatus();
    expect(done.overall.images.remaining).toBe(0);
    expect(done.overall.videoSeconds.remaining).toBe(0);
    expect(done.overall.images.total).toBe(1);
    expect(done.overall.videoSeconds.total).toBe(120);
  });
});
