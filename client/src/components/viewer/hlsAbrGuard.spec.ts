import Hls from "hls.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDownswitch,
  attachHlsAbrUpswitchGuard,
  autoLevelCeiling,
  applyUpswitch,
  createInitialAbrGuardState,
  dwellForOscillationCount,
  forwardBufferSeconds,
  MAX_UPSWITCH_DWELL_MS,
  OSCILLATION_RESET_IDLE_MS,
  OSCILLATION_WINDOW_MS,
  recordBandwidthSample,
  shouldUpswitch,
  UPSWITCH_DWELL_MS,
  UPSWITCH_HEADROOM_FACTOR,
  UPSWITCH_MIN_BUFFER_S,
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

describe("climbing onto a rung that still has to be encoded", () => {
  const ready = () => {
    let state = createInitialAbrGuardState();
    for (let i = 0; i < UPSWITCH_SUSTAIN_SAMPLES; i++) {
      state = recordBandwidthSample(state, 100_000_000);
    }
    return state;
  };

  it("waits for a buffer deep enough to ride out the new rung's cold start", () => {
    // Measured: a cold 1080p encode took 3.6 s to its first segment while the
    // player held ~1 s of buffer, so hls.js's own climb stalled for 8 s.
    expect(shouldUpswitch(ready(), 0, 5_000_000, 1)).toBe(false);
    expect(shouldUpswitch(ready(), 0, 5_000_000, UPSWITCH_MIN_BUFFER_S - 0.1)).toBe(false);
    expect(shouldUpswitch(ready(), 0, 5_000_000, UPSWITCH_MIN_BUFFER_S)).toBe(true);
  });

  it("measures the buffer ahead of the playhead, not behind it or across a gap", () => {
    const ranges = (pairs: [number, number][]) => ({
      length: pairs.length,
      start: (i: number) => pairs[i][0],
      end: (i: number) => pairs[i][1],
    });
    const media = (currentTime: number, pairs: [number, number][]) =>
      ({ currentTime, buffered: ranges(pairs) }) as unknown as HTMLMediaElement;

    expect(forwardBufferSeconds(null)).toBe(0);
    expect(forwardBufferSeconds(media(5, [[0, 17]]))).toBe(12);
    expect(forwardBufferSeconds(media(20, [[0, 17], [30, 60]]))).toBe(0);
    expect(forwardBufferSeconds(media(30.2, [[0, 17], [30, 60]]))).toBeCloseTo(29.8);
  });
});

describe("Auto's 1080p ceiling (feedback #165)", () => {
  const ladder = (...heights: number[]) =>
    heights.map((height, i) => ({ height, maxBitrate: 1_000_000 * (i + 1) }));

  it("caps Auto below a 4K rung, and not at all without one", () => {
    expect(autoLevelCeiling(ladder(360, 720, 1080, 2160))).toBe(2);
    expect(autoLevelCeiling(ladder(360, 720, 1080))).toBe(-1);
    expect(autoLevelCeiling(ladder(360))).toBe(-1);
  });

  /** Just enough of an Hls instance for the guard. */
  const fakeHls = (levels: { height: number; maxBitrate: number }[]) => {
    const handlers = new Map<string, (event: unknown, data: { level: number }) => void>();
    const media = {
      currentTime: 0,
      buffered: { length: 1, start: () => 0, end: () => 60 },
    };
    const hls = {
      levels,
      autoLevelEnabled: true,
      autoLevelCapping: -1,
      bandwidthEstimate: 1_000_000_000,
      media,
      on: (event: string, fn: (event: unknown, data: { level: number }) => void) =>
        handlers.set(event, fn),
      off: (event: string) => handlers.delete(event),
    };
    const emit = (event: string, data: { level: number } = { level: 0 }) =>
      handlers.get(event)?.(event, data);
    return { hls, emit };
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never lifts Auto onto the 4K rung, however fast the link", () => {
    vi.useFakeTimers();
    const { hls, emit } = fakeHls(ladder(360, 720, 1080, 2160));
    const detach = attachHlsAbrUpswitchGuard(hls as unknown as Hls);

    emit(Hls.Events.MANIFEST_PARSED);
    expect(hls.autoLevelCapping).toBe(2);

    emit(Hls.Events.LEVEL_SWITCHED, { level: 0 });
    vi.advanceTimersByTime(10 * 60_000);
    expect(hls.autoLevelCapping).toBe(2);
    detach();
  });

  it("still lifts Auto to the top of a ladder without 4K", () => {
    vi.useFakeTimers();
    const { hls, emit } = fakeHls(ladder(360, 720, 1080));
    const detach = attachHlsAbrUpswitchGuard(hls as unknown as Hls);

    emit(Hls.Events.MANIFEST_PARSED);
    emit(Hls.Events.LEVEL_SWITCHED, { level: 0 });
    vi.advanceTimersByTime(10 * 60_000);
    expect(hls.autoLevelCapping).toBe(-1);
    detach();
  });
});
