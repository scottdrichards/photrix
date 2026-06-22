import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CACHE_DIR } from "../common/cacheUtils.js";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("whisperWorker");

export type TranscriptSegment = { start: number; end: number; text: string };

type WorkerResponse =
  | { type: "ready" }
  | { id: number; segments: TranscriptSegment[] }
  | { id: number | null; error: string };

type PendingRequest = {
  resolve: (segments: TranscriptSegment[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Long timeout: large-v3 on CPU can be slow for long videos
const REQUEST_TIMEOUT_MS = 30 * 60 * 1_000;
const WHISPER_SCRIPT = path.resolve(process.cwd(), "python", "whisper_worker.py");

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

const onWorkerLine = (line: string, onReady: () => void) => {
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
    request.reject(new Error((message as { id: number; error: string }).error));
    return;
  }

  request.resolve((message as { id: number; segments: TranscriptSegment[] }).segments);
};

const ensureWorkerReady = async (): Promise<void> => {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    if (!(await canAccess(WHISPER_SCRIPT))) {
      throw new Error(`Whisper worker script missing at ${WHISPER_SCRIPT}`);
    }

    const pythonCommand = await resolvePythonCommand();
    const device = process.env.PHOTRIX_WHISPER_DEVICE ?? "cpu";

    const child = spawn(pythonCommand, [WHISPER_SCRIPT, device], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, HF_HOME: path.join(CACHE_DIR, "huggingface") },
    });
    worker = child;

    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;

      const resolveReady = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const rejectReady = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      createInterface({ input: child.stdout }).on("line", (line) => {
        onWorkerLine(line, resolveReady);
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
        worker = null;
        readyPromise = null;
        const err = new Error(
          `Whisper worker exited${signal ? ` with signal ${signal}` : ` with code ${code ?? "unknown"}`}`,
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

const sendRequest = async (payload: Record<string, unknown>): Promise<TranscriptSegment[]> => {
  await ensureWorkerReady();
  if (!worker) throw new Error("Whisper worker is not available");

  const id = nextRequestId++;

  return new Promise<TranscriptSegment[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Whisper worker timed out for request ${id}`));
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

export const transcribeWithWhisper = (videoPath: string): Promise<TranscriptSegment[]> =>
  sendRequest({ operation: "transcribe", videoPath });
