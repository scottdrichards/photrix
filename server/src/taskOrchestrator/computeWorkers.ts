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

export const COMPUTE_WORKER_IDS = {
  image: "image-analysis",
  clap: "clap-audio",
  whisper: "whisper-audio",
} as const;

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
};

const workers = new Map<string, Entry>();
let suspended = false;

const signal = (pid: number | null | undefined, sig: "SIGSTOP" | "SIGCONT", id: string) => {
  if (!canSuspend || pid == null) return;
  try {
    process.kill(pid, sig);
  } catch (err) {
    // The worker may have exited between the pid read and the signal; harmless.
    log.debug({ err, id, sig }, "compute worker signal failed");
  }
};

export const registerComputeWorker = (
  id: string,
  getPid: () => number | null | undefined,
): void => {
  workers.set(id, { getPid, leases: 0, idleGate: null, resolveIdle: null });
  // A worker may spawn lazily during an active suspension window (first use of
  // a model mid-request). Freeze it on arrival so it doesn't burn CPU loading a
  // model while we're trying to keep the request fast.
  if (suspended) signal(getPid(), "SIGSTOP", id);
};

export const unregisterComputeWorker = (id: string): void => {
  workers.delete(id);
};

/** Freeze every background ML worker that isn't pinned awake by a foreground lease. */
export const suspendComputeWorkers = (): void => {
  if (suspended) return;
  suspended = true;
  for (const [id, entry] of workers) {
    if (entry.leases === 0) {
      log.debug({ id, pid: entry.getPid() }, "suspending compute worker");
      signal(entry.getPid(), "SIGSTOP", id);
    }
  }
};

/** Thaw every frozen worker. */
export const resumeComputeWorkers = (): void => {
  if (!suspended) return;
  suspended = false;
  for (const [id, entry] of workers) {
    log.debug({ id, pid: entry.getPid() }, "resuming compute worker");
    signal(entry.getPid(), "SIGCONT", id);
  }
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
  if (suspended && entry.leases === 1) signal(entry.getPid(), "SIGCONT", id);
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
    if (suspended && entry.leases === 0) signal(entry.getPid(), "SIGSTOP", id);
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
  log.debug({ id, waitMs: Date.now() - start }, "background dispatch waited for foreground idle");
};
