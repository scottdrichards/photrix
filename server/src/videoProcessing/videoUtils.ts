import { spawn } from "child_process";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import { StandardHeight } from "../common/standardHeights.ts";
import {
  getHash,
  CACHE_DIR,
  getCachedFilePath,
} from "../common/cacheUtils.ts";
import { mediaProcessingQueue, QueuePriority } from "../common/processingQueue.ts";
import { ExifMetadata } from "../indexDatabase/fileRecord.type.ts";

console.log(`[VideoCache] Initialized at ${CACHE_DIR}`);

const MAX_CAPTURED_LOG_CHARS = 64_000;

const appendWithLimit = (current: string, chunk: string): string => {
  if (chunk.length >= MAX_CAPTURED_LOG_CHARS) {
    return chunk.slice(-MAX_CAPTURED_LOG_CHARS);
  }
  const combined = current + chunk;
  return combined.length > MAX_CAPTURED_LOG_CHARS
    ? combined.slice(combined.length - MAX_CAPTURED_LOG_CHARS)
    : combined;
};

const pipeChildProcessLogs = (
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
  const modifiedTimeMs = (await stat(filePath)).mtimeMs;
  const hash = getHash(filePath, modifiedTimeMs);
  const durationSeconds = Math.round(durationMS / 1000);
  const cachedPath = getCachedFilePath(
    hash,
    `preview.${height}.${durationSeconds}s.audio`,
    "mp4",
  );

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  await mediaProcessingQueue.enqueue(
    () => {
      console.log(`[VideoCache] Generating ${height}p preview for ${filePath}`);
      return new Promise<void>((resolve, reject) => {
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
  );
  return cachedPath;
};

/** Generates a static image thumbnail from the video and caches the result. Returns the cached file path. */
export const generateVideoThumbnail = async (
  filePath: string,
  height: StandardHeight = 320,
  opts?: { priority?: QueuePriority },
): Promise<string> => {
  const modifiedTimeMs = (await stat(filePath)).mtimeMs;
  const hash = getHash(filePath, modifiedTimeMs);
  const cachedPath = getCachedFilePath(hash, height, "jpg");

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  await mediaProcessingQueue.enqueue(
    () => {
      console.log(`[VideoCache] Generating ${height}p thumbnail for ${filePath}`);
      return new Promise<void>((resolve, reject) => {
        const args = [
          "-y",
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

        console.log(`[VideoCache] ffmpeg (thumbnail) args: ${JSON.stringify(args)}`);
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

          console.error(`[VideoCache] FFmpeg thumbnail failed: ${stderr}`);
          reject(new Error(`Video thumbnail generation failed: ${stderr}`));
        });

        process.on("error", (err) => {
          console.error(`[VideoCache] Failed to start ffmpeg process: ${err.message}`);
          reject(err);
        });
      });
    },
    opts?.priority,
  );
  return cachedPath;
};

/** Generates a web-safe video (full-length H.264/AAC MP4) and caches the result. Returns the cached file path. */
export const generateWebSafeVideo = async (
  filePath: string,
  height: StandardHeight = "original",
  opts?: { priority?: QueuePriority },
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
  );
  return cachedPath;
};

export const getVideoMetadata = async (filePath: string): Promise<Partial<ExifMetadata>> => {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ];

    const process = spawn("ffprobe", args);
    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr}`));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const format = data.format;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const videoStream = data.streams.find((s: any) => s.codec_type === "video");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const audioStream = data.streams.find((s: any) => s.codec_type === "audio");

        const metadata: Partial<ExifMetadata> = {};

        if (format && format.tags) {
          if (format.tags.creation_time) {
            metadata.dateTaken = new Date(format.tags.creation_time);
          }
        }

        if (format && format.duration) {
          metadata.duration = parseFloat(format.duration);
        }

        if (videoStream) {
          let width = videoStream.width;
          let height = videoStream.height;
          let rotate: number | undefined;

          if (videoStream.tags && videoStream.tags.rotate) {
             rotate = parseInt(videoStream.tags.rotate);
          } else if (videoStream.side_data_list) {
             // eslint-disable-next-line @typescript-eslint/no-explicit-any
             const sideData = videoStream.side_data_list.find((sd: any) => sd.rotation !== undefined);
             if (sideData) {
                rotate = parseInt(sideData.rotation);
             }
          }

          if (rotate !== undefined) {
             // Normalize rotation to 0-360 positive
             rotate = rotate % 360;
             if (rotate < 0) rotate += 360;

             if (rotate === 90) metadata.orientation = 6;
             else if (rotate === 180) metadata.orientation = 3;
             else if (rotate === 270) metadata.orientation = 8;

             if (rotate === 90 || rotate === 270) {
               const temp = width;
               width = height;
               height = temp;
             }
          }

          metadata.dimensionWidth = width;
          metadata.dimensionHeight = height;
          metadata.videoCodec = videoStream.codec_name;
          if (videoStream.r_frame_rate) {
            const [num, den] = videoStream.r_frame_rate.split("/");
            metadata.framerate = den ? parseInt(num) / parseInt(den) : parseInt(num);
          }
        }

        if (audioStream) {
          metadata.audioCodec = audioStream.codec_name;
        }

        resolve(metadata);
      } catch (e) {
        reject(e);
      }
    });

    process.on("error", (err) => {
      reject(err);
    });
  });
};
