import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getExifMetadataFromFile } from "../fileHandling/fileUtils.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";

const dbBatchSize = 200;
const parallelism = 4;

/**
 * Processes pending EXIF metadata updates with pause/resume/cancel controls.
 */
export const processExifMetadata = (database: IndexDatabase): TaskRunner => {
  let state: "running" | "paused" | "cancelled" | "complete" = "running";
  let resumeSignal: (() => void) | null = null;

  const cancelledError = new Error("EXIF metadata processing cancelled");

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

      const items = await database.getFilesNeedingMetadataUpdate("exif", dbBatchSize);
      if (!items.length) {
        state = "complete";
        return;
      }

      for (const chunk of batch(items, parallelism)) {
        // @ts-expect-error - false positive type narrowing with mutable captured variable in async context
        if (state === "cancelled") {
          throw cancelledError;
        }

        await waitUntilResumed();
        // @ts-expect-error - false positive type narrowing with mutable captured variable in async context
        if (state === "cancelled") {
          throw cancelledError;
        }

        await Promise.all(
          chunk.map(async (entry) => {
            const { relativePath } = entry;
            const fullPath = path.join(
              database.storagePath,
              stripLeadingSlash(relativePath),
            );
            const now = new Date();
            try {
              const exif = await getExifMetadataFromFile(fullPath);
              await database.addOrUpdateFileData(entry.relativePath, {
                ...exif,
                exifProcessedAt: now.toISOString(),
              });
              if (Array.isArray(exif.regions) && exif.regions.length > 0) {
                await database.saveFacesFromMetadataRegions(
                  entry.relativePath,
                  exif.regions,
                  now,
                );
              }
            } catch {
              const errorDate = new Date();
              await database.addOrUpdateFileData(entry.relativePath, {
                exifProcessedAt: errorDate.toISOString(),
              });
            }
          }),
        );
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
      const totalEligible = counts.imageEntries + counts.videoEntries;
      const done = Math.max(0, totalEligible - counts.missingMediaMetadata);
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
