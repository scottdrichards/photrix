import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { getLogger } from "../observability/logger.ts";
import { closeHlsWatcher } from "./hlsSegmentWatcher.ts";

const log = getLogger("HlsSession");

// HLS output is ephemeral: once a player stops requesting segments for this long,
// the encode is killed (if still running) and the directory is deleted so nothing
// accumulates. Replays after this idle window re-encode from scratch.
const IDLE_MS = Number(process.env.PHOTRIX_HLS_IDLE_MS) || 90_000;

type Session = {
  timer: ReturnType<typeof setTimeout>;
  child?: ChildProcess;
};

// Keyed by the multi-bitrate HLS base directory (the whole tree is reaped together).
const sessions = new Map<string, Session>();

const reap = async (hlsDir: string): Promise<void> => {
  const session = sessions.get(hlsDir);
  if (!session) return;
  sessions.delete(hlsDir);

  // Stop the encoder first so it isn't writing into a directory we're removing.
  session.child?.kill("SIGKILL");
  closeHlsWatcher(hlsDir);

  try {
    await rm(hlsDir, { recursive: true, force: true });
    log.info({ hlsDir }, "Reaped ephemeral HLS after idle");
  } catch (err) {
    log.warn({ err, hlsDir }, "Failed to reap HLS directory");
  }
};

const armTimer = (hlsDir: string): ReturnType<typeof setTimeout> => {
  const timer = setTimeout(() => void reap(hlsDir), IDLE_MS);
  timer.unref?.();
  return timer;
};

/**
 * Marks an HLS directory as actively in use. Call on every HLS request (master
 * playlist, variant playlist, segment). Resets the idle countdown so the encode
 * survives as long as a player keeps fetching, then is reaped once it goes quiet.
 */
export const touchHlsSession = (hlsDir: string): void => {
  const existing = sessions.get(hlsDir);
  if (existing) {
    clearTimeout(existing.timer);
    existing.timer = armTimer(hlsDir);
    return;
  }
  sessions.set(hlsDir, { timer: armTimer(hlsDir) });
};

/**
 * Associates the encoding ffmpeg process with an HLS directory so the reaper can
 * terminate it if playback stops before encoding finishes.
 */
export const registerHlsProcess = (hlsDir: string, child: ChildProcess): void => {
  const existing = sessions.get(hlsDir);
  if (existing) {
    existing.child = child;
    return;
  }
  sessions.set(hlsDir, { timer: armTimer(hlsDir), child });
};
