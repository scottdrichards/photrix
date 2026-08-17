import { getLogger } from "../observability/logger.ts";

const log = getLogger("computeWorkers");

/**
 * Registry of the heavy ML worker child processes (image analysis, Whisper,
 * CLAP) so the task orchestrator can freeze them while a user request is in
 * flight and thaw them again the moment the user goes idle.
 *
 * The orchestrator's cooperative pause stops *feeding* a worker new background
 * work, but it can only take effect at a chunk boundary — an in-flight native
 * forward pass keeps pegging the CPU for seconds. SIGSTOP/SIGCONT preempt that
 * pass at the OS level: the process freezes in place (no CPU, model state
 * retained) and resumes exactly where it left off, so a request gets the box
 * immediately without paying a model reload. It is the "kill but restartable"
 * lever, only cheaper than an actual kill.
 *
 * SIGSTOP/SIGCONT are POSIX-only. On Windows suspension is a no-op and we rely
 * on the cooperative pause alone.
 */

const canSuspend = process.platform !== "win32";

/**
 * Serialized GPU init queue. ML models can OOM when multiple workers try to
 * load onto the GPU simultaneously. Workers call acquireGpuInitSlot() before
 * spawning and release the returned handle once their worker emits "ready" (or
 * on error). This ensures only one model loads at a time; once resident they
 * all run concurrently with no further queuing.
 */
let gpuInitTail: Promise<void> = Promise.resolve();

export const acquireGpuInitSlot = (): Promise<() => void> => {
  let release!: () => void;
  const thisSlotDone = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Snapshot the current tail — this caller waits behind it.
  const waitForPrev = gpuInitTail;
  // Next caller waits behind this one.
  gpuInitTail = thisSlotDone;
  // Resolve with the release fn once the previous slot is done.
  return waitForPrev.then(() => release);
};

export const COMPUTE_WORKER_IDS = {
  image: "image-analysis",
  clap: "clap-audio",
  whisper: "whisper-audio",
} as const;

export type ComputeWorkerRole = "image" | "clap" | "whisper";

const ROLE_BY_ID: Record<string, ComputeWorkerRole> = {
  [COMPUTE_WORKER_IDS.image]: "image",
  [COMPUTE_WORKER_IDS.clap]: "clap",
  [COMPUTE_WORKER_IDS.whisper]: "whisper",
};

export const roleForComputeWorkerId = (id: string): ComputeWorkerRole | undefined =>
  ROLE_BY_ID[id];

type Entry = {
  getPid: () => number | null | undefined;
  // Active foreground (user-facing) calls that must keep this worker awake even
  // while background suspension is in effect — e.g. a search's text embedding,
  // which is served by the very same process that does background work.
  leases: number;
  // Resolves when no foreground call is in flight. While a foreground lease is
  // held this is a pending promise that background work awaits, so background
  // passes stop being dispatched and stop contending for the worker's internal
  // model lock — letting the foreground call through promptly. Null means idle
  // (equivalent to an already-resolved gate).
  idleGate: Promise<void> | null;
  resolveIdle: (() => void) | null;
  suspended: boolean;
  suspensionListeners: Set<(suspended: boolean) => void>;
};

const workers = new Map<string, Entry>();
let suspended = false;

const signal = (
  pid: number | null | undefined,
  sig: "SIGSTOP" | "SIGCONT",
  id: string,
) => {
  if (!canSuspend || pid == null) return;
  try {
    process.kill(pid, sig);
  } catch (err) {
    // The worker may have exited between the pid read and the signal; harmless.
    log.debug({ err, id, sig }, "compute worker signal failed");
  }
};

const setWorkerSuspended = (id: string, entry: Entry, nextSuspended: boolean): void => {
  if (entry.suspended === nextSuspended) return;
  entry.suspended = nextSuspended;
  log.debug(
    { id, pid: entry.getPid() },
    nextSuspended ? "suspending compute worker" : "resuming compute worker",
  );
  signal(entry.getPid(), nextSuspended ? "SIGSTOP" : "SIGCONT", id);
  for (const listener of entry.suspensionListeners) {
    listener(nextSuspended);
  }
};

export const registerComputeWorker = (
  id: string,
  getPid: () => number | null | undefined,
): void => {
  const entry: Entry = {
    getPid,
    leases: 0,
    idleGate: null,
    resolveIdle: null,
    suspended: false,
    suspensionListeners: new Set(),
  };
  workers.set(id, entry);
  // A worker may spawn lazily during an active suspension window (first use of
  // a model mid-request). Freeze it on arrival so it doesn't burn CPU loading a
  // model while we're trying to keep the request fast.
  if (suspended) setWorkerSuspended(id, entry, true);
};

