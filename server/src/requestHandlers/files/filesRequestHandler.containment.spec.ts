import { afterAll, describe, expect, it, jest } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type http from "node:http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import type { TaskOrchestrator } from "../../taskOrchestrator/taskOrchestrator.ts";

/**
 * No request may read a file outside the media root, or outside what a share
 * grants. Every case here aims at a real file outside the root whose content
 * is a canary: the response must be a 4xx and must never contain it.
 */

const sandbox = mkdtempSync(path.join(os.tmpdir(), "photrix-files-containment-"));
// The cache directories are read from the environment when cacheUtils loads,
// so they are set before the handler is imported.
process.env.CACHE_DIR = path.join(sandbox, "cache");
process.env.HLS_CACHE_DIR = path.join(sandbox, "hls");

const { filesEndpointRequestHandler } = await import("./filesRequestHandler.ts");
const { getMultibitrateHLSDirectory } = await import(
  "../../videoProcessing/generateMultibitrateHLS.ts"
);

const CANARY = "CANARY-outside-the-library";

const library = path.join(sandbox, "library");
const outside = path.join(sandbox, "outside");
mkdirSync(path.join(library, "shared"), { recursive: true });
mkdirSync(path.join(library, "private"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(path.join(outside, "secret.txt"), CANARY);
writeFileSync(path.join(library, "shared", "photo.jpg"), "shared photo bytes");
writeFileSync(path.join(library, "shared", "clip.mp4"), "shared video bytes");
writeFileSync(path.join(library, "private", "photo.jpg"), "private photo bytes");
writeFileSync(path.join(library, "..foo.jpg"), "dotted name bytes");
symlinkSync(path.join(outside, "secret.txt"), path.join(library, "shared", "escape.jpg"));
symlinkSync(outside, path.join(library, "shared", "escape-dir"));
symlinkSync(
  path.join(library, "private", "photo.jpg"),
  path.join(library, "shared", "to-private.jpg"),
);
symlinkSync(path.join(library, "shared", "photo.jpg"), path.join(library, "shared", "alias.jpg"));

// An initialised HLS tree for the shared video, so the segment route gets as
// far as it ever did before the fix: master.m3u8 present, variant dir present.
const hlsDir = getMultibitrateHLSDirectory(path.join(library, "/shared/clip.mp4"));
mkdirSync(path.join(hlsDir, "720p"), { recursive: true });
writeFileSync(path.join(hlsDir, "master.m3u8"), "#EXTM3U\n720p/playlist.m3u8\n");
writeFileSync(path.join(hlsDir, "720p", "segment_000.ts"), "segment zero bytes");
// The pre-fix exploit: a segment name relative to the variant directory that
// lands on the canary file.
const segmentTraversal = path.relative(path.join(hlsDir, "720p"), path.join(outside, "secret.txt"));

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const orchestrator = {
  setPerformBackgroundTasks: () => {},
  getPerformBackgroundTasks: () => true,
  getBackgroundTaskStatus: async () => [],
  addTask: jest.fn(),
  onQueueExhausted: () => {},
  noteUserActivity: () => {},
  beginUserRequest: () => ({ release: () => {}, refresh: () => {} }),
  getDiagnosticsSnapshot: () => ({}),
} as unknown as TaskOrchestrator;

/** A share that grants `/shared/` only (paths compared in index form). */
const SHARE_FILTER = { folder: "/shared/" };

// Index lookups accept a path with or without its leading slash, like splitPath.
const fileMatchesFilter = jest.fn(async (subPath: string) =>
  `/${subPath.replace(/^\/+/, "")}`.startsWith("/shared/"),
);

const database = {
  getFileRecord: async () => ({ duration: 10, embeddedVideoLength: 4 }),
  fileMatchesFilter,
  raiseConversionPriority: () => {},
  queryFiles: async () => ({ items: [], total: 0, page: 1, pageSize: 200 }),
  getDefaultExclusionFilter: async () => null,
  analysis: { getAudioSegments: async () => [] },
} as unknown as IndexDatabase;

type Captured = { status: number | undefined; body: string };

const request = async (url: string, shareFilter?: unknown): Promise<Captured> => {
  const res = new PassThrough() as unknown as http.ServerResponse & { statusCode: number };
  let status: number | undefined;
  let headersSent = false;
  Object.defineProperty(res, "headersSent", { get: () => headersSent });
  res.writeHead = ((code: number) => {
    status = code;
    headersSent = true;
    return res;
  });
  res.setHeader = () => res;
  const chunks: Buffer[] = [];
  (res as unknown as PassThrough).on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => {
    (res as unknown as PassThrough).on("end", () => resolve());
    (res as unknown as PassThrough).on("close", () => resolve());
  });
  await filesEndpointRequestHandler(
    { url, headers: { host: "localhost" }, method: "GET" } as http.IncomingMessage &
      Required<Pick<http.IncomingMessage, "url">>,
    res,
    { database, storageRoot: library, taskOrchestrator: orchestrator, shareFilter },
  );
  // A streamed file finishes after the handler returns; wait for the last byte.
  await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 2000))]);
  return { status, body: Buffer.concat(chunks).toString("utf-8") };
};

