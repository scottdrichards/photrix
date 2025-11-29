import { spawn } from "child_process";
import { existsSync } from "fs";
import { StandardHeight } from "../common/standardHeights.ts";
import {
  ensureCacheDirExists,
  getHash,
  CACHE_DIR,
  getCachedFilePath,
} from "../common/cacheUtils.ts";
import { ExifMetadata } from "../indexDatabase/fileRecord.type.ts";

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
      "-pix_fmt", "yuv420p", // Ensure compatibility
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
          metadata.dimensions = {
            width: videoStream.width,
            height: videoStream.height,
          };
          metadata.videoCodec = videoStream.codec_name;
          if (videoStream.r_frame_rate) {
            const [num, den] = videoStream.r_frame_rate.split("/");
            metadata.framerate = den ? parseInt(num) / parseInt(den) : parseInt(num);
          }
          
          if (videoStream.tags && videoStream.tags.rotate) {
             const rotate = parseInt(videoStream.tags.rotate);
             if (rotate === 90) metadata.orientation = 6;
             else if (rotate === 180) metadata.orientation = 3;
             else if (rotate === 270) metadata.orientation = 8;
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
