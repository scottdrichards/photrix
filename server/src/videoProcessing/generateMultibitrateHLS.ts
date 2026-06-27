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

type Variant = {
  height: number;
  bitrate: number;
  maxrate: string;
  bufsize: string;
  audioBitrate: string;
};

/**
 * HLS quality variants: 360p fast-start, 720p standard, 1080p quality — all at 30fps.
 *
 * All three are advertised in the master playlist and the player adapts between them
 * mid-stream (real ABR) from its own measured throughput. Each is encoded lazily and
 * only while actually being fetched: a single ffmpeg encode of one variant runs well
 * above real time, and an idle variant's encode is reaped within seconds of an ABR
 * switch, so at most ~1 (briefly 2, across a switch) run concurrently rather than all
 * three. 2160p (4K) is intentionally not offered: it is the heaviest to encode, rarely
 * beneficial in a browser viewer, and the biggest throughput risk.
 */
const HLS_VARIANTS: readonly Variant[] = [
  { height: 360, bitrate: 800_000, maxrate: "1M", bufsize: "1.5M", audioBitrate: "96k" },
  { height: 720, bitrate: 2_500_000, maxrate: "4M", bufsize: "4M", audioBitrate: "128k" },
  { height: 1080, bitrate: 5_000_000, maxrate: "8M", bufsize: "8M", audioBitrate: "128k" },
] as const;

const VARIANT_BY_HEIGHT = new Map(HLS_VARIANTS.map((v) => [v.height, v]));

/** Heights the on-the-fly encoder can produce, ascending. */
export const SUPPORTED_HLS_HEIGHTS = HLS_VARIANTS.map((v) => v.height);

/** Fallback height for a request that names an unsupported one. */
const DEFAULT_HLS_HEIGHT = 720;

/** Clamps an arbitrary requested height to a supported variant, defaulting when unknown. */
export const clampToSupportedHeight = (height: number): number =>
  VARIANT_BY_HEIGHT.has(height) ? height : DEFAULT_HLS_HEIGHT;

/**
 * Returns the base directory for HLS output.
 */
export const getMultibitrateHLSDirectory = (filePath: string): string =>
  getMirroredHLSDirectory(filePath, "abr");

/**
 * Returns the path to the master playlist.
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
 * Get HLS info for a video file.
 */
export const getMultibitrateHLSInfo = async (
  filePath: string,
): Promise<{
  hlsDir: string;
  masterPlaylistPath: string;
  /** Structure is initialized (master.m3u8 exists); encoding may still be in progress. */
  initialized: boolean;
}> => {
  await stat(filePath);
  const hlsDir = getMultibitrateHLSDirectory(filePath);
  const masterPlaylistPath = getMasterPlaylistPath(hlsDir);
  const initialized = await multibitrateHLSInitialized(hlsDir);
  return { hlsDir, masterPlaylistPath, initialized };
};

/** Approximate 16:9 resolutions for each supported variant height. */
const VARIANT_RESOLUTIONS: Record<number, string> = {
  360: "640x360",
  720: "1280x720",
  1080: "1920x1080",
};

const resolutionFor = (variant: Variant): string =>
  VARIANT_RESOLUTIONS[variant.height] ??
  `${Math.round((variant.height * 16) / 9)}x${variant.height}`;

/**
 * Creates the master playlist advertising every variant, ordered lowest→highest
 * bitrate. Written immediately (before ffmpeg starts) so the player can begin
 * requesting a variant playlist and segments right away.
 *
 * All variants are advertised so the client's HLS player can adapt between them
 * mid-stream (real ABR): it starts on the lowest and climbs as its *measured*
 * throughput allows, then drops again if the link degrades. Each variant is only
 * actually encoded once the player fetches its segments (lazy, see the request
 * handler), and an idle variant's encode is reaped, so advertising all three does
 * not mean encoding all three at once.
 */
const createMasterPlaylist = async (hlsDir: string): Promise<void> => {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const variant of HLS_VARIANTS) {
    lines.push(
      "",
      `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bitrate},RESOLUTION=${resolutionFor(variant)}`,
      `${variant.height}p/playlist.m3u8`,
    );
  }
  await writeFile(getMasterPlaylistPath(hlsDir), lines.join("\n"), "utf-8");
};

/**
 * Creates the HLS directory structure and multi-variant master playlist without
 * running FFmpeg. Call this first to return the master to the client immediately;
 * then encoding for whichever variant the player requests is started lazily.
 *
 * Idempotent — safe to call multiple times.
 */
export const prepareMultibitrateHLSStructure = async (filePath: string): Promise<void> => {
  await stat(filePath);
  const hlsDir = getMultibitrateHLSDirectory(filePath);

  await Promise.all(
    HLS_VARIANTS.map((v) => mkdir(join(hlsDir, `${v.height}p`), { recursive: true })),
  );

  const masterExists = await access(getMasterPlaylistPath(hlsDir)).then(
    () => true,
    () => false,
  );
  if (!masterExists) {
    await createMasterPlaylist(hlsDir);
  }
};

/**
 * Runs a single-variant HLS encode for one height, starting at segment
 * `startSegment` (0 = from the beginning). Writes segments + playlist into
 * `{height}p/`. Falls back to software encoding if GPU acceleration fails.
 *
 * `startSegment > 0` seeks the input to that segment boundary (`-ss`) and numbers
 * output segments from there (`-start_number`), so an encode can begin at the
 * player's current position rather than re-encoding from 0 — needed for mid-stream
 * ABR up-switches and forward seeks. `-copyts` preserves source timestamps so the
 * same segment index carries identical PTS across every variant, which is what lets
 * the player switch levels seamlessly.
 */
