import { spawn } from "child_process";
import { mkdir, stat, writeFile, access } from "fs/promises";
import { join } from "path";
import { getMirroredHLSDirectory } from "../common/cacheUtils.ts";
import { measureOperation } from "../observability/requestTrace.ts";
import { pipeChildProcessLogs, appendWithLimit } from "./videoUtils.ts";
import { getGpuAcceleration, type GpuAcceleration } from "./gpuAcceleration.ts";

/** HLS quality variants: 360p fast-start, 720p standard, 1080p quality — all at 30fps */
const HLS_VARIANTS = [
  { height: 360, bitrate: 800_000, maxrate: "1M", bufsize: "1.5M", audioBitrate: "96k" },
  { height: 720, bitrate: 2_500_000, maxrate: "4M", bufsize: "4M", audioBitrate: "128k" },
  {
    height: 1080,
    bitrate: 5_000_000,
    maxrate: "8M",
    bufsize: "8M",
    audioBitrate: "128k",
  },
] as const;

const isVerboseHlsLoggingEnabled = () => process.env.HLS_ENCODE_VERBOSE === "1";

/** Path to the completion marker written after all FFmpeg variants finish. */
const getCompleteMarkerPath = (hlsDir: string): string => join(hlsDir, ".complete");

/**
 * Returns the base directory for multi-bitrate HLS output.
 */
export const getMultibitrateHLSDirectory = (filePath: string): string =>
  getMirroredHLSDirectory(filePath, "abr");

/**
 * Returns the path to the master playlist for multi-bitrate HLS.
 */
export const getMasterPlaylistPath = (hlsDir: string): string =>
  join(hlsDir, "master.m3u8");

/**
 * Returns the path to a variant's playlist.
 */
export const getVariantPlaylistPath = (hlsDir: string, height: number): string =>
  join(hlsDir, `${height}p`, "playlist.m3u8");

/**
 * Returns the path to a variant's segment.
 */
export const getVariantSegmentPath = (
  hlsDir: string,
  height: number,
  segmentName: string,
): string => join(hlsDir, `${height}p`, segmentName);

/**
 * True once master.m3u8 has been written (structure initialized, encoding may still be in progress).
 */
export const multibitrateHLSInitialized = async (hlsDir: string): Promise<boolean> =>
  access(getMasterPlaylistPath(hlsDir)).then(
    () => true,
    () => false,
  );

/**
 * True once all variants have finished encoding (the .complete marker exists).
 */
export const multibitrateHLSComplete = async (hlsDir: string): Promise<boolean> =>
  access(getCompleteMarkerPath(hlsDir)).then(
    () => true,
    () => false,
  );

/** @deprecated use multibitrateHLSComplete */
export const multibitrateHLSExists = multibitrateHLSComplete;

/**
 * Get HLS info for a video file.
 */
export const getMultibitrateHLSInfo = async (
  filePath: string,
): Promise<{
  hlsDir: string;
  masterPlaylistPath: string;
  /** Structure is initialized (master.m3u8 exists); encoding may still be in progress. */
  initialized: boolean;
  /** All variants have finished encoding (.complete marker exists). */
  complete: boolean;
  /** @deprecated use complete */
  exists: boolean;
}> => {
  await stat(filePath);
  const hlsDir = getMultibitrateHLSDirectory(filePath);
  const masterPlaylistPath = getMasterPlaylistPath(hlsDir);
  const [initialized, complete] = await Promise.all([
    multibitrateHLSInitialized(hlsDir),
    multibitrateHLSComplete(hlsDir),
  ]);
  return {
    hlsDir,
    masterPlaylistPath,
    initialized,
    complete,
    exists: complete,
  };
};

/**
 * Generates all variant streams in a single FFmpeg process using filter_complex split.
 * Decodes the source once and encodes 360p/720p/1080p in parallel.
 * Falls back to software encoding if GPU acceleration fails.
 */
const generateAllVariants = (
  filePath: string,
  hlsDir: string,
  gpu: GpuAcceleration | null,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const n = HLS_VARIANTS.length;
    const splitOutputs = HLS_VARIANTS.map((_, i) => `[vin${i}]`).join("");
    const filterComplex = [
      `[0:v]fps=30,split=${n}${splitOutputs}`,
      ...HLS_VARIANTS.map((v, i) => `[vin${i}]scale=-2:${v.height}[vout${i}]`),
    ].join(";");

    const args: string[] = [
      "-y",
      ...(gpu ? gpu.hwaccelArgs : []),
      "-i",
      filePath,
      "-filter_complex",
      filterComplex,
    ];

    for (let i = 0; i < HLS_VARIANTS.length; i++) {
      const variant = HLS_VARIANTS[i];
      const variantDir = join(hlsDir, `${variant.height}p`);
      args.push(
        "-map",
        `[vout${i}]`,
        "-map",
        "0:a?",
        "-c:v",
        gpu ? gpu.h264Codec : "libx264",
        ...(gpu ? gpu.vbrArgs(28) : ["-preset", "veryfast", "-crf", "28"]),
        "-b:v",
        String(variant.bitrate),
        "-maxrate",
        variant.maxrate,
        "-bufsize",
        variant.bufsize,
        "-g",
        "60",
        "-c:a",
        "aac",
        "-b:a",
        variant.audioBitrate,
        "-f",
        "hls",
        "-hls_time",
        "2",
        "-hls_list_size",
        "0",
        "-hls_segment_type",
        "mpegts",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_filename",
        join(variantDir, "segment_%03d.ts"),
        "-hls_playlist_type",
        "event",
        join(variantDir, "playlist.m3u8"),
      );
    }

    const encoderLabel = gpu ? gpu.label : "software";
    if (isVerboseHlsLoggingEnabled()) {
      console.log(`[HLS-ABR] Generating all variants (${encoderLabel}) for ${filePath}`);
    }
    const process = spawn("ffmpeg", args);

    let stderr = "";
    pipeChildProcessLogs(process, "hls-abr", (chunk) => {
      stderr = appendWithLimit(stderr, chunk);
    });

    process.on("close", (code) => {
      if (code === 0) {
        if (isVerboseHlsLoggingEnabled()) {
          console.log(`[HLS-ABR] All variants complete (${encoderLabel})`);
        }
        resolve();
        return;
      }

      if (gpu && gpu.isHardwareFailure(stderr)) {
        console.warn(
          `[HLS-ABR] ${gpu.label} encoding failed, falling back to software encoding`,
        );
        generateAllVariants(filePath, hlsDir, null).then(resolve).catch(reject);
        return;
      }

      console.error(`[HLS-ABR] All variants failed: ${stderr}`);
      reject(new Error("HLS ABR generation failed"));
    });

    process.on("error", reject);
  });
};

