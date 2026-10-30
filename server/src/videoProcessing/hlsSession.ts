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

// Per-encode idle window. An encode is killed once no request has touched the
// part of the video it is producing for this long — which happens as soon as
// ABR switches to a different quality or the player seeks elsewhere. Requests
// still waiting on it count as touching it (see keepVariantAlive).
const VARIANT_IDLE_MS = Number(process.env.PHOTRIX_HLS_VARIANT_IDLE_MS) || 8_000;

// How far past an encode's head a request may be before waiting for it costs more
// than starting a new encode at the request (feedback #167). The encode runs
// ~2-3x realtime and a new one costs a spawn plus a seek, so ~10 one-second
// segments is a few seconds either way. Normal playback asks for the segment
// right after the head; only a seek, or an ABR switch onto a variant whose
// encode is elsewhere, lands further out.
export const SEEK_RESTART_GAP_SEGMENTS =
  Number(process.env.PHOTRIX_HLS_SEEK_RESTART_GAP) || 10;

// How many encodes one variant of one video may run at once: one per place it
// is being watched from (two viewers far apart, or one viewer's seek while the
// encode it left behind idles out). Past this, the least recently used goes.
const MAX_RUNS_PER_VARIANT = Number(process.env.PHOTRIX_HLS_MAX_RUNS_PER_VARIANT) || 3;

// Pacing. An encode runs well above realtime, so left alone it races to the end
// of the file whether or not anyone will watch that far — and on a shared iGPU
// that throughput is exactly what a second viewer, or this viewer's next seek,
// needs. Once an encode is this many segments past the furthest one requested
// from it, it is frozen (SIGSTOP) until the player catches up to within
// PACE_RESUME_SEGMENTS. hls.js buffers ~30 s ahead, so the encode stays a full
// buffer ahead of what is asked for and the player never waits on a frozen one.
const PACE_AHEAD_SEGMENTS = Number(process.env.PHOTRIX_HLS_PACE_AHEAD_SEGMENTS) || 30;
const PACE_RESUME_SEGMENTS = Math.max(1, PACE_AHEAD_SEGMENTS - 10);
const PACE_CHECK_MS = 500;