export const unregisterComputeWorker = (id: string): void => {
  workers.delete(id);
};

export const onComputeWorkerSuspensionChange = (
  id: string,
  listener: (suspended: boolean) => void,
): (() => void) => {
  const entry = workers.get(id);
  if (!entry) {
    listener(false);
    return () => {};
  }
  entry.suspensionListeners.add(listener);
  listener(entry.suspended);
  return () => {
    entry.suspensionListeners.delete(listener);
  };
};

/**
 * Whether this worker is inside a suspension window right now.
 *
 * Needed because `onComputeWorkerSuspensionChange` only fires on *transitions*,
 * while a worker's child process spawns and exits independently of them. A
 * child that starts while suspension is already in effect produces no
 * transition, so an edge-triggered listener never learns about it.
 */
export const isComputeWorkerSuspended = (id: string): boolean =>
  workers.get(id)?.suspended ?? false;

export const createSuspensionAwareTimeout = (
  id: string,
  timeoutMs: number,
  onTimeout: () => void,
): { clear: () => void } => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerStartedAt = 0;
  let remainingMs = timeoutMs;
  let cleared = false;
  let unsubscribe = () => {};

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    unsubscribe();
  };

  const arm = () => {
    if (cleared || timer || remainingMs <= 0) return;
    timerStartedAt = Date.now();
    timer = setTimeout(() => {
      if (cleared) return;
      cleared = true;
      timer = null;
      unsubscribe();
      onTimeout();
    }, remainingMs);
    timer.unref?.();
  };

  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    remainingMs = Math.max(0, remainingMs - (Date.now() - timerStartedAt));
  };

  unsubscribe = onComputeWorkerSuspensionChange(id, (isSuspended) => {
    if (cleared) return;
    if (isSuspended) {
      pause();
      return;
    }
    if (remainingMs <= 0) {
      cleared = true;
      unsubscribe();
      onTimeout();
      return;
    }
    arm();
  });

  return {
    clear: () => {
      if (cleared) return;
      cleared = true;
      cleanup();
    },
  };
};

/** Freeze every background ML worker that isn't pinned awake by a foreground lease. */
export const suspendComputeWorkers = (): void => {
  if (suspended) return;
  suspended = true;
  for (const [id, entry] of workers) {
    if (entry.leases === 0) setWorkerSuspended(id, entry, true);
  }
};

/** Thaw every frozen worker. */
export const resumeComputeWorkers = (): void => {
  if (!suspended) return;
  suspended = false;
  for (const [id, entry] of workers) {
    setWorkerSuspended(id, entry, false);
  }
};

// Pids we SIGKILLed on purpose (GPU reclaim / shutdown), so a worker's exit
// handler can tell a deliberate eviction apart from a genuine crash. Entries
// are consumed by the exit handler; worker pids are few, so the set stays tiny.
const deliberatelyKilledPids = new Set<number>();

export const markDeliberateKill = (pid: number): void => {
  deliberatelyKilledPids.add(pid);
};

/**
 * True (once) if `pid` was SIGKILLed by us on purpose. Worker exit handlers use
 * this to tag the rejection they propagate to in-flight jobs, so job runners
 * leave the file pending for retry instead of permanently marking it errored —
 * a reclaim during playback would otherwise poison the DB record of whatever
 * files happened to be in flight.
 */
export const consumeDeliberateKill = (pid: number | null | undefined): boolean =>
  pid != null && deliberatelyKilledPids.delete(pid);

// Marker property carried by errors caused by a deliberate worker kill.
const WORKER_EVICTED = Symbol.for("photrix.workerEvicted");

export const markWorkerEvictedError = (error: Error): Error =>
  Object.assign(error, { [WORKER_EVICTED]: true });

export const isWorkerEvictedError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as Record<symbol, unknown>)[WORKER_EVICTED] === true;

// True while a user GPU request (e.g. a video transcode) has evicted the
// background ML workers' VRAM. Reflected in the status payload so the reclaim is
// observable, and cleared by releaseGpuReclaim() once the user goes idle.
let gpuReclaimed = false;

export const isGpuReclaimed = (): boolean => gpuReclaimed;

/**
 * Snapshot of every registered compute worker that currently has a live pid,
 * for the diagnostics/status view. VRAM is filled in by the metrics layer from
 * nvidia-smi; here we only know the process identity and its throttle state.
 */
export const getComputeWorkerPids = (): Array<{
  id: string;
  role: ComputeWorkerRole | undefined;
  pid: number;
  suspended: boolean;
  leases: number;
}> => {
  const result = [];
  for (const [id, entry] of workers) {
    const pid = entry.getPid();
    if (pid == null) continue;
    result.push({
      id,
      role: roleForComputeWorkerId(id),
      pid,
      suspended: entry.suspended,
      leases: entry.leases,
    });
  }
  return result;
};

