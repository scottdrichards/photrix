import { getHeapStatistics } from "node:v8";
import { getLogger } from "./logger.ts";

const log = getLogger("memory");

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * Logs heap and native memory on an interval. The server runs with a fixed
 * heap cap, and a heap OOM aborts the process with only V8's last few GC lines,
 * so this trail is what shows whether memory crept up for hours or spiked.
 * PHOTRIX_MEMORY_LOG_INTERVAL_MS=0 turns it off.
 */
export const startMemoryLog = (): (() => void) => {
  const raw = process.env.PHOTRIX_MEMORY_LOG_INTERVAL_MS;
  const intervalMs = raw === undefined ? DEFAULT_INTERVAL_MS : Number(raw);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};

  const timer = setInterval(() => {
    const usage = process.memoryUsage();
    log.info(
      {
        rssMB: mb(usage.rss),
        heapUsedMB: mb(usage.heapUsed),
        heapLimitMB: mb(getHeapStatistics().heap_size_limit),
        externalMB: mb(usage.external),
        arrayBuffersMB: mb(usage.arrayBuffers),
      },
      "Memory usage",
    );
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};
