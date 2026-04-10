import path from "node:path";
import { getFastMediaDimensions, getFileInfo } from "../fileHandling/fileUtils.ts";
import { waitForBackgroundTasksEnabled } from "../common/backgroundTasksControl.ts";
import { measureOperation } from "../observability/requestTrace.ts";
import { IndexDatabase } from "./indexDatabase.ts";

const stripLeadingSlash = (value: string) => value.replace(/^\\?\//, "");

let isProcessingFileInfo = false;

export const startBackgroundProcessFileInfoMetadata = async (
  database: IndexDatabase,
  onComplete?: () => void,
) => {
  if (isProcessingFileInfo) {
    // Just for debugging - should never happen in practice
    throw new Error("File info processing is already running");
  }

  isProcessingFileInfo = true;
  const totalToProcess = await database.countFilesNeedingMetadataUpdate("info");
  let processedCount = 0;
  let restartAtMS = 0;
  let lastReportTime = Date.now();
  let lastReportCount = 0;

  const processAll = async () => {
    while (true) {
      await waitForBackgroundTasksEnabled();

      const batchSize = 200;
      const items = await database.getFilesNeedingMetadataUpdate("info", batchSize);
      if (!items.length) {
        console.log("[metadata:file-info] processing complete");
        onComplete?.();
        return;
      }

      for (const entry of items) {
        await waitForBackgroundTasksEnabled();

        const { relativePath } = entry;
        try {
          await measureOperation(
            "metadata.fileInfo.processEntry",
            async () => {
              const fullPath = path.join(database.storagePath, stripLeadingSlash(relativePath));

              const fileInfo = await getFileInfo(fullPath);
              const fastDimensions = await getFastMediaDimensions(fullPath);
              const now = new Date();
              const metadata = {
                ...fileInfo,
                ...fastDimensions,
                infoProcessedAt: now.toISOString(),
              };

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
          const percentComplete = ((processedCount / totalToProcess) * 100).toFixed(2);
          const rate =
            (processedCount - lastReportCount) /
            ((now.getTime() - lastReportTime) / 1000);
          lastReportCount = processedCount;
          console.log(
            `[metadata:file-info] ${percentComplete}% complete. ${rate.toFixed(2)} items/sec. Last processed: ${relativePath}`,
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

  processAll();

  const pause = (durationMS: number = 10_000) => {
    const localRestartMs = Date.now() + durationMS;
    restartAtMS = Math.max(restartAtMS, localRestartMs);
  };

  return pause;
};
