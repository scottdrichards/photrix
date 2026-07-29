import { describe, expect, it } from "vitest";
import {
  applyDownswitch,
  applyUpswitch,
  createInitialAbrGuardState,
  dwellForOscillationCount,
  MAX_UPSWITCH_DWELL_MS,
  OSCILLATION_RESET_IDLE_MS,
  OSCILLATION_WINDOW_MS,
  recordBandwidthSample,
  shouldUpswitch,
  UPSWITCH_DWELL_MS,
  UPSWITCH_HEADROOM_FACTOR,
  UPSWITCH_SUSTAIN_SAMPLES,
} from "./hlsAbrGuard";

const CANDIDATE_BITRATE_BPS = 4_000_000; // e.g. a 4 Mbps level
const AMPLE_BPS = CANDIDATE_BITRATE_BPS * UPSWITCH_HEADROOM_FACTOR + 1;

/** Fill the state's bandwidth window with `count` samples, all at `bps`. */
const withBandwidthSamples = (
  state: ReturnType<typeof createInitialAbrGuardState>,
  count: number,
  bps: number,
) => {
  let next = state;
  for (let i = 0; i < count; i++) {
    next = recordBandwidthSample(next, bps);
  }
  return next;
};

describe("shouldUpswitch", () => {
  it("allows an upswitch with no prior downswitch once samples show sustained headroom", () => {
    let state = createInitialAbrGuardState();
    state = withBandwidthSamples(state, UPSWITCH_SUSTAIN_SAMPLES, AMPLE_BPS);

    expect(shouldUpswitch(state, 0, CANDIDATE_BITRATE_BPS)).toBe(true);
  });

  it("blocks an upswitch immediately after a downswitch, even with ample bandwidth", () => {
    let state = createInitialAbrGuardState();
    state = applyDownswitch(state, 0, 0);
    state = withBandwidthSamples(state, UPSWITCH_SUSTAIN_SAMPLES, AMPLE_BPS);

    // Evaluated right at the downswitch instant — dwell hasn't elapsed yet.
    expect(shouldUpswitch(state, 0, CANDIDATE_BITRATE_BPS)).toBe(false);
  });

  it("blocks an upswitch during the dwell window even if the estimate briefly spikes", () => {
    let state = createInitialAbrGuardState();
    state = applyDownswitch(state, 0, 0);
    state = withBandwidthSamples(state, UPSWITCH_SUSTAIN_SAMPLES, AMPLE_BPS);

    expect(shouldUpswitch(state, UPSWITCH_DWELL_MS - 1, CANDIDATE_BITRATE_BPS)).toBe(false);
  });

  it("allows an upswitch once the dwell has elapsed and headroom is sustained", () => {
    let state = createInitialAbrGuardState();
    state = applyDownswitch(state, 0, 0);
    state = withBandwidthSamples(state, UPSWITCH_SUSTAIN_SAMPLES, AMPLE_BPS);

    expect(shouldUpswitch(state, UPSWITCH_DWELL_MS + 1, CANDIDATE_BITRATE_BPS)).toBe(true);
  });

  it("rejects a single optimistic sample — headroom must be sustained across samples", () => {
    let state = createInitialAbrGuardState();
    state = applyDownswitch(state, 0, 0);
    // Only one good sample, short of UPSWITCH_SUSTAIN_SAMPLES.
    state = recordBandwidthSample(state, AMPLE_BPS);

    expect(shouldUpswitch(state, UPSWITCH_DWELL_MS + 1, CANDIDATE_BITRATE_BPS)).toBe(false);
  });

  it("rejects headroom that doesn't clear the safety factor", () => {
    let state = createInitialAbrGuardState();
    state = applyDownswitch(state, 0, 0);
    // Exceeds the raw bitrate but not bitrate * UPSWITCH_HEADROOM_FACTOR.
    const thinBps = CANDIDATE_BITRATE_BPS * 1.05;
    state = withBandwidthSamples(state, UPSWITCH_SUSTAIN_SAMPLES, thinBps);

    expect(shouldUpswitch(state, UPSWITCH_DWELL_MS + 1, CANDIDATE_BITRATE_BPS)).toBe(false);
  });

  it("keeps only the most recent samples so a stale good streak doesn't count", () => {
    let state = createInitialAbrGuardState();
    state = applyDownswitch(state, 0, 0);
    state = withBandwidthSamples(state, UPSWITCH_SUSTAIN_SAMPLES, AMPLE_BPS);
    // One bad sample slides in; window is capped at UPSWITCH_SUSTAIN_SAMPLES so it
    // pushes out an old good one and the run is no longer all-good.
    state = recordBandwidthSample(state, 0);

    expect(shouldUpswitch(state, UPSWITCH_DWELL_MS + 1, CANDIDATE_BITRATE_BPS)).toBe(false);
  });
});

describe("dwellForOscillationCount / applyDownswitch escalation", () => {
  it("uses the base dwell for a first-time downswitch", () => {
    expect(dwellForOscillationCount(0)).toBe(UPSWITCH_DWELL_MS);
  });

  it("escalates the dwell when a downswitch follows soon after an allowed upswitch", () => {
    let state = createInitialAbrGuardState();
    state = applyDownswitch(state, 0, 0); // first drop
    state = applyUpswitch(state, 1000, 1); // guard allows climbing back

    // Link immediately falls back down again, well inside OSCILLATION_WINDOW_MS.
    state = applyDownswitch(state, 1000 + OSCILLATION_WINDOW_MS - 1, 0);

    expect(state.oscillationCount).toBe(1);
    expect(dwellForOscillationCount(state.oscillationCount)).toBe(
      UPSWITCH_DWELL_MS * 2,
    );
  });

  it("caps escalating dwell at MAX_UPSWITCH_DWELL_MS", () => {
    expect(dwellForOscillationCount(10)).toBe(MAX_UPSWITCH_DWELL_MS);
  });

  it("does not escalate a downswitch that happens long after the last upswitch", () => {
    let state = createInitialAbrGuardState();
    state = applyDownswitch(state, 0, 0);
    state = applyUpswitch(state, 1000, 1);

    // Falls back down well outside the oscillation window — a single slow
    // patch, not evidence of hunting.
    state = applyDownswitch(state, 1000 + OSCILLATION_WINDOW_MS + 1, 0);

    expect(state.oscillationCount).toBe(0);
  });

  it("forgives oscillation history after a long idle (stable) period", () => {
    let state = createInitialAbrGuardState();
    state = applyDownswitch(state, 0, 0);
    state = applyUpswitch(state, 1000, 1);
    state = applyDownswitch(state, 1000 + OSCILLATION_WINDOW_MS - 1, 0); // oscillation #1
    expect(state.oscillationCount).toBe(1);

    // Link then stays put for a long, stable stretch before dropping again.
    const stableDownswitchAt =
      (state.lastDownswitchAt ?? 0) + OSCILLATION_RESET_IDLE_MS + 1;
    state = applyDownswitch(state, stableDownswitchAt, 0);

    expect(state.oscillationCount).toBe(0);
  });
});
