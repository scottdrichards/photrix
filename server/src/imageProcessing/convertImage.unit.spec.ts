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

describe("convertImage unit", () => {
  it("returns cached image path when conversion already exists", async () => {
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-convert-cache-"));
    process.env.CACHE_DIR = cacheRoot;

    const source = path.join(cacheRoot, "source.jpg");
    writeFileSync(source, "img");

    const { getMirroredCachedFilePath } = await import("../common/cacheUtils.ts");
    const cached = getMirroredCachedFilePath(source, 320, "jpg");
    mkdirSync(path.dirname(cached), { recursive: true });
    writeFileSync(cached, "cached");

    const enqueue = jest.fn(async (fn: () => Promise<void>) => {
      await fn();
    });
    jest.unstable_mockModule("../common/processingQueue.ts", () => ({
      mediaProcessingQueue: { enqueue },
    }));

    const { convertImage } = await import("./convertImage.ts");

    const out = await convertImage(source, 320);

    expect(out).toBe(cached);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("invokes python pipeline for uncached image conversion", async () => {
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-convert-cache-"));
    process.env.CACHE_DIR = cacheRoot;

    const source = path.join(cacheRoot, "source.jpg");
    writeFileSync(source, "img");

    const spawnMock = jest.fn((command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-c")) {
          proc.stdout.emit("data", Buffer.from("C:\\Python\\python.exe\n"));
          proc.emit("close", 0);
          return;
        }
        proc.emit("close", 0);
      });
      return proc;
    });

    const enqueue = jest.fn(async (fn: () => Promise<void>) => {
      await fn();
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    jest.unstable_mockModule("../common/processingQueue.ts", () => ({
      mediaProcessingQueue: { enqueue },
    }));

    const { convertImage } = await import("./convertImage.ts");

    const out = await convertImage(source, 320);
    expect(out.endsWith("320.jpg")).toBe(true);
    expect(spawnMock).toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalled();
  });

  it("throws ImageConversionError with dependency guidance on module missing", async () => {
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-convert-cache-"));
    process.env.CACHE_DIR = cacheRoot;

    const source = path.join(cacheRoot, "source.jpg");
    writeFileSync(source, "img");

    const spawnMock = jest.fn((command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-c")) {
          proc.stdout.emit("data", Buffer.from("C:\\Python\\python.exe\n"));
          proc.emit("close", 0);
          return;
        }
        proc.stderr.emit("data", Buffer.from("ModuleNotFoundError: No module named 'PIL'"));
        proc.emit("close", 1);
      });
      return proc;
    });

    const enqueue = jest.fn(async (fn: () => Promise<void>) => {
      await fn();
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    jest.unstable_mockModule("../common/processingQueue.ts", () => ({
      mediaProcessingQueue: { enqueue },
    }));

    const { convertImage, ImageConversionError } = await import("./convertImage.ts");

    const conversionPromise = convertImage(source, 320);
    await expect(conversionPromise).rejects.toBeInstanceOf(ImageConversionError);
    await expect(conversionPromise).rejects.toThrow(/requirements\.txt/i);
  });

  it("skips multi-size generation when all outputs already cached", async () => {
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-convert-cache-"));
    process.env.CACHE_DIR = cacheRoot;

    const source = path.join(cacheRoot, "source.jpg");
    writeFileSync(source, "img");

    const { getMirroredCachedFilePath } = await import("../common/cacheUtils.ts");
    const cached320 = getMirroredCachedFilePath(source, 320, "jpg");
    const cached640 = getMirroredCachedFilePath(source, 640, "jpg");
    mkdirSync(path.dirname(cached320), { recursive: true });
    writeFileSync(cached320, "a");
    writeFileSync(cached640, "b");

    const spawnMock = jest.fn();
    const enqueue = jest.fn(async (fn: () => Promise<void>) => {
      await fn();
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    jest.unstable_mockModule("../common/processingQueue.ts", () => ({
      mediaProcessingQueue: { enqueue },
    }));

    const { convertImageToMultipleSizes } = await import("./convertImage.ts");

    await convertImageToMultipleSizes(source, [320, 640]);

    expect(enqueue).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
