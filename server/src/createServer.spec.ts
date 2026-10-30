import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { walkFiles } from "./fileHandling/fileUtils.ts";
import { createTaskOrchestrator } from "./taskOrchestrator/taskOrchestrator.ts";
import { FeatureFlagStore } from "./featureFlags/featureFlagStore.ts";
import { issueShareToken, issueToken } from "./auth/authService.ts";

// Port 0: the OS picks a free port, so this suite can run alongside the others.
process.env.PORT = "0";
const { createServer } = await import("./createServer.ts");

type Response = { status: number; headers: http.IncomingHttpHeaders; body: string };

/**
 * A library of three files in three folders: `root.jpg` (unrated),
 * `subFolder/child.jpg` (5 stars) and `otherFolder/other.jpg` (2 stars).
 */
describe("createServer", () => {
  let server: http.Server;
  let database: IndexDatabase;
  let mediaRoot: string;
  let dbRoot: string;

  const request = (
    requestPath: string,
    { method = "GET", body, token }: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      const { port } = server.address() as AddressInfo;
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const req = http.request(
        { hostname: "localhost", port, path: requestPath, method, headers },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  beforeEach(async () => {
    mediaRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-server-spec-media-"));
    dbRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-server-spec-db-"));
    process.env.INDEX_DB_LOCATION = dbRoot;

    mkdirSync(path.join(mediaRoot, "subFolder"));
    mkdirSync(path.join(mediaRoot, "otherFolder"));
    writeFileSync(path.join(mediaRoot, "root.jpg"), "root");
    writeFileSync(path.join(mediaRoot, "subFolder", "child.jpg"), "child");
    writeFileSync(path.join(mediaRoot, "otherFolder", "other.jpg"), "other");

    database = new IndexDatabase(mediaRoot);
    await database.init();
    await database.startupMaintenance;
    await database.addPaths(
      [...walkFiles(mediaRoot)].map((filePath) => path.relative(mediaRoot, filePath)),
    );
    await database.addOrUpdateFileData("subFolder/child.jpg", {
      exifProcessedAt: "2026-01-01T00:00:00.000Z",
      rating: 5,
    });
    await database.addOrUpdateFileData("otherFolder/other.jpg", {
      exifProcessedAt: "2026-01-01T00:00:00.000Z",
      rating: 2,
    });

    server = createServer(database, mediaRoot, {
      taskOrchestrator: createTaskOrchestrator(database),
      featureFlags: await FeatureFlagStore.load(database.asyncSqlite, {}),
    });
    if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  });

  afterEach(async () => {
    delete process.env.AUTH_PASSWORD;
    await new Promise((resolve) => server.close(resolve));
    await database.close();
    rmSync(mediaRoot, { recursive: true, force: true });
    rmSync(dbRoot, { recursive: true, force: true });
  });

  describe("protocol", () => {
    it("answers /api/health with ok while the library is mounted", async () => {
      const response = await request("/api/health");
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ status: "ok", message: "Server is running" });
    });

    it("tags every response with an X-Request-Id", async () => {
      const response = await request("/api/health");
      expect(response.headers["x-request-id"]).toMatch(/.+/);
    });

    it("answers a CORS preflight with 204 and the allowed methods", async () => {
      const response = await request("/api/health", { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-methods"]).toBe("GET, POST, PATCH, OPTIONS");
    });

    it("answers an unknown route with a JSON 404", async () => {
      const response = await request("/nope");
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({ error: "Not found" });
    });
  });

  describe("routes, with auth disabled", () => {
    it("serves an uncacheable payload of the requested size for bandwidth probing", async () => {
      const response = await request("/api/network-probe?bytes=65536");
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate");
      expect(response.headers["content-type"]).toBe("application/octet-stream");
      expect(response.body).toHaveLength(64 * 1024);
    });

    it("lists the subfolders of a folder, with a count, narrowed by a filter", async () => {
      const root = await request("/api/folders/");
      const nested = await request("/api/folders/subFolder/");
      const fiveStars = await request(
        `/api/folders/?filter=${encodeURIComponent(JSON.stringify({ rating: { min: 5 } }))}`,
      );

      expect(JSON.parse(root.body).folders).toEqual([
        { name: "otherFolder", count: 1 },
        { name: "subFolder", count: 1 },
      ]);
      expect(JSON.parse(nested.body).folders).toEqual([]);
      expect(JSON.parse(fiveStars.body).folders).toEqual([{ name: "subFolder", count: 1 }]);
    });

    it("queries a folder's own files, or its whole subtree with includeSubfolders", async () => {
      const root = JSON.parse((await request("/api/files/")).body);
      const subtree = JSON.parse((await request("/api/files/?includeSubfolders=true")).body);

      expect(root.items.map((item: { fileName: string }) => item.fileName)).toEqual(["root.jpg"]);
      expect(subtree.total).toBe(3);
    });

    it("serves a file's bytes, and refuses a path that climbs out of the library", async () => {
      expect((await request("/api/files/root.jpg")).status).toBe(200);
      expect((await request("/api/files/..%2F..%2Fetc%2Fpasswd")).status).toBe(403);
    });

    it("pauses background tasks and reports it in /api/status", async () => {
      const toggle = await request("/api/status/background-tasks", {
        method: "POST",
        body: { enabled: false },
      });
      const status = await request("/api/status");

      expect(JSON.parse(toggle.body)).toEqual({ enabled: false });
      expect(JSON.parse(status.body).maintenance.backgroundTasksEnabled).toBe(false);
    });
  });

  describe("access, with auth enabled", () => {
    // A share link scoped to the 5-star photo only.
    const shareScope = { filter: { rating: { min: 5 } } };

    beforeEach(() => {
      process.env.AUTH_PASSWORD = "test-password";
    });

    it("refuses a request with no token", async () => {
      expect((await request("/api/folders/")).status).toBe(401);
    });

    it("leaves /api/health public", async () => {
      expect((await request("/api/health")).status).toBe(200);
    });

    it("accepts a signed-in session", async () => {
      expect((await request("/api/folders/", { token: issueToken() })).status).toBe(200);
    });

    it("narrows a share link's library to the share's filter", async () => {
      const response = await request("/api/files/?includeSubfolders=true", {
        token: issueShareToken(shareScope),
      });
      const fileNames = JSON.parse(response.body).items.map(
        (item: { fileName: string }) => item.fileName,
      );
      expect(fileNames).toEqual(["child.jpg"]);
    });

    it("lets a share link submit feedback and report its own diagnostics", async () => {
      const token = issueShareToken(shareScope);
      const feedback = await request("/api/feedback", {
        method: "POST",
        token,
        body: { text: "from a shared link" },
      });
      const diagnostics = await request("/api/diagnostics/events", {
        method: "POST",
        token,
        body: { events: [] },
      });

      expect(feedback.status).not.toBe(403);
      expect(diagnostics.status).not.toBe(403);
    });

    // Every route a share link must never reach: owner-only state, the whole
    // library's diagnostics, or anything that mutates the index.
    it.each([
      ["GET", "/api/status"],
      ["GET", "/api/status/stream"],
      ["POST", "/api/status/background-tasks"],
      ["POST", "/api/status/clear-hls"],
      ["GET", "/api/diagnostics/events"],
      ["GET", "/api/diagnostics/perf"],
      ["GET", "/api/diagnostics/report"],
      ["GET", "/api/day-photo/2026-01-01"],
      ["GET", "/api/photos/caption?path=root.jpg"],
      ["GET", "/api/photos/suggest-rotation?path=root.jpg"],
      ["GET", "/api/feedback"],
      ["POST", "/api/search/interpret"],
      ["POST", "/api/faces/identify"],
      ["GET", "/api/people/tags"],
      ["GET", "/api/settings/default-exclusion"],
      ["POST", "/api/moment-clusters/dissolve"],
    ])("forbids a share link from %s %s", async (method, route) => {
      const response = await request(route, { method, token: issueShareToken(shareScope) });
      expect(response.status).toBe(403);
    });
  });
});
