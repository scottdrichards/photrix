import { createKeyedWorkScheduler } from "./keyedWorkScheduler.ts";
import { config } from "../config/config.ts";

// 2026-08-14: reverted to 2 (original value, unchanged since 2026-07-08).
// Briefly tried 1 to shorten preview tail latency behind thumbnail bursts,
// but reverted — the likelier bottleneck on a 4-core host (i7-10610U, 4c/8t) is
// the ML background workers (CLAP/face embeddings) competing for CPU, not
// this pool's own concurrency. Investigate background-task CPU usage before
// re-tuning this again. Set with PHOTRIX_MEDIA_CONVERSION_CONCURRENCY.
const scheduler = createKeyedWorkScheduler(config().media.conversionConcurrency);

export const scheduleMediaConversion = <T>(
  key: string,
  work: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> => scheduler.schedule(key, work, options);
