import {
  LONG_VIDEO_SECONDS,
  MAX_ANALYSIS_FRAMES,
} from "../videoProcessing/extractAnalysisFrames.ts";

/**
 * What one video costs the video-face pass, and how long the rest of the
 * queue will take.
 *
 * Counting videos is useless for an ETA here: a 3 s clip costs a second, a
 * 3 min 4K clip is read end to end off the media share and costs a minute.
 * So each video is priced from what the index already knows about it (length,
 * file size, resolution) with a model that mirrors how frames are extracted
 * (extractAnalysisFrames.ts):
 *
 * - **Keyframe mode** (up to {@link LONG_VIDEO_SECONDS}): ffmpeg reads the
 *   whole file and decodes every keyframe, so the cost is the read (file size)
 *   plus the decodes (keyframes × pixels).
 * - **Seek mode** (longer): a fixed number of seeks. Each one reads and
 *   decodes from the keyframe before its target, so it costs more the higher
 *   the bitrate: a 100 Mbit/s 4K clip pays ~5 s a seek, a 30 Mbit/s one ~2 s.
 * - **Detection**: one face-model call per analysed frame.
 *
 * The coefficients start from measurements and then follow this run: every
 * finished video corrects them (see {@link createVideoFaceEta}). That also
 * absorbs what the model can't see, such as the face model falling back to
 * CPU or a slow share. The ETA divides by the share of wall time the task
 * actually works, so pauses for users and other tasks are priced in.
 *
 * The runner reads the next video's frames while the face model works on the
 * current one's, so a video costs the wall clock its slower stage, not both.
 */

export type VideoFaceCostInputs = {
  durationSeconds?: number;
  sizeBytes?: number;
  width?: number;
  height?: number;
};

/**
 * Starting coefficients, least-squares fits to extraction timed on 36 random
 * library videos on 2026-10-26 (CPU ffmpeg, two threads, media share read
 * over the network). Per video the fit is rough (±70 %), but its total over the 36 is
 * exact by construction, and a queue's total is what an ETA needs. Detection
 * is an estimate for the production GPU at 1920 px; the run corrects it within
 * a few dozen videos. See docs/video-faces.md.
 */
export const VIDEO_FACE_COST_PRIORS = {
  /** Per video in keyframe mode: process start, probe, JPEG writes. */
  keyframeBaseMs: 900,
  /** Keyframe mode reads the whole file: ~50 MB/s off the share. */
  keyframeMsPerMB: 20,
  /** Keyframe decode, per keyframe per megapixel. Small next to the read. */
  keyframeMsPerKeyframeMegapixel: 1.6,
  /** Keyframes decoded per second of video (phone video: roughly one a second). */
  keyframesPerSecond: 1,
  /** Analysed frames per second of short video, before the cap (median 0.8). */
  analysedFramesPerSecond: 0.8,
  /** Per seek in seek mode, plus the bitrate term below. */
  seekBaseMs: 1_000,
  seekMsPerMbitPerSecond: 34,
  /** One face-model call on one frame. */
  detectMsPerFrame: 150,
} as const;

/** What the model knows when a video has no stored dimensions. */
const DEFAULT_MEGAPIXELS = 2;
/** Bitrate assumed when it can't be worked out. The library averages ~50. */
const DEFAULT_MBIT_PER_SECOND = 50;

type VideoFaceCost = { extractMs: number; frames: number };

/** A video waiting for the face pass, with what ordering it needs. */
export type QueuedVideoFaces = { relativePath: string } & VideoFaceCostInputs & {
    /** ms since epoch: date taken, else file creation. */
    takenAt?: number;
    /** It failed once and came back after the retry cooldown. */
    failedBefore: boolean;
  };

/** Videos taken this recently go first, so new footage gets faces soon. */
export const RECENT_VIDEO_MS = 30 * 24 * 60 * 60 * 1_000;

const megapixels = ({ width, height }: VideoFaceCostInputs): number =>
  width && height ? (width * height) / 1e6 : DEFAULT_MEGAPIXELS;

export const predictVideoFaceCost = (
  video: VideoFaceCostInputs,
  priors = VIDEO_FACE_COST_PRIORS,
): VideoFaceCost => {
  const mp = megapixels(video);
  const sizeMB = (video.sizeBytes ?? 0) / 1e6;
  const known = video.durationSeconds !== undefined && video.durationSeconds > 0;

  if (known && video.durationSeconds! > LONG_VIDEO_SECONDS) {
    const mbitPerSecond =
      sizeMB > 0 ? (sizeMB * 8) / video.durationSeconds! : DEFAULT_MBIT_PER_SECOND;
    return {
      extractMs:
        MAX_ANALYSIS_FRAMES *
        (priors.seekBaseMs + priors.seekMsPerMbitPerSecond * mbitPerSecond),
      frames: MAX_ANALYSIS_FRAMES,
    };
  }

  // Unknown length: extraction caps the read at LONG_VIDEO_SECONDS, so guess
  // the length from the size and cap it the same way.
  const seconds = known
    ? video.durationSeconds!
    : Math.min(LONG_VIDEO_SECONDS, (sizeMB * 8) / DEFAULT_MBIT_PER_SECOND);
  const readMB = known
    ? sizeMB
    : Math.min(sizeMB, (LONG_VIDEO_SECONDS * DEFAULT_MBIT_PER_SECOND) / 8);
  const keyframes = Math.max(1, seconds * priors.keyframesPerSecond);
  return {
    extractMs:
      priors.keyframeBaseMs +
      priors.keyframeMsPerMB * readMB +
      priors.keyframeMsPerKeyframeMegapixel * keyframes * mp,
    frames: Math.min(
      MAX_ANALYSIS_FRAMES,
      Math.max(1, Math.round(seconds * priors.analysedFramesPerSecond)),
    ),
  };
};

