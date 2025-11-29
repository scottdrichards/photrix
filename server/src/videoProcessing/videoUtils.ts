import { spawn } from "child_process";
import { existsSync } from "fs";
import { StandardHeight } from "../common/standardHeights.ts";
import {
  ensureCacheDirExists,
  getHash,
  CACHE_DIR,
  getCachedFilePath,
} from "../common/cacheUtils.ts";

ensureCacheDirExists();
console.log(`[VideoCache] Initialized at ${CACHE_DIR}`);

/** Generates a video preview and caches the result. Returns the cached file path. */
export const generateVideoPreview = async (
  filePath: string,
  height: StandardHeight = 320,
  durationMS: number = 5_000,
): Promise<string> => {
  const hash = getHash(filePath);
  const cachedPath = getCachedFilePath(hash, height, "mp4");

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  console.log(`[VideoCache] Generating ${height}p preview for ${filePath}`);
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y", // Overwrite output file
      "-ss", "00:00:00", // Start time
      "-i", filePath,
      "-t", `${durationMS / 1000}`, // Duration
      "-vf", `scale=-2:${height === "original" ? -1 : height}`, // Resize
      "-c:v", "libx264", // Video codec
      "-preset", "fast",
      "-crf", "23",
      "-an", // Remove audio
      cachedPath,
    ];

    const process = spawn("ffmpeg", args);

    let stderr = "";

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error(`[VideoCache] FFmpeg failed: ${stderr}`);
        reject(new Error(`Video preview generation failed: ${stderr}`));
      }
    });

    process.on("error", (err) => {
      console.error(`[VideoCache] Failed to start ffmpeg process: ${err.message}`);
      reject(err);
    });
  });
  return cachedPath;
};

/** Generates a static image thumbnail from the video and caches the result. Returns the cached file path. */
export const generateVideoThumbnail = async (
  filePath: string,
  height: StandardHeight = 320,
): Promise<string> => {
  const hash = getHash(filePath);
  const cachedPath = getCachedFilePath(hash, height, "jpg");

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  console.log(`[VideoCache] Generating ${height}p thumbnail for ${filePath}`);
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-ss", "00:00:00",
      "-i", filePath,
      "-vframes", "1",
      "-vf", `scale=-2:${height === "original" ? -1 : height}`,
      cachedPath,
    ];

    const process = spawn("ffmpeg", args);

    let stderr = "";

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error(`[VideoCache] FFmpeg thumbnail failed: ${stderr}`);
        reject(new Error(`Video thumbnail generation failed: ${stderr}`));
      }
    });

    process.on("error", (err) => {
      console.error(`[VideoCache] Failed to start ffmpeg process: ${err.message}`);
      reject(err);
    });
  });
  return cachedPath;
};
