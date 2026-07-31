import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CACHE_DIR } from "../common/cacheUtils.js";
import { getLogger } from "../observability/logger.ts";
import { buildPythonProcessEnv, resolvePythonCommand } from "../python/pythonRuntime.ts";
import {
  noteWhisperWorkerExit,
  noteWhisperWorkerReady,
  noteWhisperWorkerStarting,
  noteWhisperWorkerTimeout,
} from "./whisperRuntimeState.ts";
import {
  COMPUTE_WORKER_IDS,
  registerComputeWorker,
  acquireGpuInitSlot,
  createSuspensionAwareTimeout,
  consumeDeliberateKill,
  markWorkerEvictedError,
} from "../taskOrchestrator/computeWorkers.ts";

const log = getLogger("whisperWorker");

export type TranscriptSegment = { start: number; end: number; text: string };

type WorkerResponse =
  | {
      type: "ready";
      device?: string;
      fallbackFrom?: string;
      fallbackReason?: string;
    }
  | { type: "error"; error: string }
  | { id: number; segments: TranscriptSegment[] }
  | { id: number | null; error: string };

type PendingRequest = {
  resolve: (segments: TranscriptSegment[]) => void;
  reject: (error: Error) => void;
  timeout: { clear: () => void };
  operation: string;
  videoPath?: string;
  startedAt: number;
};

// Long timeout: large-v3 on CPU can be slow for long videos
const REQUEST_TIMEOUT_MS = 30 * 60 * 1_000;
const SLOW_REQUEST_MS = 5 * 60 * 1_000;
const WHISPER_SCRIPT = path.resolve(process.cwd(), "python", "whisper_worker.py");

let nextRequestId = 1;
let worker: ChildProcessWithoutNullStreams | null = null;
let readyPromise: Promise<void> | null = null;
const pending = new Map<number, PendingRequest>();

// Whisper is background-only (transcription), so it can be frozen wholesale
// while a user request is in flight.
registerComputeWorker(COMPUTE_WORKER_IDS.whisper, () => worker?.pid ?? null);

