import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";
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
  jest.resetModules();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const alwaysEnabledOrchestrator: TaskOrchestrator = {
  setProcessBackgroundTasks: () => {},
  getProcessBackgroundTasks: () => true,
  getQueueSummary: () => queueSummaryFixture,
  addTask: () => {},
};

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
      getMostRecentExifProcessedEntry: () => ({
        folder: "/",
        fileName: "img.jpg",
        completedAt: "2026-03-05T00:00:00.000Z",
      }),
    } as unknown as IndexDatabase;

    await statusRequestHandler({} as http.IncomingMessage, res, {
      database,
      stream: false,
      taskOrchestrator: alwaysEnabledOrchestrator,
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
    expect(payload.maintenance.backgroundTasksEnabled).toBe(true);
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

  it("reports exif worker idle when background processing is disabled", async () => {
    const { res, getBody } = createMockResponse();

    const database = {
      getStatusCounts: () => ({
        allEntries: 10,
        mediaEntries: 8,
        missingInfo: 4,
        missingDateTaken: 2,
      }),
      getMostRecentExifProcessedEntry: () => null,
    } as unknown as IndexDatabase;

    const disabledOrchestrator: TaskOrchestrator = {
      ...alwaysEnabledOrchestrator,
      getProcessBackgroundTasks: () => false,
    };

    await statusRequestHandler({} as http.IncomingMessage, res, {
      database,
      stream: false,
      taskOrchestrator: disabledOrchestrator,
    });

    expect(JSON.parse(getBody()).maintenance).toEqual({
      exifActive: false,
      backgroundTasksEnabled: false,
    });
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
      getMostRecentExifProcessedEntry: () => null,
    } as unknown as IndexDatabase;

    statusRequestHandler(req, res, {
      database,
      stream: true,
      taskOrchestrator: alwaysEnabledOrchestrator,
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
      getMostRecentExifProcessedEntry: () => null,
    } as unknown as IndexDatabase;

    statusRequestHandler(req, res, {
      database,
      stream: true,
      taskOrchestrator: alwaysEnabledOrchestrator,
    });

    expect(statusCalls).toHaveLength(1);

    jest.advanceTimersByTime(2_000);
    expect(statusCalls).toHaveLength(1);

    resolveStatus!();
    await flushMicrotasks();
    expect(getWrites()).toHaveLength(1);

    jest.advanceTimersByTime(2_000);
    expect(statusCalls).toHaveLength(2);

    resolveStatus!();
    await flushMicrotasks();
    expect(getWrites()).toHaveLength(2);

    req.emit("close");
  });

  it("starts both background metadata processors under orchestrator control", async () => {
    const processExifMetadata = jest.fn(
      async (_database: unknown, _waitForEnabled: () => Promise<void>) => undefined,
    );
    const startBackgroundProcessFileInfoMetadata = jest.fn(
      async (_database: unknown, _waitForEnabled: () => Promise<void>) => undefined,
    );

    jest.unstable_mockModule("../indexDatabase/processExifMetadata.ts", () => ({
      processExifMetadata,
    }));
    jest.unstable_mockModule("../indexDatabase/processFileInfo.ts", () => ({
      startBackgroundProcessFileInfoMetadata,
    }));

    const { createTaskOrchestrator } = await import(
      "../taskOrchestrator/taskOrchestrator.ts"
    );

    createTaskOrchestrator({
      getNextBackgroundTask: () => new Promise(() => {}),
    } as never);

    expect(processExifMetadata).toHaveBeenCalledTimes(1);
    expect(startBackgroundProcessFileInfoMetadata).toHaveBeenCalledTimes(1);

    const [, waitForExifEnabled] = processExifMetadata.mock.calls[0] ?? [];
    const [, waitForInfoEnabled] =
      startBackgroundProcessFileInfoMetadata.mock.calls[0] ?? [];

    expect(waitForExifEnabled).toEqual(expect.any(Function));
    expect(waitForInfoEnabled).toEqual(expect.any(Function));
  });
});
