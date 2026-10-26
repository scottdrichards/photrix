import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type http from "node:http";
import { EventEmitter } from "node:events";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { feedbackHandler } from "./feedbackHandler.ts";

const createMockReq = (
  method: string,
  url: string,
  body?: unknown,
): http.IncomingMessage & { url: string } => {
  const req = new EventEmitter() as unknown as http.IncomingMessage & { url: string };
  req.method = method;
  req.url = url;
  queueMicrotask(() => {
    if (body !== undefined) {
      req.emit("data", Buffer.from(JSON.stringify(body)));
    }
    req.emit("end");
  });
  return req;
};

const createMockRes = () => {
  let statusCode = 0;
  let body = "";
  const res = {
    writeHead: jest.fn((code: number) => {
      statusCode = code;
    }),
    end: jest.fn((chunk?: string) => {
      if (chunk) body += chunk;
    }),
  } as unknown as http.ServerResponse;
  return {
    res,
    getStatus: () => statusCode,
    getJson: () => JSON.parse(body) as unknown,
  };
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe("feedbackHandler", () => {
  it("inserts a plain (non-external) submission when not marked external", async () => {
    const run = jest.fn(async () => ({ changes: 1 }));
    const database = { asyncSqlite: { run, all: jest.fn() } } as unknown as IndexDatabase;
    const { res, getStatus, getJson } = createMockRes();

    await feedbackHandler(
      createMockReq("POST", "/api/feedback", { text: "make it faster" }),
      res,
      database,
    );

    expect(getStatus()).toBe(200);
    expect(getJson()).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    const [sql, params] = run.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO feedback");
    expect(sql).toContain("source");
    expect(params).toEqual(["make it faster", expect.any(Number), null, null]);
  });

  it("tags a submission as external when markExternal is set (feedback #99)", async () => {
    const run = jest.fn(async () => ({ changes: 1 }));
    const database = { asyncSqlite: { run, all: jest.fn() } } as unknown as IndexDatabase;
    const { res, getStatus } = createMockRes();

    await feedbackHandler(
      createMockReq("POST", "/api/feedback", { text: "found via a shared link" }),
      res,
      database,
      { markExternal: true },
    );

    expect(getStatus()).toBe(200);
    const [, params] = run.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([
      "found via a shared link",
      expect.any(Number),
      "external",
      null,
    ]);
  });

  it("rejects an empty submission without touching the database", async () => {
    const run = jest.fn(async () => ({ changes: 1 }));
    const database = { asyncSqlite: { run, all: jest.fn() } } as unknown as IndexDatabase;
    const { res, getStatus } = createMockRes();

    await feedbackHandler(
      createMockReq("POST", "/api/feedback", { text: "   " }),
      res,
      database,
    );

    expect(getStatus()).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("includes source in the listed rows", async () => {
    const all = jest.fn(async () => [
      {
        id: 1,
        text: "hi",
        createdAt: 1,
        claimedAt: null,
        claimedBy: null,
        completedAt: null,
        source: "external",
        hasDiagnostics: 1,
      },
    ]);
    const database = { asyncSqlite: { run: jest.fn(), all } } as unknown as IndexDatabase;
    const { res, getJson } = createMockRes();

    await feedbackHandler(createMockReq("GET", "/api/feedback"), res, database);

    expect((all.mock.calls[0] as [string])[0]).toContain("source");
    expect(getJson()).toEqual({
      feedback: [
        {
          id: 1,
          text: "hi",
          createdAt: 1,
          claimedAt: null,
          claimedBy: null,
          completedAt: null,
          source: "external",
          hasDiagnostics: true,
          status: "open",
        },
      ],
    });
  });

  it("saves a diagnostics report for the submitting browser session so it can be reproduced", async () => {
    const run = jest.fn(async () => ({ changes: 1 }));
    const database = { asyncSqlite: { run, all: jest.fn() } } as unknown as IndexDatabase;
    const buildDiagnosticsReport = jest.fn(async (clientSessionId: string) => ({
      clientSessionId,
      events: [{ event: "video.playback.summary" }],
    }));

    await feedbackHandler(
      createMockReq("POST", "/api/feedback", {
        text: "video froze",
        clientSessionId: "s-1",
      }),
      createMockRes().res,
      database,
      { buildDiagnosticsReport },
    );

    expect(buildDiagnosticsReport).toHaveBeenCalledWith("s-1");
    const [, params] = run.mock.calls[0] as [string, unknown[]];
    expect(JSON.parse(params[3] as string)).toEqual({
      clientSessionId: "s-1",
      events: [{ event: "video.playback.summary" }],
    });
  });

  it("serves a suggestion's saved diagnostics report", async () => {
    const get = jest.fn(async () => ({ diagnostics: JSON.stringify({ events: [] }) }));
    const database = {
      asyncSqlite: { run: jest.fn(), all: jest.fn(), get },
    } as unknown as IndexDatabase;
    const { res, getStatus, getJson } = createMockRes();

    await feedbackHandler(
      createMockReq("GET", "/api/feedback/7/diagnostics"),
      res,
      database,
    );

    expect(getStatus()).toBe(200);
    expect(getJson()).toEqual({ events: [] });
    expect((get.mock.calls[0] as unknown[])[1]).toEqual([7]);
  });

  it("404s a suggestion with no saved diagnostics", async () => {
    const get = jest.fn(async () => ({ diagnostics: null }));
    const database = {
      asyncSqlite: { run: jest.fn(), all: jest.fn(), get },
    } as unknown as IndexDatabase;
    const { res, getStatus } = createMockRes();

    await feedbackHandler(
      createMockReq("GET", "/api/feedback/7/diagnostics"),
      res,
      database,
    );

    expect(getStatus()).toBe(404);
  });
});
