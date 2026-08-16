import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileSystemScanFolder } from "./fileSystemScanFolder.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("fileSystemRescanRecent");

const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Recursively collects every directory (absolute path) under `dir` whose own
 * mtime is at or after `cutoffMs` — i.e. a directory whose *immediate*
 * contents changed (a file was added/removed/renamed directly in it) since
 * the last check. A directory's mtime does not bubble up to its ancestors, so
 * every directory still has to be visited; this only costs a `readdir` +
 * `stat` per directory, not per file, so it stays cheap as the library grows
 * in photo count (it scales with folder count, e.g. by year/month/day).
 */
const collectChangedDirs = async (
  dir: string,
  cutoffMs: number,
  changed: string[],
): Promise<void> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Directory vanished mid-walk (moved/deleted concurrently) — nothing to
    // scope a scan to; the watcher/next full scan reconciles the deletion.
    return;
  }

  const stats = await stat(dir).catch(() => null);
  if (stats && stats.mtimeMs >= cutoffMs) {
    changed.push(dir);
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await collectChangedDirs(path.join(dir, entry.name), cutoffMs, changed);
    }
  }
};

// Drop any changed directory that's a descendant of another changed directory
// already in the list — fileSystemScanFolder walks its subFolder recursively,
// so scanning the ancestor already covers the descendant and re-scanning both
// would just do the same work twice.
const dropNestedDuplicates = (dirs: string[]): string[] => {
  const sorted = [...dirs].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const dir of sorted) {
    const isNested = kept.some(
      (ancestor) => dir === ancestor || dir.startsWith(ancestor + path.sep),
    );
    if (!isNested) kept.push(dir);
  }
  return kept;
};

/**
 * Complements the recursive `fs.watch` in `fileSystemMonitorFolder`, which
 * only sees changes made through the local filesystem's inotify layer — a
 * write made directly to the NAS over CIFS from another client never surfaces
 * an inotify event on this host, so files can land on disk and sit unindexed
 * until something else (a restart's full scan) notices them.
 *
 * Runs a cheap, scoped rescan on an interval: walks the directory tree
 * checking only directory mtimes (not a full recursive file scan), then runs
 * the existing `fileSystemScanFolder` scoped to just the directories that
 * actually changed since the last check. Returns a stop function.
 */
export const startPeriodicRescan = (
  database: IndexDatabase,
  onChange?: () => void,
): (() => void) => {
  const intervalMs =
    Number(process.env.FILE_SYSTEM_RESCAN_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  let lastScanMs = Date.now();
  let rescanInProgress = false;

  const runRescan = async () => {
    if (rescanInProgress) return;
    rescanInProgress = true;
    const cutoffMs = lastScanMs;
    const scanStartedAt = Date.now();
    try {
      const changedDirs: string[] = [];
      await collectChangedDirs(database.storagePath, cutoffMs, changedDirs);
      const scoped = dropNestedDuplicates(changedDirs).filter(
        (dir) => dir !== database.storagePath,
      );

      if (scoped.length) {
        log.info(
          { count: scoped.length },
          "Periodic rescan found changed folders, scanning",
        );
        for (const absoluteDir of scoped) {
          const relativeDir = path.relative(database.storagePath, absoluteDir);
          await fileSystemScanFolder(database, relativeDir).onComplete();
        }
        onChange?.();
      }
      // Only advance the watermark once the scoped scans above have
      // committed, so a directory that changes again mid-run isn't skipped
      // next cycle.
      lastScanMs = scanStartedAt;
    } catch (err) {
      log.warn({ err }, "Periodic rescan failed (will retry next interval)");
    } finally {
      rescanInProgress = false;
    }
  };

  const timer = setInterval(() => void runRescan(), intervalMs);
  timer.unref();

  return () => clearInterval(timer);
};
