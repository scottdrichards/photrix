import { spawn } from "child_process";
import { access, mkdir, stat } from "fs/promises";
import { join } from "path";
import { getMirroredHLSDirectory } from "../common/cacheUtils.ts";
import { type ConversionPriority } from "../common/conversionPriority.ts";
import type { StandardHeight } from "../common/standardHeights.ts";
import { appendWithLimit, pipeChildProcessLogs } from "./videoUtils.ts";
import { getGpuAcceleration } from "./gpuAcceleration.ts";

const gpu = await getGpuAcceleration();

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
    const process = spawn("ffmpeg", args);

    let stderr = "";

    pipeChildProcessLogs(process, logPrefix, (chunk) => {
      stderr = appendWithLimit(stderr, chunk);
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr));
    });

    process.on("error", (err) => {
      reject(err);
    });
  });

/**
 * Generates HLS stream (playlist + segments) Returns the path to the master playlist.
 */
export const generateHLS = async (
  filePath: string,
  height: StandardHeight = "original",
  opts?: { priority?: ConversionPriority; contentDurationSeconds?: number },
): Promise<string> => {
  void opts;
  await stat(filePath);
  const { exists, playlistPath, hlsDir } = await getHLSInfo(filePath, height);

  if (exists) {
    return playlistPath;
  }

  await mkdir(hlsDir, { recursive: true });

  const scaleFilter = height === "original" ? "-1:-2" : `-2:${height}`;
  const maxBitrate =
    height === "original" ? "15M" : `${Math.min(15, Math.ceil(Number(height) / 120))}M`;

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

  if (gpu) {
    const hwArgs = [
      ...gpu.hwaccelArgs,
      ...inputArgs,
      "-c:v",
      gpu.h264Codec,
      ...gpu.cqArgs(28),
      "-maxrate",
      maxBitrate,
      "-bufsize",
      maxBitrate,
      ...outputArgs,
    ];
    await (() => generateHLSWithFFMPEG(hwArgs, hlsDir, gpu.vendor))();
  } else {
    const softwareArgs = [
      ...inputArgs,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      ...outputArgs,
    ];
    await (() => generateHLSWithFFMPEG(softwareArgs, hlsDir, "software"))();
  }

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
    exists: await access(playlistPath).then(
      () => true,
      () => false,
    ),
  };
};
