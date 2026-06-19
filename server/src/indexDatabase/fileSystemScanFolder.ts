import path from "node:path";
import { walkFiles } from "../fileHandling/fileUtils.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";

export const fileSystemScanFolder = (
  database: IndexDatabase,
  subFolder?: string,
): TaskRunner => {
  const base = path.join(database.storagePath, subFolder ?? "");

  const batchSize = 500;
  let scannedFilesCount = 0;
  let currentItem = "";

  const ctrl = createTaskController("File system scan cancelled");

  const completion: Promise<void> = (async () => {
    for (const absolutePathsBatch of batch(walkFiles(base), batchSize)) {
      ctrl.checkCancelled();
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();

      const relativePathsBatch = absolutePathsBatch.map((absolutePath) =>
        path.relative(database.storagePath, absolutePath),
      );
      await database.addPaths(relativePathsBatch);
      scannedFilesCount += relativePathsBatch.length;
      currentItem = relativePathsBatch[relativePathsBatch.length - 1] ?? currentItem;
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
