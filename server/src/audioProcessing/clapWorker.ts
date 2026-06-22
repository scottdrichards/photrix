import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CACHE_DIR } from "../common/cacheUtils.js";
import { getLogger } from "../observability/logger.ts";

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
    const device = process.env.PHOTRIX_CLAP_DEVICE ?? "cpu";

    const child = spawn(pythonCommand, [CLAP_SCRIPT, device], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, HF_HOME: path.join(CACHE_DIR, "huggingface") },
    });
    worker = child;

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
        settled = true;
        log.info("CLAP worker ready");
        resolve();
      };

      const rejectReady = (error: Error) => {
        if (settled) return;
        clearTimeout(slowTimer);
        settled = true;
        reject(error);
      };

      createInterface({ input: child.stdout }).on("line", (line) => {
        onWorkerLine(line, resolveReady, (msg) =>
          rejectReady(new Error(`CLAP worker failed to initialise: ${msg}`)),
        );
      });

      createInterface({ input: child.stderr }).on("line", (line) => {
        log.debug({ line }, "CLAP worker stderr");
      });

      child.once("error", (error) => {
        rejectReady(
          new Error(
            `Failed to start CLAP worker using '${pythonCommand}': ${error.message}`,
          ),
        );
      });

      child.once("exit", (code, signal) => {
        worker = null;
        readyPromise = null;
        const err = new Error(
          `CLAP worker exited${signal ? ` with signal ${signal}` : ` with code ${code ?? "unknown"}`}`,
        );
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

export const embedAudioWithClap = (videoPath: string): Promise<Float32Array> =>
  sendRequest({ operation: "embedAudio", videoPath });

export const embedTextWithClap = (text: string): Promise<Float32Array> =>
  sendRequest({ operation: "embedText", text });
