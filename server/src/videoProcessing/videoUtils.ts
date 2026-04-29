import { spawn } from "child_process";
import { access, mkdir, stat } from "fs/promises";
import { dirname } from "path";
import { StandardHeight } from "../common/standardHeights.ts";
import { CACHE_DIR, getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import { type ConversionPriority } from "../common/conversionPriority.ts";
import { getGpuAcceleration } from "./gpuAcceleration.ts";

const MAX_CAPTURED_LOG_CHARS = 64_000;

export const appendWithLimit = (current: string, chunk: string): string => {
  if (chunk.length >= MAX_CAPTURED_LOG_CHARS) {
    return chunk.slice(-MAX_CAPTURED_LOG_CHARS);
  }
  const combined = current + chunk;
  return combined.length > MAX_CAPTURED_LOG_CHARS
    ? combined.slice(combined.length - MAX_CAPTURED_LOG_CHARS)
    : combined;
};

export const pipeChildProcessLogs = (
  child: ReturnType<typeof spawn>,
  _label: string,
  onCapturedStderr: (chunk: string) => void,
) => {
  child.stdout?.on("data", () => {
    // logging disabled
  });

  child.stderr?.on("data", (data) => {
    const text = data.toString();
    onCapturedStderr(text);
  });
};

/** Generates a video preview and caches the result. Returns the cached file path. */
export const generateVideoPreview = async (
  filePath: string,
  height: StandardHeight = 320,
  durationMS: number = 5_000,
  opts?: { priority?: ConversionPriority },
): Promise<string> => {
  void opts;
  await stat(filePath);
  const durationSeconds = Math.round(durationMS / 1000);
  const cachedPath = getMirroredCachedFilePath(
    filePath,
    `preview.${height}.${durationSeconds}s.audio`,
    "mp4",
  );

  if (
    await access(cachedPath).then(
      () => true,
      () => false,
    )
  ) {
    return cachedPath;
  }
  await mkdir(dirname(cachedPath), { recursive: true });
  const gpu = await getGpuAcceleration();
  await (() =>
    new Promise<void>((resolve, reject) => {
      const args = [
        "-y",
        ...(gpu ? gpu.hwaccelArgs : []),
        "-ss",
        "00:00:00",
        "-i",
        filePath,
        "-t",
        `${durationMS / 1000}`,
        "-vf",
        `scale=-2:${height === "original" ? -1 : height}`,
        "-c:v",
        gpu ? gpu.h264Codec : "libx264",
        ...(gpu ? gpu.cqArgs(23) : ["-preset", "fast", "-crf", "23"]),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        cachedPath,
      ];

      console.log(`[VideoCache] ffmpeg (preview) args: ${JSON.stringify(args)}`);
      const process = spawn("ffmpeg", args);

      let stderr = "";

      pipeChildProcessLogs(process, "preview", (chunk) => {
        stderr = appendWithLimit(stderr, chunk);
      });

      process.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        console.error(`[VideoCache] FFmpeg failed: ${stderr}`);
        reject(new Error(`Video preview generation failed: ${stderr}`));
      });

      process.on("error", (err) => {
        console.error(`[VideoCache] Failed to start ffmpeg process: ${err.message}`);
        reject(err);
      });
    }))();
  return cachedPath;
};

/** Generates a static image thumbnail from the video and caches the result. Returns the cached file path. */
export const generateVideoThumbnail = async (
  filePath: string,
  height: StandardHeight = 320,
  opts?: { priority?: ConversionPriority },
): Promise<string> => {
  void opts;
  await stat(filePath);
  const cachedPath = getMirroredCachedFilePath(filePath, height, "jpg");

  if (
    await access(cachedPath).then(
      () => true,
      () => false,
    )
  ) {
    return cachedPath;
  }

  const gpu = await getGpuAcceleration();

  const generateWithMode = async (useHardware: boolean): Promise<void> => {
    const encoderType = useHardware && gpu ? gpu.label : "software";
    await mkdir(dirname(cachedPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const args = [
        "-y",
        ...(useHardware && gpu ? gpu.hwaccelArgs : []),
        "-ss",
        "00:00:00",
        "-i",
        filePath,
        "-vframes",
        "1",
        "-vf",
        `scale=-2:${height === "original" ? -1 : height}`,
        cachedPath,
      ];

      const process = spawn("ffmpeg", args);

      let stderr = "";

      pipeChildProcessLogs(process, "thumbnail", (chunk) => {
        stderr = appendWithLimit(stderr, chunk);
      });

      process.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        if (useHardware && gpu?.isHardwareFailure(stderr)) {
          generateWithMode(false).then(resolve).catch(reject);
          return;
        }

        reject(new Error(`Video thumbnail generation failed: ${stderr}`));
      });

      process.on("error", (err) => {
        console.error(`[VideoCache] Failed to start ffmpeg process: ${err.message}`);
        reject(err);
      });
    });
  };

  await generateWithMode(gpu !== null);
  return cachedPath;
};
