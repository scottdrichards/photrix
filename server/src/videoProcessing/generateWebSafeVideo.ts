import { spawn } from "child_process";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import { getHash, getCachedFilePath } from "../common/cacheUtils.ts";
import { type QueuePriority, mediaProcessingQueue } from "../common/processingQueue.ts";
import type { StandardHeight } from "../common/standardHeights.ts";
import { pipeChildProcessLogs, appendWithLimit } from "./videoUtils.ts";

/** Generates a web-safe video (full-length H.264/AAC MP4) and caches the result. Returns the cached file path. */
export const generateWebSafeVideo = async (
  filePath: string,
  height: StandardHeight = "original",
  opts?: { priority?: QueuePriority; }
): Promise<string> => {
  const modifiedTimeMs = (await stat(filePath)).mtimeMs;
  const hash = getHash(filePath, modifiedTimeMs);
  const cachedPath = getCachedFilePath(hash, height, "mp4");

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  await mediaProcessingQueue.enqueue(
    () => {
      console.log(`[VideoCache] Generating ${height}p web-safe video for ${filePath}`);
      return new Promise<void>((resolve, reject) => {
        const scaleFilter = height === "original" ? "-1:-2" : `-2:${height}`;
        const args = [
          "-y", // Overwrite output file
          "-i",
          filePath,
          "-vf",
          `scale=${scaleFilter}`,
          "-c:v",
          "libx264", // Video codec (H.264)
          "-pix_fmt",
          "yuv420p", // Ensure compatibility
          "-preset",
          "fast",
          "-crf",
          "23", // Quality (lower = better, 23 is default)
          "-c:a",
          "aac", // Audio codec
          "-b:a",
          "128k", // Audio bitrate
          "-movflags",
          "+faststart", // Enable streaming
          cachedPath,
        ];

        console.log(`[VideoCache] ffmpeg (webSafe) args: ${JSON.stringify(args)}`);
        const process = spawn("ffmpeg", args);

        let stderr = "";

        pipeChildProcessLogs(process, "webSafe", (chunk) => {
          stderr = appendWithLimit(stderr, chunk);
        });

        process.on("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          console.error(`[VideoCache] FFmpeg web-safe conversion failed: ${stderr}`);
          reject(new Error(`Web-safe video generation failed: ${stderr}`));
        });

        process.on("error", (err) => {
          console.error(`[VideoCache] Failed to start ffmpeg process: ${err.message}`);
          reject(err);
        });
      });
    },
    opts?.priority,
    'video'
  );
  return cachedPath;
};
