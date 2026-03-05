import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, stat } from "fs/promises";
import { dirname } from "path";
import { StandardHeight } from "../common/standardHeights.ts";
import {
  CACHE_DIR,
  getMirroredCachedFilePath,
} from "../common/cacheUtils.ts";
import { mediaProcessingQueue, QueuePriority } from "../common/processingQueue.ts";

console.log(`[VideoCache] Initialized at ${CACHE_DIR}`);

const MAX_CAPTURED_LOG_CHARS = 64_000;

let cudaAvailabilityPromise: Promise<boolean> | null = null;

const determineIfCUDAAvailable = async (): Promise<boolean> => {
  if (!cudaAvailabilityPromise) {
    cudaAvailabilityPromise = new Promise<boolean>((resolve) => {
      const process = spawn("ffmpeg", [
        "-hide_banner",
        "-init_hw_device",
        "cuda",
        "-f",
        "lavfi",
        "-i",
        "nullsrc",
        "-t",
        "0",
        "-f",
        "null",
        "-",
      ]);

      let stderr = "";

      process.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      process.on("close", (code) => {
        const available =
          code === 0 &&
          !stderr.includes("Cannot load nvcuda.dll") &&
          !stderr.includes("Could not dynamically load CUDA");
        resolve(available);
      });

      process.on("error", () => {
        resolve(false);
      });
    });
  }

  return await cudaAvailabilityPromise;
};

const isCUDAFailure = (stderr: string): boolean => {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("nvcuda") ||
    normalized.includes("cuda") ||
    normalized.includes("hwaccel")
  );
};

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
  label: string,
  onCapturedStderr: (chunk: string) => void,
) => {
  const logChunk = (stream: "stdout" | "stderr", chunk: string) => {
    const normalized = chunk.replace(/\r/g, "\n");
    const lines = normalized.split("\n").filter(Boolean);
    for (const line of lines) {
      const prefix = `[ffmpeg:${label}:${stream}]`;
      if (stream === "stderr") {
        console.log(`${prefix} ${line}`);
      } else {
        console.log(`${prefix} ${line}`);
      }
    }
  };

  child.stdout?.on("data", (data) => {
    logChunk("stdout", data.toString());
  });

  child.stderr?.on("data", (data) => {
    const text = data.toString();
    onCapturedStderr(text);
    logChunk("stderr", text);
  });
};

/** Generates a video preview and caches the result. Returns the cached file path. */
export const generateVideoPreview = async (
  filePath: string,
  height: StandardHeight = 320,
  durationMS: number = 5_000,
  opts?: { priority?: QueuePriority },
): Promise<string> => {
  await stat(filePath);
  const durationSeconds = Math.round(durationMS / 1000);
  const cachedPath = getMirroredCachedFilePath(
    filePath,
    `preview.${height}.${durationSeconds}s.audio`,
    "mp4",
  );

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  await mediaProcessingQueue.enqueue(
    async () => {
      console.log(`[VideoCache] Generating ${height}p preview for ${filePath}`);
      await mkdir(dirname(cachedPath), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const args = [
          "-y", // Overwrite output file
          "-ss",
          "00:00:00", // Start time
          "-i",
          filePath,
          "-t",
          `${durationMS / 1000}`, // Duration
          "-vf",
          `scale=-2:${height === "original" ? -1 : height}`,
          "-c:v",
          "libx264", // Video codec
          "-pix_fmt",
          "yuv420p", // Ensure compatibility
          "-preset",
          "fast",
          "-crf",
          "23",
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
      });
    },
    opts?.priority,
    'video',
  );
  return cachedPath;
};

/** Generates a static image thumbnail from the video and caches the result. Returns the cached file path. */
export const generateVideoThumbnail = async (
  filePath: string,
  height: StandardHeight = 320,
  opts?: { priority?: QueuePriority },
): Promise<string> => {
  await stat(filePath);
  const cachedPath = getMirroredCachedFilePath(filePath, height, "jpg");

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  const cudaAvailable = await determineIfCUDAAvailable();

  await mediaProcessingQueue.enqueue(
    () => {
      const generateWithMode = async (useHardware: boolean): Promise<void> => {
        const encoderType = useHardware ? "CUDA" : "software";
        console.log(`[VideoCache] Generating ${height}p thumbnail for ${filePath} (${encoderType})`);
        await mkdir(dirname(cachedPath), { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const args = [
            "-y",
            ...(useHardware ? ["-hwaccel", "cuda"] : []),
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

          console.log(`[VideoCache] ffmpeg (thumbnail:${encoderType}) args: ${JSON.stringify(args)}`);
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

            if (useHardware && isCUDAFailure(stderr)) {
              console.warn(`[VideoCache] CUDA thumbnail generation failed, retrying with software encoding`);
              generateWithMode(false).then(resolve).catch(reject);
              return;
            }

            console.error(`[VideoCache] FFmpeg thumbnail failed: ${stderr}`);
            reject(new Error(`Video thumbnail generation failed: ${stderr}`));
          });

          process.on("error", (err) => {
            console.error(`[VideoCache] Failed to start ffmpeg process: ${err.message}`);
            reject(err);
          });
        });
      };

      return generateWithMode(cudaAvailable);
    },
    opts?.priority,
    'video',
  );
  return cachedPath;
};


