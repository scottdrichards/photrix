import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, stat, readdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import { getHash, CACHE_DIR } from "../common/cacheUtils.ts";
import { type QueuePriority, mediaProcessingQueue } from "../common/processingQueue.ts";
import type { StandardHeight } from "../common/standardHeights.ts";
import { pipeChildProcessLogs, appendWithLimit } from "./videoUtils.ts";

/**
 * Returns the directory path where HLS segments and playlist are stored for a given video.
 */
export const getHLSDirectory = (hash: string, height: StandardHeight): string =>
  join(CACHE_DIR, "hls", `${hash}.${height}`);

/**
 * Returns the path to the master playlist for an HLS stream.
 */
export const getHLSPlaylistPath = (hash: string, height: StandardHeight): string =>
  join(getHLSDirectory(hash, height), "playlist.m3u8");

/**
 * Checks if HLS stream already exists for a video.
 */
export const hlsExists = (hash: string, height: StandardHeight): boolean => {
  const playlistPath = getHLSPlaylistPath(hash, height);
  return existsSync(playlistPath);
};

/**
 * Reads the HLS playlist file content.
 */
export const readHLSPlaylist = async (hash: string, height: StandardHeight): Promise<string> => {
  const playlistPath = getHLSPlaylistPath(hash, height);
  return readFile(playlistPath, "utf-8");
};

/**
 * Gets the path to a specific HLS segment file.
 */
export const getHLSSegmentPath = (hash: string, height: StandardHeight, segmentName: string): string =>
  join(getHLSDirectory(hash, height), segmentName);

/**
 * Lists all segment files in an HLS directory.
 */
export const listHLSSegments = async (hash: string, height: StandardHeight): Promise<string[]> => {
  const hlsDir = getHLSDirectory(hash, height);
  if (!existsSync(hlsDir)) return [];
  const files = await readdir(hlsDir);
  return files.filter((f) => f.endsWith(".ts"));
};

/**
 * Generates HLS stream (playlist + segments) using NVIDIA NVENC hardware acceleration.
 * Returns the path to the master playlist.
 */
export const generateHLS = async (
  filePath: string,
  height: StandardHeight = "original",
  opts?: { priority?: QueuePriority }
): Promise<string> => {
  const modifiedTimeMs = (await stat(filePath)).mtimeMs;
  const hash = getHash(filePath, modifiedTimeMs);
  const hlsDir = getHLSDirectory(hash, height);
  const playlistPath = getHLSPlaylistPath(hash, height);

  if (existsSync(playlistPath)) {
    return playlistPath;
  }

  await mediaProcessingQueue.enqueue(
    async () => {
      // Create directory for HLS output
      await mkdir(hlsDir, { recursive: true });

      console.log(`[HLS] Generating ${height}p HLS stream for ${filePath} using NVENC`);

      return new Promise<void>((resolve, reject) => {
        const scaleFilter = height === "original" ? "-1:-2" : `-2:${height}`;

        // FFmpeg args for HLS with NVIDIA NVENC hardware acceleration
        const args = [
          "-y",
          // Hardware acceleration input
          "-hwaccel", "cuda",
          "-hwaccel_output_format", "cuda",
          "-i", filePath,
          // Scale filter (use CUDA scale for hardware path)
          "-vf", `scale_cuda=${scaleFilter}:format=nv12`,
          // NVIDIA H.264 encoder
          "-c:v", "h264_nvenc",
          "-preset", "p4", // balanced preset (p1=fastest, p7=slowest/best quality)
          "-tune", "hq", // high quality tuning
          "-rc", "vbr", // variable bitrate
          "-cq", "23", // quality level (similar to CRF, lower = better)
          "-b:v", "0", // let CQ control bitrate
          "-maxrate", height === "original" ? "20M" : `${Math.min(20, Math.ceil(Number(height) / 100))}M`,
          "-bufsize", height === "original" ? "40M" : `${Math.min(40, Math.ceil(Number(height) / 50))}M`,
          // Audio codec
          "-c:a", "aac",
          "-b:a", "128k",
          // HLS specific options
          "-f", "hls",
          "-hls_time", "4", // 4-second segments
          "-hls_list_size", "0", // Keep all segments in playlist
          "-hls_segment_type", "mpegts",
          "-hls_segment_filename", join(hlsDir, "segment_%03d.ts"),
          "-hls_playlist_type", "vod", // Video on demand (complete playlist)
          playlistPath,
        ];

        console.log(`[HLS] ffmpeg args: ${JSON.stringify(args)}`);
        const process = spawn("ffmpeg", args);

        let stderr = "";

        pipeChildProcessLogs(process, "hls", (chunk) => {
          stderr = appendWithLimit(stderr, chunk);
        });

        process.on("close", (code) => {
          if (code === 0) {
            console.log(`[HLS] Successfully generated HLS stream at ${hlsDir}`);
            resolve();
            return;
          }
          console.error(`[HLS] FFmpeg HLS generation failed: ${stderr}`);
          reject(new Error(`HLS generation failed: ${stderr}`));
        });

        process.on("error", (err) => {
          console.error(`[HLS] Failed to start ffmpeg process: ${err.message}`);
          reject(err);
        });
      });
    },
    opts?.priority,
    "video"
  );

  return playlistPath;
};