const expectRefused = (result: Captured) => {
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.status).toBeLessThan(500);
  expect(result.body).not.toContain(CANARY);
};

const callers: Array<[string, unknown]> = [
  ["a signed-in session", undefined],
  ["a share link", SHARE_FILTER],
];

describe.each(callers)("file containment for %s", (_label, shareFilter) => {
  describe("HLS segment names", () => {
    const base = "/api/files/shared/clip.mp4?representation=hls&variant=720&segment=";

    it("still serves a real segment", async () => {
      const result = await request(`${base}segment_000.ts`, shareFilter);
      expect(result.status).toBe(200);
      expect(result.body).toBe("segment zero bytes");
    });

    it.each([
      ["relative traversal to a real file", segmentTraversal],
      ["/etc/hostname-style traversal", "../../../../../../../../etc/hostname"],
      ["percent-encoded traversal", encodeURIComponent(segmentTraversal)],
      ["double-encoded traversal", encodeURIComponent(encodeURIComponent(segmentTraversal))],
      ["an absolute path", encodeURIComponent(path.join(outside, "secret.txt"))],
      ["a valid name with traversal after it", "segment_000.ts/../../x"],
      ["a backslash", "..%5Csegment_000.ts"],
      ["a NUL byte", "segment_000.ts%00"],
      ["a prefix before a valid name", "x/segment_000.ts"],
    ])("refuses %s with 400", async (_name, segment) => {
      const result = await request(`${base}${segment}`, shareFilter);
      expect(result.status).toBe(400);
      expectRefused(result);
    });

    it("refuses a non-numeric variant", async () => {
      const result = await request(
        "/api/files/shared/clip.mp4?representation=hls&variant=..%2F..&segment=segment_000.ts",
        shareFilter,
      );
      expect(result.status).toBe(400);
    });
  });

  describe("the file path", () => {
    it.each([
      ["percent-encoded ../", "..%2F..%2Foutside%2Fsecret.txt"],
      ["percent-encoded dots and slashes", "%2e%2e%2f%2e%2e%2foutside%2fsecret.txt"],
      ["traversal after a real folder", "shared%2F..%2F..%2Foutside%2Fsecret.txt"],
      ["double-encoded ../", "%252e%252e%252f%252e%252e%252foutside%252fsecret.txt"],
      ["an absolute filesystem path", encodeURIComponent(path.join(outside, "secret.txt"))],
      ["a doubled leading slash", `/${path.join(outside, "secret.txt")}`],
      ["backslash separators", "..%5C..%5Coutside%5Csecret.txt"],
      ["a NUL byte", "shared%2Fphoto.jpg%00.txt"],
      ["a file symlink pointing outside", "shared/escape.jpg"],
      ["a directory symlink pointing outside", "shared/escape-dir/secret.txt"],
    ])("refuses %s", async (_name, requested) => {
      expectRefused(await request(`/api/files/${requested}`, shareFilter));
    });

    it.each(["live-photo", "transcript", "webSafe", "preview", "scrub&index=0", "storyboard"])(
      "refuses a symlink escape for representation=%s",
      async (representation) => {
        const result = await request(
          `/api/files/shared/escape.jpg?representation=${representation}`,
          shareFilter,
        );
        expect(result.status).toBe(403);
        expectRefused(result);
      },
    );

    it("serves an ordinary shared file", async () => {
      const result = await request("/api/files/shared/photo.jpg", shareFilter);
      expect(result.status).toBe(200);
      expect(result.body).toBe("shared photo bytes");
    });

    it("serves a symlink whose target is in the library and in scope", async () => {
      const result = await request("/api/files/shared/alias.jpg", shareFilter);
      expect(result.status).toBe(200);
      expect(result.body).toBe("shared photo bytes");
    });
  });
});

describe("share scope", () => {
  it("refuses a file outside the share", async () => {
    const result = await request("/api/files/private/photo.jpg", SHARE_FILTER);
    expect(result.status).toBe(403);
    expect(result.body).not.toContain("private photo bytes");
  });

  it("answers a missing out-of-share file with the same 403 (no existence probe)", async () => {
    expect((await request("/api/files/private/nope.jpg", SHARE_FILTER)).status).toBe(403);
  });

  it("refuses a symlink in the share whose target is outside the share", async () => {
    const result = await request("/api/files/shared/to-private.jpg", SHARE_FILTER);
    expect(result.status).toBe(403);
    expect(result.body).not.toContain("private photo bytes");
  });

  it("checks the share against the canonical path, not the raw one", async () => {
    fileMatchesFilter.mockClear();
    await request("/api/files/shared//.%2Fphoto.jpg", SHARE_FILTER);
    expect(fileMatchesFilter).toHaveBeenCalledWith("/shared/photo.jpg", SHARE_FILTER);
  });

  it("lets a session follow a symlink to another library file", async () => {
    const result = await request("/api/files/shared/to-private.jpg");
    expect(result.status).toBe(200);
    expect(result.body).toBe("private photo bytes");
  });
});

describe("legitimate names", () => {
  it("serves a root file literally named ..foo.jpg", async () => {
    const result = await request("/api/files/..foo.jpg");
    expect(result.status).toBe(200);
    expect(result.body).toBe("dotted name bytes");
  });
});
