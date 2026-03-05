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
});

describe("generateHLS", () => {
  it("returns existing playlist path without queueing", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-hls-existing-"));
    process.env.CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const { getMirroredHLSDirectory } = await import("../common/cacheUtils.ts");
    const hlsDir = getMirroredHLSDirectory(source, "720");
    const playlistPath = path.join(hlsDir, "playlist.m3u8");
    mkdirSync(hlsDir, { recursive: true });
    writeFileSync(playlistPath, "#EXTM3U");

    const enqueue = jest.fn();
    jest.unstable_mockModule("../common/processingQueue.ts", () => ({
      mediaProcessingQueue: { enqueue },
    }));

    const spawnMock = jest.fn(() => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => proc.emit("close", 1));
      return proc;
    });
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateHLS } = await import("./generateHLS.ts");

    const result = await generateHLS(source, 720);

    expect(result).toBe(playlistPath);
    expect(enqueue).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("enqueues conversion and uses software encoder when CUDA is unavailable", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-hls-soft-"));
    process.env.CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const { getMirroredHLSDirectory } = await import("../common/cacheUtils.ts");
    const hlsDir = getMirroredHLSDirectory(source, "360");
    const playlistPath = path.join(hlsDir, "playlist.m3u8");

    const enqueue = jest.fn(async (task: () => Promise<void>) => {
      await task();
    });

    const spawnMock = jest.fn((_command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-init_hw_device")) {
          proc.stderr.emit("data", Buffer.from("Could not dynamically load CUDA"));
          proc.emit("close", 1);
          return;
        }

        const outputPath = args.at(-1);
        if (outputPath) {
          mkdirSync(path.dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, "#EXTM3U");
        }
        proc.emit("close", 0);
      });
      return proc;
    });

    jest.unstable_mockModule("../common/processingQueue.ts", () => ({
      mediaProcessingQueue: { enqueue },
    }));
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateHLS } = await import("./generateHLS.ts");

    const result = await generateHLS(source, 360, {
      priority: "foreground",
      estimatedDurationSeconds: 12,
    });

    expect(result).toBe(playlistPath);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const generationArgs = spawnMock.mock.calls[1]?.[1] as string[];
    expect(generationArgs).toContain("libx264");
    expect(generationArgs).toContain("scale=-2:360");
  });

  it("rejects when ffmpeg generation fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-hls-fail-"));
    process.env.CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const enqueue = jest.fn(async (task: () => Promise<void>) => {
      await task();
    });

    const spawnMock = jest.fn((_command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-init_hw_device")) {
          proc.stderr.emit("data", Buffer.from("Could not dynamically load CUDA"));
          proc.emit("close", 1);
          return;
        }
        proc.stderr.emit("data", Buffer.from("ffmpeg encode boom"));
        proc.emit("close", 1);
      });
      return proc;
    });

    jest.unstable_mockModule("../common/processingQueue.ts", () => ({
      mediaProcessingQueue: { enqueue },
    }));
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateHLS } = await import("./generateHLS.ts");

    await expect(generateHLS(source, "original")).rejects.toThrow(/ffmpeg encode boom/i);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
