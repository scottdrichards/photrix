import { createKeyedWorkScheduler } from "./keyedWorkScheduler.ts";

// 2026-08-14: lowered 2 -> 1 for the LXC 124 (i7-10610U, 4c/8t) host this
// pool now runs on. This value has been "2" unchanged since it was
// introduced (2026-07-08), tuned for the old, more powerful dev host — it
// was never re-tuned during the 2026-08-14 migration. A gallery-scroll burst
// of thumbnail conversions fills both pool slots and any fullscreen preview
// request has to wait a full slot's worth of CPU-bound PIL/HEIF work before
// it can even start, and the ML background workers (CLAP/face embeddings)
// compete for the same weak CPU on top of that. Serializing to 1 keeps a
// single conversion's tail latency predictable instead of doubling it.
// Override with PHOTRIX_MEDIA_CONVERSION_CONCURRENCY if this proves too
// conservative once VAAPI-accelerated paths take more of the load.
const DEFAULT_MEDIA_CONVERSION_CONCURRENCY = 1;

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
