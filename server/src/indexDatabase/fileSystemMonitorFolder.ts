import { watch } from "node:fs";
import { lstat, rename as fsRename } from "node:fs/promises";
import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import {
  clearMirroredCacheForFile,
  getMirroredCacheBaseDirectory,
} from "../common/cacheUtils.ts";
import { fileSystemScanFolder } from "./fileSystemScanFolder.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("fileSystemMonitor");

// A rename on disk surfaces as a delete of the old path and a create of the new
// one, and `fs.watch` does not guarantee their order (on Linux the create is
// often delivered first). Buffer both sides for this window and pair them by
// content fingerprint, so a move is recognised regardless of arrival order and
// preserves the file's derived metadata instead of degrading to add + remove.
const MOVE_WINDOW_MS = 500;

// A single save often streams many `change` events as bytes are written. Wait
// this long after the last one before re-syncing, so we act on the settled file
// rather than reprocessing a half-written one repeatedly.
const DEFAULT_CHANGE_SETTLE_MS = 2000;

type PendingEntry = {
  sizeInBytes: number;
  modifiedMs: number;
  timer: ReturnType<typeof setTimeout>;
};

export type FileSystemMonitorOptions = {
  /**
   * Called after the index gains new work (a new file appears, or a changed
   * file is queued for re-sync), so drained background processors can be
   * re-triggered.
   */
  onChange?: () => void;
  /**
   * How long to wait after the last `change` event on a file before re-syncing
   * it, to coalesce a save's write burst. Defaults to {@link DEFAULT_CHANGE_SETTLE_MS}.
   */
  changeSettleMs?: number;
};

