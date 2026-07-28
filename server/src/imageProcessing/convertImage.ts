import { spawn } from "child_process";
import { stat, mkdir, access } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { StandardHeight } from "../common/standardHeights.ts";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import { type ConversionPriority } from "../common/conversionPriority.ts";
import { scheduleMediaConversion } from "../common/mediaConversionScheduler.ts";
import { createAbortError, getRequestAbortSignal } from "../common/requestAbort.ts";
import { getLogger } from "../observability/logger.ts";
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "process_image.py");

const log = getLogger("convertImage");

// Helper function to ensure cache directory exists
const ensureCacheDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};

type PythonInvocation = {
  command: string;
  baseArgs: string[];
};

let pythonInvocationPromise: Promise<PythonInvocation> | null = null;

// process_image.py imports these at module load. The interpreter probe validates
// it can import them (not merely that python launches) so a missing dependency
// fails loudly during resolution instead of silently 422-ing every image-serving
// request. Importing pillow_heif loads a native lib, so allow more time than a
// bare interpreter launch.
const REQUIRED_PYTHON_MODULES = ["PIL", "pillow_heif"] as const;
const PYTHON_PROBE_TIMEOUT_MS = 15_000;
const DEPENDENCY_GUIDANCE =
  "Ensure the interpreter has the image dependencies (pip install -r requirements.txt), " +
  "or set PHOTRIX_PYTHON to a Python that does (e.g. the project .venv).";

const runProbe = async (
  command: string,
  args: string[],
  timeoutMs = 2_000,
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}> =>
  await new Promise((resolveProbe) => {
    const process = spawn(command, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, timeoutMs);

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      clearTimeout(timer);
      resolveProbe({
        ok: code === 0 && !timedOut,
        stdout,
        stderr,
        exitCode: code,
        timedOut,
      });
    });

    process.on("error", (error) => {
      clearTimeout(timer);
      resolveProbe({
        ok: false,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        exitCode: null,
        timedOut,
      });
    });
  });

const isWindowsStorePythonShim = (sysExecutable: string): boolean =>
  /\\AppData\\Local\\Microsoft\\WindowsApps\\python\.exe$/i.test(sysExecutable.trim());

// Validate that `command` can both launch and import the modules process_image.py
// needs. Returns the interpreter's own sys.executable path on success (used to
// reject the Windows Store shim), or a human-readable reason string on failure.
const probeInterpreter = async (
  command: string,
  baseArgs: string[],
): Promise<{ ok: true; sysExecutable: string } | { ok: false; reason: string }> => {
  const probeCode = `import sys, ${REQUIRED_PYTHON_MODULES.join(", ")}; print(sys.executable)`;
  const probe = await runProbe(
    command,
    [...baseArgs, "-c", probeCode],
    PYTHON_PROBE_TIMEOUT_MS,
  );
  if (probe.ok) {
    return { ok: true, sysExecutable: probe.stdout.trim() };
  }
  const detail = probe.timedOut
    ? "timed out"
    : `exit=${probe.exitCode} ${probe.stderr.trim()}`;
  return { ok: false, reason: detail };
};

const resolvePythonInvocation = async (): Promise<PythonInvocation> => {
  if (!pythonInvocationPromise) {
    // Reset the cache if resolution rejects so a transient probe failure (e.g. a
    // timeout under load) doesn't permanently pin conversion to a broken state.
    pythonInvocationPromise = resolvePythonInvocationUncached().catch((error) => {
      pythonInvocationPromise = null;
      throw error;
    });
  }
  return await pythonInvocationPromise;
};

