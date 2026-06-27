import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CACHE_DIR } from "../common/cacheUtils.js";
import { getLogger } from "../observability/logger.ts";
import {
  COMPUTE_WORKER_IDS,
  registerComputeWorker,
  withForegroundWorker,
  awaitForegroundIdle,
} from "../taskOrchestrator/computeWorkers.ts";
import type { DetectedFace } from "../faceDetection/faceDetector.type.ts";

const log = getLogger("imageAnalysisWorker");

/**
 * Process manager for the combined image-analysis worker. A single Python
 * process holds both the InsightFace and CLIP models and decodes each image
 * once, so face detection and semantic embedding no longer load every photo
 * twice. The Node side keeps the same request/response framing as the other
 * workers and dispatches by numeric id.
 *
 * A single Python process handles both background image analysis and search
 * text-embedding. Inside the worker, embedText requests are routed to a
 * dedicated thread so a search query waits at most one CLIP forward pass
 * (~200 ms) rather than an entire analyzeImage pipeline (5–15 s).
 */

type RawFace = {
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
  embedding: number[];
};

type WorkerSuccess = {
  id: number;
  faces?: RawFace[];
  embedding?: number[];
  facesError?: string;
  embeddingError?: string;
};

type WorkerResponse =
  | { type: "ready" }
  | { id: number | null; error: string; permanent?: boolean }
  | WorkerSuccess;

/** Thrown when the image itself is unreadable (truncated, corrupt, missing).
 *  Unlike transient worker errors (timeout, crash), this will never succeed on
 *  retry, so callers should record a permanent skip rather than scheduling a
 *  re-run.
 */
export class PermanentImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentImageError";
  }
}

export type AnalyzeImageOptions = { faces: boolean; embed: boolean };

export type ImageAnalysisResult = {
  faces?: DetectedFace[];
  embedding?: Float32Array;
  facesError?: string;
  embeddingError?: string;
};

type PendingRequest = {
  resolve: (value: WorkerSuccess) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 120_000;
const WORKER_SCRIPT = path.resolve(process.cwd(), "python", "image_analysis_worker.py");

const isWindows = process.platform === "win32";

const canAccess = async (targetPath: string): Promise<boolean> => {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const resolvePythonCommand = async (): Promise<string> => {
  const fromEnv =
    process.env.PHOTRIX_PYTHON?.trim() ?? process.env.PHOTRIX_PYTHON_EXECUTABLE?.trim();
  if (fromEnv) return fromEnv;

  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, ".venv", "Scripts", "python.exe"),
    path.join(cwd, ".venv", "bin", "python"),
  ];
  for (const candidate of candidates) {
    if (await canAccess(candidate)) return candidate;
  }
  return isWindows ? "python" : "python3";
};

const asDetectedFace = (face: RawFace): DetectedFace => ({
  box: {
    x: face.box.x,
    y: face.box.y,
    width: face.box.width,
    height: face.box.height,
  },
  confidence: face.confidence,
  embedding: Float64Array.from(face.embedding),
});

type WorkerHandle = {
  ensureReady: () => Promise<void>;
  send: (payload: Record<string, unknown>) => Promise<WorkerSuccess>;
  getProcess: () => ChildProcessWithoutNullStreams | null;
};

