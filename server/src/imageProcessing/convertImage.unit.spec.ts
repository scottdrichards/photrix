import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const makeSpawnProcess = () => {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { write: (data: string) => boolean };
    kill: (signal?: string) => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), {
    write: () => true,
  });
  proc.kill = () => undefined;
  return proc;
};

// A `process_image.py --worker` process that reports ready and answers every
// request with {ok: true}.
const makeHealthyWorkerProcess = () => {
  const proc = makeSpawnProcess();
  proc.stdin.write = (data: string) => {
    const request = JSON.parse(data) as { id: number };
    queueMicrotask(() => {
      proc.stdout.emit(
        "data",
        Buffer.from(JSON.stringify({ id: request.id, ok: true }) + "\n"),
      );
    });
    return true;
  };
  queueMicrotask(() => {
    proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "ready" }) + "\n"));
  });
  return proc;
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  delete process.env.CACHE_DIR;
  delete process.env.PHOTRIX_PYTHON;
});

describe("convertImage unit", () => {
  it("returns cached image path when conversion already exists", async () => {
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-convert-cache-"));
    process.env.CACHE_DIR = cacheRoot;

    const source = path.join(cacheRoot, "source.jpg");
    writeFileSync(source, "img");

    const { getMirroredCachedFilePath } = await import("../common/cacheUtils.ts");
    const cached = getMirroredCachedFilePath(source, 320, "webp");
    mkdirSync(path.dirname(cached), { recursive: true });
    writeFileSync(cached, "cached");

    const { convertImage } = await import("./convertImage.ts");

    const out = await convertImage(source, 320);

    expect(out).toBe(cached);
  });

  it("invokes python pipeline for uncached image conversion", async () => {
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-convert-cache-"));
    process.env.CACHE_DIR = cacheRoot;

    const source = path.join(cacheRoot, "source.jpg");
    writeFileSync(source, "img");

    const spawnMock = jest.fn((command: string, args: string[]) => {
      if (args.includes("-c")) {
        const proc = makeSpawnProcess();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from("C:\\Python\\python.exe\n"));
          proc.emit("close", 0);
        });
        return proc;
      }
      expect(args).toContain("--worker");
      return makeHealthyWorkerProcess();
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { convertImage } = await import("./convertImage.ts");

    const out = await convertImage(source, 320);
    expect(out.endsWith("320.webp")).toBe(true);
    expect(spawnMock).toHaveBeenCalled();
  });

  it("reuses the persistent worker across conversions", async () => {
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-convert-cache-"));
    process.env.CACHE_DIR = cacheRoot;

    const sourceA = path.join(cacheRoot, "a.jpg");
    const sourceB = path.join(cacheRoot, "b.jpg");
    writeFileSync(sourceA, "img");
    writeFileSync(sourceB, "img");

    const spawnMock = jest.fn((command: string, args: string[]) => {
      if (args.includes("-c")) {
        const proc = makeSpawnProcess();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from("C:\\Python\\python.exe\n"));
          proc.emit("close", 0);
        });
        return proc;
      }
      return makeHealthyWorkerProcess();
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { convertImage } = await import("./convertImage.ts");

    await convertImage(sourceA, 320);
    await convertImage(sourceB, 320);

    // One probe (-c) plus exactly one worker spawn for both conversions.
    const workerSpawns = spawnMock.mock.calls.filter(
      (call) => !(call[1] as string[]).includes("-c"),
    );
    expect(workerSpawns).toHaveLength(1);
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
        // Worker crashes at startup before ever reporting ready.
        proc.stderr.emit(
          "data",
          Buffer.from("ModuleNotFoundError: No module named 'PIL'"),
        );
        proc.emit("close", 1);
      });
      return proc;
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { convertImage, ImageConversionError } = await import("./convertImage.ts");

    const conversionPromise = convertImage(source, 320);
    await expect(conversionPromise).rejects.toBeInstanceOf(ImageConversionError);
    await expect(conversionPromise).rejects.toThrow(/requirements\.txt/i);
  });

  it("fails loudly at startup validation when the interpreter is missing image deps", async () => {
    // The interpreter launches but can't import the required modules — the probe
    // (args include "-c") exits non-zero. Resolution must surface this, not fall
    // back to a silently-broken interpreter.
    const spawnMock = jest.fn((_command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-c")) {
          proc.stderr.emit(
            "data",
            Buffer.from("ModuleNotFoundError: No module named 'pillow_heif'"),
          );
          proc.emit("close", 1);
          return;
        }
        proc.emit("close", 0);
      });
      return proc;
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { ensureImageConversionReady } = await import("./convertImage.ts");

    const readyPromise = ensureImageConversionReady();
    await expect(readyPromise).rejects.toThrow(/pillow_heif/);
    await expect(readyPromise).rejects.toThrow(/requirements\.txt/i);
  });

  it("does not fall back to system python when PHOTRIX_PYTHON is set but broken", async () => {
    process.env.PHOTRIX_PYTHON = "/opt/broken/python";

    const spawnMock = jest.fn((_command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-c")) {
          proc.stderr.emit(
            "data",
            Buffer.from("ModuleNotFoundError: No module named 'pillow_heif'"),
          );
          proc.emit("close", 1);
          return;
        }
        proc.emit("close", 0);
      });
      return proc;
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { ensureImageConversionReady } = await import("./convertImage.ts");

    await expect(ensureImageConversionReady()).rejects.toThrow(/PHOTRIX_PYTHON/);
    // Only the configured interpreter is probed — no silent fallback to python3.
    const probedCommands = spawnMock.mock.calls.map((call) => call[0]);
    expect(probedCommands).toContain("/opt/broken/python");
    expect(probedCommands).not.toContain("python3");
  });

  it("kills the conversion subprocess when the request aborts", async () => {
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-convert-cache-"));
    process.env.CACHE_DIR = cacheRoot;

    const source = path.join(cacheRoot, "source.jpg");
    writeFileSync(source, "img");

    const conversionStarted = deferred<void>();
    let conversionProc: ReturnType<typeof makeSpawnProcess> | null = null;
    const spawnMock = jest.fn((command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      if (args.includes("-c")) {
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from("C:\\Python\\python.exe\n"));
          proc.emit("close", 0);
        });
        return proc;
      }

      // Worker becomes ready but the conversion request never completes; the
      // abort must kill the whole worker process.
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "ready" }) + "\n"));
      });
      proc.stdin.write = () => {
        conversionStarted.resolve();
        return true;
      };
      proc.kill = jest.fn((signal?: string) => {
        queueMicrotask(() => proc.emit("close", null));
        return undefined;
      }) as typeof proc.kill;
      conversionProc = proc;
      return proc;
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { runWithRequestAbortSignal } = await import("../common/requestAbort.ts");
    const { convertImage } = await import("./convertImage.ts");
    const abortController = new AbortController();

    const conversionPromise = runWithRequestAbortSignal(abortController.signal, () =>
      convertImage(source, 320),
    );

    await conversionStarted.promise;
    abortController.abort();

    await expect(conversionPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(conversionProc).not.toBeNull();
    expect(conversionProc!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("skips multi-size generation when all outputs already cached", async () => {
    const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-convert-cache-"));
    process.env.CACHE_DIR = cacheRoot;

    const source = path.join(cacheRoot, "source.jpg");
    writeFileSync(source, "img");

    const { getMirroredCachedFilePath } = await import("../common/cacheUtils.ts");
    const cached320 = getMirroredCachedFilePath(source, 320, "webp");
    const cached640 = getMirroredCachedFilePath(source, 640, "webp");
    mkdirSync(path.dirname(cached320), { recursive: true });
    writeFileSync(cached320, "a");
    writeFileSync(cached640, "b");

    const spawnMock = jest.fn();
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { convertImageToMultipleSizes } = await import("./convertImage.ts");

    await convertImageToMultipleSizes(source, [320, 640]);

    expect(spawnMock).not.toHaveBeenCalled();
  });
});
