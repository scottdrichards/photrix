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
  isComputeWorkerSuspended,
  killAndAwaitExit,
  markDeliberateKill,
  markWorkerEvictedError,
  onComputeWorkerSuspensionChange,
} from "../taskOrchestrator/computeWorkers.ts";

const log = getLogger("whisperWorker");

export type TranscriptSegment = { start: number; end: number; text: string };

type WorkerResponse =
  | {
      type: "ready";
      device?: string;
      computeType?: string;
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

// Long timeout: transcription on CPU can be slow for long videos.
// A flat cap is wrong for a library that mixes 30-second clips with multi-hour
// interview footage: on CPU (this box falls back to CPU whenever the GPU is
// full) transcription runs at best around realtime, so anything longer than the
// cap could never finish and failed on the clock every single time. The budget
// is scaled off the media's own duration instead, with the old flat value kept
// as the floor and a hard ceiling so one pathological file cannot hold the
// single worker forever.
const REQUEST_TIMEOUT_MS = 30 * 60 * 1_000;
const REQUEST_TIMEOUT_MAX_MS = 6 * 60 * 60 * 1_000;
// Slower than realtime, because CPU int8 transcription is, plus the time spent
// reading the source off the network share before decoding even starts.
const REQUEST_TIMEOUT_REALTIME_FACTOR = 3;

export const transcriptionTimeoutMs = (durationSeconds?: number): number => {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return REQUEST_TIMEOUT_MS;
  }
  const budget = durationSeconds * 1_000 * REQUEST_TIMEOUT_REALTIME_FACTOR;
  return Math.min(
    REQUEST_TIMEOUT_MAX_MS,
    Math.max(REQUEST_TIMEOUT_MS, Math.round(budget)),
  );
};
const SLOW_REQUEST_MS = 5 * 60 * 1_000;

// A loaded Whisper model sits at ~3.5 GB RSS. On a 12 GB box that is the
// difference between serving thumbnails out of page cache and swapping, so the
// worker is unloaded rather than left resident between jobs. SIGSTOP (the
// orchestrator's compute throttle) only stops it burning CPU — a frozen process
// keeps every byte of its resident set, so freezing alone does nothing for the
// memory pressure that makes image requests slow.
//
// When the orchestrator freezes us for a user request the worker is killed
// outright and immediately — see the suspension hook below. This timer covers
// only the other case: genuinely idle with no work in flight. Generous enough
// that a run of queued transcriptions doesn't pay a model reload per file.
// `Number(x) || fallback` would silently reject a legitimate 0, since 0 is
// falsy — which makes these knobs impossible to turn off. Parse explicitly.
const envMs = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const IDLE_UNLOAD_MS = envMs(process.env.PHOTRIX_WHISPER_IDLE_UNLOAD_MS, 60_000);

// How long the box must be quiet before paying for a model load.
//
// The orchestrator's ACTIVITY_COOLDOWN_MS is 2s, so background work resumes two
// seconds after each request. Loading Whisper takes ~30s and ~2.2 GB, so during
// ordinary browsing it would start in every two-second gap and be killed by the
// next request, over and over: 16 spawns and 17 unloads in four minutes were
// measured at one request per two seconds, none of which ever transcribed
// anything. Requiring a longer quiet period makes the start decision match the
// cost of the thing being started.
const START_QUIET_MS = envMs(process.env.PHOTRIX_WHISPER_START_QUIET_MS, 60_000);

// When the current quiet stretch began, or null while a user-request window is
// open. Anchored to the *resume* edge (activity ending), not the suspend edge
// (activity starting): under continuous browsing suspend edges are rare, so a
// suspend-anchored timestamp goes stale and eventually satisfies any quiet
// test — which is exactly how 7 spawns still slipped through 90s of steady
// requests. Seeded to startup so a booted-and-then-idle server can proceed.
let quietSince: number | null = Date.now();
const WHISPER_SCRIPT = path.resolve(process.cwd(), "python", "whisper_worker.py");

