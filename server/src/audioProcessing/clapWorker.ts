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

const log = getLogger("clapWorker");

type WorkerResponse =
  | { type: "ready" }
  | { id: number; embedding: number[] }
  | { id: number | null; error: string };

type PendingRequest = {
  resolve: (embedding: Float32Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
const CLAP_SCRIPT = path.resolve(process.cwd(), "python", "clap_worker.py");

let nextRequestId = 1;
let worker: ChildProcessWithoutNullStreams | null = null;
let readyPromise: Promise<void> | null = null;
const pending = new Map<number, PendingRequest>();

const isWindows = process.platform === "win32";

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

const rejectAllPending = (error: Error) => {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
};

const onWorkerLine = (line: string, onReady: () => void, onInitError: (msg: string) => void) => {
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
  clearTimeout(request.timer);

  if ("error" in message) {
    request.reject(new Error((message as { id: number; error: string }).error));
    return;
  }

  const arr = new Float32Array((message as { id: number; embedding: number[] }).embedding);
  request.resolve(arr);
};

const ensureWorkerReady = async (): Promise<void> => {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    if (!(await canAccess(CLAP_SCRIPT))) {
      throw new Error(`CLAP worker script missing at ${CLAP_SCRIPT}`);
    }

    const pythonCommand = await resolvePythonCommand();

    const child = spawn(pythonCommand, [CLAP_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, HF_HOME: path.join(CACHE_DIR, "huggingface") },
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
      const readyTimeoutMs = Number(process.env.PHOTRIX_CLAP_READY_TIMEOUT_MS) || 5 * 60 * 1_000;
      const readyTimer = setTimeout(() => {
        rejectReady(new Error(`CLAP worker failed to become ready within ${readyTimeoutMs}ms`));
        child.kill();
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
        const err = new Error(
          `CLAP worker exited${signal ? ` with signal ${signal}` : ` with code ${code ?? "unknown"}`}`,
        );
        log.warn({ code, signal, pendingCount }, "CLAP worker exited");
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
    worker = null;
    throw error;
  }
};

const sendRequest = async (payload: Record<string, unknown>): Promise<Float32Array> => {
  await ensureWorkerReady();
  if (!worker) throw new Error("CLAP worker is not available");

  const id = nextRequestId++;

  return new Promise<Float32Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // Kill the hung worker — the exit handler will rejectAllPending and reset state
      // so the next request starts a fresh process rather than inheriting the stuck one.
      log.warn({ id, timeoutMs: REQUEST_TIMEOUT_MS }, "CLAP worker timed out — killing process");
      worker?.kill();
      reject(new Error(`CLAP worker timed out for request ${id}`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    try {
      worker?.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
    } catch (error) {
      clearTimeout(timer);
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
