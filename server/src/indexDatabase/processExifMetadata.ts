import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getExifMetadataFromFile } from "../fileHandling/fileUtils.ts";
import { measureOperation } from "../observability/requestTrace.ts";
import { batch, formatDuration } from "../utils.ts";
import { IndexDatabase } from "./indexDatabase.ts";

const dbBatchSize = 200;
const parallelism = 4;

let activeExifProcessing = false;

export const isExifMetadataProcessingActive = () => activeExifProcessing;

/**
 * Processes pending EXIF metadata updates.
 * Returns early without running when EXIF processing is already active.
 */
export const processExifMetadata = async (
  database: IndexDatabase,
  waitForEnabled: () => Promise<void>,
  onComplete?: () => void,
) => {
  if (activeExifProcessing) {
    return;
  }

  activeExifProcessing = true;

  let processedCount = 0;
  let totalToProcessUpdated = 0;
  let lastReportTime = Date.now();
  let lastReportCount = 0;

  const processAllBatches = async () => {
    while (true) {
      const items = await database.getFilesNeedingMetadataUpdate("exif", dbBatchSize);
      if (!items.length) {
        return;
      }

      // Keep a moving lower-bound estimate for progress without running an expensive
      // full-table COUNT(*) every loop iteration.
      totalToProcessUpdated = Math.max(
        totalToProcessUpdated,
        processedCount + items.length,
      );

      for (const chunk of batch(items, parallelism)) {
        await waitForEnabled();

        await Promise.all(
          chunk.map(async (entry) => {
            await measureOperation(
              "metadata.exif.processEntry",
              async () => {
                const { relativePath } = entry;
                const fullPath = path.join(
                  database.storagePath,
                  stripLeadingSlash(relativePath),
                );
                const now = new Date();
                try {
                  if (!entry.sizeInBytes) {
                    throw new Error("zero-byte file");
                  }
                  const exif = await getExifMetadataFromFile(fullPath);
                  await database.addOrUpdateFileData(entry.relativePath, {
                    ...exif,
                    exifProcessedAt: now.toISOString(),
                  });
                } catch (error) {
                  const errorDate = new Date();
                  await database.addOrUpdateFileData(entry.relativePath, {
                    exifProcessedAt: errorDate.toISOString(),
                  });
                  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                  console.log(`[metadata:exif] skipping file: ${relativePath}, ${error}`);
                }
                processedCount++;
              },
              { category: "other", detail: entry.relativePath, logWithoutRequest: true },
            );
          }),
        );

        const now = Date.now();
        if (now - lastReportTime > 1000) {
          const stableTotalToProcess = Math.max(totalToProcessUpdated, processedCount, 1);
          const percentComplete = ((processedCount / stableTotalToProcess) * 100).toFixed(
            2,
          );
          const rate =
            (processedCount - lastReportCount) / ((now - lastReportTime) / 1000);
          lastReportCount = processedCount;
          const remainingItems = Math.max(stableTotalToProcess - processedCount, 0);
          const totalSecondsRemaining = rate > 0 ? remainingItems / rate : Infinity;
          console.log(
            `[metadata:exif] ${percentComplete}% complete (${processedCount}/${stableTotalToProcess}). ${rate.toFixed(2)} items/sec. Time remaining: ${formatDuration(totalSecondsRemaining)}. Last processed batch ending with: ${chunk[chunk.length - 1]?.relativePath ?? "<none>"}`,
          );
          lastReportTime = now;
        }
      }
    }
  };

  await processAllBatches().finally(() => {
    activeExifProcessing = false;
  });

  console.log("[metadata:exif] processing complete");
  onComplete?.();
};
