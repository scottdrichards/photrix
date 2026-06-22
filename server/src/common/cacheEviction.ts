import { readdir, stat, unlink, utimes } from "fs/promises";
import { join, resolve } from "path";
import { MEDIA_CACHE_DIR } from "./cacheUtils.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("cacheEviction");

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB

/**
 * Parses a human-friendly size string ("10GB", "512mb", "1024") into bytes.
 * Plain numbers are treated as bytes. Returns null when the value is unset or
 * cannot be parsed.
 */
export const parseByteSize = (value: string | undefined): number | null => {
  if (!value) return null;
  const match = /^\s*([\d.]+)\s*(b|kb|mb|gb|tb)?\s*$/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = (match[2] ?? "b").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
  };
  return Math.floor(amount * multipliers[unit]);
};

const getMaxBytes = (): number =>
  parseByteSize(process.env.CACHE_MAX_BYTES) ?? DEFAULT_MAX_BYTES;

type CacheFile = {
  path: string;
  size: number;
  /** Last-used time: newest of access/modification time. */
  lastUsedMs: number;
};

const collectCacheFiles = async (dir: string): Promise<CacheFile[]> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const files: CacheFile[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectCacheFiles(fullPath)));
        return;
      }
      if (!entry.isFile()) return;
      try {
        const stats = await stat(fullPath);
        files.push({
          path: fullPath,
          size: stats.size,
          lastUsedMs: Math.max(stats.atimeMs, stats.mtimeMs),
        });
      } catch (err) {
        // File may have been removed between readdir and stat; ignore.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn({ err, path: fullPath }, "Failed to stat cache file");
        }
      }
    }),
  );
  return files;
};

let evictionInProgress = false;

/**
 * Enforces the media cache size limit by deleting least-recently-used files
 * until the total drops below the configured maximum. LRU is approximated by
 * the newest of each file's access/modification time (see {@link markCacheAccess}).
 *
 * Safe to call concurrently — overlapping calls are coalesced into one run.
 */
export const enforceCacheLimit = async (): Promise<{
  totalBytes: number;
  evictedBytes: number;
  evictedCount: number;
}> => {
  const noop = { totalBytes: 0, evictedBytes: 0, evictedCount: 0 };
  if (evictionInProgress) return noop;
  evictionInProgress = true;
  try {
    const maxBytes = getMaxBytes();
    const files = await collectCacheFiles(MEDIA_CACHE_DIR);
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

    if (totalBytes <= maxBytes) {
      return { totalBytes, evictedBytes: 0, evictedCount: 0 };
    }

    // Evict down to a low-water mark so we don't re-trigger on every new file.
    const targetBytes = Math.floor(maxBytes * 0.9);
    // Oldest first.
    files.sort((a, b) => a.lastUsedMs - b.lastUsedMs);

    let remaining = totalBytes;
    let evictedBytes = 0;
    let evictedCount = 0;
    for (const file of files) {
      if (remaining <= targetBytes) break;
      try {
        await unlink(file.path);
        remaining -= file.size;
        evictedBytes += file.size;
        evictedCount += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn({ err, path: file.path }, "Failed to evict cache file");
        }
      }
    }

    log.info(
      { totalBytes, maxBytes, evictedBytes, evictedCount, remainingBytes: remaining },
      "Cache eviction complete",
    );
    return { totalBytes, evictedBytes, evictedCount };
  } finally {
    evictionInProgress = false;
  }
};

/**
 * Records that a cached file was just used by bumping its modification time, so
 * the eviction policy treats it as recently used. Fire-and-forget: failures are
 * ignored and only files inside the media cache are touched.
 */
export const markCacheAccess = (filePath: string): void => {
  const resolved = resolve(filePath);
  if (!resolved.startsWith(resolve(MEDIA_CACHE_DIR))) return;
  const now = new Date();
  void utimes(resolved, now, now).catch(() => {});
};

/**
 * Starts a periodic background task that enforces the cache size limit. Runs
 * once on startup and then on an interval. Returns a stop function.
 */
export const startCacheEviction = (): (() => void) => {
  const intervalMs = Number(process.env.CACHE_EVICTION_INTERVAL_MS) || 5 * 60_000;

  void enforceCacheLimit().catch((err) =>
    log.error({ err }, "Cache eviction failed"),
  );

  const timer = setInterval(() => {
    void enforceCacheLimit().catch((err) =>
      log.error({ err }, "Cache eviction failed"),
    );
  }, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
};
