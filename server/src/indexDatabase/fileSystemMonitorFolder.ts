import { watch } from "node:fs";
import { lstat, rename as fsRename } from "node:fs/promises";
import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getMirroredCacheBaseDirectory } from "../common/cacheUtils.ts";
import { fileSystemScanFolder } from "./fileSystemScanFolder.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("fileSystemMonitor");

// A rename event on disk generates a delete + create in quick succession.
// Buffer deletes for this many ms so we can pair them with a matching create.
const MOVE_WINDOW_MS = 500;

type PendingDelete = {
  sizeInBytes: number;
  modifiedMs: number;
  timer: ReturnType<typeof setTimeout>;
};

export const fileSystemMonitorFolder = (db: IndexDatabase) => {
  const rootPath = db.storagePath;
  const pendingDeletes = new Map<string, PendingDelete>();

  const toRelative = (filename: string) =>
    stripLeadingSlash(
      path
        .relative(rootPath, path.join(rootPath, filename))
        .replace(/\\/g, "/"),
    );

  const commitDelete = async (relativePath: string) => {
    pendingDeletes.delete(relativePath);
    if (!(await db.removeFile(relativePath))) {
      await db.removeFolder(relativePath);
    }
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

  const handleFileCreate = async (
    relativePath: string,
    stats: Awaited<ReturnType<typeof lstat>>,
  ) => {
    const sizeInBytes = Number(stats.size);
    const modifiedMs = Math.round(Number(stats.mtimeMs));

    // Check whether this create is the destination half of a pending move.
    for (const [oldPath, pending] of pendingDeletes) {
      if (pending.sizeInBytes === sizeInBytes && pending.modifiedMs === modifiedMs) {
        clearTimeout(pending.timer);
        pendingDeletes.delete(oldPath);
        log.info(`Move detected: ${oldPath} → ${relativePath}`);
        const moved = await db.moveFile(oldPath, relativePath);
        if (moved) {
          await tryMoveCacheDir(
            path.join(rootPath, oldPath),
            path.join(rootPath, relativePath),
          );
        } else {
          // Source was not yet in DB — just register the new path.
          await db.addPaths([relativePath]);
        }
        return;
      }
    }

    await db.addPaths([relativePath]);
  };

  const handleDelete = async (relativePath: string) => {
    const record = await db.getFileRecord(relativePath);
    if (!record?.sizeInBytes || !record?.modified) {
      // No indexed metadata to fingerprint — delete immediately.
      await commitDelete(relativePath);
      return;
    }

    const pending: PendingDelete = {
      sizeInBytes: record.sizeInBytes,
      modifiedMs: record.modified instanceof Date
        ? record.modified.getTime()
        : Number(record.modified),
      timer: setTimeout(() => void commitDelete(relativePath), MOVE_WINDOW_MS),
    };
    pendingDeletes.set(relativePath, pending);
  };

  const handleChange = async (
    _eventType: "rename" | "change",
    filename: string,
  ) => {
    const relativePath = toRelative(filename);
    if (!relativePath) return;

    const absolutePath = path.join(rootPath, relativePath);

    try {
      const stats = await lstat(absolutePath);
      if (stats.isFile()) {
        await handleFileCreate(relativePath, stats);
      } else if (stats.isDirectory()) {
        await fileSystemScanFolder(db, absolutePath).onComplete();
      }
    } catch {
      await handleDelete(relativePath);
    }
  };

  const watcher = watch(
    rootPath,
    { recursive: true },
    (_et, fn) => { if (fn) void handleChange(_et, fn); },
  );

  return () => {
    watcher.close();
    for (const { timer } of pendingDeletes.values()) clearTimeout(timer);
    pendingDeletes.clear();
  };
};