let nextRequestId = 1;
let worker: ChildProcessWithoutNullStreams | null = null;
let readyPromise: Promise<void> | null = null;
const pending = new Map<number, PendingRequest>();

// Whisper is background-only (transcription), so it can be frozen wholesale
// while a user request is in flight.
registerComputeWorker(COMPUTE_WORKER_IDS.whisper, () => worker?.pid ?? null);

let idleUnloadTimer: NodeJS.Timeout | null = null;

const clearIdleUnload = () => {
  if (!idleUnloadTimer) return;
  clearTimeout(idleUnloadTimer);
  idleUnloadTimer = null;
};

/**
 * Kill the worker so its resident model is returned to the OS. SIGKILL (not
 * SIGTERM) for the same reason the GPU reclaim uses it: it lands even on a
 * process that is currently SIGSTOP'd, whereas SIGTERM would queue behind the
 * freeze and never run. Tagged as a deliberate kill so the exit handler reports
 * an eviction rather than a crash, and any in-flight file is left pending for
 * retry instead of being marked errored.
 *
 * The worker respawns lazily on the next transcription via ensureWorkerReady().
 */
const unloadWorker = (reason: string, { force = false } = {}) => {
  const child = worker;
  const pid = child?.pid;
  if (!child || pid == null) return;
  // Re-check under the timer callback: work can arrive between arming and
  // firing. `force` overrides this for the user-request case, where discarding
  // the in-flight transcription is the whole point.
  if (!force && pending.size > 0) return;
  log.info(
    { pid, reason, discardedRequests: pending.size },
    "Unloading Whisper worker to release memory",
  );
  markDeliberateKill(pid);
  try {
    child.kill("SIGKILL");
  } catch (err) {
    log.debug({ err, pid }, "Whisper unload kill failed");
  }
};

const armIdleUnload = (delayMs: number, reason: string) => {
  clearIdleUnload();
  // Nothing loaded, or still working — the completion path re-arms.
  if (!worker || pending.size > 0) return;
  idleUnloadTimer = setTimeout(() => {
    idleUnloadTimer = null;
    unloadWorker(reason);
  }, delayMs);
  // Never hold the event loop open just to unload something.
  idleUnloadTimer.unref?.();
};