/**
 * Generates HLS with software encoding fallback (for systems without NVIDIA GPU).
 * Uses libx264 instead of h264_nvenc.
 */
export const generateHLSSoftware = async (
  filePath: string,
  height: StandardHeight = "original",
  opts?: { priority?: QueuePriority }
): Promise<string> => {
  const modifiedTimeMs = (await stat(filePath)).mtimeMs;
  const hash = getHash(filePath, modifiedTimeMs);
  const hlsDir = getHLSDirectory(hash, height);
  const playlistPath = getHLSPlaylistPath(hash, height);

  if (existsSync(playlistPath)) {
    return playlistPath;
  }

  await mediaProcessingQueue.enqueue(
    async () => {
      await mkdir(hlsDir, { recursive: true });

      console.log(`[HLS] Generating ${height}p HLS stream for ${filePath} using software encoding`);

      return new Promise<void>((resolve, reject) => {
        const scaleFilter = height === "original" ? "-1:-2" : `-2:${height}`;

        const args = [
          "-y",
          "-i", filePath,
          "-vf", `scale=${scaleFilter}`,
          "-c:v", "libx264",
          "-preset", "fast",
          "-crf", "23",
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-b:a", "128k",
          "-f", "hls",
          "-hls_time", "4",
          "-hls_list_size", "0",
          "-hls_segment_type", "mpegts",
          "-hls_segment_filename", join(hlsDir, "segment_%03d.ts"),
          "-hls_playlist_type", "vod",
          playlistPath,
        ];

        console.log(`[HLS] ffmpeg (software) args: ${JSON.stringify(args)}`);
        const process = spawn("ffmpeg", args);

        let stderr = "";

        pipeChildProcessLogs(process, "hls-sw", (chunk) => {
          stderr = appendWithLimit(stderr, chunk);
        });

        process.on("close", (code) => {
          if (code === 0) {
            console.log(`[HLS] Successfully generated HLS stream at ${hlsDir}`);
            resolve();
            return;
          }
          console.error(`[HLS] FFmpeg HLS generation failed: ${stderr}`);
          reject(new Error(`HLS generation failed: ${stderr}`));
        });

        process.on("error", (err) => {
          console.error(`[HLS] Failed to start ffmpeg process: ${err.message}`);
          reject(err);
        });
      });
    },
    opts?.priority,
    "video"
  );

  return playlistPath;
};

/**
 * Gets HLS info (hash and paths) for a video file without generating.
 */
export const getHLSInfo = async (
  filePath: string,
  height: StandardHeight = "original"
): Promise<{
  hash: string;
  hlsDir: string;
  playlistPath: string;
  exists: boolean;
}> => {
  const modifiedTimeMs = (await stat(filePath)).mtimeMs;
  const hash = getHash(filePath, modifiedTimeMs);
  const hlsDir = getHLSDirectory(hash, height);
  const playlistPath = getHLSPlaylistPath(hash, height);

  return {
    hash,
    hlsDir,
    playlistPath,
    exists: existsSync(playlistPath),
  };
};