const createWorkerHandle = (label: string): WorkerHandle => {
  let nextId = 1;
  let proc: ChildProcessWithoutNullStreams | null = null;
  let readyPromise: Promise<void> | null = null;
  const pending = new Map<number, PendingRequest>();

  const rejectAllPending = (error: Error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  const onLine = (line: string, onReady: () => void) => {
    let message: WorkerResponse;
    try {
      message = JSON.parse(line) as WorkerResponse;
    } catch {
      return;
    }

    if ("type" in message && message.type === "ready") {
      onReady();
      return;
    }

    if (!("id" in message) || message.id === null) return;

    const request = pending.get(message.id);
    if (!request) return;

    pending.delete(message.id);
    clearTimeout(request.timer);

    if ("error" in message) {
      const err = message.permanent
        ? new PermanentImageError(message.error)
        : new Error(message.error);
      request.reject(err);
      return;
    }

    request.resolve(message);
  };

  const ensureReady = async (): Promise<void> => {
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      if (!(await canAccess(WORKER_SCRIPT))) {
        throw new Error(`Image analysis worker script missing at ${WORKER_SCRIPT}`);
      }

      const pythonCommand = await resolvePythonCommand();
      const provider = process.env.PHOTRIX_CLIP_PROVIDER ?? "CPUExecutionProvider";

      log.info({ label, provider }, "Starting image analysis worker — may take a minute on first run");
      const child = spawn(pythonCommand, [WORKER_SCRIPT, provider], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, HF_HOME: path.join(CACHE_DIR, "huggingface") },
      });
      proc = child;

      // The child's stdin can emit an async 'error' (e.g. EPIPE) if the Python
      // process dies between requests. Without a listener Node escalates it to an
      // uncaught exception and takes down the whole server. Swallow it here — the
      // 'exit' handler rejects any pending requests and resets state so the next
      // call respawns a fresh worker.
      child.stdin.on("error", (error) => {
        log.warn({ err: error }, "Image analysis worker stdin error (worker likely exited)");
      });

      const ready = new Promise<void>((resolve, reject) => {
        let settled = false;

        const resolveReady = () => {
          if (settled) return;
          clearTimeout(readyTimer);
          settled = true;
          log.info({ label }, "Image analysis worker ready");
          resolve();
        };

        const rejectReady = (error: Error) => {
          if (settled) return;
          clearTimeout(readyTimer);
          settled = true;
          reject(error);
        };

        // Bound model load/init. Without this a worker that never emits "ready"
        // leaves ensureReady awaiting forever, and because readyPromise is
        // memoised that wedges every later request too. On timeout we kill the
        // child so the exit handler resets state and the next call respawns.
        const readyTimeoutMs =
          Number(process.env.PHOTRIX_IMAGE_WORKER_READY_TIMEOUT_MS) || 5 * 60 * 1_000;
        const readyTimer = setTimeout(() => {
          rejectReady(
            new Error(
              `Image analysis worker (${label}) failed to become ready within ${readyTimeoutMs}ms`,
            ),
          );
          child.kill();
        }, readyTimeoutMs);

        createInterface({ input: child.stdout }).on("line", (line) => {
          onLine(line, resolveReady);
        });

        createInterface({ input: child.stderr }).on("line", (line) => {
          log.warn({ line, worker: label }, "worker stderr");
        });

        child.once("error", (error) => {
          rejectReady(
            new Error(
              `Failed to start image analysis worker (${label}) using '${pythonCommand}': ${error.message}`,
            ),
          );
        });

        child.once("exit", (code, signal) => {
          const pendingCount = pending.size;
          proc = null;
          readyPromise = null;
          const err = new Error(
            `Image analysis worker (${label}) exited${signal ? ` with signal ${signal}` : ` with code ${code ?? "unknown"}`}`,
          );
          log.warn({ label, code, signal, pendingCount }, "Image analysis worker exited");
          rejectAllPending(err);
          if (!settled) rejectReady(err);
        });
      });

      await ready;
    })();

    try {
      await readyPromise;
    } catch (error) {
      readyPromise = null;
      proc = null;
      throw error;
    }
  };

  const send = (payload: Record<string, unknown>): Promise<WorkerSuccess> => {
    const id = nextId++;

    return new Promise<WorkerSuccess>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // A timeout means the worker is wedged on a forward pass (a pathological
        // image, a stuck model run). The Python side holds _clip_lock during the
        // pass, so a hung analyzeImage permanently starves the embedText thread
        // used by search — and the stuck request never returns on its own. Kill
        // the process; the exit handler rejects any pending requests and resets
        // state so the next call respawns a fresh worker (matches clapWorker).
        log.warn({ label, id, timeoutMs: REQUEST_TIMEOUT_MS }, "Image analysis worker timed out — killing process");
        proc?.kill();
        reject(new Error(`Image analysis worker (${label}) timed out for request ${id}`));
      }, REQUEST_TIMEOUT_MS);

      pending.set(id, { resolve, reject, timer });

      try {
        proc?.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  return { ensureReady, send, getProcess: () => proc };
};

const analysisWorker = createWorkerHandle("analysis");

// Let the orchestrator freeze this process while a user request is in flight.
// embedText (search) is routed through withForegroundWorker below so a query is
// never blocked by a background suspension of the shared worker.
registerComputeWorker(
  COMPUTE_WORKER_IDS.image,
  () => analysisWorker.getProcess()?.pid ?? null,
);

/**
 * Decode an image once and run the requested model(s). The caller asks only for
 * the parts a file is still missing, so completed work is never recomputed.
 */
export const analyzeImage = async (
  imagePath: string,
  { faces, embed }: AnalyzeImageOptions,
): Promise<ImageAnalysisResult> => {
  // Yield to any in-flight foreground search embedding: it shares this process
  // and its model lock, so dispatching background passes first would starve it.
  await awaitForegroundIdle(COMPUTE_WORKER_IDS.image);
  await analysisWorker.ensureReady();
  if (!analysisWorker.getProcess()) throw new Error("Image analysis worker is not available");

  const raw = await analysisWorker.send({
    operation: "analyzeImage",
    imagePath,
    faces,
    embed,
  });

  const result: ImageAnalysisResult = {};
  if (raw.faces) result.faces = raw.faces.map(asDetectedFace);
  if (raw.embedding) result.embedding = new Float32Array(raw.embedding);
  if (raw.facesError) result.facesError = raw.facesError;
  if (raw.embeddingError) result.embeddingError = raw.embeddingError;
  return result;
};

export const embedText = (text: string): Promise<Float32Array> =>
  // Pin the worker awake for the duration: this is the foreground search path,
  // and the same process may currently be SIGSTOP'd for background work.
  withForegroundWorker(COMPUTE_WORKER_IDS.image, async () => {
    await analysisWorker.ensureReady();
    if (!analysisWorker.getProcess())
      throw new Error("Image analysis worker is not available");
    const raw = await analysisWorker.send({ operation: "embedText", text });
    if (!raw.embedding) throw new Error("Image analysis worker returned no embedding");
    return new Float32Array(raw.embedding);
  });
