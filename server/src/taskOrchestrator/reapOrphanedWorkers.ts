import { readdir, readFile } from "fs/promises";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("reapWorkers");

/**
 * Basenames of the Python ML worker scripts this server spawns. A process whose
 * argv contains one of these is one of our workers (ours or a prior instance's).
 */
const WORKER_SCRIPT_BASENAMES = [
  "image_analysis_worker.py",
  "whisper_worker.py",
  "clap_worker.py",
] as const;

/**
 * True if a process's argv (space-joined) is one of our Python workers. The
 * image conversion worker is matched only in `--worker` (persistent) mode so a
 * one-shot CLI invocation of process_image.py is never reaped mid-conversion.
 */
export const isWorkerCmdline = (cmdline: string): boolean =>
  WORKER_SCRIPT_BASENAMES.some((name) => cmdline.includes(name)) ||
  (cmdline.includes("process_image.py") && cmdline.includes("--worker"));

/** Read a /proc/<pid>/cmdline (NUL-separated argv) as a plain string. */
const readCmdline = async (pid: string): Promise<string | null> => {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf-8");
    return raw.replace(/\0/g, " ");
  } catch {
    // Process exited between the readdir and this read, or is not ours to read.
    return null;
  }
};

/**
 * Kill Python ML worker processes left resident by a prior server instance.
 *
 * These workers keep their models — and the ~300–500 MB CUDA context each — in
 * VRAM for as long as they live, and Node does not kill child processes when it
 * exits (they're spawned attached, not detached). So every restart, whether
 * graceful or a hard `kill -9`, orphans the previous instance's whisper/CLAP/
 * image workers. On a small GPU those orphans (plus a second instance's) exhaust
 * VRAM, so the next user video transcode can't allocate NVDEC/NVENC memory and
 * silently falls back to realtime-starved libx264 — 360p limps along but 720p/
 * 1080p buffer. Reaping them at startup, before our own workers spawn, gives the
 * fresh instance the whole card.
 *
 * Linux-only (reads /proc); a no-op elsewhere. Runs at boot when none of our own
 * workers exist yet, so every match is by definition an orphan to be killed.
 */
export const reapOrphanedComputeWorkers = async (): Promise<void> => {
  if (process.platform !== "linux") return;

  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch (err) {
    log.debug({ err }, "could not scan /proc for orphaned workers");
    return;
  }

  const self = process.pid;
  const killed: number[] = [];
  const unkillable: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === self) continue;

    const cmdline = await readCmdline(entry);
    if (cmdline == null || !isWorkerCmdline(cmdline)) continue;

    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch (err) {
      // ESRCH: exited between our readdir and the kill — nothing to do.
      // EPERM: alive but owned by another (higher-privilege) user, so we
      // cannot reap it. That is the dual-instance case — e.g. a root-owned
      // server's worker squatting on VRAM while we run as an unprivileged
      // user — and it silently starves the GPU, so surface it loudly rather
      // than swallowing it at debug.
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        unkillable.push(pid);
      } else {
        log.debug({ err, pid }, "could not kill orphaned worker");
      }
    }
  }

  if (killed.length > 0) {
    log.info(
      { pids: killed },
      "reaped orphaned ML worker(s) from a prior instance to free VRAM",
    );
  }

  if (unkillable.length > 0) {
    log.warn(
      { pids: unkillable },
      "found orphaned ML worker(s) owned by another user we cannot reap " +
        "(likely a second server instance running as a different user); " +
        "their VRAM will not be freed — stop the other instance and kill " +
        "these PIDs manually (e.g. `sudo kill -9 <pids>`)",
    );
  }
};
