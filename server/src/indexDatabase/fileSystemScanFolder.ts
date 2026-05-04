import path from "node:path";
import { walkFiles } from "../fileHandling/fileUtils.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";

/**
 * Does an entire scan of the files in the database's storage path and adds them to the database.
 */
export const fileSystemScanFolder = (
  database: IndexDatabase,
  subFolder?: string,
): TaskRunner => {
  const base = path.join(database.storagePath, subFolder ?? "");

  const batchSize = 500;
  let scannedFilesCount = 0;
  let currentItem = "";

  let state: "running" | "paused" | "cancelled" | "complete" = "running";
  let resumeSignal: (() => void) | null = null;

  const cancelledError = new Error("File system scan cancelled");

  const waitUntilResumed = async () => {
    if (state !== "paused") {
      return;
    }
    await new Promise<void>((resolve) => {
      resumeSignal = resolve;
    });
  };

  const completion: Promise<void> = (async () => {
    for (const absolutePathsBatch of batch(walkFiles(base), batchSize)) {
      // @ts-expect-error - false positive type narrowing with mutable captured variable in async context
      if (state === "cancelled") {
        throw cancelledError;
      }

      await waitUntilResumed();
      // @ts-expect-error - false positive type narrowing with mutable captured variable in async context
      if (state === "cancelled") {
        throw cancelledError;
      }

      const relativePathsBatch = absolutePathsBatch.map((absolutePath) =>
        path.relative(database.storagePath, absolutePath),
      );
      await database.addPaths(relativePathsBatch);
      scannedFilesCount += relativePathsBatch.length;
      currentItem = relativePathsBatch[relativePathsBatch.length - 1] ?? currentItem;
    }

    // @ts-expect-error - false positive type narrowing with mutable captured variable in async context
    if (state !== "cancelled") {
      state = "complete";
      return;
    }

    throw cancelledError;
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
    getStatus: () =>
      Promise.resolve({
        state,
        itemsProcessed: scannedFilesCount,
        description: currentItem || undefined,
      }),
    onComplete: () => completion,
  };
};