/** One ffmpeg encode of one variant, writing segments forward from `startSegment`. */
type EncodeRun = {
  id: number;
  // The encoder process. Null while the encode is still queued (claimed but not
  // yet spawned).
  child: ChildProcess | null;
  // True once the encode has ended or been killed. A dead run covers nothing.
  dead: boolean;
  // True once *we* killed it (idle, replaced, session reaped). A run whose
  // process merely exited can be revived by a retry spawn (see registerHlsProcess).
  killed: boolean;
  startSegment: number;
  // Highest segment this encode is known to have written (startSegment - 1
  // before the first). Advanced lazily from the variant's isProduced.
  head: number;
  // Furthest segment any request has asked this run for.
  maxRequested: number;
  // Requests currently long-polling a segment this run will produce. While any
  // are waiting, the idle reaper must not kill it.
  waiters: number;
  lastTouched: number;
  // True while frozen by pacing.
  frozen: boolean;
  pacer?: ReturnType<typeof setInterval>;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type VariantState = {
  runs: EncodeRun[];
  // Reports whether a segment of this variant is on disk (from the latest claim).
  isProduced: (segment: number) => boolean;
};

type Session = {
  // Whole-tree reaper.
  treeTimer: ReturnType<typeof setTimeout>;
  // User-activity lease held for the session's lifetime (see playbackHooks).
  activity?: PlaybackActivity;
  // Per variant height: its encodes.
  variants: Map<number, VariantState>;
};

// Keyed by the HLS base directory (the whole tree is reaped together).
const sessions = new Map<string, Session>();
let nextRunId = 1;
// Runs whose process exited on its own, by id, so a retry spawn can find them
// after they have left their variant's list. Weak: nothing else holds them.
const exitedRuns = new Map<number, WeakRef<EncodeRun>>();

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

const stopPacing = (run: EncodeRun): void => {
  if (run.pacer) clearInterval(run.pacer);
  run.pacer = undefined;
  run.frozen = false;
};

const advanceHead = (variant: VariantState, run: EncodeRun): void => {
  while (variant.isProduced(run.head + 1)) run.head += 1;
};

/** Freezes or thaws an encode according to how far ahead of its player it is. */
const pace = (variant: VariantState, run: EncodeRun): void => {
  const child = run.child;
  if (!child || run.dead) return;
  advanceHead(variant, run);
  const lead = run.head - run.maxRequested;
  if (!run.frozen && lead >= PACE_AHEAD_SEGMENTS) {
    run.frozen = child.kill("SIGSTOP");
  } else if (run.frozen && lead < PACE_RESUME_SEGMENTS) {
    child.kill("SIGCONT");
    run.frozen = false;
  }
};

const killRun = (variant: VariantState, run: EncodeRun): void => {
  clearTimeout(run.idleTimer);
  stopPacing(run);
  run.child?.kill("SIGKILL");
  run.child = null;
  run.dead = true;
  run.killed = true;
  variant.runs = variant.runs.filter((r) => r !== run);
};

const reap = async (hlsDir: string): Promise<void> => {
  const session = sessions.get(hlsDir);
  if (!session) return;
  sessions.delete(hlsDir);
  clearTimeout(session.treeTimer);
  session.activity?.release();

  // Stop every encoder first so nothing is writing into a directory we're removing.
  for (const variant of session.variants.values()) {
    for (const run of [...variant.runs]) killRun(variant, run);
  }
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

const ensureVariant = (session: Session, height: number): VariantState => {
  let variant = session.variants.get(height);
  if (!variant) {
    variant = { runs: [], isProduced: () => false };
    session.variants.set(height, variant);
  }
  return variant;
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

const armRunIdle = (hlsDir: string, height: number, variant: VariantState, run: EncodeRun) => {
  clearTimeout(run.idleTimer);
  run.idleTimer = setTimeout(() => {
    if (run.dead) return;
    // A request is still waiting on this encode: the player hasn't moved on, it
    // is waiting for the segment past the encode head. Killing the encode now
    // would strand that request until it times out.
    if (run.waiters > 0) {
      armRunIdle(hlsDir, height, variant, run);
      return;
    }
    // Idle: the player switched quality or seeked away. Already-written segments
    // stay served; a later request for unwritten ones starts a new encode.
    killRun(variant, run);
    log.debug(
      { hlsDir: pathToken(hlsDir), height, startSegment: run.startSegment },
      "Reaped idle HLS encode",
    );
  }, VARIANT_IDLE_MS);
  run.idleTimer.unref?.();
};

const touchRun = (
  hlsDir: string,
  height: number,
  variant: VariantState,
  run: EncodeRun,
  segmentIndex?: number,
): void => {
  run.lastTouched = Date.now();
  armRunIdle(hlsDir, height, variant, run);
  if (segmentIndex !== undefined && segmentIndex > run.maxRequested) {
    run.maxRequested = segmentIndex;
    // Thaw at once rather than on the next pacing tick: the player is catching up.
    pace(variant, run);
  }
};

/**
 * The live encode that produces (or soon will produce) `segmentIndex`: started
 * at or before it, and with its head no more than `gap` segments short of it.
 * The latest-starting one wins, being the closest.
 */
const coveringRun = (
  variant: VariantState,
  segmentIndex: number,
  gap: number,
): EncodeRun | undefined => {
  let best: EncodeRun | undefined;
  for (const run of variant.runs) {
    if (run.dead || run.startSegment > segmentIndex) continue;
    advanceHead(variant, run);
    if (segmentIndex > run.head + gap) continue;
    if (!best || run.startSegment > best.startSegment) best = run;
  }
  return best;
};

/**
 * Marks a variant as actively in use. Call on every request that touches a
 * specific variant: a playlist request (no index) keeps all of its encodes
 * alive; a segment request keeps alive, and paces, the encode producing it.
 */
export const touchVariant = (hlsDir: string, height: number, segmentIndex?: number): void => {
  const variant = ensureVariant(ensureSession(hlsDir), height);
  if (segmentIndex === undefined) {
    for (const run of variant.runs) touchRun(hlsDir, height, variant, run);
    return;
  }
  const run = coveringRun(variant, segmentIndex, SEEK_RESTART_GAP_SEGMENTS);
  if (run) touchRun(hlsDir, height, variant, run, segmentIndex);
};

/**
 * Marks a request as waiting for segment `segmentIndex` of variant `height`.
 * Returns the function to call once it stops waiting. While any request waits
 * on an encode, the idle reaper leaves that encode running.
 */
export const keepVariantAlive = (
  hlsDir: string,
  height: number,
  segmentIndex?: number,
): (() => void) => {
  const variant = ensureVariant(ensureSession(hlsDir), height);
  const run =
    segmentIndex === undefined
      ? variant.runs.at(-1)
      : coveringRun(variant, segmentIndex, SEEK_RESTART_GAP_SEGMENTS);
  if (!run) return () => {};
  touchRun(hlsDir, height, variant, run, segmentIndex);
  run.waiters += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    run.waiters = Math.max(0, run.waiters - 1);
    // The wait itself was activity: give the player a full idle window from here.
    if (!run.dead) touchRun(hlsDir, height, variant, run);
  };
};

type EncodeClaim = {
  /** Segment index the new encode must start at. */
  startSegment: number;
  /** Pass to registerHlsProcess so the spawn attaches to this encode. */
  runId: number;
};

/**
 * Decides — atomically — whether variant `height` needs a new encode so that
 * segment `segmentIndex` gets produced, and if so claims one. Returns where the
 * new encode starts, or null if a running (or still queued) encode will reach
 * the segment soon enough and the request should just wait for it.
 *
 * A new encode starts at the requested segment rather than at 0, so a seek or a
 * quality switch late in a long video doesn't wait for minutes of re-encoding.
 * Other encodes of the variant keep running: a second viewer elsewhere in the
 * same video has its own, rather than the two dragging one encode back and
 * forth. Each idles out on its own once nobody asks for its part of the video,
 * and past MAX_RUNS_PER_VARIANT the least recently used is dropped.
 *
 * With no `segmentIndex` (a caller that only needs *an* encode, such as the
 * EVENT-playlist path) any live encode counts, and a new one starts at 0.
 *
 * `isProduced(i)` reports whether segment i is on disk; it lets the claim track
 * each encode's head. Runs synchronously with no `await`, so two
 * near-simultaneous requests can't double-spawn.
 */
export const claimVariantEncode = (
  hlsDir: string,
  height: number,
  requestedSegment?: number,
  isProduced: (segment: number) => boolean = () => false,
): EncodeClaim | null => {
  const variant = ensureVariant(ensureSession(hlsDir), height);
  variant.isProduced = isProduced;
  variant.runs = variant.runs.filter((run) => !run.dead);

  if (requestedSegment === undefined) {
    if (variant.runs.length > 0) return null;
  } else {
    const covering = coveringRun(variant, requestedSegment, SEEK_RESTART_GAP_SEGMENTS);
    if (covering) {
      // Make sure pacing knows the player wants this, or a frozen encode would
      // never reach it.
      touchRun(hlsDir, height, variant, covering, requestedSegment);
      return null;
    }
  }

  const startSegment = requestedSegment ?? 0;
  while (variant.runs.length >= MAX_RUNS_PER_VARIANT) {
    const leastRecent = variant.runs.reduce((a, b) => (a.lastTouched <= b.lastTouched ? a : b));
    killRun(variant, leastRecent);
  }
  const run: EncodeRun = {
    id: nextRunId++,
    child: null,
    dead: false,
    killed: false,
    startSegment,
    head: startSegment - 1,
    maxRequested: startSegment,
    waiters: 0,
    lastTouched: Date.now(),
    frozen: false,
  };
  variant.runs.push(run);
  armRunIdle(hlsDir, height, variant, run);
  log.debug(
    { hlsDir: pathToken(hlsDir), height, startSegment, running: variant.runs.length },
    "HLS encode claimed",
  );
  return { startSegment, runId: run.id };
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
 * Associates a spawned ffmpeg process with the encode it was claimed for, so the
 * reaper and pacing can act on it. Marks the encode dead when the process exits,
 * so a request for a segment it never wrote starts a new one instead of hanging.
 * A spawn for an encode that has since been dropped is killed on arrival.
 * Without a `runId`, attaches to the variant's newest encode that has no process.
 *
 * An encode whose process failed and is retried on a lower tier (see
 * encodeVariant) spawns again under the same `runId` after the first process
 * has exited; that spawn revives the run rather than being taken for an orphan.
 */
export const registerHlsProcess = (
  hlsDir: string,
  height: number,
  child: ChildProcess,
  runId?: number,
): void => {
  const variant = sessions.get(hlsDir)?.variants.get(height);
  const run =
    runId === undefined
      ? variant?.runs.findLast((r) => !r.dead && !r.child)
      : (variant?.runs.find((r) => r.id === runId) ?? exitedRuns.get(runId)?.deref());
  if (runId !== undefined) exitedRuns.delete(runId);
  if (!variant || !run || run.killed) {
    // No such encode any more (reaped, replaced, session gone): an orphan writer.
    child.kill("SIGKILL");
    return;
  }
  if (run.dead) {
    run.dead = false;
    if (!variant.runs.includes(run)) variant.runs.push(run);
    armRunIdle(hlsDir, height, variant, run);
  }
  run.child = child;
  stopPacing(run);
  run.pacer = setInterval(() => pace(variant, run), PACE_CHECK_MS);
  run.pacer.unref?.();
  child.once("exit", () => {
    if (run.child !== child) return;
    stopPacing(run);
    clearTimeout(run.idleTimer);
    run.child = null;
    run.dead = true;
    variant.runs = variant.runs.filter((r) => r !== run);
    exitedRuns.set(run.id, new WeakRef(run));
    // A retry spawns within moments of the exit, or never.
    setTimeout(() => exitedRuns.delete(run.id), 30_000).unref?.();
  });
};
