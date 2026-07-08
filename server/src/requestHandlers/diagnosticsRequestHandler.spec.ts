import { afterEach, describe, expect, it } from "@jest/globals";
import type http from "node:http";
import { clearDiagnosticsEvents } from "../observability/diagnosticsStore.ts";
import { diagnosticsEventsRequestHandler } from "./diagnosticsRequestHandler.ts";

const createMockRequest = (options: {
  method: "GET" | "POST";
  url: string;
  body?: string;
  headers?: Record<string, string>;
}) => {
  async function* bodyGenerator() {
    if (options.body) {
      yield Buffer.from(options.body);
    }
  }

  return {
    method: options.method,
    url: options.url,
    headers: { host: "localhost", ...(options.headers ?? {}) },
    [Symbol.asyncIterator]: bodyGenerator,
  } as unknown as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>;
};

const createMockResponse = () => {
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    writeHead: (statusCode: number, outgoingHeaders?: Record<string, string>) => {
      res.statusCode = statusCode;
      Object.assign(headers, outgoingHeaders ?? {});
      return res as unknown as http.ServerResponse;
    },
    end: (chunk?: string) => {
      if (chunk) {
        body += chunk;
      }
      return res as unknown as http.ServerResponse;
    },
    statusCode: 0,
  } as unknown as http.ServerResponse & { statusCode: number };

  return {
    res,
    getBody: () => body,
    getHeaders: () => headers,
  };
};

afterEach(() => {
  clearDiagnosticsEvents();
});

describe("diagnosticsEventsRequestHandler", () => {
  it("accepts client diagnostics events", async () => {
    const req = createMockRequest({
      method: "POST",
      url: "/api/diagnostics/events",
      body: JSON.stringify({
        events: [
          {
            event: "video.element.waiting",
            level: "warn",
            clientSessionId: "session-1",
            clientOperationId: "op-1",
            data: { path: "clip.mp4" },
          },
        ],
      }),
    });
    const { res, getBody } = createMockResponse();

    await diagnosticsEventsRequestHandler(req, res);

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(getBody())).toEqual({ accepted: 1 });
  });

  it("lists filtered diagnostics events", async () => {
    const firstReq = createMockRequest({
      method: "POST",
      url: "/api/diagnostics/events",
      body: JSON.stringify({
        events: [
          {
            event: "video.negotiation.completed",
            clientSessionId: "session-1",
            clientOperationId: "op-1",
          },
          {
            event: "video.element.stalled",
            clientSessionId: "session-2",
            clientOperationId: "op-2",
          },
        ],
      }),
    });
    await diagnosticsEventsRequestHandler(firstReq, createMockResponse().res);

    const listReq = createMockRequest({
      method: "GET",
      url: "/api/diagnostics/events?clientSessionId=session-1",
    });
    const { res, getBody } = createMockResponse();

    await diagnosticsEventsRequestHandler(listReq, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(getBody())).toEqual({
      events: [expect.objectContaining({ event: "video.negotiation.completed" })],
    });
  });
});
