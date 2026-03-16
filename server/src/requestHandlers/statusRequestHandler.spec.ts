import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { setBackgroundTasksEnabled } from "../common/backgroundTasksControl.ts";
import { statusRequestHandler } from "./statusRequestHandler.ts";

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
  jest.useRealTimers();
  setBackgroundTasksEnabled(true);
});

describe("statusRequestHandler", () => {
  it("returns JSON status payload for non-stream mode", () => {
    const { res, getBody } = createMockResponse();

    const database = {
      countAllEntries: () => 10,
      countMediaEntries: () => 8,
      countImageEntries: () => 6,
      countMissingInfo: () => 4,
      countMissingDateTaken: () => 2,
      getMostRecentExifProcessedEntry: () => ({
        folder: "/",
        fileName: "img.jpg",
        completedAt: "2026-03-05T00:00:00.000Z",
      }),
    } as unknown as IndexDatabase;

    statusRequestHandler({} as http.IncomingMessage, res, {
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
  });

  it("streams SSE updates and closes on request close", () => {
    jest.useFakeTimers();

    const req = new EventEmitter() as http.IncomingMessage;
    const { res, getWrites } = createMockResponse();

    const database = {
      countAllEntries: () => 1,
      countMediaEntries: () => 1,
      countImageEntries: () => 1,
      countMissingInfo: () => 0,
      countMissingDateTaken: () => 0,
      getMostRecentExifProcessedEntry: () => null,
    } as unknown as IndexDatabase;

    statusRequestHandler(req, res, {
      database,
      stream: true,
    });

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(getWrites().length).toBe(1);

    jest.advanceTimersByTime(2000);
    expect(getWrites().length).toBe(2);
    expect(getWrites()[0]?.startsWith("data: ")).toBe(true);

    req.emit("close");
    expect(res.end).toHaveBeenCalled();
  });
});
