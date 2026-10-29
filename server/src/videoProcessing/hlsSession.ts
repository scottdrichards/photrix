import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { getLogger } from "../observability/logger.ts";
import { pathToken } from "../observability/privacy.ts";
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

// How far past the encode head a request may be before waiting for the running
// encode costs more than starting a new one at the request (feedback #167). The
// encode runs ~2-3x realtime and a restart costs a spawn plus a seek, so ~10
// one-second segments is a few seconds either way. Normal playback asks for the
// segment right after the head; only a seek lands further out.
export const SEEK_RESTART_GAP_SEGMENTS =
  Number(process.env.PHOTRIX_HLS_SEEK_RESTART_GAP) || 10;

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
  // First segment this encode writes: 0, or where a seek started it.
  startSegment: number;
  // Highest segment index known to be on disk for this encode (a scan cursor,
  // so finding the head doesn't re-check every segment on each request).
  headHint: number;
  // Idle reaper that kills this variant's encode after VARIANT_IDLE_MS of no fetches.
  idleTimer: ReturnType<typeof setTimeout>;
};

type Session = {
  // Whole-tree reaper.
  treeTimer: ReturnType<typeof setTimeout>;
  // User-activity lease held for the session's lifetime (see playbackHooks).
  activity?: PlaybackActivity;
  // Per variant height: its current encode state.
  variants: Map<number, VariantEncode>;
};

// Keyed by the HLS base directory (the whole tree is reaped together).
const sessions = new Map<string, Session>();

// Lifecycle hook bracketing each session from creation to reap. Wired (in
// main.ts) to the task orchestrator's beginUserRequest lease so an
// active playback counts as user activity for its whole lifetime, not just the
// instants of individual segment fetches. An HLS player buffers ahead and goes
// HTTP-quiet for many seconds mid-playback; without this bracket the
// orchestrator declares the user idle in those gaps, resumes background ML
// work, and releases the GPU VRAM reclaim — so the workers respawn, refill
// VRAM, and the next ABR variant switch can't get NVENC and falls back to
// realtime-starved libx264. The session owns the lease it gets back: it refreshes
// it on every touch (so a long playback never hits the lease's max age) and
// releases it on reap.
type PlaybackActivity = { release: () => void; refresh: () => void };
type PlaybackLifecycleHooks = {
  onSessionStart: () => PlaybackActivity;
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
  clearTimeout(session.treeTimer);
  session.activity?.release();

  // Stop every encoder first so nothing is writing into a directory we're removing.
  for (const encode of session.variants.values()) killVariant(encode);
  closeHlsWatcher(hlsDir);

  try {
    await rm(hlsDir, { recursive: true, force: true });
    log.info({ hlsDir: pathToken(hlsDir) }, "Reaped ephemeral HLS after idle");
  } catch (err) {
    // Error code only: fs error messages quote the (path-mirroring) directory.
    log.warn(
      { code: (err as NodeJS.ErrnoException)?.code, hlsDir: pathToken(hlsDir) },
      "Failed to reap HLS directory",
    );
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
    session = {
      treeTimer: armTreeTimer(hlsDir),
      variants: new Map(),
      activity: playbackHooks?.onSessionStart(),
    };
    sessions.set(hlsDir, session);
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
    session.activity?.refresh();
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
    log.debug({ hlsDir: pathToken(hlsDir), height }, "Reaped idle HLS variant encode");
  }, VARIANT_IDLE_MS);
  timer.unref?.();
  return timer;
};

const newVariantEntry = (
  hlsDir: string,
  height: number,
  dead: boolean,
  startSegment = 0,
): VariantEncode => ({
  child: null,
  dead,
  startSegment,
  headHint: startSegment - 1,
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

/** Walks forward from the encode's last known head while segments exist on disk. */
const advanceHead = (
  entry: VariantEncode,
  segmentExists: (index: number) => boolean,
  upTo: number,
): number => {
  let head = Math.max(entry.headHint, entry.startSegment - 1);
  while (head < upTo && segmentExists(head + 1)) head += 1;
  entry.headHint = head;
  return head;
};

/**
 * Decides — atomically — whether a fresh encode is needed for variant `height` to
 * produce `segment`, and if so claims the slot. Returns the segment the new encode
 * must start at, or null when the live/pending encode will reach `segment` soon
 * (the caller then just long-polls for it).
 *
 * A new encode starts when the slot is dead (process ended or idle-reaped), or when
 * the request is one the running encode won't reach soon: before its start, or more
 * than SEEK_RESTART_GAP_SEGMENTS past its head (feedback #167: a seek to 7:00 used to
 * wait for an encode from 0:00, time out, and restart from 0:00 again). It starts at
 * the requested segment rather than 0. Runs synchronously with no `await` so two
 * near-simultaneous requests can't double-spawn.
 */
export const claimVariantEncode = (
  hlsDir: string,
  height: number,
  segment = 0,
  segmentExists: (index: number) => boolean = () => false,
): number | null => {
  const session = ensureSession(hlsDir);
  const entry = session.variants.get(height);
  if (!entry) {
    session.variants.set(height, newVariantEntry(hlsDir, height, false, segment));
    return segment;
  }

  if (!entry.dead) {
    const behindStart = segment < entry.startSegment;
    const head = behindStart ? -1 : advanceHead(entry, segmentExists, segment);
    if (!behindStart && segment - head <= SEEK_RESTART_GAP_SEGMENTS) return null;
  }

  entry.child?.kill("SIGKILL");
  entry.child = null;
  entry.dead = false;
  entry.startSegment = segment;
  entry.headHint = segment - 1;
  return segment;
};

/**
 * Keeps a variant's encode alive while a request is waiting on one of its
 * segments. touchVariant alone re-arms the idle reaper only when a request
 * *arrives*, so a request long-polling past the reaper window lost the very
 * encode it was waiting for. Returns a stop function.
 */
export const keepVariantAlive = (hlsDir: string, height: number): (() => void) => {
  const timer = setInterval(() => {
    touchHlsSession(hlsDir);
    touchVariant(hlsDir, height);
  }, Math.max(250, VARIANT_IDLE_MS / 2));
  timer.unref?.();
  return () => clearInterval(timer);
};

/**
 * Force-kills all active HLS sessions immediately, freeing any GPU VRAM held by
 * running ffmpeg/NVENC processes. Intended as a manual "clear transcodes" action;
 * the normal idle reaper handles routine cleanup. Each session's directory is
 * deleted after its encoders are killed, matching the reap() behaviour.
 */
export const killAllSessions = (): void => {
  const dirs = [...sessions.keys()];
  for (const hlsDir of dirs) {
    void reap(hlsDir);
  }
  log.info({ count: dirs.length }, "Force-killed all HLS sessions");
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
