import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, stat, writeFile } from "fs/promises";
import { join } from "path";
import { getHash, CACHE_DIR } from "../common/cacheUtils.ts";
import { type QueuePriority, mediaProcessingQueue } from "../common/processingQueue.ts";
import { pipeChildProcessLogs, appendWithLimit } from "./videoUtils.ts";

/** HLS quality variants: 360p for fast start, 720p for quality */
const HLS_VARIANTS = [
  { height: 360, bitrate: 800_000, maxrate: "1M", bufsize: "1.5M" },
  { height: 720, bitrate: 2_500_000, maxrate: "4M", bufsize: "6M" },
] as const;

type HLSVariant = (typeof HLS_VARIANTS)[number];

/**
 * Returns the base directory for multi-bitrate HLS output.
 */
export const getMultibitrateHLSDirectory = (hash: string): string =>
  join(CACHE_DIR, "hls-abr", hash);

/**
 * Returns the path to the master playlist for multi-bitrate HLS.
 */
export const getMasterPlaylistPath = (hash: string): string =>
  join(getMultibitrateHLSDirectory(hash), "master.m3u8");

/**
 * Returns the path to a variant's playlist.
 */
export const getVariantPlaylistPath = (hash: string, height: number): string =>
  join(getMultibitrateHLSDirectory(hash), `${height}p`, "playlist.m3u8");

/**
 * Returns the path to a variant's segment.
 */
export const getVariantSegmentPath = (hash: string, height: number, segmentName: string): string =>
  join(getMultibitrateHLSDirectory(hash), `${height}p`, segmentName);

/**
 * Checks if multi-bitrate HLS exists for a video.
 */
export const multibitrateHLSExists = (hash: string): boolean =>
  existsSync(getMasterPlaylistPath(hash));

/**
 * Get HLS info for a video file.
 */
export const getMultibitrateHLSInfo = async (
  filePath: string
): Promise<{
  hash: string;
  hlsDir: string;
  masterPlaylistPath: string;
  exists: boolean;
}> => {
  const modifiedTimeMs = (await stat(filePath)).mtimeMs;
  const hash = getHash(filePath, modifiedTimeMs);
  return {
    hash,
    hlsDir: getMultibitrateHLSDirectory(hash),
    masterPlaylistPath: getMasterPlaylistPath(hash),
    exists: multibitrateHLSExists(hash),
  };
};

/**
 * Generates a single variant stream.
 */
const generateVariant = (
  filePath: string,
  hlsDir: string,
  variant: HLSVariant
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const variantDir = join(hlsDir, `${variant.height}p`);
    const playlistPath = join(variantDir, "playlist.m3u8");

    const args = [
      "-y",
      "-hwaccel", "cuda",
      "-i", filePath,
      "-vf", `scale=-2:${variant.height}`,
      "-c:v", "h264_nvenc",
      "-preset", "p1",
      "-tune", "ll",
      "-rc", "vbr",
      "-cq", "28",
      "-b:v", String(variant.bitrate),
      "-maxrate", variant.maxrate,
      "-bufsize", variant.bufsize,
      "-g", "60",
      "-c:a", "aac",
      "-b:a", variant.height <= 360 ? "96k" : "128k",
      "-f", "hls",
      "-hls_time", "2",
      "-hls_list_size", "0",
      "-hls_segment_type", "mpegts",
      "-hls_flags", "independent_segments",
      "-hls_segment_filename", join(variantDir, "segment_%03d.ts"),
      "-hls_playlist_type", "vod",
      playlistPath,
    ];

    console.log(`[HLS-ABR] Generating ${variant.height}p variant for ${filePath}`);
    const process = spawn("ffmpeg", args);

    let stderr = "";
    pipeChildProcessLogs(process, `hls-${variant.height}p`, (chunk) => {
      stderr = appendWithLimit(stderr, chunk);
    });

    process.on("close", (code) => {
      if (code === 0) {
        console.log(`[HLS-ABR] ${variant.height}p variant complete`);
        resolve();
        return;
      }
      console.error(`[HLS-ABR] ${variant.height}p failed: ${stderr}`);
      reject(new Error(`HLS ${variant.height}p generation failed`));
    });

    process.on("error", reject);
  });
};

/**
 * Creates the master playlist that references all variants.
 */
const createMasterPlaylist = async (hlsDir: string): Promise<void> => {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", ""];

  for (const variant of HLS_VARIANTS) {
    const bandwidth = variant.bitrate;
    const resolution = variant.height <= 360 
      ? `640x${variant.height}` 
      : `1280x${variant.height}`;
    
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution}`);
    lines.push(`${variant.height}p/playlist.m3u8`);
  }

  const masterPath = join(hlsDir, "master.m3u8");
  await writeFile(masterPath, lines.join("\n"), "utf-8");
  console.log(`[HLS-ABR] Created master playlist at ${masterPath}`);
};

/**
 * Generates multi-bitrate HLS (360p + 720p) with NVIDIA NVENC.
 * Returns the path to the master playlist.
 */
export const generateMultibitrateHLS = async (
  filePath: string,
  opts?: { priority?: QueuePriority; waitForCompletion?: boolean }
): Promise<string> => {
  const modifiedTimeMs = (await stat(filePath)).mtimeMs;
  const hash = getHash(filePath, modifiedTimeMs);
  const hlsDir = getMultibitrateHLSDirectory(hash);
  const masterPath = getMasterPlaylistPath(hash);

  if (existsSync(masterPath)) {
    return masterPath;
  }

  const doEncode = async () => {
    // Create directories for each variant
    for (const variant of HLS_VARIANTS) {
      await mkdir(join(hlsDir, `${variant.height}p`), { recursive: true });
    }

    console.log(`[HLS-ABR] Generating multi-bitrate HLS for ${filePath}`);
    const startTime = Date.now();

    // Generate variants sequentially (NVENC can only do one encode at a time efficiently)
    for (const variant of HLS_VARIANTS) {
      await generateVariant(filePath, hlsDir, variant);
    }

    // Create master playlist
    await createMasterPlaylist(hlsDir);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[HLS-ABR] Multi-bitrate HLS complete for ${filePath} in ${elapsed}s`);
  };

  if (opts?.waitForCompletion) {
    await mediaProcessingQueue.enqueue(doEncode, opts.priority, "video");
  } else {
    void mediaProcessingQueue.enqueue(doEncode, opts?.priority, "video");
  }

  return masterPath;
};

/**
 * Check if a video needs HLS encoding (doesn't have multi-bitrate HLS yet).
 */
export const videoNeedsHLSEncoding = async (filePath: string): Promise<boolean> => {
  const info = await getMultibitrateHLSInfo(filePath);
  return !info.exists;
};
