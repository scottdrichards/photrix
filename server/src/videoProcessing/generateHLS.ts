import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, stat, readdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import { getHash, CACHE_DIR } from "../common/cacheUtils.ts";
import { type QueuePriority, mediaProcessingQueue } from "../common/processingQueue.ts";
import type { StandardHeight } from "../common/standardHeights.ts";
import { pipeChildProcessLogs, appendWithLimit } from "./videoUtils.ts";

/**
 * Cached CUDA availability state.
 * null = not yet checked, true = available, false = unavailable
 */
let cudaAvailable: boolean | null = null;

/**
 * Checks if CUDA/NVENC hardware acceleration is available.
 * Result is cached after first check.
 */
const checkCudaAvailability = (): Promise<boolean> =>
  new Promise((resolve) => {
    if (cudaAvailable !== null) {
      resolve(cudaAvailable);
      return;
    }

    const process = spawn("ffmpeg", ["-hide_banner", "-init_hw_device", "cuda", "-f", "lavfi", "-i", "nullsrc", "-t", "0", "-f", "null", "-"]);

    let stderr = "";
    process.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    process.on("close", (code) => {
      cudaAvailable = code === 0 && !stderr.includes("Cannot load nvcuda.dll") && !stderr.includes("Could not dynamically load CUDA");
      console.log(`[HLS] CUDA/NVENC hardware acceleration: ${cudaAvailable ? "available" : "not available"}`);
      resolve(cudaAvailable);
    });

    process.on("error", () => {
      cudaAvailable = false;
      console.log("[HLS] CUDA/NVENC hardware acceleration: not available (ffmpeg error)");
      resolve(false);
    });
  });

// Check CUDA availability on module load
void checkCudaAvailability();

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
 * Runs FFmpeg HLS generation with the given args.
 * Returns a promise that resolves on success or rejects with the stderr on failure.
 */
const runHLSGeneration = (
  args: string[],
  hlsDir: string,
  logPrefix: string
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    console.log(`[HLS] ffmpeg (${logPrefix}) args: ${JSON.stringify(args)}`);
    const process = spawn("ffmpeg", args);

    let stderr = "";

    pipeChildProcessLogs(process, logPrefix, (chunk) => {
      stderr = appendWithLimit(stderr, chunk);
    });

    process.on("close", (code) => {
      if (code === 0) {
        console.log(`[HLS] Successfully generated HLS stream at ${hlsDir}`);
        resolve();
        return;
      }
      console.error(`[HLS] FFmpeg HLS generation failed: ${stderr}`);
      reject(new Error(stderr));
    });

    process.on("error", (err) => {
      console.error(`[HLS] Failed to start ffmpeg process: ${err.message}`);
      reject(err);
    });
  });

/**
 * Generates HLS stream (playlist + segments) using NVIDIA NVENC hardware acceleration.
 * Automatically falls back to software encoding if CUDA/NVENC is unavailable.
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

  // Start transcoding in the background (don't await completion)
  // This allows the client to start playing as soon as first segments are ready
  void mediaProcessingQueue.enqueue(
    async () => {
      // Create directory for HLS output
      await mkdir(hlsDir, { recursive: true });

      const scaleFilter = height === "original" ? "-1:-2" : `-2:${height}`;
      const maxBitrate = height === "original" ? "15M" : `${Math.min(15, Math.ceil(Number(height) / 120))}M`;

      const inputArgs = ["-y", "-i", filePath, "-vf", `scale=${scaleFilter}`];

      const outputArgs = [
        "-g", "60", // keyframe every 60 frames (~2 sec at 30fps) for consistent segments
        "-c:a", "aac",
        "-b:a", "128k", // audio bitrate
        "-f", "hls",
        "-hls_time", "2", // 2-second segments for fast initial playback
        "-hls_list_size", "0", // keep all segments in playlist
        "-hls_segment_type", "mpegts",
        "-hls_flags", "independent_segments+append_list", // segments are self-contained, playlist updated incrementally
        "-hls_segment_filename", join(hlsDir, "segment_%03d.ts"),
        "-hls_playlist_type", "event", // playlist grows as segments are added (for live-like behavior)
        playlistPath,
      ];

      // FFmpeg args for HLS with NVIDIA NVENC hardware acceleration
      const nvencArgs = [
        "-hwaccel", "cuda", // use GPU for decoding
        ...inputArgs,
        "-c:v", "h264_nvenc", // NVIDIA hardware encoder
        "-preset", "p1", // fastest NVENC preset
        "-tune", "ll", // low latency tuning
        "-rc", "vbr", // variable bitrate rate control
        "-cq", "28", // constant quality level (lower = better quality)
        "-b:v", "0", // let CQ control quality, no target bitrate
        "-maxrate", maxBitrate, // cap peak bitrate
        "-bufsize", maxBitrate, // VBV buffer size
        ...outputArgs,
      ];

      // FFmpeg args for software encoding fallback
      const softwareArgs = [
        ...inputArgs,
        "-c:v", "libx264", // software H.264 encoder
        "-preset", "fast", // balance speed vs compression
        "-crf", "23", // constant rate factor (lower = better quality, 23 is default)
        "-pix_fmt", "yuv420p", // widely compatible pixel format
        ...outputArgs,
      ];

      const useCuda = await checkCudaAvailability();

      if (useCuda) {
        console.log(`[HLS] Generating ${height}p HLS stream for ${filePath} using NVENC`);
        await runHLSGeneration(nvencArgs, hlsDir, "nvenc");
      } else {
        console.log(`[HLS] Generating ${height}p HLS stream for ${filePath} using software encoding`);
        await runHLSGeneration(softwareArgs, hlsDir, "software");
      }
    },
    opts?.priority,
    "video"
  );

  return playlistPath;
};

/**
 * Generates HLS with software encoding only (for systems without NVIDIA GPU).
 * Uses libx264 instead of h264_nvenc.
 * Note: generateHLS() automatically falls back to software encoding if CUDA is unavailable,
 * so this function is mainly useful when you want to force software encoding.
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

  void mediaProcessingQueue.enqueue(
    async () => {
      await mkdir(hlsDir, { recursive: true });

      console.log(`[HLS] Generating ${height}p HLS stream for ${filePath} using software encoding`);

      const scaleFilter = height === "original" ? "-1:-2" : `-2:${height}`;

      const args = [
        "-y",
        "-i", filePath,
        "-vf", `scale=${scaleFilter}`,
        "-c:v", "libx264", // software H.264 encoder
        "-preset", "fast", // balance speed vs compression
        "-crf", "23", // constant rate factor (lower = better quality, 23 is default)
        "-pix_fmt", "yuv420p", // widely compatible pixel format
        "-g", "60", // keyframe every 60 frames (~2 sec at 30fps)
        "-c:a", "aac",
        "-b:a", "128k", // audio bitrate
        "-f", "hls",
        "-hls_time", "2", // 2-second segments
        "-hls_list_size", "0", // keep all segments in playlist
        "-hls_segment_type", "mpegts",
        "-hls_flags", "independent_segments+append_list",
        "-hls_segment_filename", join(hlsDir, "segment_%03d.ts"),
        "-hls_playlist_type", "event",
        playlistPath,
      ];

      await runHLSGeneration(args, hlsDir, "software");
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