/** Approximate 16:9 resolutions for each supported variant height. */
const VARIANT_RESOLUTIONS: Record<number, string> = {
  360: "640x360",
  720: "1280x720",
  1080: "1920x1080",
};

/**
 * Creates the master playlist that references all variants.
 * This is written immediately before FFmpeg starts so clients can begin
 * requesting variant playlists and segments right away.
 */
const createMasterPlaylist = async (hlsDir: string): Promise<void> => {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", ""];

  for (const variant of HLS_VARIANTS) {
    const bandwidth = variant.bitrate;
    const resolution =
      VARIANT_RESOLUTIONS[variant.height] ??
      `${Math.round((variant.height * 16) / 9)}x${variant.height}`;

    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution}`);
    lines.push(`${variant.height}p/playlist.m3u8`);
  }

  const masterPath = join(hlsDir, "master.m3u8");
  await writeFile(masterPath, lines.join("\n"), "utf-8");
  if (isVerboseHlsLoggingEnabled()) {
    console.log(`[HLS-ABR] Created master playlist at ${masterPath}`);
  }
};

/**
 * Creates the HLS directory structure and master playlist for a video without running FFmpeg.
 * Call this first to return a playlist to the client immediately; then call
 * generateMultibitrateHLS (which will skip the structure creation since it already exists).
 *
 * Idempotent — safe to call multiple times.
 */
export const prepareMultibitrateHLSStructure = async (
  filePath: string,
): Promise<void> => {
  await stat(filePath);
  const hlsDir = getMultibitrateHLSDirectory(filePath);

  // Create all variant directories
  await Promise.all(
    HLS_VARIANTS.map((v) => mkdir(join(hlsDir, `${v.height}p`), { recursive: true })),
  );

  // Write master playlist only if it doesn't already exist
  const masterPath = getMasterPlaylistPath(hlsDir);
  const masterExists = await access(masterPath).then(
    () => true,
    () => false,
  );
  if (!masterExists) {
    await createMasterPlaylist(hlsDir);
  }
};

/**
 * Generates multi-bitrate HLS (360p + 720p + 1080p @ 30fps) using a single FFmpeg process.
 * All three variants are encoded in parallel via filter_complex split.
 *
 * The master playlist is written before FFmpeg starts (via prepareMultibitrateHLSStructure)
 * so clients can begin requesting segments immediately while encoding is in progress.
 *
 * Returns the path to the master playlist.
 */
export const generateMultibitrateHLS = async (filePath: string): Promise<string> => {
  await stat(filePath);
  const hlsDir = getMultibitrateHLSDirectory(filePath);
  const masterPath = getMasterPlaylistPath(hlsDir);

  // Already fully encoded — nothing to do
  const isComplete = await multibitrateHLSComplete(hlsDir);
  if (isComplete) {
    return masterPath;
  }

  // Ensure directory structure and master playlist exist before FFmpeg starts
  await prepareMultibitrateHLSStructure(filePath);

  if (isVerboseHlsLoggingEnabled()) {
    console.log(`[HLS-ABR] Generating multi-bitrate HLS for ${filePath}`);
  }
  const startTime = Date.now();

  const gpu = await getGpuAcceleration();

  // Encode all variants in one FFmpeg process
  await measureOperation(
    "generateHlsAllVariants",
    () => generateAllVariants(filePath, hlsDir, gpu),
    {
      category: "conversion",
      detail: "360p+720p+1080p",
      logWithoutRequest: true,
    },
  );

  // Write the completion marker so future requests can skip encoding
  await writeFile(getCompleteMarkerPath(hlsDir), "", "utf-8");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  if (isVerboseHlsLoggingEnabled()) {
    console.log(`[HLS-ABR] Multi-bitrate HLS complete for ${filePath} in ${elapsed}s`);
  }

  return masterPath;
};

/**
 * Check if a video needs HLS encoding (hasn't been fully encoded yet).
 */
export const videoNeedsHLSEncoding = async (filePath: string): Promise<boolean> => {
  const info = await getMultibitrateHLSInfo(filePath);
  return !info.complete;
};
