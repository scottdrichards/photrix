import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";

const mockGetSystemMetrics = jest.fn(() => ({
  cpu: { usage: 25, cores: 4 },
  memory: { used: 4000000000, total: 16000000000, usage: 25 },
}));

jest.unstable_mockModule("../observability/systemMetrics.ts", () => ({
  getSystemMetrics: mockGetSystemMetrics,
}));

const { statusRequestHandler } = await import("./statusRequestHandler.ts");

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
    // The SSE stream path registers a `res.on("error", …)` listener; the stream
    // tests drive lifecycle via `req` events, so a no-op listener is enough.
    on: jest.fn(),
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
  getBackgroundTaskStatus: async () => [],
  addTask: () => {},
  onQueueExhausted: () => {},
  noteUserActivity: () => {},
};

describe("statusRequestHandler", () => {
  it("returns JSON status payload for non-stream mode", async () => {
    const { res, getBody } = createMockResponse();

    const taskOrchestrator: TaskOrchestrator = {
      ...alwaysEnabledOrchestrator,
      getBackgroundTaskStatus: async () => [
        {
          id: "background:file-scan",
          name: "File system scan",
          queue: "background",
          state: "running",
          itemsProcessed: 33,
          total: 100,
          portionComplete: 0.33,
        },
      ],
    };

    await statusRequestHandler({} as http.IncomingMessage, res, {
      stream: false,
      taskOrchestrator,
    });

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    const payload = JSON.parse(getBody());
    expect(payload.backgroundTasks).toEqual([
      {
        id: "background:file-scan",
        name: "File system scan",
        queue: "background",
        state: "running",
        itemsProcessed: 33,
        total: 100,
        portionComplete: 0.33,
      },
    ]);
    expect(payload.maintenance.backgroundTasksEnabled).toBe(true);
    expect(payload.system).toEqual({
      cpu: { usage: 25, cores: 4 },
      memory: { used: 4000000000, total: 16000000000, usage: 25 },
    });
  });

  it("reports backgroundTasksEnabled false when background processing is disabled", async () => {
    const { res, getBody } = createMockResponse();

    const disabledOrchestrator: TaskOrchestrator = {
      ...alwaysEnabledOrchestrator,
      getPerformBackgroundTasks: () => false,
    };

    await statusRequestHandler({} as http.IncomingMessage, res, {
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

    statusRequestHandler(req, res, {
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

    const taskOrchestrator: TaskOrchestrator = {
      ...alwaysEnabledOrchestrator,
      getBackgroundTaskStatus: () => {
        statusCalls.push(Date.now());
        return new Promise((resolve) => {
          resolveStatus = () => resolve([]);
        });
      },
    };

    statusRequestHandler(req, res, {
      stream: true,
      taskOrchestrator,
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
