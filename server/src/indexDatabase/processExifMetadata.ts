import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getExifMetadataFromFile, getFastMediaDimensions } from "../fileHandling/fileUtils.ts";
import { getLogger } from "../observability/logger.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";

const log = getLogger("processExifMetadata");

const dbBatchSize = 200;
const parallelism = 4;

type TaskCtrl = ReturnType<typeof createTaskController>;

const fillMissingDimensions = async (ctrl: TaskCtrl, database: IndexDatabase) => {
  while (true) {
    ctrl.checkCancelled();
    await ctrl.waitUntilResumed();
    ctrl.checkCancelled();

    const items = await database.getImagesMissingDimensions(dbBatchSize);
    if (!items.length) return;

    for (const chunk of batch(items, parallelism)) {
      ctrl.checkCancelled();
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();

      await Promise.all(
        chunk.map(async ({ relativePath }) => {
          const fullPath = path.join(database.storagePath, stripLeadingSlash(relativePath));
          try {
            const dims = await getFastMediaDimensions(fullPath);
            if (dims.dimensionWidth !== undefined && dims.dimensionHeight !== undefined) {
              await database.addOrUpdateFileData(relativePath, dims);
            }
          } catch (err) {
            log.warn({ err, path: relativePath }, "Dimension fill-in failed");
          }
        }),
      );
    }
  }
};

export const processExifMetadata = (database: IndexDatabase): TaskRunner => {
  const ctrl = createTaskController("EXIF metadata processing cancelled");

  const completion: Promise<void> = (async () => {
    while (true) {
      ctrl.checkCancelled();

      const items = await database.getFilesNeedingMetadataUpdate("exif", dbBatchSize);
      if (!items.length) {
        // All EXIF processing done. Fill in dimensions for images that were
        // processed before sharp was available and have null dimensionsWidth.
        await fillMissingDimensions(ctrl, database);
        ctrl.markComplete();
        return;
      }

      for (const chunk of batch(items, parallelism)) {
        ctrl.checkCancelled();
        await ctrl.waitUntilResumed();
        ctrl.checkCancelled();

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
            } catch (err) {
              log.warn({ err, path: relativePath }, "EXIF extraction failed");
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
    pause: ctrl.pause,
    resume: ctrl.resume,
    cancel: ctrl.cancel,
    getStatus: async () => {
      const counts = await database.getStatusCounts();
      const totalEligible = counts.imageEntries + counts.videoEntries;
      const done = Math.max(0, totalEligible - counts.missingMediaMetadata);
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
