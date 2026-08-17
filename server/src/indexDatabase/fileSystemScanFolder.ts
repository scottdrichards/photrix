import { stat } from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "../fileHandling/fileUtils.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import { canonicalRelativePath } from "./utils/pathUtils.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";

export const fileSystemScanFolder = (
  database: IndexDatabase,
  subFolder?: string,
): TaskRunner => {
  const base = path.join(database.storagePath, subFolder ?? "");
  const relativeBase = path.relative(database.storagePath, base);

  const batchSize = 500;
  let scannedFilesCount = 0;
  let currentItem = "";

  const ctrl = createTaskController("File system scan cancelled");
  // Only the root scan (no subFolder) is trusted to judge whether the whole
  // media root is mounted — a subfolder scan legitimately sees an empty
  // slice of a populated library.
  const isRootScan = !relativeBase;

  const completion: Promise<void> = (async () => {
    if (isRootScan) {
      const rootStats = await stat(base).catch(() => null);
      if (!rootStats?.isDirectory()) {
        // The root path itself is missing (e.g. an unmounted network share
        // presenting no directory at all). Treat the index as unloaded
        // rather than walking an absent tree and pruning everything it
        // "didn't find" — see docs/host-migration.md "Incident: DB got
        // zeroed out from the earlier empty-mount workaround".
        database.setMediaRootUnavailable?.(true);
        ctrl.markComplete();
        return;
      }
    }

    // Track every path seen on disk so we can prune index entries whose files
    // were moved or deleted while the watcher wasn't running.
    const seenPaths = new Set<string>();

    for (const absolutePathsBatch of batch(walkFiles(base), batchSize)) {
      ctrl.checkCancelled();
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();

      const discoveredPaths = await Promise.all(
        absolutePathsBatch.map(async (absolutePath) => {
          const stats = await stat(absolutePath).catch(() => null);
          if (!stats?.isFile() || stats.size === 0) {
            return null;
          }
          return path.relative(database.storagePath, absolutePath);
        }),
      );
      const relativePathsBatch = discoveredPaths.filter(
        (relativePath) => relativePath !== null,
      );
      if (!relativePathsBatch.length) {
        continue;
      }

      await database.addPaths(relativePathsBatch);
      for (const relativePath of relativePathsBatch) {
        seenPaths.add(canonicalRelativePath(relativePath));
      }
      scannedFilesCount += relativePathsBatch.length;
      currentItem = relativePathsBatch[relativePathsBatch.length - 1] ?? currentItem;
    }

    // The walk completed without cancellation (a cancel throws above), so
    // seenPaths is authoritative for the scanned scope: any indexed path not
    // in it no longer exists on disk and is removed.
    const indexedPaths = await database.getIndexedPaths(relativeBase || undefined);

    if (isRootScan && seenPaths.size === 0 && indexedPaths.length > 0) {
      // A root scan that found *zero* files while the index already has
      // entries almost certainly means the media root is present as a
      // directory but not actually mounted (an empty local mountpoint), not
      // that the entire library vanished. Refuse to prune — leave the index
      // as-is and mark it unloaded rather than wiping it out from under a
      // transient mount failure.
      database.setMediaRootUnavailable?.(true);
      ctrl.markComplete();
      return;
    }
    if (isRootScan) {
      database.setMediaRootUnavailable?.(false);
    }

    const missingPaths = indexedPaths.filter((p) => !seenPaths.has(p));
    if (missingPaths.length) {
      await database.removePaths(missingPaths);
    }

    ctrl.markComplete();
  })();

  return {
    pause: ctrl.pause,
    resume: ctrl.resume,
    cancel: ctrl.cancel,
    getStatus: () =>
      Promise.resolve({
        state: ctrl.state,
        itemsProcessed: scannedFilesCount,
        description: currentItem || undefined,
      }),
    onComplete: () => completion,
  };
};
