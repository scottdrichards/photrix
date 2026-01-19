import path from "node:path";
import { IndexDatabase } from "./indexDatabase.ts";
import { generateMultibitrateHLS, multibitrateHLSExists } from "../videoProcessing/generateMultibitrateHLS.ts";
import { getHash } from "../common/cacheUtils.ts";
import { stat } from "node:fs/promises";

const stripLeadingSlash = (value: string) => value.replace(/^\\?\//, "");

const durationFormatter = new (Intl as any).DurationFormat("en");

let isProcessingHLS = false;

/**
 * Starts background HLS encoding for all videos after metadata processing is complete.
 * Similar to processExifMetadata but specifically for video HLS pre-encoding.
 */
export const startBackgroundHLSEncoding = (database: IndexDatabase, onComplete?: () => void) => {
  if (isProcessingHLS) {
    throw new Error("HLS encoding is already running");
  }
  isProcessingHLS = true;

  let restartAtMS: number = 0;
  let lastReportTime = Date.now();
  let lastReportCount = 0;
  let processedCount = 0;
  let totalToProcess = 0;

  const processAll = async () => {
    totalToProcess = database.countVideosReadyForHLS();
    console.log(`[hls-encode] Starting background HLS encoding for ${totalToProcess} videos`);

    while (true) {
      const batchSize = 20; // Smaller batch since HLS encoding takes longer
      const items = database.getVideosReadyForHLS(batchSize);

      // Filter to only videos that don't have HLS yet
      const needsEncoding: Array<{ relativePath: string; fullPath: string }> = [];
      for (const item of items) {
        const fullPath = path.join(database.storagePath, stripLeadingSlash(item.relativePath));
        try {
          const modifiedTimeMs = (await stat(fullPath)).mtimeMs;
          const hash = getHash(fullPath, modifiedTimeMs);
          if (!multibitrateHLSExists(hash)) {
            needsEncoding.push({ ...item, fullPath });
          }
        } catch {
          // File may have been deleted, skip it
        }
      }

      if (needsEncoding.length === 0) {
        console.log("[hls-encode] All videos have HLS streams, encoding complete");
        isProcessingHLS = false;
        onComplete?.();
        return;
      }

      // Process videos one at a time (NVENC is most efficient with single encodes)
      for (const item of needsEncoding) {
        // Check for pause
        while (restartAtMS && restartAtMS > Date.now()) {
          console.log("[hls-encode] Paused HLS encoding...");
          const timeoutDuration = restartAtMS - Date.now();
          await new Promise((resolve) => setTimeout(resolve, timeoutDuration));
        }

        const { relativePath, fullPath } = item;
        const startTime = Date.now();

        try {
          console.log(`[hls-encode] Encoding: ${relativePath}`);
          await generateMultibitrateHLS(fullPath, {
            priority: "background",
            waitForCompletion: true,
          });
          processedCount++;

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`[hls-encode] Completed: ${relativePath} (${elapsed}s)`);
        } catch (error) {
          console.error(`[hls-encode] Failed to encode ${relativePath}:`, error);
          processedCount++; // Count as processed even on failure
        }

        // Progress report
        const now = Date.now();
        if (now - lastReportTime > 10_000) {
          // Report every 10s for slow HLS encoding
          const percentComplete = ((processedCount / totalToProcess) * 100).toFixed(2);
          const rate = (processedCount - lastReportCount) / ((now - lastReportTime) / 1000);
          lastReportCount = processedCount;

          if (rate > 0) {
            const totalSecondsRemaining = (totalToProcess - processedCount) / rate;
            const hoursRemaining = Math.floor(totalSecondsRemaining / 3600);
            const minutesRemaining = Math.floor((totalSecondsRemaining % 3600) / 60);
            const secondsRemaining = Math.floor(totalSecondsRemaining % 60);
            const durationString = durationFormatter.format({
              hours: hoursRemaining,
              minutes: minutesRemaining,
              seconds: secondsRemaining,
            });
            console.log(
              `[hls-encode] ${percentComplete}% complete. ${(rate * 3600).toFixed(1)} videos/hour. Time remaining: ${durationString}`
            );
          } else {
            console.log(`[hls-encode] ${percentComplete}% complete (${processedCount}/${totalToProcess})`);
          }
          lastReportTime = now;
        }
      }
    }
  };

  processAll().catch((error) => {
    console.error("[hls-encode] Background HLS encoding failed:", error);
    isProcessingHLS = false;
  });

  const pause = (durationMS: number = 30_000) => {
    // Longer default pause for HLS since encoding is slow
    const localRestartMs = Date.now() + durationMS;
    restartAtMS = Math.max(restartAtMS, localRestartMs);
  };

  return pause;
};
