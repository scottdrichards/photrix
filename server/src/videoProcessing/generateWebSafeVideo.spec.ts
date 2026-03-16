import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
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

describe("generateWebSafeVideo", () => {
  it("returns cached path when web-safe video already exists", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-websafe-cached-"));
    process.env.CACHE_DIR = root;

    const source = path.join(root, "source.mov");
    writeFileSync(source, "video");

    const { getHash, getCachedFilePath } = await import("../common/cacheUtils.ts");
    const cachedPath = getCachedFilePath(getHash(source, statSync(source).mtimeMs), "original", "mp4");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(cachedPath), { recursive: true });
    writeFileSync(cachedPath, "cached");

    const enqueue = jest.fn();
    jest.unstable_mockModule("../common/processingQueue.ts", () => ({
      mediaProcessingQueue: { enqueue },
    }));

    const { generateWebSafeVideo } = await import("./generateWebSafeVideo.ts");

    const out = await generateWebSafeVideo(source);

    expect(out).toBe(cachedPath);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues ffmpeg conversion for uncached file", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-websafe-run-"));
    process.env.CACHE_DIR = root;

    const source = path.join(root, "source.mov");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((_command: string, _args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        proc.emit("close", 0);
      });
      return proc;
    });

    const enqueue = jest.fn(async (task: { fn: () => Promise<void> }) => {
      await task.fn();
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    jest.unstable_mockModule("../common/processingQueue.ts", () => ({
      mediaProcessingQueue: { enqueue },
    }));

    const { generateWebSafeVideo } = await import("./generateWebSafeVideo.ts");
    const out = await generateWebSafeVideo(source, 720, { priority: "foreground" });

    expect(out.endsWith(".720.mp4")).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const ffmpegArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(ffmpegArgs).toContain("scale=-2:720");
    expect(ffmpegArgs).toContain("libx264");
  });

  it("rejects when ffmpeg exits non-zero", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-websafe-fail-"));
    process.env.CACHE_DIR = root;

    const source = path.join(root, "source.mov");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((_command: string, _args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        proc.stderr.emit("data", Buffer.from("encode failed"));
        proc.emit("close", 1);
      });
      return proc;
    });

    const enqueue = jest.fn(async (task: { fn: () => Promise<void> }) => {
      await task.fn();
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    jest.unstable_mockModule("../common/processingQueue.ts", () => ({
      mediaProcessingQueue: { enqueue },
    }));

    const { generateWebSafeVideo } = await import("./generateWebSafeVideo.ts");

    await expect(generateWebSafeVideo(source, "original")).rejects.toThrow(
      /web-safe video generation failed/i,
    );
  });

  it("rejects when ffmpeg process emits error", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-websafe-error-"));
    process.env.CACHE_DIR = root;

    const source = path.join(root, "source.mov");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((_command: string, _args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        proc.emit("error", new Error("spawn boom"));
      });
      return proc;
    });

    const enqueue = jest.fn(async (task: { fn: () => Promise<void> }) => {
      await task.fn();
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    jest.unstable_mockModule("../common/processingQueue.ts", () => ({
      mediaProcessingQueue: { enqueue },
    }));

    const { generateWebSafeVideo } = await import("./generateWebSafeVideo.ts");

    await expect(generateWebSafeVideo(source)).rejects.toThrow(/spawn boom/i);
  });
});
