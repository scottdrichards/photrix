import { readdir, stat, unlink, utimes } from "fs/promises";
import { join, resolve } from "path";
import { MEDIA_CACHE_DIR } from "./cacheUtils.ts";
import { getLogger } from "../observability/logger.ts";
import { isNotFound } from "./result.ts";
import { toError } from "./toError.ts";

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

// Grid thumbnails: the 160 micro tile (embedded-EXIF or decoded), the 320 photo
// tile and the 320 video frame. The overnight backfill (thumbnailBackfill.ts)
// makes one set per library file, so their total is bounded by the library
// (~3 GB for ~190k files), and they sit outside the LRU budget: counted in it,
// years of full-size views would slowly evict the backfill and grid scrolling
// would go cold again.
const GRID_THUMBNAIL_FILE_NAMES = new Set([
  "160.webp",
  "160.micro2.webp",
  "320.webp",
  "320.jpg",
]);

type CacheFile = {
  path: string;
  size: number;
  /** Last-used time: newest of access/modification time. */
  lastUsedMs: number;
};

/** Concurrent `stat` calls during a walk — enough to keep the disk busy, few enough to stay flat. */
const STAT_CONCURRENCY = 32;

/**
 * Lists every evictable cache file. Grid thumbnails are skipped by name before
 * they are ever stat'ed or held, since they are most of the files and none of
 * them can be evicted.
 *
 * Iterative with bounded concurrency on purpose. The recursive version spread
 * each subtree's results into `push(...)`, which throws "Maximum call stack size
 * exceeded" once a subtree holds enough files, and it stat'ed every file in the
 * cache at once; the backfill's ~230k thumbnails broke the first and turned the
 * second into a large heap spike every five minutes.
 */
const collectCacheFiles = async (root: string): Promise<CacheFile[]> => {
  const files: CacheFile[] = [];
  const dirs = [root];
  const pendingFiles: string[] = [];

  const statFile = async (fullPath: string) => {
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
  };

  const drainFiles = async () => {
    while (pendingFiles.length > 0) {
      await Promise.all(pendingFiles.splice(0, STAT_CONCURRENCY).map(statFile));
    }
  };

  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(fullPath);
      else if (entry.isFile() && !GRID_THUMBNAIL_FILE_NAMES.has(entry.name)) {
        pendingFiles.push(fullPath);
      }
    }
    if (pendingFiles.length >= STAT_CONCURRENCY) await drainFiles();
  }
  await drainFiles();
  return files;
};

let evictionInProgress = false;

/**
 * Enforces the media cache size limit by deleting least-recently-used files
 * until the total drops below the configured maximum. Grid thumbnails are
 * neither counted nor evicted ({@link GRID_THUMBNAIL_FILE_NAMES}). LRU is approximated by
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
  // A file evicted between the serve and this touch is fine; anything else isn't.
  void utimes(resolved, now, now).catch((error: unknown) => {
    const err = toError(error);
    if (!isNotFound(err)) log.warn({ err }, "Could not record cache access");
  });
};

/**
 * Starts a periodic background task that enforces the cache size limit. Runs
 * once on startup and then on an interval. Returns a stop function.
 */
export const startCacheEviction = (): (() => void) => {
  const intervalMs = Number(process.env.CACHE_EVICTION_INTERVAL_MS) || 5 * 60_000;

  void enforceCacheLimit().catch((err) => log.error({ err }, "Cache eviction failed"));

  const timer = setInterval(() => {
    void enforceCacheLimit().catch((err) => log.error({ err }, "Cache eviction failed"));
  }, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
};
