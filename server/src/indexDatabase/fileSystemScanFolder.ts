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

  const completion: Promise<void> = (async () => {
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
