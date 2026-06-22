import { spawn } from "child_process";
import { mkdir, stat, writeFile, access } from "fs/promises";
import { join } from "path";
import { getMirroredHLSDirectory } from "../common/cacheUtils.ts";
import { pipeChildProcessLogs, appendWithLimit } from "./videoUtils.ts";
import { existsSync } from "fs";
import { getGpuAcceleration, type GpuAcceleration } from "./gpuAcceleration.ts";
import { HLS_SEGMENT_SECONDS } from "./buildHlsPlaylist.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("HLS");

/** Output frame rate for all variants. */
const HLS_FPS = 30;
/**
 * Keyframe interval in frames. Derived so a keyframe lands on every segment
 * boundary (`-g` = fps × segment seconds), which lets the HLS muxer cut clean
 * fixed-length segments that match the synthetic VOD playlist's segment count.
 */
const HLS_GOP = HLS_FPS * HLS_SEGMENT_SECONDS;

/** HLS quality variants: 360p fast-start, 720p standard, 1080p quality, 2160p 4K — all at 30fps */
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
  {
    height: 2160,
    bitrate: 12_000_000,
    maxrate: "15M",
    bufsize: "18M",
    audioBitrate: "192k",
  },
] as const;

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
}> => {
  await stat(filePath);
  const hlsDir = getMultibitrateHLSDirectory(filePath);
  const masterPlaylistPath = getMasterPlaylistPath(hlsDir);
  const [initialized, complete] = await Promise.all([
    multibitrateHLSInitialized(hlsDir),
    multibitrateHLSComplete(hlsDir),
  ]);
  return { hlsDir, masterPlaylistPath, initialized, complete };
};

/**
 * Generates all variant streams in a single FFmpeg process using filter_complex split.
 * Decodes the source once and encodes 360p/720p/1080p/2160p in parallel.
 * Falls back to software encoding if GPU acceleration fails.
 */
const generateAllVariants = (
  filePath: string,
  hlsDir: string,
  gpu: GpuAcceleration | null,
  onSpawn?: (child: ReturnType<typeof spawn>) => void,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const n = HLS_VARIANTS.length;
    // Keep the whole pipeline on the GPU for NVIDIA: decode to CUDA frames,
    // scale with scale_cuda, and feed NVENC directly — no per-frame GPU↔CPU
    // copies. AMD/software stay on the CPU scaler. Output frame rate is forced
    // per-output with `-r` (below) rather than an `fps` filter, since the CPU
    // `fps` filter can't run on GPU-resident CUDA frames.
    const useCuda = gpu?.vendor === "nvidia";
    const scaleFilter = useCuda ? "scale_cuda" : "scale";
    const splitOutputs = HLS_VARIANTS.map((_, i) => `[vin${i}]`).join("");
    const filterComplex = [
      `[0:v]split=${n}${splitOutputs}`,
      ...HLS_VARIANTS.map((v, i) => `[vin${i}]${scaleFilter}=-2:${v.height}[vout${i}]`),
    ].join(";");

    const args: string[] = [
      "-y",
      ...(gpu ? gpu.hwaccelArgs : []),
      ...(useCuda ? ["-hwaccel_output_format", "cuda"] : []),
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
        "-r",
        String(HLS_FPS),
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
        String(HLS_GOP),
        "-c:a",
        "aac",
        "-b:a",
        variant.audioBitrate,
        "-f",
        "hls",
        "-hls_time",
        String(HLS_SEGMENT_SECONDS),
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

    const spawnedAt = Date.now();
    const process = spawn("ffmpeg", args);
    onSpawn?.(process);

    log.info(
      { hlsDir, encoder: gpu ? gpu.label : "software (libx264)", gpuResident: useCuda },
      "HLS encode spawned",
    );

    // Time-to-first-segment: the user-perceived startup latency. Playback can't
    // begin until the first segment of the smallest variant is flushed. This
    // includes ffmpeg launch + (for GPU) NVENC/CUDA context init + encoding the
    // first segment, so it isolates fixed startup cost from total encode time.
    // Polled (not fs.watch) so it owns no event-loop handles to leak; unref'd and
    // cleared on close so it never keeps the process alive.
    const firstVariant = HLS_VARIANTS[0];
    const firstSegment = getVariantSegmentPath(hlsDir, firstVariant.height, "segment_000.ts");
    const firstSegmentPoll = setInterval(() => {
      if (!existsSync(firstSegment)) return;
      clearInterval(firstSegmentPoll);
      log.info(
        { hlsDir, variant: `${firstVariant.height}p`, ms: Date.now() - spawnedAt },
        "HLS first segment ready",
      );
    }, 100);
    firstSegmentPoll.unref?.();

    let stderr = "";
    pipeChildProcessLogs(process, (chunk) => {
      stderr = appendWithLimit(stderr, chunk);
    });

    process.on("close", (code) => {
      clearInterval(firstSegmentPoll);
      if (code === 0) {
        log.info(
          { hlsDir, ms: Date.now() - spawnedAt },
          "HLS encode complete (all variants)",
        );
        resolve();
        return;
      }

      if (gpu && gpu.isHardwareFailure(stderr)) {
        generateAllVariants(filePath, hlsDir, null, onSpawn).then(resolve).catch(reject);
        return;
      }
      reject(new Error("HLS ABR generation failed"));
    });

    process.on("error", (err) => {
      clearInterval(firstSegmentPoll);
      reject(err);
    });
  });
};

/** Approximate 16:9 resolutions for each supported variant height. */
const VARIANT_RESOLUTIONS: Record<number, string> = {
  360: "640x360",
  720: "1280x720",
  1080: "1920x1080",
  2160: "3840x2160",
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
 * Generates multi-bitrate HLS (360p + 720p + 1080p + 2160p @ 30fps) using a single FFmpeg process.
 * All variants are encoded in parallel via filter_complex split.
 *
 * The master playlist is written before FFmpeg starts (via prepareMultibitrateHLSStructure)
 * so clients can begin requesting segments immediately while encoding is in progress.
 *
 * Returns the path to the master playlist.
 */
export const generateMultibitrateHLS = async (
  filePath: string,
  opts?: { onSpawn?: (child: ReturnType<typeof spawn>) => void },
): Promise<string> => {
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

  const gpu = await getGpuAcceleration();

  // Encode all variants in one FFmpeg process
  await generateAllVariants(filePath, hlsDir, gpu, opts?.onSpawn);

  // Write the completion marker so future requests can skip encoding
  await writeFile(getCompleteMarkerPath(hlsDir), "", "utf-8");

  return masterPath;
};

/**
 * Check if a video needs HLS encoding (hasn't been fully encoded yet).
 */
export const videoNeedsHLSEncoding = async (filePath: string): Promise<boolean> => {
  const info = await getMultibitrateHLSInfo(filePath);
  return !info.complete;
};
