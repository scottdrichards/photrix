import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import * as realFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Regression tests for the server crash in feedback #29:
 *
 *   FATAL: Uncaught exception — Error: ENOENT: no such file or directory,
 *   scandir '.../hls/abr/1080p'
 *     at readdirSync ... at #watchFolder (node:internal/fs/recursive_watch)
 *
 * A recursive fs.watch re-scans directories on every event. Starting an encode
 * for a variant used to `rm -rf` that variant's directory (to drop stale
 * segments) while the watcher on the `abr` tree was live, so the re-scan hit a
 * directory that had just been deleted and threw ENOENT. Node raises that as an
 * "error" event on the watcher, and an EventEmitter "error" with no listener is
 * rethrown — killing the process.
 */

const tempRoots: string[] = [];

const makeTempHlsDir = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "photrix-hlswatch-"));
  tempRoots.push(root);
  const hlsDir = path.join(root, "hls", "abr");
  for (const height of [360, 720, 1080]) {
    mkdirSync(path.join(hlsDir, `${height}p`), { recursive: true });
  }
  return hlsDir;
};

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("waitForHlsFile", () => {
  it("resolves true when the segment appears", async () => {
    const hlsDir = makeTempHlsDir();
    const segment = path.join(hlsDir, "1080p", "segment_000.ts");
    const { waitForHlsFile } = await import("./hlsSegmentWatcher.ts");

    const pending = waitForHlsFile(hlsDir, segment, 10_000);
    setTimeout(() => writeFileSync(segment, "ts"), 20);

    await expect(pending).resolves.toBe(true);
  });

  it("survives a watcher ENOENT error instead of crashing the process", async () => {
    // Fake watcher so the internal failure mode can be triggered deterministically.
    const fakeWatcher = new EventEmitter() as EventEmitter & { close: () => void };
    fakeWatcher.close = () => undefined;
    const watch = jest.fn(() => fakeWatcher);

    jest.unstable_mockModule("node:fs", () => ({ ...realFs, default: realFs, watch }));

    const hlsDir = makeTempHlsDir();
    const segment = path.join(hlsDir, "1080p", "segment_000.ts");
    const { waitForHlsFile } = await import("./hlsSegmentWatcher.ts");

    const pending = waitForHlsFile(hlsDir, segment, 10_000);
    expect(watch).toHaveBeenCalled();
    // The guard: an error listener must be attached, or this emit throws exactly
    // the way it did in production.
    expect(fakeWatcher.listenerCount("error")).toBeGreaterThan(0);

    const enoent = Object.assign(
      new Error(`ENOENT: no such file or directory, scandir '${hlsDir}/1080p'`),
      { code: "ENOENT" },
    );
    expect(() => fakeWatcher.emit("error", enoent)).not.toThrow();

    // The waiter still completes once the encoder writes the segment, despite
    // having lost its watcher.
    writeFileSync(segment, "ts");
    await expect(pending).resolves.toBe(true);
  });

  it("falls back to polling when the watcher never fires an event", async () => {
    const deadWatcher = new EventEmitter() as EventEmitter & { close: () => void };
    deadWatcher.close = () => undefined;

    jest.unstable_mockModule("node:fs", () => ({
      ...realFs,
      default: realFs,
      watch: jest.fn(() => deadWatcher),
    }));

    const hlsDir = makeTempHlsDir();
    const playlist = path.join(hlsDir, "720p", "playlist.m3u8");
    const { waitForHlsFile } = await import("./hlsSegmentWatcher.ts");

    const pending = waitForHlsFile(hlsDir, playlist, 10_000);
    writeFileSync(playlist, "#EXTM3U");

    await expect(pending).resolves.toBe(true);
  });

  it("gives up quickly when the HLS tree is reaped mid-wait", async () => {
    const hlsDir = makeTempHlsDir();
    const segment = path.join(hlsDir, "1080p", "segment_007.ts");
    const { waitForHlsFile, closeHlsWatcher } = await import("./hlsSegmentWatcher.ts");

    const startedAt = Date.now();
    // 60s is the timeout the request handler uses; a reap must not hold the
    // request open for it.
    const pending = waitForHlsFile(hlsDir, segment, 60_000);
    setTimeout(() => {
      closeHlsWatcher(hlsDir);
      rmSync(path.dirname(hlsDir), { recursive: true, force: true });
    }, 30);

    await expect(pending).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("does not throw when asked to watch a directory that does not exist", async () => {
    const hlsDir = path.join(os.tmpdir(), "photrix-hlswatch-absent", "hls", "abr");
    const { waitForHlsFile } = await import("./hlsSegmentWatcher.ts");

    await expect(
      waitForHlsFile(hlsDir, path.join(hlsDir, "1080p", "segment_000.ts"), 60_000),
    ).resolves.toBe(false);
  });
});

describe("closeHlsWatchersUnder", () => {
  it("closes watchers inside a subtree that is about to be deleted", async () => {
    const hlsDir = makeTempHlsDir(); // .../hls/abr
    const hlsRoot = path.dirname(hlsDir); // .../hls
    const { waitForHlsFile, closeHlsWatchersUnder } = await import(
      "./hlsSegmentWatcher.ts"
    );

    const pending = waitForHlsFile(hlsDir, path.join(hlsDir, "720p", "segment_000.ts"), 60_000);
    closeHlsWatchersUnder(hlsRoot);
    rmSync(hlsRoot, { recursive: true, force: true });

    await expect(pending).resolves.toBe(false);
  });
});

describe("encode restart", () => {
  it("clears a variant's output without deleting the watched directory", async () => {
    const hlsDir = makeTempHlsDir();
    const variantDir = path.join(hlsDir, "1080p");
    writeFileSync(path.join(variantDir, "segment_000.ts"), "stale");
    writeFileSync(path.join(variantDir, "playlist.m3u8"), "#EXTM3U");

    const { clearVariantOutput } = await import("./generateMultibitrateHLS.ts");
    await clearVariantOutput(hlsDir, 1080);

    // Directory survives (nothing is pulled out from under the recursive watcher)
    // but its stale contents are gone.
    expect(existsSync(variantDir)).toBe(true);
    expect(existsSync(path.join(variantDir, "segment_000.ts"))).toBe(false);
    expect(existsSync(path.join(variantDir, "playlist.m3u8"))).toBe(false);
  });

  it("recreates the variant directory if it is missing", async () => {
    const hlsDir = makeTempHlsDir();
    const variantDir = path.join(hlsDir, "720p");
    rmSync(variantDir, { recursive: true, force: true });

    const { clearVariantOutput } = await import("./generateMultibitrateHLS.ts");
    await clearVariantOutput(hlsDir, 720);

    expect(existsSync(variantDir)).toBe(true);
  });
});
