import Hls from "hls.js";

// ---------------------------------------------------------------------------
// Asymmetric ABR hysteresis for HLS playback.
//
// Why: every level transcode on this deployment is produced on-demand by a
// shared 8GB GPU. A downswitch is cheap (we just stop asking for the higher
// rung) but an upswitch that turns out to be premature costs a wasted GPU
// transcode pass for the higher-quality segment *and* a visible stutter when
// the link can't actually sustain it and we have to drop right back down.
// Over the owner's variable T-Mobile WAN link, hls.js's stock ABR (which
// reacts to a single EWMA bandwidth sample in either direction) hunts: it
// climbs the moment one segment downloads fast, then immediately falls back.
//
// The fix keeps hls.js's own bandwidth estimator and default (fast) downward
// reaction untouched, but gates *upward* auto-level moves behind:
//   1. a dwell period since the last downswitch, and
//   2. several consecutive bandwidth samples with real headroom over the
//      candidate level's bitrate (not one optimistic sample).
// If the link keeps oscillating (down again shortly after an allowed
// upswitch), the dwell period escalates so a persistently bad link settles
// on a lower rung instead of hunting forever.
//
// This is implemented as a thin guard around hls.js's own `autoLevelCapping`
// (which only constrains Auto-mode level selection — manual level overrides
// from the UI's quality selector are unaffected). Downswitches are never
// capped or delayed: hls.js's internal ABR is left free to drop immediately
// on a stall or a falling estimate.
// ---------------------------------------------------------------------------

/** Minimum time an upswitch must wait after the most recent downswitch. */
export const UPSWITCH_DWELL_MS = 15_000;

/**
 * Each additional oscillation (a downswitch soon after an allowed upswitch)
 * multiplies the dwell by this factor, up to MAX_UPSWITCH_DWELL_MS.
 */
export const OSCILLATION_DWELL_MULTIPLIER = 2;

/** Ceiling on the escalating dwell so a link that eventually stabilizes can still recover quality. */
export const MAX_UPSWITCH_DWELL_MS = 120_000;

/**
 * A downswitch occurring within this long of the last allowed upswitch counts
 * as "the link is hunting" and escalates the dwell for next time.
 */
export const OSCILLATION_WINDOW_MS = 45_000;

/**
 * How long the link must go without a downswitch before we forgive prior
 * oscillations and reset the dwell back to the base value.
 */
export const OSCILLATION_RESET_IDLE_MS = 90_000;

/**
 * Bandwidth headroom required over a candidate level's bitrate before we'll
 * allow climbing to it — the estimate must clear the bitrate by this factor,
 * not just exceed it, to absorb overhead and estimation noise.
 */
export const UPSWITCH_HEADROOM_FACTOR = 1.5;

/** Consecutive good samples required before an upswitch is allowed (rejects a single lucky sample). */
export const UPSWITCH_SUSTAIN_SAMPLES = 3;

/** How often the guard re-samples hls.js's bandwidth estimate to evaluate an upswitch. */
export const ABR_GUARD_POLL_INTERVAL_MS = 1000;

export type AbrGuardState = {
  /** Auto-mode ceiling level index currently enforced, or -1 when uncapped. */
  capIndex: number;
  lastDownswitchAt: number | null;
  lastUpswitchAt: number | null;
  /** Count of recent oscillations (downswitch soon after an allowed upswitch). */
  oscillationCount: number;
  /** Rolling window of recent bandwidth samples in bits/s, oldest first. */
  recentBandwidthSamplesBps: number[];
};

export const createInitialAbrGuardState = (): AbrGuardState => ({
  capIndex: -1,
  lastDownswitchAt: null,
  lastUpswitchAt: null,
  oscillationCount: 0,
  recentBandwidthSamplesBps: [],
});

/** The dwell required after a downswitch, escalated by recent oscillation history. */
export const dwellForOscillationCount = (oscillationCount: number): number =>
  Math.min(
    MAX_UPSWITCH_DWELL_MS,
    UPSWITCH_DWELL_MS * OSCILLATION_DWELL_MULTIPLIER ** oscillationCount,
  );

/**
 * Record a downswitch to `newLevelIndex` at time `now`. Immediately caps Auto
 * mode at the new (lower) level — the cap itself is what blocks a premature
 * bounce-back — and escalates the oscillation counter if this downswitch
 * followed closely on the heels of the last allowed upswitch.
 */
