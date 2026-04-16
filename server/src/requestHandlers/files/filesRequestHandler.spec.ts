import { describe, expect, it, jest } from "@jest/globals";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import { filesEndpointRequestHandler } from "./filesRequestHandler.ts";
import { createConversionWorker } from "../../indexDatabase/conversionWorker.ts";

const createMockResponse = () => {
  let body = "";

  const res = {
    headersSent: false,
    writeHead: jest.fn(() => {
      (res as { headersSent: boolean }).headersSent = true;
      return res as unknown as http.ServerResponse;
    }),
    end: jest.fn((chunk?: string) => {
      if (chunk) {
        body += chunk;
      }
      return res as unknown as http.ServerResponse;
    }),
    write: jest.fn(() => true),
  } as unknown as http.ServerResponse;

  return {
    res,
    getBody: () => body,
  };
};

describe("filesEndpointRequestHandler", () => {
  it("returns 400 when URL does not match files route", async () => {
    const { res, getBody } = createMockResponse();

    await filesEndpointRequestHandler(
      {
        url: "/api/nope",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {} as IndexDatabase,
        storageRoot: os.tmpdir(),
        conversionWorker: createConversionWorker(),
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(400);
    expect(JSON.parse(getBody())).toEqual({ error: "Bad request" });
  });

  it("returns query results for trailing slash endpoint", async () => {
    const { res, getBody } = createMockResponse();
    const queryFiles = jest.fn(async () => ({
      items: [{ folder: "/", fileName: "root.jpg" }],
      total: 1,
      page: 1,
      pageSize: 1000,
    }));
    const raiseConversionPriority = jest.fn();

    await filesEndpointRequestHandler(
      {
        url: "/api/files/",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: { queryFiles, raiseConversionPriority } as unknown as IndexDatabase,
        storageRoot: os.tmpdir(),
        conversionWorker: createConversionWorker(),
      },
    );

    expect(queryFiles).toHaveBeenCalled();
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({
      items: [{ folder: "/", fileName: "root.jpg" }],
      total: 1,
      page: 1,
      pageSize: 1000,
    });
  });

  it("returns 403 for path traversal attempt", async () => {
    const { res, getBody } = createMockResponse();
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-root-"));

    await filesEndpointRequestHandler(
      {
        url: "/api/files/..%2F..%2Fetc%2Fpasswd",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {} as IndexDatabase,
        storageRoot,
        conversionWorker: createConversionWorker(),
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(403);
    expect(JSON.parse(getBody())).toEqual({ error: "Access denied" });
  });

  it("returns 404 when requested file does not exist", async () => {
    const { res, getBody } = createMockResponse();
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-root-"));

    await filesEndpointRequestHandler(
      {
        url: "/api/files/missing.jpg",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {} as IndexDatabase,
        storageRoot,
        conversionWorker: createConversionWorker(),
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(404);
    expect(JSON.parse(getBody())).toEqual({ error: "File not found" });
  });

  it("returns 404 for directory path instead of file", async () => {
    const { res, getBody } = createMockResponse();
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-root-"));
    const dirName = "folder";
    mkdirSync(path.join(storageRoot, dirName), { recursive: true });

    await filesEndpointRequestHandler(
      {
        url: `/api/files/${dirName}`,
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {} as IndexDatabase,
        storageRoot,
        conversionWorker: createConversionWorker(),
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(404);
    expect(JSON.parse(getBody())).toEqual({ error: "File not found" });
  });
});
