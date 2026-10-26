import { afterEach, describe, expect, it } from "@jest/globals";
import type http from "node:http";
import {
  clearDiagnosticsEvents,
  recordClientDiagnosticEvent,
  recordServerDiagnosticEvent,
} from "../observability/diagnosticsStore.ts";
import { diagnosticsReportRequestHandler } from "./diagnosticsReportRequestHandler.ts";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";

const taskOrchestrator = {
  getDiagnosticsSnapshot: () => ({
    queueLengths: { blocking: 1, implied: 0, background: 7 },
  }),
} as unknown as TaskOrchestrator;

const get = async (url: string) => {
  let body = "";
  const res = {
    statusCode: 0,
    writeHead(statusCode: number) {
      res.statusCode = statusCode;
      return res;
    },
    end(chunk?: string) {
      body += chunk ?? "";
      return res;
    },
  };
  await diagnosticsReportRequestHandler(
    {
      method: "GET",
      url,
      headers: { host: "localhost" },
    } as unknown as http.IncomingMessage & {
      url: string;
    },
    res as unknown as http.ServerResponse,
    taskOrchestrator,
  );
  return { status: res.statusCode, json: JSON.parse(body) };
};

afterEach(() => clearDiagnosticsEvents());

describe("diagnostics report", () => {
  it("bundles one session's timeline with server-wide events and server state", async () => {
    recordClientDiagnosticEvent({ level: "info", event: "mine", clientSessionId: "A" });
    recordClientDiagnosticEvent({
      level: "info",
      event: "someone-else",
      clientSessionId: "B",
    });
    recordServerDiagnosticEvent({ level: "warn", event: "server.eventloop.stall" });

    const { status, json } = await get("/api/diagnostics/report?clientSessionId=A");

    expect(status).toBe(200);
    expect(json.events.map((e: { event: string }) => e.event)).toEqual([
      "mine",
      "server.eventloop.stall",
    ]);
    expect(json.tasks.queueLengths.background).toBe(7);
    expect(json.perf.routes).toEqual(expect.any(Array));
    expect(json.server.node).toBe(process.version);
  });

  it("serves the live perf snapshot on its own", async () => {
    const { status, json } = await get("/api/diagnostics/perf");

    expect(status).toBe(200);
    expect(json).toHaveProperty("eventLoop");
    expect(json).toHaveProperty("inFlight");
  });
});