export const applyDownswitch = (
  state: AbrGuardState,
  now: number,
  newLevelIndex: number,
): AbrGuardState => {
  const followedRecentUpswitch =
    state.lastUpswitchAt !== null && now - state.lastUpswitchAt < OSCILLATION_WINDOW_MS;
  const wasIdleSinceLastDownswitch =
    state.lastDownswitchAt !== null && now - state.lastDownswitchAt > OSCILLATION_RESET_IDLE_MS;

  let oscillationCount = state.oscillationCount;
  if (followedRecentUpswitch) {
    oscillationCount += 1;
  } else if (wasIdleSinceLastDownswitch) {
    // The link had settled for a good while since the last downswitch before
    // this new one — treat it as a fresh problem rather than continued hunting.
    oscillationCount = 0;
  }

  return {
    capIndex: newLevelIndex,
    lastDownswitchAt: now,
    lastUpswitchAt: state.lastUpswitchAt,
    oscillationCount,
    recentBandwidthSamplesBps: [],
  };
};

/** Record that the guard raised the cap (an allowed upswitch) to `newLevelIndex`. */
export const applyUpswitch = (
  state: AbrGuardState,
  now: number,
  newLevelIndex: number,
): AbrGuardState => ({
  ...state,
  capIndex: newLevelIndex,
  lastUpswitchAt: now,
  // Require a fresh set of sustained-headroom samples before climbing again.
  recentBandwidthSamplesBps: [],
});

/** Push a new bandwidth sample (bits/s) into the rolling window used for the sustain check. */
export const recordBandwidthSample = (
  state: AbrGuardState,
  bandwidthBps: number,
): AbrGuardState => {
  const window = [...state.recentBandwidthSamplesBps, bandwidthBps];
  while (window.length > UPSWITCH_SUSTAIN_SAMPLES) window.shift();
  return { ...state, recentBandwidthSamplesBps: window };
};

/**
 * Decide whether the guard should raise the auto-level cap to `candidateLevelIndex`
 * (bitrate `candidateBitrateBps`), given the current state at time `now`.
 * Pure/deterministic so the hysteresis policy is unit-testable without a real
 * hls.js instance or timers.
 */
export const shouldUpswitch = (
  state: AbrGuardState,
  now: number,
  candidateBitrateBps: number,
): boolean => {
  if (state.lastDownswitchAt !== null) {
    const dwellMs = dwellForOscillationCount(state.oscillationCount);
    if (now - state.lastDownswitchAt < dwellMs) return false;
  }

  if (state.recentBandwidthSamplesBps.length < UPSWITCH_SUSTAIN_SAMPLES) return false;

  const requiredBps = candidateBitrateBps * UPSWITCH_HEADROOM_FACTOR;
  return state.recentBandwidthSamplesBps.every((sample) => sample >= requiredBps);
};

// ---------------------------------------------------------------------------
// hls.js wiring
// ---------------------------------------------------------------------------

/**
 * Attach the asymmetric-ABR guard to a live Hls instance. Downswitches chosen
 * by hls.js's own (fast, untouched) ABR immediately cap Auto mode at the new
 * level; a poll loop reuses hls.js's own bandwidth estimator (no second,
 * competing measurement) to decide when enough dwell time and sustained
 * headroom have accumulated to lift the cap one rung at a time. Returns a
 * detach function to call when the Hls instance is destroyed.
 */
export const attachHlsAbrUpswitchGuard = (hls: Hls): (() => void) => {
  let state = createInitialAbrGuardState();
  let previousLevel: number | null = null;

  const onLevelSwitched = (_event: unknown, data: { level: number }) => {
    // Only react to hls.js's own Auto-mode decisions. A manual quality-selector
    // pick (see FullscreenViewer's quality <select>) is the user overriding ABR
    // entirely and should not be reinterpreted as a downswitch to guard against.
    if (hls.autoLevelEnabled && previousLevel !== null && data.level < previousLevel) {
      state = applyDownswitch(state, Date.now(), data.level);
      hls.autoLevelCapping = data.level;
    }
    previousLevel = data.level;
  };

  const onManifestParsed = () => {
    state = createInitialAbrGuardState();
    previousLevel = null;
    hls.autoLevelCapping = -1;
  };

  hls.on(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);
  hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);

  const intervalId = setInterval(() => {
    if (state.capIndex === -1) return; // Already fully auto; nothing to lift.

    const now = Date.now();
    const bandwidthBps = hls.bandwidthEstimate;
    if (typeof bandwidthBps === "number" && Number.isFinite(bandwidthBps)) {
      state = recordBandwidthSample(state, bandwidthBps);
    }

    const candidateIndex = state.capIndex + 1;
    const candidateLevel = hls.levels[candidateIndex];
    if (!candidateLevel) return;

    if (shouldUpswitch(state, now, candidateLevel.maxBitrate)) {
      const isTopLevel = candidateIndex >= hls.levels.length - 1;
      const nextCap = isTopLevel ? -1 : candidateIndex;
      state = applyUpswitch(state, now, candidateIndex);
      hls.autoLevelCapping = nextCap;
    }
  }, ABR_GUARD_POLL_INTERVAL_MS);

  return () => {
    clearInterval(intervalId);
    hls.off(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);
    hls.off(Hls.Events.MANIFEST_PARSED, onManifestParsed);
  };
};
