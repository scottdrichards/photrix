import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import path from "node:path";
import os from "node:os";
import type { IndexDatabase } from "./indexDatabase.ts";
import { createConversionWorker } from "./conversionWorker.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createMockDatabase = (overrides?: Partial<IndexDatabase>) =>
  ({
    storagePath: path.join(os.tmpdir(), "photrix-conversion-test"),
    resetInProgressConversions: jest.fn(),
    getNextConversionTasks: jest.fn(() => []),
    countPendingConversions: jest.fn(() => ({ thumbnail: 0, hls: 0 })),
    setConversionPriority: jest.fn(),
    getConversionTaskInfo: jest.fn(),
    ...overrides,
  }) as unknown as IndexDatabase;

describe("conversionWorker", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("reports idle status before starting", () => {
    const worker = createConversionWorker();
    const status = worker.getStatus();

    expect(status.active).toBe(false);
    expect(status.background).toEqual({ completed: 0, remaining: 0 });
    expect(status.activeTaskCount).toBe(0);
    expect(status.failures).toBe(0);
  });

  it("completes immediately when no tasks are pending and calls onComplete", async () => {
    const worker = createConversionWorker();
    const database = createMockDatabase();

    let completed = false;
    await worker.startBackgroundLoop(database, () => {
      completed = true;
    });
    await wait(20);

    expect(completed).toBe(true);
    expect(worker.getStatus().active).toBe(false);
  });

  it("resets in-progress conversions on startup", async () => {
    const worker = createConversionWorker();
    const resetFn = jest.fn<() => void>();
    const database = createMockDatabase({
      resetInProgressConversions: resetFn,
    } as unknown as Partial<IndexDatabase>);

    await worker.startBackgroundLoop(database);
    await wait(20);

    expect(resetFn).toHaveBeenCalledWith("thumbnail");
    expect(resetFn).toHaveBeenCalledWith("hls");
  });

  it("submitActive returns the result of the work function", async () => {
    const worker = createConversionWorker();

    const result = await worker.submitActive("test-key", async () => "done");

    expect(result).toBe("done");
  });

  it("submitActive deduplicates concurrent calls with the same key", async () => {
    const worker = createConversionWorker();
    let callCount = 0;

    const work = async () => {
      callCount++;
      await wait(10);
      return "result";
    };

    const [r1, r2] = await Promise.all([
      worker.submitActive("dup-key", work),
      worker.submitActive("dup-key", work),
    ]);

    expect(r1).toBe("result");
    expect(r2).toBe("result");
    expect(callCount).toBe(1);
  });

  it("tracks active task count during submitActive execution", async () => {
    const worker = createConversionWorker();

    let statusDuringWork: ReturnType<typeof worker.getStatus> | undefined;
    await worker.submitActive("track-key", async () => {
      statusDuringWork = worker.getStatus();
      return "ok";
    });

    expect(statusDuringWork?.activeTaskCount).toBe(1);
    expect(worker.getStatus().activeTaskCount).toBe(0);
  });

  it("pause delays background processing", async () => {
    const worker = createConversionWorker();
    let taskReturnCount = 0;
    const database = createMockDatabase({
      getNextConversionTasks: jest.fn(() => {
        taskReturnCount++;
        return [];
      }),
    } as unknown as Partial<IndexDatabase>);

    await worker.startBackgroundLoop(database);
    worker.pause(50);
    const countBefore = taskReturnCount;
    await wait(10);
    // While paused, no new tasks should be fetched
    expect(taskReturnCount).toBe(countBefore);
  });
});