const encodeVariant = (
  filePath: string,
  hlsDir: string,
  variant: Variant,
  gpu: GpuAcceleration | null,
  startSegment: number,
  onSpawn?: (child: ReturnType<typeof spawn>) => void,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Keep the whole pipeline on the GPU for NVIDIA: decode to CUDA frames, scale
    // with scale_cuda, and feed NVENC directly — no per-frame GPU↔CPU copies.
    // AMD/software stay on the CPU scaler. Output frame rate is forced with `-r`
    // rather than an `fps` filter, since the CPU `fps` filter can't run on
    // GPU-resident CUDA frames.
    const useCuda = gpu?.vendor === "nvidia";
    // Force 8-bit 4:2:0 output. Sources are frequently 10-bit HEVC (HDR/HLG — the
    // default for iPhone and much GoPro footage). Two reasons this matters:
    //   1. h264_nvenc rejects 10-bit input outright ("10 bit encode not supported"),
    //      which trips the hardware-failure fallback onto a pure-software path that
    //      decodes 4K HEVC + encodes libx264 at ~0.3x realtime — slower than playback,
    //      so it stalls and rebuffers for the entire video.
    //   2. Even if software succeeded, libx264 would emit 10-bit H.264 (High 10),
    //      which browsers can't decode.
    // Converting to 8-bit on the GPU (scale_cuda's `format` option) keeps the whole
    // pipeline on NVENC at ~7x realtime; the CPU path appends an equivalent `format`.
    const vf = useCuda
      ? `scale_cuda=-2:${variant.height}:format=yuv420p`
      : `scale=-2:${variant.height},format=yuv420p`;
    const variantDir = join(hlsDir, `${variant.height}p`);

    // Offset encode: seek the input to the segment boundary and keep source
    // timestamps (`-copyts`) so every variant's segment_N carries the same PTS.
    // Omitted for startSegment 0 so the common from-the-start path is unchanged.
    const seekArgs =
      startSegment > 0
        ? ["-ss", String(startSegment * HLS_SEGMENT_SECONDS), "-copyts"]
        : [];

    const args: string[] = [
      "-y",
      ...(gpu ? gpu.hwaccelArgs : []),
      ...(useCuda ? ["-hwaccel_output_format", "cuda"] : []),
      ...seekArgs,
      "-i",
      filePath,
      "-vf",
      vf,
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
      "-start_number",
      String(startSegment),
      "-hls_segment_type",
      "mpegts",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_filename",
      join(variantDir, "segment_%03d.ts"),
      "-hls_playlist_type",
      "event",
      join(variantDir, "playlist.m3u8"),
    ];

    const spawnedAt = Date.now();
    const process = spawn("ffmpeg", args);
    onSpawn?.(process);

    log.info(
      {
        hlsDir,
        variant: `${variant.height}p`,
        encoder: gpu ? gpu.label : "software (libx264)",
        gpuResident: useCuda,
      },
      "HLS encode spawned",
    );

    // Time-to-first-segment: the user-perceived startup latency. Playback can't
    // begin until the first segment is flushed. Polled (not fs.watch) so it owns no
    // event-loop handles to leak; unref'd and cleared on close. Named from the
    // encode's start segment, which may be > 0 for an offset (seek/up-switch) encode.
    const firstSegmentName = `segment_${String(startSegment).padStart(3, "0")}.ts`;
    const firstSegment = join(variantDir, firstSegmentName);
    const firstSegmentPoll = setInterval(() => {
      if (!existsSync(firstSegment)) return;
      clearInterval(firstSegmentPoll);
      log.info(
        { hlsDir, variant: `${variant.height}p`, ms: Date.now() - spawnedAt },
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
          { hlsDir, variant: `${variant.height}p`, ms: Date.now() - spawnedAt },
          "HLS encode complete",
        );
        resolve();
        return;
      }

      if (gpu && gpu.isHardwareFailure(stderr)) {
        encodeVariant(filePath, hlsDir, variant, null, startSegment, onSpawn)
          .then(resolve)
          .catch(reject);
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

/**
 * Generates a single HLS variant (one of SUPPORTED_HLS_HEIGHTS @ 30fps) on the fly.
 *
 * The master + variant directory should already exist (via prepareMultibitrateHLSStructure)
 * so the client can begin requesting segments immediately while this encodes. Segments not
 * yet written are long-polled by the segment handler (see waitForHlsFile) until ffmpeg
 * produces them. The output is ephemeral and is reaped once playback goes idle.
 */
export const generateVariantHLS = async (
  filePath: string,
  height: number,
  opts?: {
    /** Segment index to begin encoding at (0 = from the start). */
    startSegment?: number;
    onSpawn?: (child: ReturnType<typeof spawn>) => void;
  },
): Promise<void> => {
  await stat(filePath);
  const variant = VARIANT_BY_HEIGHT.get(clampToSupportedHeight(height));
  if (!variant) throw new Error(`Unsupported HLS height: ${height}`);

  const hlsDir = getMultibitrateHLSDirectory(filePath);
  await mkdir(join(hlsDir, `${variant.height}p`), { recursive: true });

  const gpu = await getGpuAcceleration();
  await encodeVariant(filePath, hlsDir, variant, gpu, opts?.startSegment ?? 0, opts?.onSpawn);
};