const canAccess = async (targetPath: string): Promise<boolean> => {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const rejectAllPending = (error: Error) => {
  for (const { reject, timeout } of pending.values()) {
    timeout.clear();
    reject(error);
  }
  pending.clear();
};

const describePendingRequests = () =>
  [...pending.entries()]
    .map(([id, request]) => ({
      id,
      operation: request.operation,
      videoPath: request.videoPath,
      elapsedMs: Date.now() - request.startedAt,
    }))
    .sort((a, b) => b.elapsedMs - a.elapsedMs)
    .slice(0, 5);

const onWorkerLine = (
  line: string,
  onReady: (message: Extract<WorkerResponse, { type: "ready" }>) => void,
  onInitError: (msg: string) => void,
) => {
  let message: WorkerResponse;
  try {
    message = JSON.parse(line) as WorkerResponse;
  } catch {
    return;
  }

  if ("type" in message) {
    if (message.type === "ready") {
      onReady(message);
    } else if (message.type === "error") {
      onInitError(message.error);
    }
    return;
  }

  if (!("id" in message) || message.id === null) return;

  const request = pending.get(message.id);
  if (!request) return;

  pending.delete(message.id);
  request.timeout.clear();

  const elapsedMs = Date.now() - request.startedAt;

  if ("error" in message) {
    log.warn(
      {
        id: message.id,
        operation: request.operation,
        videoPath: request.videoPath,
        elapsedMs,
        error: message.error,
      },
      "Whisper request failed",
    );
    request.reject(new Error((message as { id: number; error: string }).error));
    return;
  }

  const segments = (message as { id: number; segments: TranscriptSegment[] }).segments;
  const logMethod = elapsedMs >= SLOW_REQUEST_MS ? log.info.bind(log) : log.debug.bind(log);
  logMethod(
    {
      id: message.id,
      operation: request.operation,
      videoPath: request.videoPath,
      elapsedMs,
      segmentCount: segments.length,
    },
    elapsedMs >= SLOW_REQUEST_MS ? "Whisper request completed slowly" : "Whisper request completed",
  );

  request.resolve(segments);
};

const ensureWorkerReady = async (): Promise<void> => {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    if (!(await canAccess(WHISPER_SCRIPT))) {
      throw new Error(`Whisper worker script missing at ${WHISPER_SCRIPT}`);
    }

    const pythonCommand = await resolvePythonCommand();
    const pythonEnv = await buildPythonProcessEnv(pythonCommand, process.env);

    // Serialize GPU model loading to avoid OOM from simultaneous CUDA loads.
    const releaseGpuSlot = await acquireGpuInitSlot();

    log.info("Starting Whisper worker — may take a minute on first run");
    const child = spawn(pythonCommand, [WHISPER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...pythonEnv, HF_HOME: path.join(CACHE_DIR, "huggingface") },
    });
    worker = child;
    noteWhisperWorkerStarting(child.pid);

    // The child's stdin can emit an async 'error' (e.g. EPIPE) if the Python
    // process dies between requests. Without a listener Node escalates it to an
    // uncaught exception and takes down the whole server. Swallow it here — the
    // 'exit' handler rejects any pending requests and resets state so the next
    // call respawns a fresh worker.
    child.stdin.on("error", (error) => {
      log.warn({ err: error }, "Whisper worker stdin error (worker likely exited)");
    });

    const slowTimer = setTimeout(() => {
      log.warn(
        "Whisper worker is still loading — likely downloading the model for the first time, please wait",
      );
    }, 15_000);

      const ready = new Promise<void>((resolve, reject) => {
        let settled = false;

      // Bound model load/init. Without this a worker that never emits "ready"
      // (stuck import, partial model download) leaves ensureWorkerReady awaiting
      // forever; because readyPromise is memoised that wedges every later request
      // too. On timeout we kill the child so the exit handler resets state and the
      // next call respawns a fresh worker.
      //
      // Suspension-aware so the clock pauses while the worker is SIGSTOP'd for a
      // user request — a plain setTimeout would fire during suspension and falsely
      // kill a worker that is simply frozen, not stuck.
      const readyTimeoutMs =
        Number(process.env.PHOTRIX_WHISPER_READY_TIMEOUT_MS) || 5 * 60 * 1_000;
      const readyTimer = createSuspensionAwareTimeout(
        COMPUTE_WORKER_IDS.whisper,
        readyTimeoutMs,
        () => {
          rejectReady(
            new Error(`Whisper worker failed to become ready within ${readyTimeoutMs}ms`),
          );
          child.kill();
        },
      );

      const resolveReady = (readyState: Extract<WorkerResponse, { type: "ready" }>) => {
        if (settled) return;
        clearTimeout(slowTimer);
        readyTimer.clear();
        settled = true;
        noteWhisperWorkerReady({
          pid: child.pid,
          device: readyState.device,
          fallbackFrom: readyState.fallbackFrom,
          fallbackReason: readyState.fallbackReason,
        });
        log.info(
          {
            device: readyState.device ?? "unknown",
            fallbackFrom: readyState.fallbackFrom,
            fallbackReason: readyState.fallbackReason,
          },
          "Whisper worker ready",
        );
        resolve();
      };

      const rejectReady = (error: Error) => {
        if (settled) return;
        clearTimeout(slowTimer);
        readyTimer.clear();
        settled = true;
        reject(error);
      };

      createInterface({ input: child.stdout }).on("line", (line) => {
        onWorkerLine(line, resolveReady, (msg) =>
          rejectReady(new Error(`Whisper worker failed to initialise: ${msg}`)),
        );
      });

      createInterface({ input: child.stderr }).on("line", (line) => {
        log.warn({ line }, "worker stderr");
      });

      child.once("error", (error) => {
        rejectReady(
          new Error(
            `Failed to start Whisper worker using '${pythonCommand}': ${error.message}`,
          ),
        );
      });

      child.once("exit", (code, signal) => {
        const pendingCount = pending.size;
        worker = null;
        readyPromise = null;
        // A kill we issued ourselves (GPU reclaim for playback, shutdown) is
        // not a failure of the in-flight files: tag the rejection so the task
        // runner leaves them pending for retry instead of marking them errored.
        const evicted = consumeDeliberateKill(child.pid);
        const err = new Error(
          `Whisper worker exited${signal ? ` with signal ${signal}` : ` with code ${code ?? "unknown"}`}${evicted ? " (deliberately evicted for a user request)" : ""}`,
        );
        noteWhisperWorkerExit({
          code: code ?? null,
          signal: signal ?? null,
          evicted,
          pendingCount,
        });
        if (evicted) markWorkerEvictedError(err);
        log.warn(
          {
            code,
            signal,
            pendingCount,
            evicted,
            pending: describePendingRequests(),
          },
          "Whisper worker exited",
        );
        rejectAllPending(err);
        if (!settled) rejectReady(err);
      });
    });

    try {
      await ready;
    } finally {
      releaseGpuSlot();
    }
  })();

  try {
    await readyPromise;
  } catch (error) {
    readyPromise = null;
    worker = null;
    throw error;
  }
};

const sendRequest = async (
  payload: Record<string, unknown>,
): Promise<TranscriptSegment[]> => {
  await ensureWorkerReady();
  if (!worker) throw new Error("Whisper worker is not available");

  const id = nextRequestId++;
  const operation = typeof payload.operation === "string" ? payload.operation : "unknown";
  const videoPath = typeof payload.videoPath === "string" ? payload.videoPath : undefined;

  return new Promise<TranscriptSegment[]>((resolve, reject) => {
    const timeout = createSuspensionAwareTimeout(
      COMPUTE_WORKER_IDS.whisper,
      REQUEST_TIMEOUT_MS,
      () => {
        const request = pending.get(id);
        pending.delete(id);
        noteWhisperWorkerTimeout({
          requestId: id,
          operation: request?.operation ?? operation,
          videoPath: request?.videoPath ?? videoPath,
          elapsedMs: request ? Date.now() - request.startedAt : undefined,
        });
        log.warn(
          {
            id,
            pid: worker?.pid,
            operation: request?.operation ?? operation,
            videoPath: request?.videoPath ?? videoPath,
            elapsedMs: request ? Date.now() - request.startedAt : undefined,
            timeoutMs: REQUEST_TIMEOUT_MS,
            otherPending: describePendingRequests(),
          },
          "Whisper worker timed out — killing process",
        );
        worker?.kill();
        reject(new Error(`Whisper worker timed out for request ${id}`));
      },
    );

    pending.set(id, { resolve, reject, timeout, operation, videoPath, startedAt: Date.now() });

    try {
      log.debug(
        { id, pid: worker?.pid, operation, videoPath, pendingCount: pending.size },
        "Dispatching Whisper request",
      );
      worker?.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
    } catch (error) {
      timeout.clear();
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
};

export const transcribeWithWhisper = (videoPath: string): Promise<TranscriptSegment[]> =>
  sendRequest({ operation: "transcribe", videoPath });
