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

// Forward-seek detection. The player fills its buffer by requesting segments one
// after another, so the furthest segment it has asked for advances ~1 at a time.
// A jump of more than this many segments past that high-water mark is a seek, not
// buffer-fill, and the encode is restarted at the seek target rather than letting
// the player wait for the linear encode to crawl there. Comfortably above any
// request look-ahead (which never jumps) and above the break-even point where
// restarting beats waiting (~encode-speed × restart latency).
const FORWARD_SEEK_GAP = Number(process.env.PHOTRIX_HLS_FORWARD_SEEK_GAP) || 12;

type VariantEncode = {
  // Running encoder process for this variant. Null while the encode is still queued
  // (claimed but not yet spawned) or after it has ended.
  child: ChildProcess | null;
  // Segment index this encode began at (via -ss/-start_number). A live/pending encode
  // produces segments forward from here, so it covers any requested segment >= this.
  startSegment: number;
  // True once the encode has ended or been killed (process exit, idle reap, or being
  // replaced). A dead slot covers nothing, so the next request restarts it. Kept
  // distinct from `child === null` so the still-queued (not-yet-spawned) window — when
  // child is also null — is NOT mistaken for "needs another encode", which would spawn
  // a duplicate writer into the same directory.
  dead: boolean;
  // Highest segment index the player has requested for this variant. Advances ~1 per
  // request during normal buffer-fill; a request far beyond it signals a forward seek.
  maxRequested: number;
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
  startSegment: number,
  dead: boolean,
  maxRequested: number,
): VariantEncode => ({
  child: null,
  startSegment,
  dead,
  maxRequested,
  idleTimer: armVariantIdle(hlsDir, height),
});

/**
 * Marks a single variant as actively in use, re-arming its idle reaper. Call on
 * every request that touches a specific variant (its playlist or a segment). When a
 * segment index is given, also tracks the request high-water mark and returns whether
 * this request is a forward seek (a jump well past it) so the caller can restart the
 * encode at the seek target instead of waiting for the linear encode to reach it.
 */
export const touchVariant = (
  hlsDir: string,
  height: number,
  segmentIndex?: number,
): boolean => {
  const session = ensureSession(hlsDir);
  let entry = session.variants.get(height);
  if (!entry) {
    // First touch with no encode yet: a dead slot the next claim will start.
    entry = newVariantEntry(hlsDir, height, 0, true, segmentIndex ?? 0);
    session.variants.set(height, entry);
    return false;
  }
  clearTimeout(entry.idleTimer);
  entry.idleTimer = armVariantIdle(hlsDir, height);
  if (segmentIndex === undefined) return false;

  // Only a live/pending encode can be "behind" — a dead slot is restarted anyway.
  const forwardSeek = !entry.dead && segmentIndex > entry.maxRequested + FORWARD_SEEK_GAP;
  if (segmentIndex > entry.maxRequested) entry.maxRequested = segmentIndex;
  return forwardSeek;
};

/**
 * Decides — atomically — whether a fresh encode is needed so that variant `height`
 * will produce `segmentIndex`, and if so claims the slot. Returns the segment the
 * caller should start encoding from, or null if a live/pending encode already covers
 * this request (caller does nothing and lets the long-poll wait for it).
 *
 * A live or still-queued encode that began at or before `segmentIndex` normally
 * covers it (it writes segments forward), so we only (re)start when:
 *   - there is no slot, or it is dead (process ended or was idle-reaped);
 *   - the request is behind the slot's start point — a backward seek, or an ABR switch
 *     whose encode must begin at the player's current position rather than from 0; or
 *   - `forwardSeek` is set — the request jumped far ahead of the encode (see
 *     touchVariant), so restarting at the seek target beats waiting for the linear
 *     encode to crawl there.
 * When restarting, the new encode begins exactly at `segmentIndex`. Runs synchronously
 * with no `await`, and the slot is mutated in place (preserving the request high-water
 * mark), so two near-simultaneous requests for the same start point can't double-spawn.
 */
export const claimVariantEncode = (
  hlsDir: string,
  height: number,
  segmentIndex: number,
  forwardSeek = false,
): number | null => {
  const session = ensureSession(hlsDir);
  const entry = session.variants.get(height);
  if (!entry) {
    session.variants.set(height, newVariantEntry(hlsDir, height, segmentIndex, false, segmentIndex));
    return segmentIndex;
  }

  const needsRestart =
    entry.dead ||
    segmentIndex < entry.startSegment ||
    (forwardSeek && entry.startSegment < segmentIndex);
  if (!needsRestart) return null;

  entry.child?.kill("SIGKILL");
  entry.child = null;
  entry.dead = false;
  entry.startSegment = segmentIndex;
  return segmentIndex;
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
