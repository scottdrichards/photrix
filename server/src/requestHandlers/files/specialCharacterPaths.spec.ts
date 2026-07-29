import { describe, expect, it, jest } from "@jest/globals";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import type { TaskOrchestrator } from "../../taskOrchestrator/taskOrchestrator.ts";
import { filesEndpointRequestHandler } from "./filesRequestHandler.ts";
import { decodeRequestPath } from "../../common/decodeRequestPath.ts";

/**
 * Feedback #5: "/Sarah Pictures/2009/11/#2 Thankful for Dessert Night (8).jpg"
 * failed to load. `#` starts a URL fragment, so a path dropped into a URL
 * unencoded is truncated before it ever reaches the server.
 *
 * These lock in the whole round trip: the client encodes every path segment,
 * the server decodes it back, and neither end is confused by the characters
 * that mean something in a URL.
 */

const orchestrator = {
  setPerformBackgroundTasks: () => {},
  getPerformBackgroundTasks: () => true,
  getBackgroundTaskStatus: async () => [],
  addTask: () => {},
  onQueueExhausted: () => {},
  noteUserActivity: () => {},
  beginUserRequest: () => {},
  endUserRequest: () => {},
  getDiagnosticsSnapshot: () => ({}),
} as unknown as TaskOrchestrator;

const createMockResponse = () => {
  let body = "";
  const res = {
    headersSent: false,
    writeHead: jest.fn(() => {
      (res as { headersSent: boolean }).headersSent = true;
      return res as unknown as http.ServerResponse;
    }),
    end: jest.fn((chunk?: string) => {
      if (chunk) body += chunk;
      return res as unknown as http.ServerResponse;
    }),
    write: jest.fn(() => true),
  } as unknown as http.ServerResponse;
  return {
    res,
    getBody: () => body,
    status: () => (res.writeHead as jest.Mock).mock.calls[0]?.[0] as number | undefined,
  };
};

/** Exactly how the client builds a file URL (client/src/api/photoItem.ts). */
const encodePathSegments = (p: string): string =>
  p.split("/").map(encodeURIComponent).join("/");

const database = {
  getFileRecord: async () => undefined,
  raiseConversionPriority: () => {},
  // Reached only when a request resolves to a folder listing rather than a file.
  queryFiles: async () => ({ items: [], total: 0, page: 1, pageSize: 200 }),
} as unknown as IndexDatabase;

const requestFile = async (storageRoot: string, requestUrl: string) => {
  const { res, status, getBody } = createMockResponse();
  await filesEndpointRequestHandler(
    {
      url: requestUrl,
      headers: { host: "localhost" },
      method: "GET",
    } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
    res,
    { database, storageRoot, taskOrchestrator: orchestrator } as never,
  );
  return { status: status(), body: getBody() };
};

const seed = (fileName: string) => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-specialchars-"));
  const folder = "Sarah Pictures/2009/11";
  mkdirSync(path.join(storageRoot, ...folder.split("/")), { recursive: true });
  writeFileSync(path.join(storageRoot, ...folder.split("/"), fileName), "jpegbytes");
  return { storageRoot, relativePath: `${folder}/${fileName}` };
};

describe("special characters in file paths", () => {
  const fileNames = [
    "#2 Thankful for Dessert Night (8).jpg", // the reported failure
    "why? really.jpg",
    "50% off.jpg",
    "a & b.jpg",
    "plus+one.jpg",
    "hash#in#middle.jpg",
  ];

  for (const fileName of fileNames) {
    it(`serves ${JSON.stringify(fileName)} when each segment is encoded`, async () => {
      const { storageRoot, relativePath } = seed(fileName);
      const { status } = await requestFile(
        storageRoot,
        `/api/files/${encodePathSegments(relativePath)}`,
      );
      expect(status).toBe(200);
    });
  }

  it("truncates at an unencoded '#' — the original bug, kept as documentation", async () => {
    const { storageRoot, relativePath } = seed("#2 Thankful for Dessert Night (8).jpg");
    // What the client used to send: the fragment (everything from '#') never
    // reaches the server, so it asks for the directory instead of the file —
    // the request degrades into a folder listing, never the image.
    const { body } = await requestFile(
      storageRoot,
      `/api/files/${relativePath.split("#")[0]}`,
    );
    expect(JSON.parse(body)).toHaveProperty("items");
  });

  it("does not 500 on a malformed percent escape", async () => {
    const { storageRoot } = seed("50% off.jpg");
    // A hand-typed/legacy link with a bare '%': decodeURIComponent would throw.
    const { status } = await requestFile(storageRoot, "/api/files/50% off.jpg");
    expect(status).toBe(404);
  });

  it("still rejects traversal in an encoded path", async () => {
    const { storageRoot } = seed("#2 ok.jpg");
    const { status } = await requestFile(storageRoot, "/api/files/..%2F..%2Fetc%2Fpasswd");
    expect(status).toBe(403);
  });
});

describe("decodeRequestPath", () => {
  it("round-trips every character that is structural in a URL", () => {
    for (const raw of [
      "Sarah Pictures/2009/11/#2 Thankful for Dessert Night (8).jpg",
      "why? really.jpg",
      "50% off.jpg",
      "a & b.jpg",
      "plus+one.jpg",
    ]) {
      const encoded = raw.split("/").map(encodeURIComponent).join("/");
      expect(decodeRequestPath(encoded)).toBe(raw);
    }
  });

  it("returns the raw text instead of throwing on a malformed escape", () => {
    expect(decodeRequestPath("50% off.jpg")).toBe("50% off.jpg");
    expect(decodeRequestPath("%zz")).toBe("%zz");
    expect(decodeRequestPath("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