const resolvePythonInvocationUncached = async (): Promise<PythonInvocation> => {
  // When explicitly configured, that interpreter is the answer — validate it and
  // fail loudly if it can't do the job rather than silently falling back to a
  // system python that would hide the misconfiguration.
  const configured = process.env.PHOTRIX_PYTHON?.trim();
  if (configured) {
    const probe = await probeInterpreter(configured, []);
    if (probe.ok) {
      return { command: configured, baseArgs: [] };
    }
    throw new Error(
      `PHOTRIX_PYTHON="${configured}" cannot run image conversion (${probe.reason}). ${DEPENDENCY_GUIDANCE}`,
    );
  }

  const candidates: PythonInvocation[] =
    process.platform === "win32"
      ? [
          { command: "py", baseArgs: [] },
          { command: "python", baseArgs: [] },
        ]
      : [
          { command: "python3", baseArgs: [] },
          { command: "python", baseArgs: [] },
        ];

  // Record why each candidate was rejected so a total failure names the actual
  // problem (interpreter absent vs present-but-missing-modules) instead of a
  // generic "not found".
  const rejections: string[] = [];
  for (const candidate of candidates) {
    const probe = await probeInterpreter(candidate.command, candidate.baseArgs);
    if (!probe.ok) {
      rejections.push(`${candidate.command}: ${probe.reason}`);
      continue;
    }
    if (
      process.platform === "win32" &&
      candidate.command === "python" &&
      isWindowsStorePythonShim(probe.sysExecutable)
    ) {
      // This commonly hangs or redirects to the Store; skip it.
      rejections.push(`${candidate.command}: Windows Store shim`);
      continue;
    }
    return candidate;
  }

  const guidance =
    process.platform === "win32"
      ? "Install Python from python.org (or via winget) so the `py` launcher is available, or set PHOTRIX_PYTHON to your python.exe. Also ensure App Execution Aliases for python.exe are disabled if you only have the Windows Store shim."
      : "Install Python 3 (python3) or set PHOTRIX_PYTHON to your python executable.";

  throw new Error(
    `No usable Python interpreter for image conversion. ${guidance} ${DEPENDENCY_GUIDANCE}\n` +
      `Tried:\n  ${rejections.join("\n  ")}`,
  );
};

/**
 * Resolve and validate the Python interpreter used for image conversion. Call at
 * startup so a missing interpreter or missing image dependency fails loudly here
 * instead of surfacing as a per-request 422 during image serving.
 */
export const ensureImageConversionReady = async (): Promise<void> => {
  const { command } = await resolvePythonInvocation();
  log.info({ pythonCommand: command }, "Image conversion Python validated");
};

// Converted images are emitted as WebP: ~30% smaller than JPEG at matching
// quality with universal modern-browser support. process_image.py picks the
// encoder from the output file extension, so the extension and content type must
// stay in sync — both are derived from here.
export const IMAGE_OUTPUT_EXTENSION = "webp";
export const IMAGE_OUTPUT_CONTENT_TYPE = "image/webp";

// WebP is the default (smaller than JPEG), but some consumers can't decode it —
// notably link-unfurl bots (Microsoft Teams, Outlook) that fetch og:image and
// silently drop the whole preview card on an unsupported format. Those callers
// ask for "jpeg" so the served bytes are universally viewable. process_image.py
// picks the encoder from the output extension, so ext and content type are paired.
export type ImageOutputFormat = "webp" | "jpeg";

const OUTPUT_EXTENSION: Record<ImageOutputFormat, string> = {
  webp: "webp",
  jpeg: "jpg",
};

const OUTPUT_CONTENT_TYPE: Record<ImageOutputFormat, string> = {
  webp: "image/webp",
  jpeg: "image/jpeg",
};

export const contentTypeForImageFormat = (format: ImageOutputFormat): string =>
  OUTPUT_CONTENT_TYPE[format];

export class ImageConversionError extends Error {
  constructor(
    message: string,
    readonly inputPath: string,
    readonly stderr: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "ImageConversionError";
  }
}

/**
 * Crop region expressed as normalized top-left fractions (0..1) of the
 * EXIF-oriented source image.
 */
export type CropBox = { x: number; y: number; width: number; height: number };

