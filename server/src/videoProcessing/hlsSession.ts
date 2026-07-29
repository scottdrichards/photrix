import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { getLogger } from "../observability/logger.ts";
import { closeHlsWatcher } from "./hlsSegmentWatcher.ts";

const log = getLogger("HlsSession");

// HLS output is ephemeral: once a player stops requesting anything from this tree
// for this long, every encode is killed and the directory is deleted so nothing
// accumulates. Replays after this idle window re-encode from scratch.
const IDLE_MS = Number(process.env.PHOTRIX_HLS_IDLE_MS) || 90_000;

// Per-variant idle window. A variant's encode is killed once the player stops
// fetching that specific variant's segments for this long — which happens as soon
// as ABR switches to a different quality. This caps concurrency to the variant
// actually being played (plus, briefly, a newly-selected one during a switch)
// instead of leaving every level's encode running.
const VARIANT_IDLE_MS = Number(process.env.PHOTRIX_HLS_VARIANT_IDLE_MS) || 8_000;

type VariantEncode = {
  // Running encoder process for this variant. Null while the encode is still queued
  // (claimed but not yet spawned) or after it has ended.
  child: ChildProcess | null;
  // True once the encode has ended or been killed (process exit, idle reap, or being
  // replaced). A dead slot covers nothing, so the next request restarts it. Kept
  // distinct from `child === null` so the still-queued (not-yet-spawned) window — when
  // child is also null — is NOT mistaken for "needs another encode", which would spawn
  // a duplicate writer into the same directory.
  dead: boolean;
  // Idle reaper that kills this variant's encode after VARIANT_IDLE_MS of no fetches.
  idleTimer: ReturnType<typeof setTimeout>;
};

type Session = {
  // Whole-tree reaper.
  treeTimer: ReturnType<typeof setTimeout>;
  // Per variant height: its current encode state.
  variants: Map<number, VariantEncode>;
};

// Keyed by the HLS base directory (the whole tree is reaped together).
const sessions = new Map<string, Session>();

// Lifecycle hooks bracketing each session from creation to reap. Wired (in
// main.ts) to the task orchestrator's beginUserRequest/endUserRequest so an
// active playback counts as user activity for its whole lifetime, not just the
// instants of individual segment fetches. An HLS player buffers ahead and goes
// HTTP-quiet for many seconds mid-playback; without this bracket the
// orchestrator declares the user idle in those gaps, resumes background ML
// work, and releases the GPU VRAM reclaim — so the workers respawn, refill
// VRAM, and the next ABR variant switch can't get NVENC and falls back to
// realtime-starved libx264.
type PlaybackLifecycleHooks = {
  onSessionStart: () => void;
  onSessionEnd: () => void;
};
let playbackHooks: PlaybackLifecycleHooks | undefined;

export const setPlaybackLifecycleHooks = (hooks: PlaybackLifecycleHooks): void => {
  playbackHooks = hooks;
};

const killVariant = (encode: VariantEncode): void => {
  clearTimeout(encode.idleTimer);
  encode.child?.kill("SIGKILL");
  encode.child = null;
  encode.dead = true;
};

const reap = async (hlsDir: string): Promise<void> => {
  const session = sessions.get(hlsDir);
  if (!session) return;
  sessions.delete(hlsDir);
  playbackHooks?.onSessionEnd();

  // Stop every encoder first so nothing is writing into a directory we're removing.
  for (const encode of session.variants.values()) killVariant(encode);
  closeHlsWatcher(hlsDir);

  try {
    await rm(hlsDir, { recursive: true, force: true });
    log.info({ hlsDir }, "Reaped ephemeral HLS after idle");
  } catch (err) {
    log.warn({ err, hlsDir }, "Failed to reap HLS directory");
  }
};

const armTreeTimer = (hlsDir: string): ReturnType<typeof setTimeout> => {
  const timer = setTimeout(() => void reap(hlsDir), IDLE_MS);
  timer.unref?.();
  return timer;
};

