import { createKeyedWorkScheduler } from "./keyedWorkScheduler.ts";

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
