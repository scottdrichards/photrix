import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CACHE_DIR } from "../common/cacheUtils.js";
import { getLogger } from "../observability/logger.ts";
import { buildPythonProcessEnv, resolvePythonCommand } from "../python/pythonRuntime.ts";
import {
  COMPUTE_WORKER_IDS,
  registerComputeWorker,
  withForegroundWorker,
  awaitForegroundIdle,
  acquireGpuInitSlot,
  createSuspensionAwareTimeout,
  consumeDeliberateKill,
  killAndAwaitExit,
  markWorkerEvictedError,
} from "../taskOrchestrator/computeWorkers.ts";

const log = getLogger("clapWorker");

type WorkerResponse =
  | { type: "ready" }
  | { id: number; embedding: number[] }
  | { id: number | null; error: string };

type PendingRequest = {
  resolve: (embedding: Float32Array) => void;
  reject: (error: Error) => void;
  timeout: { clear: () => void };
};

const REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
const CLAP_SCRIPT = path.resolve(process.cwd(), "python", "clap_worker.py");

let nextRequestId = 1;
let worker: ChildProcessWithoutNullStreams | null = null;
let readyPromise: Promise<void> | null = null;
const pending = new Map<number, PendingRequest>();

// Allow the orchestrator to freeze the worker during user requests. embedText
// (search) is routed through withForegroundWorker, so a query is never blocked
// by a background suspension of this shared process.
registerComputeWorker(COMPUTE_WORKER_IDS.clap, () => worker?.pid ?? null);

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

const onWorkerLine = (
  line: string,
  onReady: () => void,
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
      onReady();
    } else if ("error" in message) {
      onInitError((message as { type: string; error: string }).error);
    }
    return;
  }

  if (!("id" in message) || message.id === null) return;

  const request = pending.get(message.id);
  if (!request) return;

  pending.delete(message.id);
  request.timeout.clear();

  if ("error" in message) {
    request.reject(new Error((message as { id: number; error: string }).error));
    return;
  }

  const arr = new Float32Array(
    (message as { id: number; embedding: number[] }).embedding,
  );
  request.resolve(arr);
};

