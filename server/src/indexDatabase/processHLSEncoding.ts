import path from "node:path";
import { IndexDatabase } from "./indexDatabase.ts";
import { waitForBackgroundTasksEnabled } from "../common/backgroundTasksControl.ts";
import { generateMultibitrateHLS } from "../videoProcessing/generateMultibitrateHLS.ts";
import { convertImageToMultipleSizes } from "../imageProcessing/convertImage.ts";
import { standardHeights } from "../common/standardHeights.ts";
import type { StandardHeight } from "../common/standardHeights.ts";
import { generateVideoThumbnail } from "../videoProcessing/videoUtils.ts";
import { type ConversionPriority } from "../common/conversionPriority.ts";
import { measureOperation } from "../observability/requestTrace.ts";
import {
  ConversionTaskPriority,
  type PendingConversionTaskPriority,
} from "./indexDatabase.type.ts";

const stripLeadingSlash = (value: string) => value.replace(/^\\?\//, "");
const numericHeights = standardHeights.filter(
  (height): height is Exclude<StandardHeight, "original"> => typeof height === "number",
);

const toConversionPriority = (priority: PendingConversionTaskPriority): ConversionPriority => {
  if (priority === ConversionTaskPriority.UserBlocked) return "userBlocked";
  if (priority === ConversionTaskPriority.UserImplicit) return "userImplicit";
  return "background";
};

const formatDuration = (totalSeconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
};

let isProcessingHLS = false;

type HLSEncodingSnapshot = {
  active: boolean;
  videos: { completed: number; remaining: number };
  failures: number;
};

const hlsEncodingStatus: HLSEncodingSnapshot = {
  active: false,
  videos: { completed: 0, remaining: 0 },
  failures: 0,
};

export const getHLSEncodingStatus = (): HLSEncodingSnapshot => ({
  active: hlsEncodingStatus.active,
  videos: { ...hlsEncodingStatus.videos },
  failures: hlsEncodingStatus.failures,
});

export const startBackgroundConversionWorker = (
  database: IndexDatabase,
  onComplete?: () => void,
) => {
  if (isProcessingHLS) {
    throw new Error("HLS encoding is already running");
  }
  isProcessingHLS = true;

  // Reset any tasks that were in-progress when the server last shut down
  database.resetInProgressConversions("thumbnail");
  database.resetInProgressConversions("hls");

  let restartAtMS = 0;
  let lastReportTime = Date.now();
  let lastReportCount = 0;
  let processedCount = 0;
  let failedCount = 0;

  const markSnapshot = () => {
    hlsEncodingStatus.active = isProcessingHLS;
    hlsEncodingStatus.videos.completed = processedCount;
    hlsEncodingStatus.videos.remaining = database.countPendingConversions().hls;
    hlsEncodingStatus.failures = failedCount;
  };

  const processAll = async () => {
    while (true) {
      await waitForBackgroundTasksEnabled();

      while (restartAtMS && restartAtMS > Date.now()) {
        console.log("[hls-encode] Paused HLS encoding...");
        await new Promise((resolve) => setTimeout(resolve, restartAtMS - Date.now()));
      }

      const [task] = database.getNextConversionTasks();
      if (!task) {
        console.log("[conversion-worker] All conversion tasks complete");
        isProcessingHLS = false;
        markSnapshot();
        onComplete?.();
        return;
      }

      const taskInfo = database.getConversionTaskInfo(task.relativePath, task.taskType);
      const mimeType = taskInfo?.mimeType ?? null;
      const durationSeconds =
        typeof taskInfo?.duration === "number" && Number.isFinite(taskInfo.duration)
          ? Math.max(taskInfo.duration, 0)
          : 0;
      const originalPriority: PendingConversionTaskPriority =
        (taskInfo?.priority as PendingConversionTaskPriority) ?? ConversionTaskPriority.Background;

      database.setConversionPriority(
        task.relativePath,
        task.taskType,
        ConversionTaskPriority.InProgress,
      );

      const fullPath = path.join(database.storagePath, stripLeadingSlash(task.relativePath));

      const startTime = Date.now();
      try {
        const conversionPriority = toConversionPriority(originalPriority);
        await measureOperation(
          "conversionWorker.processTask",
          async () => {
            if (task.taskType === "hls") {
              console.log(`[conversion-worker] HLS: ${task.relativePath}`);
              await generateMultibitrateHLS(fullPath, {
                priority: conversionPriority,
                waitForCompletion: true,
                contentDurationSeconds: durationSeconds,
              });
              return;
            }

            if (mimeType?.startsWith("video/")) {
              console.log(`[conversion-worker] Thumbnail (video): ${task.relativePath}`);
              await generateVideoThumbnail(fullPath, 320, { priority: conversionPriority });
              return;
            }

            console.log(`[conversion-worker] Thumbnail (image): ${task.relativePath}`);
            await convertImageToMultipleSizes(fullPath, numericHeights, {
              priority: conversionPriority,
            });
          },
          {
            category: "conversion",
            detail: `${task.taskType}:${task.relativePath}`,
            logWithoutRequest: true,
          },
        );
        database.setConversionPriority(task.relativePath, task.taskType, null);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[conversion-worker] Completed: ${task.relativePath} (${elapsed}s)`);
      } catch (error) {
        failedCount++;
        database.setConversionPriority(task.relativePath, task.taskType, originalPriority);
        console.error(`[conversion-worker] Failed: ${task.relativePath}:`, error);
      }

      processedCount++;
      markSnapshot();

      const now = Date.now();
      if (now - lastReportTime > 10_000) {
        const pending = hlsEncodingStatus.videos.remaining;
        const rate = (processedCount - lastReportCount) / ((now - lastReportTime) / 1000);
        lastReportCount = processedCount;
        if (rate > 0) {
          console.log(
            `[conversion-worker] ${processedCount} done, ${pending} remaining, failures: ${failedCount}. ${(rate * 3600).toFixed(1)} tasks/hour. ~${formatDuration(pending / rate)} left`,
          );
        } else {
          console.log(
            `[conversion-worker] ${processedCount} done, ${pending} remaining, failures: ${failedCount}`,
          );
        }
        lastReportTime = now;
      }
    }
  };

  processAll().catch((error) => {
    console.error("[conversion-worker] Background conversion worker failed:", error);
    isProcessingHLS = false;
    markSnapshot();
  });

  const pause = (durationMS = 30_000) => {
    restartAtMS = Math.max(restartAtMS, Date.now() + durationMS);
  };

  return pause;
};

// Backward-compatible export name used by existing imports/tests.
export const startBackgroundHLSEncoding = startBackgroundConversionWorker;