/**
 * Free the GPU for an in-flight user request by killing every background ML
 * worker that isn't pinned awake by a foreground call (leases === 0). SIGSTOP
 * (suspendComputeWorkers) only freezes CPU — a frozen process keeps every CUDA
 * allocation — so a user video transcode would still OOM the GPU. Killing is the
 * only lever that actually returns VRAM (including the ~300–500 MB CUDA context
 * per worker). SIGKILL is used deliberately: it takes effect even on a worker
 * that is currently SIGSTOP'd, whereas SIGTERM would queue behind the freeze.
 *
 * The workers respawn lazily via their existing ensureReady() path the next time
 * they're needed — which, because the orchestrator keeps background work fully
 * stopped while the user is active, is only after the user goes idle (see
 * releaseGpuReclaim). This makes the reclaim inherently temporary and
 * demand-driven, unlike the reverted permanent GPU-gating attempt.
 */
export const reclaimGpuForUser = (): void => {
  gpuReclaimed = true;
  for (const [id, entry] of workers) {
    if (entry.leases > 0) continue; // a foreground call still needs this worker
    const pid = entry.getPid();
    if (pid == null) continue;
    log.info({ id, pid }, "reclaiming GPU from compute worker for user request");
    markDeliberateKill(pid);
    try {
      process.kill(pid, "SIGKILL");
    } catch (err) {
      log.debug({ err, id, pid }, "compute worker kill (reclaim) failed");
    }
  }
};

/**
 * SIGKILL every registered compute worker. Called from the server's graceful
 * shutdown so a restart doesn't orphan ML workers whose resident models + CUDA
 * contexts keep holding VRAM. Node does not terminate its attached children on
 * exit, so without this each restart leaks a full set of GPU-resident workers.
 * Best-effort — the startup reaper (reapOrphanedComputeWorkers) is the backstop
 * for the hard-kill case where this handler never runs.
 */
export const shutdownComputeWorkers = (): void => {
  for (const [id, entry] of workers) {
    const pid = entry.getPid();
    if (pid == null) continue;
    markDeliberateKill(pid);
    try {
      process.kill(pid, "SIGKILL");
      log.info({ id, pid }, "killed compute worker on shutdown");
    } catch (err) {
      log.debug({ err, id, pid }, "compute worker kill (shutdown) failed");
    }
  }
};

/** Clear the reclaim flag once the user is idle; workers respawn on next use. */
export const releaseGpuReclaim = (): void => {
  if (!gpuReclaimed) return;
  gpuReclaimed = false;
  log.debug("released GPU reclaim; background workers may respawn on next job");
};

/**
 * Run a foreground (user-facing) call against a managed worker, guaranteeing it
 * stays awake for the call's duration even if background suspension is active.
 * Search's text embedding shares a process with background analysis, so without
 * this a query could hang on a worker we froze for background work.
 */
export const withForegroundWorker = async <T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const entry = workers.get(id);
  if (!entry) return fn();
  entry.leases += 1;
  if (entry.leases === 1) {
    // Close the idle gate so background work on this worker pauses for the
    // duration of the foreground call.
    entry.idleGate = new Promise<void>((resolve) => {
      entry.resolveIdle = resolve;
    });
  }
  if (suspended && entry.leases === 1) setWorkerSuspended(id, entry, false);
  try {
    return await fn();
  } finally {
    entry.leases -= 1;
    if (entry.leases === 0) {
      // Last foreground call done: open the gate so background work resumes.
      entry.resolveIdle?.();
      entry.idleGate = null;
      entry.resolveIdle = null;
    }
    // Re-freeze only if background suspension is still in effect and no other
    // foreground call is keeping the worker awake.
    if (suspended && entry.leases === 0) setWorkerSuspended(id, entry, true);
  }
};

/**
 * Resolves once no foreground (user-facing) call is in flight on the worker.
 *
 * Background callers (image embedding, audio embedding) await this *before*
 * dispatching a pass. The foreground search embedding shares a single process —
 * and a single internal model lock — with background analysis, and that lock is
 * not fairly queued: a steady stream of background passes keeps re-acquiring it
 * and can starve a waiting foreground request until it times out. Gating new
 * background dispatch on foreground idleness bounds the foreground wait to the
 * one pass already in flight, so a search embedding gets the worker promptly.
 */
export const awaitForegroundIdle = async (id: string): Promise<void> => {
  const entry = workers.get(id);
  if (!entry?.idleGate) return;
  const start = Date.now();
  await entry.idleGate;
  log.debug(
    { id, waitMs: Date.now() - start },
    "background dispatch waited for foreground idle",
  );
};