// A user request has arrived and the orchestrator froze us for it. Kill now,
// synchronously, without waiting for the in-flight transcription to finish: a
// frozen worker makes no progress anyway, so every byte it holds is taken
// straight from the request the freeze was meant to protect. The abandoned file
// is not lost — the kill is tagged deliberate, so its rejection is an eviction
// and the task runner leaves it pending for a later retry rather than marking
// it errored. Transcription is idempotent, so the discarded work is just time.
onComputeWorkerSuspensionChange(COMPUTE_WORKER_IDS.whisper, (isSuspended) => {
  if (isSuspended) {
    quietSince = null; // a user is active; the quiet stretch is over
    clearIdleUnload();
    unloadWorker("suspended for user request", { force: true });
    return;
  }
  quietSince = Date.now(); // activity window lapsed — quiet starts now
  armIdleUnload(IDLE_UNLOAD_MS, "idle");
});

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
  // Queue went empty — start counting down to unload. If the resolve/reject
  // below feeds another file straight back in, sendRequest cancels this.
  armIdleUnload(IDLE_UNLOAD_MS, "idle");

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
    // Emergency kill switch: see main.ts. Checked at spawn time so this
    // covers every caller of ensureWorkerReady, not just the background
    // transcription task.
    if (process.env.PHOTRIX_DISABLE_AUDIO === "1") {
      throw new Error("Whisper worker disabled via PHOTRIX_DISABLE_AUDIO=1");
    }
    // Refuse to *start* inside a user-request window, rather than starting and
    // being killed moments later. Loading this model costs ~30s and ~2.2 GB, and
    // a request only enters `pending` after this function resolves — so a
    // kill-after-spawn during the load window discards nothing (pending.size is
    // 0) while paying the full cost. Under steady browsing that becomes a
    // respawn loop that never completes a single transcription: three
    // spawn/kill cycles in 11s were observed before this gate existed.
    //
    // Evicted-tagged so the task runner requeues the file instead of erroring
    // it, exactly as for a mid-flight kill.
    if (isComputeWorkerSuspended(COMPUTE_WORKER_IDS.whisper)) {
      throw markWorkerEvictedError(
        new Error("Whisper worker not started: a user request is in flight"),
      );
    }
    // Not merely "no request right now" — the box must have been quiet long
    // enough that the load has a chance to finish and do real work.
    const quietMs = quietSince === null ? 0 : Date.now() - quietSince;
    if (quietMs < START_QUIET_MS) {
      throw markWorkerEvictedError(
        new Error(
          `Whisper worker not started: only ${quietMs}ms of quiet ` +
            `(need ${START_QUIET_MS}ms)`,
        ),
      );
    }
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

    // The suspension hook below is edge-triggered, but this child may have
    // spawned *inside* an already-active user-request window — in which case no
    // transition fires and nothing else will stop it. (The orchestrator's own
    // SIGSTOP has the same blind spot for the same reason, so such a child runs
    // at full speed while a user request is in flight.) Check the level, not the
    // edge, and evict immediately: the request rejects as an eviction and the
    // task runner requeues the file once the user goes idle.
    if (isComputeWorkerSuspended(COMPUTE_WORKER_IDS.whisper)) {
      unloadWorker("spawned during a user-request window", { force: true });
    }

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
          // The outer `await ready` catch below also force-kills+waits on any
          // rejection; this call just makes sure the OS-level kill starts
          // immediately rather than waiting for that catch to run.
          child.kill("SIGKILL");
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
            computeType: readyState.computeType ?? "unknown",
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
        clearIdleUnload(); // nothing left to unload; don't kill the next worker
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
    } catch (error) {
      // The worker's own error handling is *supposed* to exit the process
      // (see whisper_worker.py's sys.exit(1) paths) whenever init fails, and
      // the 'exit' handler above already resets `worker`/`readyPromise`. But
      // that's not guaranteed — a stuck CUDA call can leave the process alive
      // and still holding VRAM. Force it and wait for confirmation before
      // releasing the GPU-init slot below, so the next queued worker (CLAP,
      // image analysis) can't start loading onto the GPU while this one's
      // memory is still resident — that race is what let failed workers pile
      // up and exhaust the card's 2 GB in the 2026-08-25/08-27 incidents.
      await killAndAwaitExit(child, { label: "whisper" });
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

const sendRequest = async (
  payload: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<TranscriptSegment[]> => {
  // Hold off the unload across the (possibly slow) spawn/model-load too, so a
  // worker can't be reaped in the window between becoming ready and being fed.
  clearIdleUnload();
  try {
    await ensureWorkerReady();
  } catch (error) {
    // Re-arm: a failed start may still have left a child behind.
    armIdleUnload(IDLE_UNLOAD_MS, "idle");
    throw error;
  }
  if (!worker) throw new Error("Whisper worker is not available");

  const id = nextRequestId++;
  const operation = typeof payload.operation === "string" ? payload.operation : "unknown";
  const videoPath = typeof payload.videoPath === "string" ? payload.videoPath : undefined;

  return new Promise<TranscriptSegment[]>((resolve, reject) => {
    const timeout = createSuspensionAwareTimeout(
      COMPUTE_WORKER_IDS.whisper,
      timeoutMs,
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
            timeoutMs,
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
      armIdleUnload(IDLE_UNLOAD_MS, "idle");
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
};

export const transcribeWithWhisper = (
  videoPath: string,
  durationSeconds?: number,
): Promise<TranscriptSegment[]> =>
  sendRequest(
    { operation: "transcribe", videoPath },
    transcriptionTimeoutMs(durationSeconds),
  );
