import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { measureOperation } from "../observability/requestTrace.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import { stat } from "node:fs/promises";
import { FileInfo } from "./fileRecord.type.ts";

const getFileInfoMetadata = async (fullPath: string): Promise<FileInfo> => {
  const stats = await stat(fullPath);
  return {
    sizeInBytes: stats.size,
    created: new Date(stats.birthtimeMs),
    modified: new Date(stats.mtimeMs),
  };
};

export const startBackgroundProcessFileInfoMetadata = async (
  database: IndexDatabase,
  waitForEnabled: () => Promise<void>,
  onComplete?: () => void,
) => {
  let processedCount = 0;
  let totalToProcessUpdated = 0;
  let restartAtMS = 0;
  let lastReportTime = Date.now();
  let lastReportCount = 0;

  const processAll = async () => {
    while (true) {
      const batchSize = 200;
      const items = await database.getFilesNeedingMetadataUpdate("info", batchSize);
      if (!items.length) {
        console.log("[metadata:file-info] processing complete");
        onComplete?.();
        return;
      }

      // Keep a moving lower-bound estimate without an expensive full-table COUNT(*).
      totalToProcessUpdated = Math.max(
        totalToProcessUpdated,
        processedCount + items.length,
      );

      for (const entry of items) {
        await waitForEnabled();

        const { relativePath } = entry;
        try {
          await measureOperation(
            "metadata.fileInfo.processEntry",
            async () => {
              const fullPath = path.join(
                database.storagePath,
                stripLeadingSlash(relativePath),
              );
              const metadata = await getFileInfoMetadata(fullPath);
              await database.addOrUpdateFileData(relativePath, metadata);
            },
            { category: "other", detail: relativePath, logWithoutRequest: true },
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[metadata:file-info] failed to process ${relativePath}: ${msg}`);
          await database.addOrUpdateFileData(relativePath, {
            infoProcessedAt: new Date().toISOString(),
          });
        }

        const now = new Date();
        processedCount++;
        if (now.getTime() - lastReportTime > 1000) {
          const stableTotalToProcess = Math.max(totalToProcessUpdated, processedCount, 1);
          const percentComplete = ((processedCount / stableTotalToProcess) * 100).toFixed(
            2,
          );
          const rate =
            (processedCount - lastReportCount) /
            ((now.getTime() - lastReportTime) / 1000);
          lastReportCount = processedCount;
          console.log(
            `[metadata:file-info] ${percentComplete}% complete (${processedCount}/${stableTotalToProcess}). ${rate.toFixed(2)} items/sec. Last processed: ${relativePath}`,
          );
          lastReportTime = now.getTime();
        }

        while (restartAtMS && restartAtMS > Date.now()) {
          console.log("[metadata:file-info] paused processing...");
          const timeoutDuration = restartAtMS - Date.now();
          await new Promise((resolve) => setTimeout(resolve, timeoutDuration));
        }
      }
    }
  };

  void processAll();

  const pause = (durationMS: number = 10_000) => {
    const localRestartMs = Date.now() + durationMS;
    restartAtMS = Math.max(restartAtMS, localRestartMs);
  };

  return pause;
};
