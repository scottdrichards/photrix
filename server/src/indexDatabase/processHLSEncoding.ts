import path from "node:path";
import { stat } from "node:fs/promises";
import { IndexDatabase } from "./indexDatabase.ts";
import {
  generateMultibitrateHLS,
  getMultibitrateHLSDirectory,
  multibitrateHLSExists,
} from "../videoProcessing/generateMultibitrateHLS.ts";
import { getHash } from "../common/cacheUtils.ts";

const stripLeadingSlash = (value: string) => value.replace(/^\\?\//, "");

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
  videos: {
    total: number;
    completed: number;
    remaining: number;
    queued: number;
  };
  videoSeconds: {
    total: number;
    completed: number;
    remaining: number;
    queued: number;
  };
  failures: number;
};

const hlsEncodingStatus: HLSEncodingSnapshot = {
  active: false,
  videos: {
    total: 0,
    completed: 0,
    remaining: 0,
    queued: 0,
  },
  videoSeconds: {
    total: 0,
    completed: 0,
    remaining: 0,
    queued: 0,
  },
  failures: 0,
};

const updateHLSEncodingSnapshot = (params: {
  active: boolean;
  totalVideos: number;
  completedVideos: number;
  failedVideos: number;
  totalDurationSeconds: number;
  completedDurationSeconds: number;
  currentItemDurationSeconds: number;
}) => {
  const {
    active,
    totalVideos,
    completedVideos,
    failedVideos,
    totalDurationSeconds,
    completedDurationSeconds,
    currentItemDurationSeconds,
  } = params;

  const remainingVideos = Math.max(totalVideos - completedVideos, 0);
  const processingVideos = active && remainingVideos > 0 ? 1 : 0;
  const queuedVideos = Math.max(remainingVideos - processingVideos, 0);

  const remainingSeconds = Math.max(totalDurationSeconds - completedDurationSeconds, 0);
  const normalizedCurrentItemSeconds = Math.min(
    Math.max(currentItemDurationSeconds, 0),
    remainingSeconds,
  );
  const queuedSeconds = Math.max(remainingSeconds - normalizedCurrentItemSeconds, 0);

  hlsEncodingStatus.active = active;
  hlsEncodingStatus.videos = {
    total: totalVideos,
    completed: completedVideos,
    remaining: remainingVideos,
    queued: queuedVideos,
  };
  hlsEncodingStatus.videoSeconds = {
    total: totalDurationSeconds,
    completed: completedDurationSeconds,
    remaining: remainingSeconds,
    queued: queuedSeconds,
  };
  hlsEncodingStatus.failures = failedVideos;
};

export const getHLSEncodingStatus = (): HLSEncodingSnapshot => ({
  active: hlsEncodingStatus.active,
  videos: { ...hlsEncodingStatus.videos },
  videoSeconds: { ...hlsEncodingStatus.videoSeconds },
  failures: hlsEncodingStatus.failures,
});