export const fileSystemMonitorFolder = (
  db: IndexDatabase,
  { onChange, changeSettleMs = DEFAULT_CHANGE_SETTLE_MS }: FileSystemMonitorOptions = {},
) => {
  const rootPath = db.storagePath;
  // Both keyed by relative path; each side is scanned by fingerprint to pair a
  // delete with a create (in either arrival order) into a single move.
  const pendingDeletes = new Map<string, PendingEntry>();
  const pendingCreates = new Map<string, PendingEntry>();
  const pendingResyncs = new Map<string, ReturnType<typeof setTimeout>>();

  const toRelative = (filename: string) =>
    stripLeadingSlash(
      path.relative(rootPath, path.join(rootPath, filename)).replace(/\\/g, "/"),
    );

  // Match how processFileInfo stores mtime (`new Date(mtimeMs)`, which truncates
  // sub-millisecond precision) so the fingerprint stored in the DB and the one
  // derived from a live `stat` compare equal.
  const toModifiedMs = (mtimeMs: number) => Math.trunc(mtimeMs);

  const commitDelete = async (relativePath: string) => {
    pendingDeletes.delete(relativePath);
    clearTimeout(pendingResyncs.get(relativePath));
    pendingResyncs.delete(relativePath);
    if (!(await db.removeFile(relativePath))) {
      await db.removeFolder(relativePath);
    }
  };

  const completeMove = async (oldPath: string, newPath: string) => {
    log.info(`Move detected: ${oldPath} → ${newPath}`);
    const moved = await db.moveFile(oldPath, newPath);
    if (moved) {
      await tryMoveCacheDir(path.join(rootPath, oldPath), path.join(rootPath, newPath));
    } else {
      // Source was not in the DB after all — just register the new path.
      await db.addPaths([newPath]);
    }
    onChange?.();
  };

  const tryMoveCacheDir = async (oldAbsPath: string, newAbsPath: string) => {
    const src = getMirroredCacheBaseDirectory(oldAbsPath);
    const dst = getMirroredCacheBaseDirectory(newAbsPath);
    if (src === dst) return;
    try {
      await fsRename(src, dst);
    } catch {
      // Cache dir missing or destination occupied — will regenerate naturally.
    }
  };

  // Re-sync a file whose bytes changed in place: reset its derived index state
  // and drop its now-stale cached derivatives so the pipeline rebuilds them.
  // Debounced per path via CHANGE_SETTLE_MS to coalesce a save's write burst.
  const commitResync = async (relativePath: string) => {
    pendingResyncs.delete(relativePath);
    if (!(await db.markFileForResync(relativePath))) return;
    await clearMirroredCacheForFile(path.join(rootPath, relativePath));
    log.info(`Change detected, re-syncing: ${relativePath}`);
    onChange?.();
  };

  const scheduleResync = (relativePath: string) => {
    clearTimeout(pendingResyncs.get(relativePath));
    pendingResyncs.set(
      relativePath,
      setTimeout(() => void commitResync(relativePath), changeSettleMs),
    );
  };

  const handleFileCreate = async (
    relativePath: string,
    stats: Awaited<ReturnType<typeof lstat>>,
  ) => {
    if (Number(stats.size) === 0) {
      // An in-place rewrite briefly truncates the file to 0 bytes, so a size-0
      // event is not proof the file is gone. If it's already indexed, treat it
      // as a change and let the debounced resync settle on the final content
      // (the info pass prunes files that really are empty). Only an unindexed
      // 0-byte path is nothing to track.
      if (await db.getFileRecord(relativePath)) scheduleResync(relativePath);
      return;
    }

    const sizeInBytes = Number(stats.size);
    const modifiedMs = toModifiedMs(Number(stats.mtimeMs));

    // Destination half of a move whose delete already arrived (delete-first).
    for (const [oldPath, pending] of pendingDeletes) {
      if (pending.sizeInBytes === sizeInBytes && pending.modifiedMs === modifiedMs) {
        clearTimeout(pending.timer);
        pendingDeletes.delete(oldPath);
        await completeMove(oldPath, relativePath);
        return;
      }
    }

    // Already indexed? Then this is an in-place edit (or a redundant event),
    // not a new file — INSERT OR IGNORE would silently drop it. Re-sync only if
    // the fingerprint actually moved.
    const existing = await db.getFileRecord(relativePath);
    if (existing) {
      if (existing.modified == null || existing.sizeInBytes == null) {
        // Not yet fingerprinted by the info pass — it's still queued for its
        // initial processing. Just make sure the pipeline is running.
        onChange?.();
        return;
      }
      const existingModifiedMs =
        existing.modified instanceof Date
          ? existing.modified.getTime()
          : Number(existing.modified);
      if (existing.sizeInBytes !== sizeInBytes || existingModifiedMs !== modifiedMs) {
        scheduleResync(relativePath);
      }
      return;
    }

    // Not indexed and unpaired: either a brand-new file, or the create half of a
    // move whose delete hasn't landed yet (create-first, the common order on
    // Linux). Buffer it; a matching delete within the window becomes a move,
    // otherwise it registers as a new file.
    clearTimeout(pendingCreates.get(relativePath)?.timer);
    pendingCreates.set(relativePath, {
      sizeInBytes,
      modifiedMs,
      timer: setTimeout(() => {
        pendingCreates.delete(relativePath);
        void (async () => {
          await db.addPaths([relativePath]);
          onChange?.();
        })();
      }, MOVE_WINDOW_MS),
    });
  };

  const handleDelete = async (relativePath: string) => {
    const record = await db.getFileRecord(relativePath);
    if (!record?.sizeInBytes || !record?.modified) {
      // No indexed metadata to fingerprint — delete immediately.
      await commitDelete(relativePath);
      return;
    }

    const modifiedMs =
      record.modified instanceof Date
        ? record.modified.getTime()
        : Number(record.modified);

    // Source half of a move whose create already arrived (create-first).
    for (const [newPath, pending] of pendingCreates) {
      if (
        pending.sizeInBytes === record.sizeInBytes &&
        pending.modifiedMs === modifiedMs
      ) {
        clearTimeout(pending.timer);
        pendingCreates.delete(newPath);
        await completeMove(relativePath, newPath);
        return;
      }
    }

    // Otherwise buffer the delete to pair with a create that may still arrive.
    pendingDeletes.set(relativePath, {
      sizeInBytes: record.sizeInBytes,
      modifiedMs,
      timer: setTimeout(() => void commitDelete(relativePath), MOVE_WINDOW_MS),
    });
  };

  const handleChange = async (_eventType: "rename" | "change", filename: string) => {
    const relativePath = toRelative(filename);
    if (!relativePath) return;

    const absolutePath = path.join(rootPath, relativePath);

    try {
      const stats = await lstat(absolutePath);
      if (stats.isFile()) {
        await handleFileCreate(relativePath, stats);
      } else if (stats.isDirectory()) {
        // A new/renamed directory can drop in many files at once; scan it so they
        // are all registered, then wake the pipeline.
        await fileSystemScanFolder(db, relativePath).onComplete();
        onChange?.();
      }
    } catch {
      await handleDelete(relativePath);
    }
  };

  const watcher = watch(rootPath, { recursive: true }, (_et, fn) => {
    if (fn) void handleChange(_et, fn);
  });

  // A recursive watcher re-scans directories as it walks the tree; when one is
  // deleted mid-scan (a folder moved or removed in the library) that scan throws
  // ENOENT and Node raises it as an "error" event. An EventEmitter "error" with
  // no listener is rethrown and takes the whole process down, so absorb it: the
  // affected path's change is simply missed, and a rescan picks it up later.
  watcher.on("error", (err) => {
    log.warn(`Filesystem watcher error on ${rootPath}: ${String(err)}`);
  });

  return () => {
    watcher.close();
    for (const { timer } of pendingDeletes.values()) clearTimeout(timer);
    pendingDeletes.clear();
    for (const { timer } of pendingCreates.values()) clearTimeout(timer);
    pendingCreates.clear();
    for (const timer of pendingResyncs.values()) clearTimeout(timer);
    pendingResyncs.clear();
  };
};
