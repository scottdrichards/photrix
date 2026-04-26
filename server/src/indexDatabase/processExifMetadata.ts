import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getExifMetadataFromFile } from "../fileHandling/fileUtils.ts";
import { measureOperation } from "../observability/requestTrace.ts";
import { batch } from "../utils.ts";
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

  const processAllBatches = async () => {
    while (true) {
      const items = await database.getFilesNeedingMetadataUpdate("exif", dbBatchSize);
      if (!items.length) {
        return;
      }

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
                  const exif = await getExifMetadataFromFile(fullPath);
                  await database.addOrUpdateFileData(entry.relativePath, {
                    ...exif,
                    exifProcessedAt: now.toISOString(),
                  });
                } catch {
                  const errorDate = new Date();
                  await database.addOrUpdateFileData(entry.relativePath, {
                    exifProcessedAt: errorDate.toISOString(),
                  });
                }
              },
              { category: "other", detail: entry.relativePath, logWithoutRequest: true },
            );
          }),
        );


      }
    }
  };

  await processAllBatches().finally(() => {
    activeExifProcessing = false;
  });

  onComplete?.();
};
