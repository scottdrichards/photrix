import { spawn } from "child_process";
import { stat, access } from "fs/promises";
import { getHash, getCachedFilePath } from "../common/cacheUtils.ts";
import { type ConversionPriority } from "../common/conversionPriority.ts";
import type { StandardHeight } from "../common/standardHeights.ts";
import { pipeChildProcessLogs, appendWithLimit } from "./videoUtils.ts";
import { getGpuAcceleration } from "./gpuAcceleration.ts";

const gpu = await getGpuAcceleration();

/** Generates a web-safe video (full-length H.264/AAC MP4) and caches the result. Returns the cached file path. */
export const generateWebSafeVideo = async (
  filePath: string,
  height: StandardHeight = "original",
  opts?: { priority?: ConversionPriority },
): Promise<string> => {
  void opts;
  const fileStats = await stat(filePath);
  const modifiedTimeMs = fileStats.mtimeMs;
  const hash = getHash(filePath, modifiedTimeMs);
  const cachedPath = getCachedFilePath(hash, height, "mp4");

  const cachedExists = await access(cachedPath).then(() => true, () => false);
  if (cachedExists) {
    return cachedPath;
  }

  const scaleFilter = height === "original" ? "-1:-2" : `-2:${height}`;
  const encoderLabel = gpu ? gpu.label : "software";
  console.log(`[VideoCache] Generating ${height}p web-safe video for ${filePath} (${encoderLabel})`);
  await new Promise<void>((resolve, reject) => {
        const args = [
          "-y",
          ...( gpu ? gpu.hwaccelArgs : []),
          "-i",
          filePath,
          "-vf",
          `scale=${scaleFilter}`,
          "-c:v",
          gpu ? gpu.h264Codec : "libx264",
          ...(gpu
            ? gpu.cqArgs(23)
            : ["-preset", "fast", "-crf", "23"]),
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-movflags",
          "+faststart",
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
  return cachedPath;
};
