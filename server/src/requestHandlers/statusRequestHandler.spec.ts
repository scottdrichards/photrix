import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { setBackgroundTasksEnabled } from "../common/backgroundTasksControl.ts";
import { statusRequestHandler } from "./statusRequestHandler.ts";

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const createMockResponse = () => {
  let body = "";
  const writes: string[] = [];

  const res = {
    writeHead: jest.fn(),
    write: jest.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: jest.fn((chunk?: string) => {
      if (chunk) {
        body += chunk;
      }
      return res as unknown as http.ServerResponse;
    }),
  } as unknown as http.ServerResponse;

  return {
    res,
    getBody: () => body,
    getWrites: () => writes,
  };
};

const queueSummaryFixture = {
  completed: {
    image: { count: 0, sizeBytes: 0 },
    video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
  },
  active: {
    image: { count: 0, sizeBytes: 0 },
    video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
  },
  userBlocked: {
    image: { count: 0, sizeBytes: 0 },
    video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
  },
  userImplicit: {
    image: { count: 0, sizeBytes: 0 },
    video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
  },
  background: {
    image: { count: 0, sizeBytes: 0 },
    video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
  },
};

afterEach(() => {
  jest.useRealTimers();
  setBackgroundTasksEnabled(true);
});

describe("statusRequestHandler", () => {
  it("returns JSON status payload for non-stream mode", async () => {
    const { res, getBody } = createMockResponse();

    const database = {
      getStatusCounts: () => ({
        allEntries: 10,
        mediaEntries: 8,
        missingInfo: 4,
        missingDateTaken: 2,
      }),
      countImageEntries: () => 6,
      getConversionQueueCounts: () => ({ pending: 0, processing: 0 }),
      getConversionQueueSummary: () => queueSummaryFixture,
      getMostRecentExifProcessedEntry: () => ({
        folder: "/",
        fileName: "img.jpg",
        completedAt: "2026-03-05T00:00:00.000Z",
      }),
    } as unknown as IndexDatabase;

    await statusRequestHandler({} as http.IncomingMessage, res, {
      database,
      stream: false,
    });

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    const payload = JSON.parse(getBody());
    expect(payload.databaseSize).toBe(10);
    expect(payload.pending).toEqual({ info: 4, exif: 2 });
    expect(payload.progress.info).toEqual({ completed: 6, total: 10, percent: 0.6 });
    expect(payload.progress.exif).toEqual({ completed: 6, total: 8, percent: 0.75 });
    expect(payload.progress.overall).toEqual({
      completed: 12,
      total: 18,
      percent: 12 / 18,
    });
    expect(payload.recent.exif.fileName).toBe("img.jpg");
    expect(payload.maintenance.faceActive).toBe(false);
    expect(payload.maintenance.backgroundTasksEnabled).toBe(true);
    expect(payload.faceProcessing).toEqual({
      processed: 0,
      workerSuccess: 0,
      fallbackCount: 0,
      workerFailures: 0,
    });
    expect(payload.queueSummary).toBeDefined();
    expect(payload.queueSummary).toEqual(
      expect.objectContaining({
        completed: expect.any(Object),
        active: expect.any(Object),
        userBlocked: expect.any(Object),
        userImplicit: expect.any(Object),
        background: expect.any(Object),
      }),
    );
  });

  it("streams SSE updates and closes on request close", async () => {
    jest.useFakeTimers();

    const req = new EventEmitter() as http.IncomingMessage;
    const { res, getWrites } = createMockResponse();

    const database = {
      getStatusCounts: () => ({
        allEntries: 1,
        mediaEntries: 1,
        missingInfo: 0,
        missingDateTaken: 0,
      }),
      countImageEntries: () => 1,
      getConversionQueueCounts: () => ({ pending: 0, processing: 0 }),
      getConversionQueueSummary: () => queueSummaryFixture,
      getMostRecentExifProcessedEntry: () => null,
    } as unknown as IndexDatabase;

    statusRequestHandler(req, res, {
      database,
      stream: true,
    });

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    await flushMicrotasks();
    expect(getWrites().length).toBe(1);

    jest.advanceTimersByTime(2000);
    await flushMicrotasks();
    expect(getWrites().length).toBe(2);
    expect(getWrites()[0]?.startsWith("data: ")).toBe(true);

    req.emit("close");
    expect(res.end).toHaveBeenCalled();
  });

  it("skips overlapping stream updates when previous is still in flight", async () => {
    jest.useFakeTimers();

    const req = new EventEmitter() as http.IncomingMessage;
    const { res, getWrites } = createMockResponse();

    let resolveStatus: (() => void) | undefined;
    const statusCalls: number[] = [];

    const database = {
      getStatusCounts: () => {
        statusCalls.push(Date.now());
        return new Promise((resolve) => {
          resolveStatus = () =>
            resolve({
              allEntries: 1,
              mediaEntries: 1,
              missingInfo: 0,
              missingDateTaken: 0,
            });
        });
      },
      countImageEntries: () => 1,
      getConversionQueueCounts: () => ({ pending: 0, processing: 0 }),
      getConversionQueueSummary: () => queueSummaryFixture,
      getMostRecentExifProcessedEntry: () => null,
    } as unknown as IndexDatabase;

    statusRequestHandler(req, res, { database, stream: true });

    // First sendUpdate is in flight (getStatusCounts hasn't resolved)
    expect(statusCalls).toHaveLength(1);

    // Advance past the interval — should NOT start another update
    jest.advanceTimersByTime(2_000);
    expect(statusCalls).toHaveLength(1);

    // Resolve the first call and flush microtasks
    resolveStatus!();
    await flushMicrotasks();
    expect(getWrites()).toHaveLength(1);

    // Now the next interval tick should start a new update
    jest.advanceTimersByTime(2_000);
    expect(statusCalls).toHaveLength(2);

    resolveStatus!();
    await flushMicrotasks();
    expect(getWrites()).toHaveLength(2);

    req.emit("close");
  });
});