const buildConversionError = (
  inputPath: string,
  detail: string,
  exitCode?: number | null,
): ImageConversionError => {
  const normalizedError = detail.trim() || "Image conversion worker failed";
  const isCorrupt =
    /unexpected end of file/i.test(normalizedError) ||
    /invalid input/i.test(normalizedError);
  const isMissingDependency =
    /modulenotfounderror/i.test(normalizedError) ||
    /no module named/i.test(normalizedError);

  const baseMessage = isCorrupt
    ? `Corrupt or unreadable image ${inputPath}: ${normalizedError}`
    : `Image conversion failed for ${inputPath}: ${normalizedError}`;

  const message = isMissingDependency
    ? `${baseMessage}\n\nPython dependencies may be missing. Try: pip install -r server/src/imageProcessing/requirements.txt`
    : baseMessage;

  log.error(
    { inputPath, exitCode, stderr: normalizedError },
    "Image conversion failed",
  );
  return new ImageConversionError(message, inputPath, normalizedError, exitCode ?? undefined);
};

// ---------------------------------------------------------------------------
// Persistent conversion worker pool.
//
// Every conversion used to spawn a fresh Python process, which re-imports PIL
// and pillow_heif (a native lib) before touching a single pixel — ~0.5–1s of
// pure startup tax per image. A burst of uncached grid previews queues those
// spawns behind the media-conversion concurrency cap and the tail request
// waits 10s+. Instead we keep a small pool of `process_image.py --worker`
// processes alive (newline-delimited JSON over stdio, same pattern as the ML
// workers) so repeat conversions only pay for decode+encode.
//
// The pool sizes itself to observed demand: the scheduler admits at most
// PHOTRIX_MEDIA_CONVERSION_CONCURRENCY jobs at once, and each job briefly
// claims (or spawns) its own worker, so the pool never exceeds that cap.
// Idle workers are reaped after a TTL to give their RAM back.
// ---------------------------------------------------------------------------

const WORKER_READY_TIMEOUT_MS = 30_000;
const WORKER_IDLE_TTL_MS = 60_000;
// A conversion is seconds of work; anything this long means a wedged decoder.
// Killing the worker frees its scheduler lane and it respawns on next use.
const JOB_TIMEOUT_MS = 5 * 60_000;
const STDERR_TAIL_LIMIT = 4_000;

type PoolWorker = {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
  busy: boolean;
  dead: boolean;
  stderrTail: string;
  exitCode: number | null;
  currentId: number;
  pending: { id: number; resolve: () => void; reject: (error: Error) => void } | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const pool: PoolWorker[] = [];

const destroyWorker = (worker: PoolWorker, error: Error): void => {
  if (worker.dead) return;
  worker.dead = true;
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = null;
  const index = pool.indexOf(worker);
  if (index >= 0) pool.splice(index, 1);
  try {
    worker.child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  const pending = worker.pending;
  worker.pending = null;
  pending?.reject(error);
};

const createWorker = (command: string, baseArgs: string[]): PoolWorker => {
  const child = spawn(command, [...baseArgs, scriptPath, "--worker"], {
    windowsHide: true,
  });

  const worker: PoolWorker = {
    child,
    ready: Promise.resolve(), // replaced below
    busy: false,
    dead: false,
    stderrTail: "",
    exitCode: null,
    currentId: 0,
    pending: null,
    idleTimer: null,
  };

  worker.ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimer);
      fn();
    };
    const readyTimer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `Image conversion worker not ready within ${WORKER_READY_TIMEOUT_MS}ms`,
          ),
        ),
      );
      destroyWorker(worker, new Error("image conversion worker startup timed out"));
    }, WORKER_READY_TIMEOUT_MS);
    readyTimer.unref?.();

    let stdoutBuffer = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message: { type?: string; id?: number | null; ok?: boolean; error?: string };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "ready") {
          settle(resolve);
          continue;
        }
        const pending = worker.pending;
        if (!pending || message.id !== pending.id) continue;
        worker.pending = null;
        if (message.ok) pending.resolve();
        else pending.reject(new Error(message.error ?? "unknown conversion error"));
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      worker.stderrTail = (worker.stderrTail + data.toString()).slice(
        -STDERR_TAIL_LIMIT,
      );
    });

    // The child's stdin can emit an async 'error' (e.g. EPIPE) if the Python
    // process dies between requests; without a listener Node escalates it to an
    // uncaught exception.
    child.stdin?.on("error", (error) => {
      log.debug({ err: error }, "image conversion worker stdin error");
    });

    child.once("error", (error) => {
      settle(() =>
        reject(
          new Error(`Failed to start image conversion worker: ${error.message}`),
        ),
      );
      destroyWorker(worker, error);
    });

    child.once("close", (code) => {
      worker.exitCode = code;
      const detail =
        worker.stderrTail.trim() ||
        `image conversion worker exited with code ${code ?? "unknown"}`;
      settle(() => reject(new Error(detail)));
      destroyWorker(worker, new Error(detail));
    });
  });
  // A worker that dies while idle just leaves the pool; nothing awaits it.
  worker.ready.catch(() => {});

  return worker;
};

