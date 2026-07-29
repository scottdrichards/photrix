import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * Returns available memory in MB. On Linux reads MemAvailable from
 * /proc/meminfo (which includes reclaimable page cache, unlike os.freemem()).
 * Falls back to os.freemem() on other platforms.
 */
export const getAvailableMemoryMB = (): number => {
  if (process.platform === "linux") {
    try {
      const content = readFileSync("/proc/meminfo", "utf8");
      const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(content);
      if (match?.[1]) return Number(match[1]) / 1024;
    } catch {
      // fall through
    }
  }
  return os.freemem() / (1024 * 1024);
};

/**
 * 1-minute load average normalized to the number of logical CPUs. ~1.0 means
 * the machine is fully subscribed; above that work is queueing for the CPU.
 *
 * `os.loadavg()` returns zeros on Windows, where this simply reads as "never
 * overloaded" and the load gate stays out of the way.
 */
export const getNormalizedLoad = (): number => {
  const cpuCount = os.cpus().length || 1;
  const [oneMinute = 0] = os.loadavg();
  return oneMinute / cpuCount;
};

const DEFAULT_OVERLOAD_THRESHOLD = 0.9;

const overloadThreshold = (): number => {
  const raw = Number.parseFloat(process.env.PHOTRIX_LOAD_THRESHOLD ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OVERLOAD_THRESHOLD;
};

/**
 * Whether the machine is hot enough that new background work should hold off and
 * let in-flight work (and user requests) drain first.
 */
export const isSystemOverloaded = (): boolean =>
  getNormalizedLoad() > overloadThreshold();