/** How fast the corrections follow new videos: ~the last 20 count. */
const SMOOTHING = 0.1;
/** One freak video (a stalled read) may move a correction this much at most. */
const MAX_RATIO_PER_VIDEO = 10;
/** Below this much wall time, the work share is noise; assume full time. */
const MIN_WALL_FOR_DUTY_MS = 10 * 60_000;
const MIN_DUTY = 0.05;

type VideoFaceEta = {
  /**
   * Folds one finished video into the corrections. Returns what the model
   * predicted for it before learning from it, for the log.
   */
  record: (
    video: VideoFaceCostInputs,
    actual: { extractMs: number; detectMs: number; frames: number },
  ) => number;
  /** Time left for these queued videos, wall clock. */
  estimateMs: (queue: readonly VideoFaceCostInputs[]) => number;
  /** The live corrections, for the progress log. */
  snapshot: () => { extractScale: number; detectMsPerFrame: number; workShare: number };
};

export const createVideoFaceEta = (
  now: () => number = Date.now,
  priors = VIDEO_FACE_COST_PRIORS,
): VideoFaceEta => {
  const startedAt = now();
  // Multiplies the modelled extraction time; learned in log space, so a video
  // twice as slow as predicted and one twice as fast cancel out.
  let logExtractScale = 0;
  let detectMsPerFrame: number = priors.detectMsPerFrame;
  let busyMs = 0;

  const workShare = () => {
    const wallMs = now() - startedAt;
    if (wallMs < MIN_WALL_FOR_DUTY_MS) return 1;
    return Math.min(1, Math.max(MIN_DUTY, busyMs / wallMs));
  };

  const cost = (video: VideoFaceCostInputs) => {
    const { extractMs, frames } = predictVideoFaceCost(video, priors);
    return Math.max(extractMs * Math.exp(logExtractScale), frames * detectMsPerFrame);
  };

  return {
    record: (video, actual) => {
      const predicted = cost(video);
      const { extractMs } = predictVideoFaceCost(video, priors);
      if (extractMs > 0 && actual.extractMs > 0) {
        const ratio = actual.extractMs / (extractMs * Math.exp(logExtractScale));
        const bounded = Math.min(
          MAX_RATIO_PER_VIDEO,
          Math.max(1 / MAX_RATIO_PER_VIDEO, ratio),
        );
        logExtractScale += SMOOTHING * Math.log(bounded);
      }
      if (actual.frames > 0) {
        const perFrame = Math.min(
          actual.detectMs / actual.frames,
          detectMsPerFrame * MAX_RATIO_PER_VIDEO,
        );
        detectMsPerFrame += SMOOTHING * (perFrame - detectMsPerFrame);
      }
      // The two stages overlap (see cost), so the slower one is the time spent.
      busyMs += Math.max(actual.extractMs, actual.detectMs);
      return predicted;
    },
    estimateMs: (queue) =>
      queue.reduce((sum, video) => sum + cost(video), 0) / workShare(),
    snapshot: () => ({
      extractScale: Number(Math.exp(logExtractScale).toFixed(2)),
      detectMsPerFrame: Math.round(detectMsPerFrame),
      workShare: Number(workShare().toFixed(2)),
    }),
  };
};

/**
 * The order the face pass takes videos in: recent ones (last
 * {@link RECENT_VIDEO_MS}) first, then the rest, and cheapest first inside
 * each group, so the most videos get faces soonest and a few huge long
 * recordings don't hold up thousands of short clips. Videos that failed
 * before go last of all: they are the likeliest to fail again.
 */
export const orderVideoFaceQueue = <T extends QueuedVideoFaces>(
  videos: readonly T[],
  now: number = Date.now(),
  priors = VIDEO_FACE_COST_PRIORS,
): T[] => {
  const group = (video: T) =>
    video.failedBefore ? 2 : (video.takenAt ?? 0) >= now - RECENT_VIDEO_MS ? 0 : 1;
  const cost = (video: T) => {
    const { extractMs, frames } = predictVideoFaceCost(video, priors);
    return extractMs + frames * priors.detectMsPerFrame;
  };
  return videos
    .map((video) => ({ video, group: group(video), cost: cost(video) }))
    .sort((a, b) => a.group - b.group || a.cost - b.cost)
    .map(({ video }) => video);
};
