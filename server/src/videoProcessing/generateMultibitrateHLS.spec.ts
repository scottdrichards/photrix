import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const makeSpawnProcess = () => {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => undefined;
  return proc;
};

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  delete process.env.CACHE_DIR;
  delete process.env.HLS_ENCODE_VERBOSE;
});

describe("generateMultibitrateHLS", () => {
  it("returns existing master playlist without queueing", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-existing-"));
    process.env.CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const { getMirroredHLSDirectory } = await import("../common/cacheUtils.ts");
    const hlsDir = getMirroredHLSDirectory(source, "abr");
    const masterPath = path.join(hlsDir, "master.m3u8");
    mkdirSync(path.dirname(masterPath), { recursive: true });
    writeFileSync(masterPath, "#EXTM3U");

    const { generateMultibitrateHLS } = await import("./generateMultibitrateHLS.ts");
    const out = await generateMultibitrateHLS(source, { waitForCompletion: true });

    expect(out).toBe(masterPath);
  });

  it("enqueues and generates both variants plus master playlist", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-success-"));
    process.env.CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const { getMirroredHLSDirectory } = await import("../common/cacheUtils.ts");
    const hlsDir = getMirroredHLSDirectory(source, "abr");

    const spawnMock = jest.fn((_command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-init_hw_device") || args.includes("h264_amf")) {
          proc.emit("close", 0);
          return;
        }
        const playlistPath = args.at(-1);
        if (playlistPath) {
          mkdirSync(path.dirname(playlistPath), { recursive: true });
          writeFileSync(playlistPath, "#EXTM3U");
        }
        proc.emit("close", 0);
      });
      return proc;
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateMultibitrateHLS, getMasterPlaylistPath } = await import(
      "./generateMultibitrateHLS.ts"
    );

    const masterPath = await generateMultibitrateHLS(source, {
      waitForCompletion: true,
      priority: "background",
      contentDurationSeconds: 14,
    });

    expect(masterPath).toBe(getMasterPlaylistPath(hlsDir));
    expect(spawnMock).toHaveBeenCalledTimes(3);

    const firstArgs = spawnMock.mock.calls[1]?.[1] as string[];
    const secondArgs = spawnMock.mock.calls[2]?.[1] as string[];
    expect(firstArgs).toContain("scale=-2:360");
    expect(secondArgs).toContain("scale=-2:720");
  });

  it("falls back to software encoding when hardware encode fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-fallback-"));
    process.env.CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const { getMirroredHLSDirectory } = await import("../common/cacheUtils.ts");
    const hlsDir = getMirroredHLSDirectory(source, "abr");

    const spawnMock = jest.fn((_command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-init_hw_device")) {
          proc.emit("close", 0);
          return;
        }

        if (args.includes("h264_nvenc") && args.includes("scale=-2:360")) {
          proc.stderr.emit("data", Buffer.from("h264_nvenc failed: Could not load CUDA"));
          proc.emit("close", 1);
          return;
        }

        const playlistPath = args.at(-1);
        if (playlistPath) {
          mkdirSync(path.dirname(playlistPath), { recursive: true });
          writeFileSync(playlistPath, "#EXTM3U");
        }
        proc.emit("close", 0);
      });
      return proc;
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateMultibitrateHLS } = await import("./generateMultibitrateHLS.ts");

    await generateMultibitrateHLS(source, { waitForCompletion: true });

    expect(spawnMock).toHaveBeenCalledTimes(4);
    const retryArgs = spawnMock.mock.calls[2]?.[1] as string[];
    expect(retryArgs).toContain("libx264");
  });

  it("rejects when ffmpeg fails without hardware fallback signal", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-fail-"));
    process.env.CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((_command: string, _args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        proc.stderr.emit("data", Buffer.from("unrecoverable ffmpeg failure"));
        proc.emit("close", 1);
      });
      return proc;
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateMultibitrateHLS } = await import("./generateMultibitrateHLS.ts");

    await expect(generateMultibitrateHLS(source, { waitForCompletion: true })).rejects.toThrow(
      /360p generation failed/i,
    );
  });
});
