import os from "node:os";

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
