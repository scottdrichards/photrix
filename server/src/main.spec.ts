import { afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { walkFiles } from "./fileHandling/fileUtils.ts";
import { setBackgroundTasksEnabled } from "./common/backgroundTasksControl.ts";

const TEST_PORT = 3101;
process.env.PORT = String(TEST_PORT);

const makeRequest = (
  port: number,
  requestPath: string,
  method = "GET",
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port,
        path: requestPath,
        method,
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });

describe("main.ts HTTP Server", () => {
  let server: http.Server;
  let database: IndexDatabase;
  let storagePath: string;

  beforeAll(() => {
    process.env.ThumbnailCacheDirectory ??= path.join(os.tmpdir(), "photrix-test-thumbs");
  });

  beforeEach(async () => {
    setBackgroundTasksEnabled(true);
    process.env.AUTH_REQUIRED = "false";
    storagePath = mkdtempSync(path.join(os.tmpdir(), "photrix-main-spec-root-"));
    process.env.INDEX_DB_LOCATION = mkdtempSync(path.join(os.tmpdir(), "photrix-main-spec-db-"));

    mkdirSync(path.join(storagePath, "subFolder"), { recursive: true });
    writeFileSync(path.join(storagePath, "root.jpg"), "root");
    writeFileSync(path.join(storagePath, "subFolder", "child.jpg"), "child");

    database = new IndexDatabase(storagePath);
    const relativePaths = [...walkFiles(storagePath)].map((filePath) =>
      path.relative(storagePath, filePath).replace(/\\/g, "/"),
    );
    database.addPaths(relativePaths);

    const { createServer } = await import("./createServer.ts");
    server = createServer(database, storagePath);

    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(storagePath, { recursive: true, force: true });
    setBackgroundTasksEnabled(true);
    delete process.env.AUTH_REQUIRED;
  });

  it("returns health response", async () => {
    const response = await makeRequest(TEST_PORT, "/api/health");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: "ok",
      message: "Server is running",
    });
  });

  it("returns CORS headers and handles OPTIONS", async () => {
    const response = await makeRequest(TEST_PORT, "/api/health", "OPTIONS");
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
  });

  it("lists folders from root and nested paths", async () => {
    const rootResponse = await makeRequest(TEST_PORT, "/api/folders/");
    const nestedResponse = await makeRequest(TEST_PORT, "/api/folders/subFolder/");

    expect(rootResponse.status).toBe(200);
    expect(JSON.parse(rootResponse.body).folders).toEqual(["subFolder"]);
    expect(nestedResponse.status).toBe(200);
    expect(JSON.parse(nestedResponse.body).folders).toEqual([]);
  });

  it("returns files query results", async () => {
    const rootResponse = await makeRequest(TEST_PORT, "/api/files/");
    const recursiveResponse = await makeRequest(
      TEST_PORT,
      "/api/files/?includeSubfolders=true",
    );

    expect(rootResponse.status).toBe(200);
    expect(recursiveResponse.status).toBe(200);

    const rootData = JSON.parse(rootResponse.body) as {
      items: Array<{ folder: string; fileName: string }>;
      total: number;
    };
    const recursiveData = JSON.parse(recursiveResponse.body) as {
      items: Array<{ folder: string; fileName: string }>;
      total: number;
    };

    expect(rootData.total).toBe(1);
    expect(rootData.items.map((item) => item.fileName)).toEqual(["root.jpg"]);
    expect(recursiveData.total).toBe(2);
    expect(recursiveData.items.map((item) => item.fileName).sort()).toEqual([
      "child.jpg",
      "root.jpg",
    ]);
  });

  it("serves existing files and blocks traversal", async () => {
    const ok = await makeRequest(TEST_PORT, "/api/files/root.jpg");
    const blocked = await makeRequest(TEST_PORT, "/api/files/..%2F..%2Fetc%2Fpasswd");

    expect(ok.status).toBe(200);
    expect(blocked.status).toBe(403);
  });

  it("returns 404 for unknown route", async () => {
    const response = await makeRequest(TEST_PORT, "/nope");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "Not found" });
  });

  it("toggles background tasks via status endpoint", async () => {
    const response = await makeRequest(
      TEST_PORT,
      "/api/status/background-tasks",
      "POST",
      JSON.stringify({ enabled: false }),
      { "Content-Type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ enabled: false });

    const statusResponse = await makeRequest(TEST_PORT, "/api/status");
    expect(statusResponse.status).toBe(200);
    expect(JSON.parse(statusResponse.body).maintenance.backgroundTasksEnabled).toBe(false);
  });
});
