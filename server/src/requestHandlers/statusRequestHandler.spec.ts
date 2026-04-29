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

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const alwaysEnabledOrchestrator: TaskOrchestrator = {
  setPerformBackgroundTasks: () => {},
  getPerformBackgroundTasks: () => true,
  addTask: () => {},
  onQueueExhausted: () => {},
};

describe("statusRequestHandler", () => {
  it("returns JSON status payload for non-stream mode", async () => {
    const { res, getBody } = createMockResponse();

    const database = {
      getStatusCounts: () => ({
        allEntries: 10,
        imageEntries: 7,
        videoEntries: 1,
        missingFileMetadata: 4,
        missingMediaMetadata: 5,
        missingThumbnails: 3,
      }),
    } as unknown as IndexDatabase;

    await statusRequestHandler({} as http.IncomingMessage, res, {
      database,
      stream: false,
      taskOrchestrator: alwaysEnabledOrchestrator,
    });

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    const payload = JSON.parse(getBody());
    expect(payload.files).toEqual({ total: 10, images: 7, videos: 1 });
    expect(payload.pending).toEqual({ fileMetadata: 4, mediaMetadata: 5, thumbnails: 3 });
    expect(payload.maintenance.backgroundTasksEnabled).toBe(true);
  });

  it("reports backgroundTasksEnabled false when background processing is disabled", async () => {
    const { res, getBody } = createMockResponse();

    const database = {
      getStatusCounts: () => ({
        allEntries: 10,
        imageEntries: 8,
        videoEntries: 0,
        missingFileMetadata: 4,
        missingMediaMetadata: 2,
        missingThumbnails: 2,
      }),
    } as unknown as IndexDatabase;

    const disabledOrchestrator: TaskOrchestrator = {
      ...alwaysEnabledOrchestrator,
      getPerformBackgroundTasks: () => false,
    };

    await statusRequestHandler({} as http.IncomingMessage, res, {
      database,
      stream: false,
      taskOrchestrator: disabledOrchestrator,
    });

    expect(JSON.parse(getBody()).maintenance).toEqual({
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
        imageEntries: 1,
        videoEntries: 0,
        missingFileMetadata: 0,
        missingMediaMetadata: 0,
        missingThumbnails: 0,
      }),
    } as unknown as IndexDatabase;

    statusRequestHandler(req, res, {
      database,
      stream: true,
      taskOrchestrator: alwaysEnabledOrchestrator,
    });

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    await flushMicrotasks();
    expect(getWrites().length).toBe(1);

    jest.advanceTimersByTime(500);
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
              imageEntries: 1,
              videoEntries: 0,
              missingFileMetadata: 0,
              missingMediaMetadata: 0,
              missingThumbnails: 0,
            });
        });
      },
    } as unknown as IndexDatabase;

    statusRequestHandler(req, res, {
      database,
      stream: true,
      taskOrchestrator: alwaysEnabledOrchestrator,
    });

    expect(statusCalls).toHaveLength(1);

    jest.advanceTimersByTime(500);
    expect(statusCalls).toHaveLength(1);

    resolveStatus!();
    await flushMicrotasks();
    expect(getWrites()).toHaveLength(1);

    jest.advanceTimersByTime(500);
    expect(statusCalls).toHaveLength(2);

    resolveStatus!();
    await flushMicrotasks();
    expect(getWrites()).toHaveLength(2);

    req.emit("close");
  });
});
