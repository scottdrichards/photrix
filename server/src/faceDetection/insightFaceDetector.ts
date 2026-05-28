import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { DetectFaces, DetectedFace } from "./faceDetector.type.ts";

type WorkerResponse =
  | { type: "ready" }
  | { id: number | null; error: string }
  | {
      id: number;
      faces: Array<{
        box: { x: number; y: number; width: number; height: number };
        confidence: number;
        embedding: number[];
      }>;
    };

type PendingRequest = {
  resolve: (faces: DetectedFace[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 120_000;
const PYTHON_SERVICE_SCRIPT = path.resolve(
  process.cwd(),
  "python",
  "face_detection_worker.py",
);

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
  if (fromEnv) {
    return fromEnv;
  }

  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, ".venv", "Scripts", "python.exe"),
    path.join(cwd, ".venv", "bin", "python"),
  ];

  for (const candidate of candidates) {
    if (await canAccess(candidate)) {
      return candidate;
    }
  }

  return isWindows ? "python" : "python3";
};

const asDetectedFace = (face: {
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
  embedding: number[];
}): DetectedFace => ({
  box: {
    x: face.box.x,
    y: face.box.y,
    width: face.box.width,
    height: face.box.height,
  },
  confidence: face.confidence,
  embedding: Float64Array.from(face.embedding),
});

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

  if (!("id" in message) || message.id === null) {
    return;
  }

  const request = pending.get(message.id);
  if (!request) {
    return;
  }

  pending.delete(message.id);
  clearTimeout(request.timer);

  if ("error" in message) {
    request.reject(new Error(message.error));
    return;
  }

  request.resolve(message.faces.map(asDetectedFace));
};

const ensureWorkerReady = async (): Promise<void> => {
  if (readyPromise) {
    return readyPromise;
  }

  readyPromise = (async () => {
    if (!(await canAccess(PYTHON_SERVICE_SCRIPT))) {
      throw new Error(`InsightFace worker script missing at ${PYTHON_SERVICE_SCRIPT}`);
    }

    const pythonCommand = await resolvePythonCommand();
    const provider = process.env.PHOTRIX_INSIGHTFACE_PROVIDER ?? "CPUExecutionProvider";

    const child = spawn(pythonCommand, [PYTHON_SERVICE_SCRIPT, provider], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    worker = child;

    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;

      const resolveReady = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const rejectReady = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      createInterface({ input: child.stdout }).on("line", (line) => {
        onWorkerLine(line, resolveReady);
      });

      createInterface({ input: child.stderr }).on("line", (line) => {
        console.warn(`[faceDetection] insightface worker: ${line}`);
      });

      child.once("error", (error) => {
        rejectReady(
          new Error(
            `Failed to start insightface worker using '${pythonCommand}': ${error.message}`,
          ),
        );
      });

      child.once("exit", (code, signal) => {
        worker = null;
        readyPromise = null;
        const err = new Error(
          `Insightface worker exited${signal ? ` with signal ${signal}` : ` with code ${code ?? "unknown"}`}`,
        );
        rejectAllPending(err);
        if (!settled) {
          rejectReady(err);
        }
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

export const detectFacesWithInsightFace: DetectFaces = async (imagePath: string) => {
  await ensureWorkerReady();
  if (!worker) {
    throw new Error("Insightface worker is not available");
  }

  const id = nextRequestId;
  nextRequestId += 1;

  return new Promise<DetectedFace[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Insightface worker timed out for request ${id}`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    try {
      worker?.stdin.write(JSON.stringify({ id, imagePath }) + "\n");
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
};
