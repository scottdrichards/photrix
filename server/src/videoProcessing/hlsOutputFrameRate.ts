/**
 * Ceiling on HLS output frame rate. Faster sources cost encode time and bitrate
 * a browser viewer rarely benefits from.
 */
const MAX_HLS_FPS = 30;

// Rates cameras actually record at. A variable-frame-rate phone clip reports
// an average a hair off one of these; encoding at that odd average would mean
// a non-standard output rate for no benefit.
const STANDARD_RATES = [
  [24000, 1001],
  [24, 1],
  [25, 1],
  [30000, 1001],
  [30, 1],
  [48, 1],
  [50, 1],
  [60000, 1001],
  [60, 1],
  [120, 1],
  [240, 1],
] as const;
const SNAP_TOLERANCE = 0.01;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * The frame rate (an ffmpeg rational, e.g. "24000/1001") to encode an HLS
 * variant at, given the source's ffprobe rate.
 *
 * Never resamples upward or by an uneven ratio: forcing a 24fps film to 30fps
 * repeats every fourth frame, and 50→30 drops frames irregularly; both read
 * as judder. So a source at or under the cap keeps its own rate, and a faster
 * one is divided by the smallest whole number that brings it under the cap
 * (60→30, 50→25, 120→30), keeping every retained frame evenly spaced.
 * HLS segment boundaries don't depend on this: keyframes are forced by time
 * (see encodeVariant).
 */
export const hlsOutputFrameRate = (sourceRate: string): string => {
  const [num, den] = sourceRate.split("/").map(Number);
  const fps = num / den;
  // ffprobe reports "0/0" when a container doesn't record a rate; the cap is the
  // one rate known to suit every variant.
  if (!Number.isFinite(fps) || fps <= 0) return `${MAX_HLS_FPS}/1`;

  const nearest = STANDARD_RATES.reduce((best, rate) =>
    Math.abs(rate[0] / rate[1] - fps) < Math.abs(best[0] / best[1] - fps) ? rate : best,
  );
  const [n, d] =
    Math.abs(nearest[0] / nearest[1] - fps) / fps <= SNAP_TOLERANCE
      ? nearest
      : [num, den];
  const outDen = d * Math.ceil(n / d / MAX_HLS_FPS - 1e-9);
  const divisor = gcd(n, outDen);
  return `${n / divisor}/${outDen / divisor}`;
};
