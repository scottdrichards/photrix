import { createKeyedWorkScheduler } from "./keyedWorkScheduler.ts";

// 2026-08-14: reverted to 2 (original value, unchanged since 2026-07-08).
// Briefly tried 1 to shorten preview tail latency behind thumbnail bursts,
// but reverted — the likelier bottleneck on LXC 124 (i7-10610U, 4c/8t) is
// the ML background workers (CLAP/face embeddings) competing for CPU, not
// this pool's own concurrency. Investigate background-task CPU usage before
// re-tuning this again.
// Override with PHOTRIX_MEDIA_CONVERSION_CONCURRENCY if needed.
const DEFAULT_MEDIA_CONVERSION_CONCURRENCY = 2;

const configuredConcurrency = Number.parseInt(
  process.env.PHOTRIX_MEDIA_CONVERSION_CONCURRENCY ?? "",
  10,
);

const mediaConversionConcurrency =
  Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
    ? configuredConcurrency
    : DEFAULT_MEDIA_CONVERSION_CONCURRENCY;

const scheduler = createKeyedWorkScheduler(mediaConversionConcurrency);

export const scheduleMediaConversion = <T>(
  key: string,
  work: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> => scheduler.schedule(key, work, options);
