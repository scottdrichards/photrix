import { stat } from "node:fs/promises";
import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getLogger } from "../observability/logger.ts";
import { FileInfo } from "./fileRecord.type.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";

const log = getLogger("processFileInfo");

const batchSize = 200;

const getFileInfoMetadata = async (fullPath: string): Promise<FileInfo> =>
  stat(fullPath).then((stats) => ({
    sizeInBytes: stats.size,
    created: new Date(stats.birthtimeMs),
    modified: new Date(stats.mtimeMs),
  }));

export const processFileInfoMetadata = (database: IndexDatabase): TaskRunner => {
  const ctrl = createTaskController("File metadata processing cancelled");

  const completion = (async () => {
    while (true) {
      ctrl.checkCancelled();

      const items = await database.getFilesNeedingMetadataUpdate("info", batchSize);

      if (items.length === 0) {
        ctrl.markComplete();
        return;
      }

      for (const entry of items) {
        ctrl.checkCancelled();
        await ctrl.waitUntilResumed();
        ctrl.checkCancelled();

        const { relativePath } = entry;
        const fullPath = path.join(database.storagePath, stripLeadingSlash(relativePath));
        const infoProcessedAt = new Date().toISOString();
        try {
          const metadata = await getFileInfoMetadata(fullPath);
          await database.addOrUpdateFileData(relativePath, {
            ...metadata,
            infoProcessedAt,
          });
        } catch (error: unknown) {
          if (
            typeof error === "object" &&
            !!error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            await database.removeFile(relativePath);
            continue;
          }

          log.warn({ err: error, path: relativePath }, "File stat failed");
          await database.addOrUpdateFileData(relativePath, {
            infoProcessedAt,
          });
        }
      }
    }
  })();

  return {
    pause: ctrl.pause,
    resume: ctrl.resume,
    cancel: ctrl.cancel,
    getStatus: async () => {
      const counts = await database.getStatusCounts();
      const totalEligible = counts.allEntries;
      const done = Math.max(0, totalEligible - counts.missingFileMetadata);
      return {
        state: ctrl.state,
        itemsProcessed: done,
        total: totalEligible,
        portionComplete: totalEligible > 0 ? done / totalEligible : undefined,
      };
    },
    onComplete: () => completion,
  };
};
