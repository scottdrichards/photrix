import {
  ENCODE_SPEED_HEADER,
  SEGMENT_WAIT_HEADER,
} from "../../../../shared/hls-segment-headers/src";

/**
 * Telling a slow encoder from a slow network (feedback #178).
 *
 * Each HLS segment is encoded while the player asks for it, so a segment can
 * be late for two different reasons: the server hadn't written it yet (the
 * encoder is slower than realtime at this quality) or it took too long to
 * download (the connection is slower than the stream). The server reports the
 * first per segment, in response headers; the second is the segment's own
 * transfer time. This module keeps the recent samples and says which one, if
 * either, is holding playback back.
 */

export type SegmentSample = {
  /** Seconds of video in the segment. */
  durationS: number;
  /** How long the server waited for the encoder to write it; null if not reported. */
  waitMs: number | null;
  /** First byte to last byte. */
  transferMs: number;
  /** The encoder's pace when it wrote this segment, in multiples of realtime. */
  encodeSpeed: number | null;
  bytes: number;
};

export type BottleneckReport =
  | {
      kind: "network";
      /** What the stream needs and what the connection is delivering, Mbit/s. */
      neededMbps: number;
      gettingMbps: number;
    }
  | {
      kind: "encoder";
      /** The encoder's recent pace, in multiples of realtime. */
      encodeSpeed: number;
    };

/** Samples a verdict is drawn from: the last few seconds of video. */
const WINDOW = 6;
const MIN_SAMPLES = 3;

/**
 * Share of each second of video one cause costs before it counts as the
 * bottleneck. Downloading a 1 s segment in 0.8 s, or encoding at 1.25x, leaves
 * so little margin that any extra wait (a request round trip, the other cause)
 * drains the buffer.
 */
const LOAD_THRESHOLD = 0.8;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Which cause the recent segments point to, or null when neither is close to
 * the limit (a stall then is a seek or a cold start, not a sustained shortfall).
 * Each cause is scored as seconds spent per second of video: transfer time for
 * the network, 1 / speed for the encoder. The larger one wins.
 */
export const classifyBottleneck = (samples: SegmentSample[]): BottleneckReport | null => {
  const recent = samples.filter((s) => s.durationS > 0).slice(-WINDOW);
  if (recent.length < MIN_SAMPLES) return null;

  const networkLoad = median(recent.map((s) => s.transferMs / (s.durationS * 1000)));
  const speeds = recent.flatMap((s) =>
    s.encodeSpeed && s.encodeSpeed > 0 ? [s.encodeSpeed] : [],
  );
  const encodeSpeed = speeds.length >= 2 ? median(speeds) : null;
  const encoderLoad = encodeSpeed ? 1 / encodeSpeed : 0;

  if (Math.max(networkLoad, encoderLoad) < LOAD_THRESHOLD) return null;
  if (encodeSpeed && encoderLoad >= networkLoad) {
    return { kind: "encoder", encodeSpeed: Math.round(encodeSpeed * 100) / 100 };
  }
  const bits = recent.reduce((sum, s) => sum + s.bytes * 8, 0);
  const videoS = recent.reduce((sum, s) => sum + s.durationS, 0);
  const transferS = recent.reduce((sum, s) => sum + s.transferMs / 1000, 0);
  return {
    kind: "network",
    neededMbps: round1(bits / videoS / 1e6),
    gettingMbps: transferS > 0 ? round1(bits / transferS / 1e6) : 0,
  };
};

/** Seconds of video buffered ahead of the playhead. */
export const bufferedAheadS = (video: HTMLMediaElement): number => {
  const { buffered, currentTime } = video;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime + 0.1 && currentTime < buffered.end(i)) {
      return buffered.end(i) - currentTime;
    }
  }
  return 0;
};

/** Below this much buffer a known bottleneck is shown; above the second it is hidden. */
export const SHOW_BELOW_BUFFER_S = 3;
export const HIDE_ABOVE_BUFFER_S = 6;

/**
 * Whether the indicator should show: only while the cause is actually hurting
 * (stalled, or the buffer nearly gone), with hysteresis so it doesn't blink as
 * each segment lands. Feedback #175 asked for nothing over a video that plays.
 */
export const shouldShowBottleneck = (opts: {
  report: BottleneckReport | null;
  stalled: boolean;
  bufferAheadS: number;
  showing: boolean;
}): boolean => {
  const { report, stalled, bufferAheadS, showing } = opts;
  if (!report) return false;
  if (stalled || bufferAheadS < SHOW_BELOW_BUFFER_S) return true;
  return showing && bufferAheadS <= HIDE_ABOVE_BUFFER_S;
};

/** Reads the server's numbers off a segment response; null when absent or bad. */
export const readSegmentHeaders = (
  xhr: Pick<XMLHttpRequest, "getResponseHeader"> | undefined,
): { waitMs: number | null; encodeSpeed: number | null } => {
  const read = (name: string) => {
    const raw = xhr?.getResponseHeader(name);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  return { waitMs: read(SEGMENT_WAIT_HEADER), encodeSpeed: read(ENCODE_SPEED_HEADER) };
};

/** Summary numbers for the `video.playback.summary` event. */
export const summarizeSegments = (samples: SegmentSample[]) => {
  if (samples.length === 0) return { segments: 0 };
  const waits = samples.flatMap((s) => (s.waitMs === null ? [] : [s.waitMs]));
  const speeds = samples.flatMap((s) => (s.encodeSpeed === null ? [] : [s.encodeSpeed]));
  return {
    segments: samples.length,
    medianWaitMs: waits.length ? Math.round(median(waits)) : null,
    totalWaitMs: Math.round(waits.reduce((a, b) => a + b, 0)),
    medianTransferMs: Math.round(median(samples.map((s) => s.transferMs))),
    totalTransferMs: Math.round(samples.reduce((a, s) => a + s.transferMs, 0)),
    medianEncodeSpeed: speeds.length ? median(speeds) : null,
    minEncodeSpeed: speeds.length ? Math.min(...speeds) : null,
  };
};