const ensureSession = (hlsDir: string): Session => {
  let session = sessions.get(hlsDir);
  if (!session) {
    session = { treeTimer: armTreeTimer(hlsDir), variants: new Map() };
    sessions.set(hlsDir, session);
    playbackHooks?.onSessionStart();
  }
  return session;
};

/**
 * Marks an HLS tree as actively in use. Call on every HLS request (master playlist,
 * variant playlist, segment). Resets the whole-tree idle countdown so the output
 * survives as long as a player keeps fetching anything, then is reaped once quiet.
 */
export const touchHlsSession = (hlsDir: string): void => {
  const session = sessions.get(hlsDir);
  if (session) {
    clearTimeout(session.treeTimer);
    session.treeTimer = armTreeTimer(hlsDir);
    return;
  }
  ensureSession(hlsDir);
};

const armVariantIdle = (
  hlsDir: string,
  height: number,
): ReturnType<typeof setTimeout> => {
  const timer = setTimeout(() => {
    const encode = sessions.get(hlsDir)?.variants.get(height);
    if (!encode) return;
    // Idle: the player has switched away from this variant. Kill its encode and mark
    // the slot dead so already-written segments stay served, but a later re-selection
    // restarts the encode (at whatever position is then requested) rather than waiting
    // on a process that is no longer running. The tree is still reaped on its own timer.
    killVariant(encode);
    log.debug({ hlsDir, height }, "Reaped idle HLS variant encode");
  }, VARIANT_IDLE_MS);
  timer.unref?.();
  return timer;
};

const newVariantEntry = (
  hlsDir: string,
  height: number,
  dead: boolean,
): VariantEncode => ({
  child: null,
  dead,
  idleTimer: armVariantIdle(hlsDir, height),
});

/**
 * Marks a single variant as actively in use, re-arming its idle reaper. Call on
 * every request that touches a specific variant (its playlist or a segment).
 */
export const touchVariant = (hlsDir: string, height: number): void => {
  const session = ensureSession(hlsDir);
  let entry = session.variants.get(height);
  if (!entry) {
    entry = newVariantEntry(hlsDir, height, true);
    session.variants.set(height, entry);
    return;
  }
  clearTimeout(entry.idleTimer);
  entry.idleTimer = armVariantIdle(hlsDir, height);
};

/**
 * Decides — atomically — whether a fresh encode is needed for variant `height`, and
 * if so claims the slot. Returns true if the caller should start encoding, or false
 * if a live/pending encode is already running (caller does nothing and lets the
 * long-poll wait for the segment to be produced).
 *
 * Encodes always start from segment 0. The only restart condition is that the encode
 * slot is dead (process ended or was idle-reaped). Runs synchronously with no `await`
 * so two near-simultaneous requests can't double-spawn.
 */
export const claimVariantEncode = (hlsDir: string, height: number): boolean => {
  const session = ensureSession(hlsDir);
  const entry = session.variants.get(height);
  if (!entry) {
    session.variants.set(height, newVariantEntry(hlsDir, height, false));
    return true;
  }

  if (!entry.dead) return false; // live/pending encode covers all future segments

  entry.child?.kill("SIGKILL");
  entry.child = null;
  entry.dead = false;
  return true;
};

/**
 * Associates a spawned ffmpeg process with a variant so the reaper can terminate it.
 * Marks the slot dead automatically when the process exits, so a request for a
 * not-yet-produced segment after the encode ends restarts it instead of hanging.
 */
export const registerHlsProcess = (
  hlsDir: string,
  height: number,
  child: ChildProcess,
): void => {
  const encode = ensureSession(hlsDir).variants.get(height);
  if (!encode) {
    // No slot was claimed (shouldn't happen); kill to avoid an orphan writer.
    child.kill("SIGKILL");
    return;
  }
  encode.child = child;
  child.once("exit", () => {
    if (encode.child === child) {
      encode.child = null;
      encode.dead = true;
    }
  });
};