const acquireWorker = (command: string, baseArgs: string[]): PoolWorker => {
  const idle = pool.find((worker) => !worker.busy && !worker.dead);
  if (idle) {
    idle.busy = true;
    if (idle.idleTimer) clearTimeout(idle.idleTimer);
    idle.idleTimer = null;
    return idle;
  }
  const worker = createWorker(command, baseArgs);
  worker.busy = true;
  pool.push(worker);
  return worker;
};

const releaseWorker = (worker: PoolWorker): void => {
  if (worker.dead) return;
  worker.busy = false;
  worker.idleTimer = setTimeout(() => {
    destroyWorker(worker, new Error("image conversion worker reaped after idle"));
  }, WORKER_IDLE_TTL_MS);
  worker.idleTimer.unref?.();
};

/**
 * Kill every pooled conversion worker. Called from the server's graceful
 * shutdown so a restart doesn't orphan them (they hold no VRAM, but each keeps
 * ~100MB of RSS alive forever otherwise).
 */
export const shutdownImageConversionWorkers = (): void => {
  for (const worker of [...pool]) {
    destroyWorker(worker, new Error("server shutting down"));
  }
};

const generateImageUnthrottled = async (
  inputPath: string,
  outputs: Array<{ path: string; height: StandardHeight; crop?: CropBox }>,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) throw createAbortError();

  // Resolve a real python executable (Windows Store shim `python.exe` will not work).
  const { command, baseArgs } = await resolvePythonInvocation();
  const worker = acquireWorker(command, baseArgs);

  const request = {
    id: ++worker.currentId,
    inputPath,
    outputs: outputs.map((o) => ({
      path: o.path,
      height: o.height === "original" ? null : o.height,
      ...(o.crop ? { crop: [o.crop.x, o.crop.y, o.crop.width, o.crop.height] } : {}),
    })),
  };

  // An abort mid-decode kills the worker outright — there is no way to cancel
  // an in-flight PIL decode cooperatively, and freeing the CPU now is the
  // point. The pool respawns a fresh worker on next use.
  const onAbort = () => destroyWorker(worker, createAbortError());
  signal?.addEventListener("abort", onAbort, { once: true });

  const jobTimer = setTimeout(() => {
    destroyWorker(
      worker,
      buildConversionError(
        inputPath,
        `conversion timed out after ${JOB_TIMEOUT_MS}ms`,
      ),
    );
  }, JOB_TIMEOUT_MS);
  jobTimer.unref?.();

  try {
    try {
      await worker.ready;
    } catch (error) {
      // Startup failure (missing deps, crashed interpreter): classify from the
      // worker's stderr so the caller gets the same actionable guidance the
      // spawn-per-job design produced.
      if (signal?.aborted) throw createAbortError();
      throw buildConversionError(
        inputPath,
        error instanceof Error ? error.message : String(error),
        worker.exitCode,
      );
    }
    if (signal?.aborted) throw createAbortError();

    await new Promise<void>((resolve, reject) => {
      worker.pending = { id: request.id, resolve, reject };
      try {
        worker.child.stdin?.write(JSON.stringify(request) + "\n");
      } catch (error) {
        worker.pending = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).catch((error: unknown) => {
      if (signal?.aborted) throw createAbortError();
      if (error instanceof ImageConversionError) throw error;
      throw buildConversionError(
        inputPath,
        error instanceof Error ? error.message : String(error),
        worker.exitCode,
      );
    });

    releaseWorker(worker);
  } catch (error) {
    // Failure paths that leave the worker healthy (a per-job error response)
    // can still reuse it; crash/abort paths have already destroyed it.
    if (!worker.dead && !worker.pending) releaseWorker(worker);
    throw error;
  } finally {
    clearTimeout(jobTimer);
    signal?.removeEventListener("abort", onAbort);
  }
};

const generateImage = async (
  inputPath: string,
  outputs: Array<{ path: string; height: StandardHeight; crop?: CropBox }>,
): Promise<void> => {
  const key = outputs
    .map((output) => output.path)
    .sort()
    .join("\n");
  await scheduleMediaConversion(
    `image:${key}`,
    async (signal) => {
      const missingOutputs = await Promise.all(
        outputs.map(async (output) => ({
          ...output,
          exists: await access(output.path).then(
            () => true,
            () => false,
          ),
        })),
      );
      const uncachedOutputs = missingOutputs.filter((output) => !output.exists);
      if (uncachedOutputs.length === 0) {
        return;
      }
      await generateImageUnthrottled(inputPath, uncachedOutputs, signal);
    },
    {
      signal: getRequestAbortSignal(),
    },
  );
};

/**
 * Creates a converted image at the specified height, caching the result.
 * @returns Path of converted image
 */
export const convertImage = async (
  filePath: string,
  height: StandardHeight = 2160,
  _opts?: { priority?: ConversionPriority; format?: ImageOutputFormat },
): Promise<string> => {
  await stat(filePath);
  const extension = OUTPUT_EXTENSION[_opts?.format ?? "webp"];
  const cachedPath = getMirroredCachedFilePath(filePath, height, extension);

  const cachedExists = await access(cachedPath).then(
    () => true,
    () => false,
  );
  if (cachedExists) {
    return cachedPath;
  }

  await ensureCacheDir(cachedPath);
  await generateImage(filePath, [{ path: cachedPath, height }]);
  return cachedPath;
};

/** Rounds a fraction to 5 decimals so near-identical crops share a cache entry. */
const cropToken = (crop: CropBox): string => {
  const q = (n: number) => Math.round(clamp01(n) * 1e5).toString();
  return `crop_${q(crop.x)}_${q(crop.y)}_${q(crop.width)}_${q(crop.height)}`;
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Creates a converted image cropped to `crop` (normalized top-left fractions of
 * the EXIF-oriented image) and resized so its longest side is at most `height`,
 * caching the result. The crop is applied before the resize, so a small crop is
 * served at higher effective resolution (and smaller file size) than cropping a
 * pre-scaled image would allow.
 * @returns Path of converted image
 */
export const convertImageCrop = async (
  filePath: string,
  crop: CropBox,
  height: StandardHeight = 2160,
  _opts?: { priority?: ConversionPriority },
): Promise<string> => {
  await stat(filePath);
  const cachedPath = getMirroredCachedFilePath(
    filePath,
    `${height}.${cropToken(crop)}`,
    IMAGE_OUTPUT_EXTENSION,
  );

  const cachedExists = await access(cachedPath).then(
    () => true,
    () => false,
  );
  if (cachedExists) {
    return cachedPath;
  }

  await ensureCacheDir(cachedPath);
  await generateImage(filePath, [{ path: cachedPath, height, crop }]);
  return cachedPath;
};

export const convertImageToMultipleSizes = async (
  filePath: string,
  heights: StandardHeight[],
  _opts?: { priority?: ConversionPriority },
): Promise<void> => {
  await stat(filePath);

  const existChecks = await Promise.all(
    heights.map(async (height) => {
      const p = getMirroredCachedFilePath(filePath, height, IMAGE_OUTPUT_EXTENSION);
      const exists = await access(p).then(
        () => true,
        () => false,
      );
      return { height, path: p, exists };
    }),
  );
  const outputs = existChecks.filter((o) => !o.exists);

  if (outputs.length === 0) {
    return;
  }

  await Promise.all(outputs.map((o) => ensureCacheDir(o.path)));
  await generateImage(filePath, outputs);
};
