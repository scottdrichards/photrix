import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, stat } from "fs/promises";
import { join } from "path";
import { getMirroredHLSDirectory } from "../common/cacheUtils.ts";
import { type QueuePriority, mediaProcessingQueue } from "../common/processingQueue.ts";
import type { StandardHeight } from "../common/standardHeights.ts";
import { appendWithLimit, pipeChildProcessLogs } from "./videoUtils.ts";

const determineIfCUDAAvailable = async () =>
  new Promise<boolean>((resolve) => {
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

const cudaAvailable = await determineIfCUDAAvailable();

const getHLSDirectory = (filePath: string, height: StandardHeight): string =>
  getMirroredHLSDirectory(filePath, String(height));

export const getHLSSegmentPath = (hlsDir: string, segmentName: string): string =>
  join(hlsDir, segmentName);

/**
 * Runs FFmpeg HLS generation with the given args.
 * Returns a promise that resolves on success or rejects with the stderr on failure.
 */
const generateHLSWithFFMPEG = (
  args: string[],
  hlsDir: string,
  logPrefix: string,
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
 * Generates HLS stream (playlist + segments) Returns the path to the master playlist.
 */
export const generateHLS = async (
  filePath: string,
  height: StandardHeight = "original",
  opts?: { priority?: QueuePriority },
): Promise<string> => {
  const { exists, playlistPath, hlsDir } = await getHLSInfo(filePath, height);

  if (exists) {
    return playlistPath;
  }

  // Start transcoding in the background (don't await completion)
  // This allows the client to start playing as soon as first segments are ready
  await mediaProcessingQueue.enqueue(
    async () => {
      await mkdir(hlsDir, { recursive: true });

      const scaleFilter = height === "original" ? "-1:-2" : `-2:${height}`;
      const maxBitrate =
        height === "original"
          ? "15M"
          : `${Math.min(15, Math.ceil(Number(height) / 120))}M`;

      const inputArgs = ["-y", "-i", filePath, "-vf", `scale=${scaleFilter}`];

      const outputArgs = [
        "-g",
        "60", // keyframe every 60 frames (~2 sec at 30fps) for consistent segments
        "-c:a",
        "aac",
        "-b:a",
        "128k", // audio bitrate
        "-f",
        "hls",
        "-hls_time",
        "2", // 2-second segments for fast initial playback
        "-hls_list_size",
        "0", // keep all segments in playlist
        "-hls_segment_type",
        "mpegts",
        "-hls_flags",
        "independent_segments+append_list", // segments are self-contained, playlist updated incrementally
        "-hls_segment_filename",
        join(hlsDir, "segment_%03d.ts"),
        "-hls_playlist_type",
        "event", // playlist grows as segments are added (for live-like behavior)
        playlistPath,
      ];

      if (cudaAvailable) {
        // FFmpeg args for HLS with NVIDIA NVENC hardware acceleration
        const nvencArgs = [
          "-hwaccel",
          "cuda", // use GPU for decoding
          ...inputArgs,
          "-c:v",
          "h264_nvenc", // NVIDIA hardware encoder
          "-preset",
          "p1", // fastest NVENC preset
          "-tune",
          "ll", // low latency tuning
          "-rc",
          "vbr", // variable bitrate rate control
          "-cq",
          "28", // constant quality level (lower = better quality)
          "-b:v",
          "0", // let CQ control quality, no target bitrate
          "-maxrate",
          maxBitrate, // cap peak bitrate
          "-bufsize",
          maxBitrate, // VBV buffer size
          ...outputArgs,
        ];
        console.log(`[HLS] Generating ${height}p HLS stream for ${filePath} using NVENC`);
        await generateHLSWithFFMPEG(nvencArgs, hlsDir, "nvenc");
      } else {
        // FFmpeg args for software encoding fallback
        const softwareArgs = [
          ...inputArgs,
          "-c:v",
          "libx264", // software H.264 encoder
          "-preset",
          "fast", // balance speed vs compression
          "-crf",
          "23", // constant rate factor (lower = better quality, 23 is default)
          "-pix_fmt",
          "yuv420p", // widely compatible pixel format
          ...outputArgs,
        ];
        console.log(
          `[HLS] Generating ${height}p HLS stream for ${filePath} using software encoding`,
        );
        await generateHLSWithFFMPEG(softwareArgs, hlsDir, "software");
      }
    },
    opts?.priority,
    "video",
  );

  return playlistPath;
};

/**
 * Gets HLS info (hash and paths) for a video file without generating.
 */
export const getHLSInfo = async (
  filePath: string,
  height: StandardHeight = "original",
): Promise<{
  hlsDir: string;
  playlistPath: string;
  exists: boolean;
}> => {
  await stat(filePath);
  const hlsDir = getHLSDirectory(filePath, height);
  const playlistPath = join(hlsDir, "playlist.m3u8");

  return {
    hlsDir,
    playlistPath,
    exists: existsSync(playlistPath),
  };
};
