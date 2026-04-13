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
import { scheduleWork } from "../common/scheduleWork.ts";
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

type ConversionWorkerStatus = {
  active: boolean;
  background: { completed: number; remaining: number };
  activeTaskCount: number;
  failures: number;
};

export const createConversionWorker = () => {
  let backgroundRunning = false;
  let restartAtMS = 0;
  let processedCount = 0;
  let failedCount = 0;
  let remainingCount = 0;
  let activeTaskCount = 0;

  const getStatus = (): ConversionWorkerStatus => ({
    active: backgroundRunning || activeTaskCount > 0,
    background: { completed: processedCount, remaining: remainingCount },
    activeTaskCount,
    failures: failedCount,
  });

  const submitActive = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    activeTaskCount++;
    return scheduleWork(key, work).finally(() => {
      activeTaskCount--;
    });
  };

  const pause = (durationMS = 30_000) => {
    restartAtMS = Math.max(restartAtMS, Date.now() + durationMS);
  };

  const startBackgroundLoop = async (database: IndexDatabase, onComplete?: () => void) => {
    if (backgroundRunning) throw new Error("Background conversion loop is already running");
    backgroundRunning = true;

    await database.resetInProgressConversions("thumbnail");
    await database.resetInProgressConversions("hls");

    remainingCount = (await database.countPendingConversions()).hls;

    let lastReportTime = Date.now();
    let lastReportCount = 0;

    const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

    const processAll = async () => {
      while (true) {
        await waitForBackgroundTasksEnabled();

        while (restartAtMS && restartAtMS > Date.now()) {
          console.log("[conversion-worker] Paused...");
          await new Promise((resolve) => setTimeout(resolve, restartAtMS - Date.now()));
        }

        // Yield to active tasks — they take priority over background work
        while (activeTaskCount > 0) {
          await yieldToEventLoop();
        }

        const [task] = await database.getNextConversionTasks();
        await yieldToEventLoop();

        if (!task) {
          console.log("[conversion-worker] All conversion tasks complete");
          backgroundRunning = false;
          onComplete?.();
          return;
        }

        const taskInfo = await database.getConversionTaskInfo(task.relativePath, task.taskType);
        const mimeType = taskInfo?.mimeType ?? null;
        const durationSeconds =
          typeof taskInfo?.duration === "number" && Number.isFinite(taskInfo.duration)
            ? Math.max(taskInfo.duration, 0)
            : 0;
        const originalPriority: PendingConversionTaskPriority =
          (taskInfo?.priority as PendingConversionTaskPriority) ??
          ConversionTaskPriority.Background;

        await database.setConversionPriority(
          task.relativePath,
          task.taskType,
          ConversionTaskPriority.InProgress,
        );
        await yieldToEventLoop();

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
          await database.setConversionPriority(task.relativePath, task.taskType, null);
          remainingCount = Math.max(0, remainingCount - 1);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`[conversion-worker] Completed: ${task.relativePath} (${elapsed}s)`);
        } catch (error) {
          failedCount++;
          await database.setConversionPriority(task.relativePath, task.taskType, originalPriority);
          console.error(`[conversion-worker] Failed: ${task.relativePath}:`, error);
        }

        processedCount++;

        const now = Date.now();
        if (now - lastReportTime > 10_000) {
          const pending = remainingCount;
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
      console.error("[conversion-worker] Background conversion loop failed:", error);
      backgroundRunning = false;
    });
  };

  return { getStatus, submitActive, pause, startBackgroundLoop };
};

export type ConversionWorker = ReturnType<typeof createConversionWorker>;
