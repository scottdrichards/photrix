import { stat } from "node:fs/promises";
import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { FileInfo } from "./fileRecord.type.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";

const batchSize = 200;

const getFileInfoMetadata = async (fullPath: string): Promise<FileInfo> =>
  stat(fullPath).then((stats) => ({
    sizeInBytes: stats.size,
    created: new Date(stats.birthtimeMs),
    modified: new Date(stats.mtimeMs),
  }));

/**
 * Processes pending file metadata updates (size, created, modified) with pause/resume/cancel controls.
 */
export const processFileInfoMetadata = (database: IndexDatabase): TaskRunner => {
  let state: "running" | "paused" | "cancelled" | "complete" = "running";
  let resumeSignal: (() => void) | null = null;

  const cancelledError = new Error("File metadata processing cancelled");

  const waitUntilResumed = async () => {
    if (state !== "paused") {
      return;
    }
    await new Promise<void>((resolve) => {
      resumeSignal = resolve;
    });
  };

  const completion: Promise<void> = (async () => {
    while (true) {
      // @ts-expect-error - false positive type narrowing with mutable captured variable in async context
      if (state === "cancelled") {
        throw cancelledError;
      }

      const items = await database.getFilesNeedingMetadataUpdate("info", batchSize);

      if (items.length === 0) {
        state = "complete";
        return;
      }

      for (const entry of items) {
        // @ts-expect-error - false positive type narrowing with mutable captured variable in async context
        if (state === "cancelled") {
          throw cancelledError;
        }

        await waitUntilResumed();
        // @ts-expect-error - false positive type narrowing with mutable captured variable in async context
        if (state === "cancelled") {
          throw cancelledError;
        }

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

          await database.addOrUpdateFileData(relativePath, {
            infoProcessedAt,
          });
        }
      }
    }
  })();

  return {
    pause: () => {
      if (state === "running") {
        state = "paused";
      }
    },
    resume: () => {
      if (state === "paused") {
        state = "running";
      }
      resumeSignal?.();
      resumeSignal = null;
      return Promise.resolve();
    },
    cancel: () => {
      state = "cancelled";
      resumeSignal?.();
      resumeSignal = null;
    },
    getStatus: async () => {
      const counts = await database.getStatusCounts();
      const totalEligible = counts.allEntries;
      const done = Math.max(0, totalEligible - counts.missingFileMetadata);
      return {
        state,
        itemsProcessed: done,
        total: totalEligible,
        portionComplete: totalEligible > 0 ? done / totalEligible : undefined,
      };
    },
    onComplete: () => completion,
  };
};