export const startBackgroundHLSEncoding = (
  database: IndexDatabase,
  onComplete?: () => void,
) => {
  if (isProcessingHLS) {
    throw new Error("HLS encoding is already running");
  }
  isProcessingHLS = true;

  let restartAtMS = 0;
  let lastReportTime = Date.now();
  let lastReportCount = 0;
  let processedCount = 0;
  let failedCount = 0;
  let totalToProcess = 0;
  let totalDurationSeconds = 0;
  let processedDurationSeconds = 0;
  let currentItemDurationSeconds = 0;

  const markSnapshot = () => {
    updateHLSEncodingSnapshot({
      active: isProcessingHLS,
      totalVideos: totalToProcess,
      completedVideos: processedCount,
      failedVideos: failedCount,
      totalDurationSeconds,
      completedDurationSeconds: processedDurationSeconds,
      currentItemDurationSeconds,
    });
  };

  const processAll = async () => {
    const totalCandidates = database.countVideosReadyForHLS();
    const candidates = database.getVideosReadyForHLS(totalCandidates || 1);

    const needsEncoding: Array<{
      relativePath: string;
      fullPath: string;
      durationSeconds: number;
    }> = [];

    for (const item of candidates) {
      const fullPath = path.join(
        database.storagePath,
        stripLeadingSlash(item.relativePath),
      );

      try {
        const modifiedTimeMs = (await stat(fullPath)).mtimeMs;
        const hash = getHash(fullPath, modifiedTimeMs);
        const hlsDir = getMultibitrateHLSDirectory(fullPath);
        const hasHLS = multibitrateHLSExists(hlsDir) || multibitrateHLSExists(hash);

        if (hasHLS) {
          continue;
        }

        const durationSeconds =
          typeof item.duration === "number" && Number.isFinite(item.duration)
            ? Math.max(item.duration, 0)
            : 0;

        needsEncoding.push({
          relativePath: item.relativePath,
          fullPath,
          durationSeconds,
        });
      } catch {
        // File may have been deleted or inaccessible; skip it.
      }
    }

    totalToProcess = needsEncoding.length;
    totalDurationSeconds = needsEncoding.reduce(
      (sum, item) => sum + item.durationSeconds,
      0,
    );
    markSnapshot();

    console.log(
      `[hls-encode] Starting background HLS encoding for ${totalToProcess} videos`,
    );

    if (needsEncoding.length === 0) {
      console.log("[hls-encode] All videos have HLS streams, encoding complete");
      isProcessingHLS = false;
      markSnapshot();
      onComplete?.();
      return;
    }

    for (const item of needsEncoding) {
      while (restartAtMS && restartAtMS > Date.now()) {
        console.log("[hls-encode] Paused HLS encoding...");
        const timeoutDuration = restartAtMS - Date.now();
        await new Promise((resolve) => setTimeout(resolve, timeoutDuration));
      }

      const { relativePath, fullPath, durationSeconds } = item;
      currentItemDurationSeconds = durationSeconds;
      markSnapshot();
      const startTime = Date.now();

      try {
        console.log(`[hls-encode] Encoding: ${relativePath}`);
        await generateMultibitrateHLS(fullPath, {
          priority: "background",
          waitForCompletion: true,
          estimatedDurationSeconds: durationSeconds,
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[hls-encode] Completed: ${relativePath} (${elapsed}s)`);
      } catch (error) {
        failedCount++;
        console.error(`[hls-encode] Failed to encode ${relativePath}:`, error);
      } finally {
        processedCount++;
        processedDurationSeconds += durationSeconds;
        currentItemDurationSeconds = 0;
        markSnapshot();
      }

      const now = Date.now();
      if (now - lastReportTime > 10_000) {
        const percentComplete =
          totalToProcess > 0
            ? ((processedCount / totalToProcess) * 100).toFixed(2)
            : "100.00";
        const rate = (processedCount - lastReportCount) / ((now - lastReportTime) / 1000);
        lastReportCount = processedCount;

        if (rate > 0) {
          const totalSecondsRemaining = (totalToProcess - processedCount) / rate;
          const durationString = formatDuration(totalSecondsRemaining);
          console.log(
            `[hls-encode] ${percentComplete}% complete (${processedCount}/${totalToProcess}, failures: ${failedCount}). ${(rate * 3600).toFixed(1)} videos/hour. Time remaining: ${durationString}`,
          );
        } else {
          console.log(
            `[hls-encode] ${percentComplete}% complete (${processedCount}/${totalToProcess}, failures: ${failedCount})`,
          );
        }

        lastReportTime = now;
      }
    }

    console.log("[hls-encode] All videos have HLS streams, encoding complete");
    isProcessingHLS = false;
    markSnapshot();
    onComplete?.();
  };

  processAll().catch((error) => {
    console.error("[hls-encode] Background HLS encoding failed:", error);
    isProcessingHLS = false;
    markSnapshot();
  });

  const pause = (durationMS = 30_000) => {
    const localRestartMs = Date.now() + durationMS;
    restartAtMS = Math.max(restartAtMS, localRestartMs);
  };

  return pause;
};