const ensureWorkerReady = async (): Promise<void> => {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    // Emergency kill switch: see main.ts. Checked at spawn time (not just in
    // the background-task registration) so a search's foreground CLAP call
    // is also blocked — "disable audio entirely" should mean no CLAP process
    // ever spawns, not just that the background embedding backlog stops.
    if (process.env.PHOTRIX_DISABLE_AUDIO === "1") {
      throw new Error("CLAP worker disabled via PHOTRIX_DISABLE_AUDIO=1");
    }
    if (!(await canAccess(CLAP_SCRIPT))) {
      throw new Error(`CLAP worker script missing at ${CLAP_SCRIPT}`);
    }

    const pythonCommand = await resolvePythonCommand();
    const pythonEnv = await buildPythonProcessEnv(pythonCommand, process.env);

    // Wait for any other GPU worker (e.g. image analysis) to finish loading
    // before spawning — simultaneous CUDA model loads can OOM the GPU.
    const releaseGpuSlot = await acquireGpuInitSlot();

    const child = spawn(pythonCommand, [CLAP_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...pythonEnv, HF_HOME: path.join(CACHE_DIR, "huggingface") },
    });
    worker = child;

    // The child's stdin can emit an async 'error' (e.g. EPIPE) if the Python
    // process dies between requests. Without a listener Node escalates it to an
    // uncaught exception and takes down the whole server. Swallow it here — the
    // 'exit' handler below rejects any pending requests and resets state so the
    // next call respawns a fresh worker.
    child.stdin.on("error", (error) => {
      log.warn({ err: error }, "CLAP worker stdin error (worker likely exited)");
    });

    log.info("Starting CLAP worker — may take a minute to download models on first run");
    const slowTimer = setTimeout(() => {
      log.warn(
        "CLAP worker is still loading — likely downloading the model for the first time, please wait",
      );
    }, 15_000);

    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;

      const resolveReady = () => {
        if (settled) return;
        clearTimeout(slowTimer);
        clearTimeout(readyTimer);
        settled = true;
        log.info("CLAP worker ready");
        resolve();
      };

      const rejectReady = (error: Error) => {
        if (settled) return;
        clearTimeout(slowTimer);
        clearTimeout(readyTimer);
        settled = true;
        reject(error);
      };

      // Bound model load/init. Without this a worker that never emits "ready"
      // (stuck import, partial model download) leaves ensureWorkerReady awaiting
      // forever; because readyPromise is memoised that wedges every later
      // request too. On timeout we kill the child so the exit handler resets
      // state and the next call respawns a fresh worker.
      const readyTimeoutMs =
        Number(process.env.PHOTRIX_CLAP_READY_TIMEOUT_MS) || 5 * 60 * 1_000;
      const readyTimer = setTimeout(() => {
        rejectReady(
          new Error(`CLAP worker failed to become ready within ${readyTimeoutMs}ms`),
        );
        // The outer `await ready` catch below also force-kills+waits on any
        // rejection; this call just makes sure the OS-level kill starts
        // immediately rather than waiting for that catch to run.
        child.kill("SIGKILL");
      }, readyTimeoutMs);

      createInterface({ input: child.stdout }).on("line", (line) => {
        onWorkerLine(line, resolveReady, (msg) =>
          rejectReady(new Error(`CLAP worker failed to initialise: ${msg}`)),
        );
      });

      createInterface({ input: child.stderr }).on("line", (line) => {
        log.warn({ line }, "CLAP worker stderr");
      });

      child.once("error", (error) => {
        rejectReady(
          new Error(
            `Failed to start CLAP worker using '${pythonCommand}': ${error.message}`,
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
          `CLAP worker exited${signal ? ` with signal ${signal}` : ` with code ${code ?? "unknown"}`}${evicted ? " (deliberately evicted for a user request)" : ""}`,
        );
        if (evicted) markWorkerEvictedError(err);
        log.warn({ code, signal, pendingCount, evicted }, "CLAP worker exited");
        rejectAllPending(err);
        if (!settled) rejectReady(err);
      });
    });

    try {
      await ready;
    } catch (error) {
      // The worker's own error handling is *supposed* to exit the process
      // (see clap_worker.py's sys.exit(1) path) whenever init fails, and the
      // 'exit' handler above already resets `worker`/`readyPromise`. But
      // that's not guaranteed — a stuck CUDA call can leave the process alive
      // and still holding VRAM. Force it and wait for confirmation before
      // releasing the GPU-init slot below, so the next queued worker
      // (Whisper, image analysis) can't start loading onto the GPU while
      // this one's memory is still resident — that race is what let failed
      // workers pile up and exhaust the card's 2 GB in the 2026-08-25/08-27
      // incidents.
      await killAndAwaitExit(child, { label: "clap" });
      throw error;
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

const sendRequest = async (payload: Record<string, unknown>): Promise<Float32Array> => {
  await ensureWorkerReady();
  if (!worker) throw new Error("CLAP worker is not available");

  const id = nextRequestId++;

  return new Promise<Float32Array>((resolve, reject) => {
    const timeout = createSuspensionAwareTimeout(
      COMPUTE_WORKER_IDS.clap,
      REQUEST_TIMEOUT_MS,
      () => {
        pending.delete(id);
        // Kill the hung worker — the exit handler will rejectAllPending and reset state
        // so the next request starts a fresh process rather than inheriting the stuck one.
        log.warn(
          { id, timeoutMs: REQUEST_TIMEOUT_MS },
          "CLAP worker timed out — killing process",
        );
        worker?.kill();
        reject(new Error(`CLAP worker timed out for request ${id}`));
      },
    );

    pending.set(id, { resolve, reject, timeout });

    try {
      worker?.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
    } catch (error) {
      timeout.clear();
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
};

export const embedAudioWithClap = async (videoPath: string): Promise<Float32Array> => {
  // Yield to any in-flight foreground search embedding: it shares this process
  // and its model lock, so dispatching background passes first would starve it.
  await awaitForegroundIdle(COMPUTE_WORKER_IDS.clap);
  return sendRequest({ operation: "embedAudio", videoPath });
};

export const embedTextWithClap = (text: string): Promise<Float32Array> =>
  withForegroundWorker(COMPUTE_WORKER_IDS.clap, () =>
    sendRequest({ operation: "embedText", text }),
  );
