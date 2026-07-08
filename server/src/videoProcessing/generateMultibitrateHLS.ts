import { spawn } from "child_process";
import { mkdir, stat, writeFile, access } from "fs/promises";
import { join } from "path";
import { getMirroredHLSDirectory } from "../common/cacheUtils.ts";
import { pipeChildProcessLogs, appendWithLimit } from "./videoUtils.ts";
import { existsSync } from "fs";
import { getGpuAcceleration, type GpuAcceleration } from "./gpuAcceleration.ts";
import { HLS_SEGMENT_SECONDS } from "./buildHlsPlaylist.ts";
import { getLogger } from "../observability/logger.ts";
import { getVideoRotationDegrees } from "./getVideoMetadata.ts";

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
 * Runs a single-variant HLS encode for one height, always from segment 0.
 * Writes segments + playlist into `{height}p/`. Falls back to software encoding
 * if GPU acceleration fails.
 */
const encodeVariant = (
  filePath: string,
  hlsDir: string,
  variant: Variant,
  gpu: GpuAcceleration | null,
  rotation: number,
  onSpawn?: (child: ReturnType<typeof spawn>) => void,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Three encode pipelines, in order of preference:
    //
    // 1. FULL CUDA (NVIDIA, landscape): decode→CUDA frames→scale_cuda→h264_nvenc.
    //    No CPU roundtrip at all. ~7× realtime for 4K. Requires rotation=0 because
    //    ffmpeg's auto-rotate (transpose) can't run on GPU-resident frames when
    //    -hwaccel_output_format cuda keeps them there.
    //
    // 2. NVDEC+NVENC (NVIDIA, rotated/portrait): -hwaccel cuda WITHOUT
    //    -hwaccel_output_format cuda. NVDEC decodes on GPU then transfers frames to
    //    CPU memory. ffmpeg's auto-rotate runs on those CPU frames. h264_nvenc
    //    re-uploads and encodes on GPU. ~4-6× realtime vs ~0.3× for pure CPU on
    //    4K HEVC — critical for phone portrait videos to avoid buffer starvation.
    //
    // 3. CPU (no GPU or GPU-only-decode failed): libx264, all filters on CPU.
    //
    // All paths force 8-bit 4:2:0 output. Sources are frequently 10-bit HEVC
    // (HDR/HLG — default for iPhone and much GoPro footage). h264_nvenc rejects
    // 10-bit outright, and browsers can't play 10-bit H.264 anyway. The GPU paths
    // convert on-chip; the CPU path uses format=yuv420p.
    const useNvidia = gpu?.vendor === "nvidia";
    const useCudaPipeline = useNvidia && rotation === 0;

    let hwaccelArgs: string[];
    let vf: string;
    let videoCodec: string;
    let encoderArgs: readonly string[];

    if (useCudaPipeline) {
      // Full CUDA: frames never leave the GPU.
      hwaccelArgs = [...(gpu?.hwaccelArgs ?? []), "-hwaccel_output_format", "cuda"];
      vf = `scale_cuda=-2:${variant.height}:format=yuv420p`;
      videoCodec = gpu?.h264Codec ?? "libx264";
      encoderArgs = gpu?.vbrArgs(28) ?? ["-preset", "veryfast", "-crf", "28"];
    } else if (useNvidia) {
      // NVDEC + CPU filters + NVENC: GPU decode, CPU auto-rotate, GPU encode.
      hwaccelArgs = [...(gpu?.hwaccelArgs ?? [])]; // -hwaccel cuda, no output format
      vf = `fps=${HLS_FPS},scale=-2:${variant.height},format=yuv420p`;
      videoCodec = gpu?.h264Codec ?? "libx264";
      encoderArgs = gpu?.vbrArgs(28) ?? ["-preset", "veryfast", "-crf", "28"];
    } else {
      // Pure CPU.
      hwaccelArgs = [];
      vf = `fps=${HLS_FPS},scale=-2:${variant.height},format=yuv420p`;
      videoCodec = "libx264";
      encoderArgs = ["-preset", "veryfast", "-crf", "28"];
    }

    const variantDir = join(hlsDir, `${variant.height}p`);

    const args: string[] = [
      "-y",
      ...hwaccelArgs,
      "-i",
      filePath,
      "-vf",
      vf,
      // `-r` is only needed for the full CUDA pipeline: frames stay on the GPU so the
      // CPU `fps` filter can't run. All other paths have `fps=` in the vf chain above.
      ...(useCudaPipeline ? ["-r", String(HLS_FPS)] : []),
      "-c:v",
      videoCodec,
      ...encoderArgs,
      "-b:v",
      String(variant.bitrate),
      "-maxrate",
      variant.maxrate,
      "-bufsize",
      variant.bufsize,
      // Force keyframes at exact integer-second boundaries so HLS segment cuts land
      // on clean 1s boundaries. Plain `-g N` counts GOP frames from the first output
      // PTS, which is non-zero for sources with B-frames before the first I-frame
      // (e.g. Canon cameras, iPhones), producing irregular segment durations that
      // mismatch the synthetic VOD playlist's fixed 1s EXTINFs.
      "-force_key_frames",
      `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
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
      "0",
      "-hls_segment_type",
      "mpegts",
      "-hls_flags",
      "independent_segments+temp_file",
      "-hls_segment_filename",
      join(variantDir, "segment_%03d.ts"),
      "-hls_playlist_type",
      "event",
      join(variantDir, "playlist.m3u8"),
    ];

    const spawnedAt = Date.now();
    const process = spawn("ffmpeg", args);
    onSpawn?.(process);

    const encoderLabel = useCudaPipeline
      ? `${gpu?.label ?? "NVIDIA"} (full CUDA)`
      : useNvidia
        ? `${gpu?.label ?? "NVIDIA"} (NVDEC+NVENC)`
        : "software (libx264)";

    log.info(
      { hlsDir, variant: `${variant.height}p`, encoder: encoderLabel, rotation },
      "HLS encode spawned",
    );

    // Time-to-first-segment: the user-perceived startup latency.
    const firstSegment = join(variantDir, "segment_000.ts");
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

      if ((useCudaPipeline || useNvidia) && gpu && gpu.isHardwareFailure(stderr)) {
        log.warn(
          { hlsDir, variant: `${variant.height}p` },
          "GPU encode failed, falling back to software",
        );
        encodeVariant(filePath, hlsDir, variant, null, rotation, onSpawn)
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
 * Generates a single HLS variant (one of SUPPORTED_HLS_HEIGHTS @ 30fps) on the fly,
 * always encoding from the beginning of the file. Segments not yet written are
 * long-polled by the segment handler (see waitForHlsFile) until ffmpeg produces them.
 * The output is ephemeral and is reaped once playback goes idle.
 */
export const generateVariantHLS = async (
  filePath: string,
  height: number,
  opts?: {
    onSpawn?: (child: ReturnType<typeof spawn>) => void;
  },
): Promise<void> => {
  await stat(filePath);
  const variant = VARIANT_BY_HEIGHT.get(clampToSupportedHeight(height));
  if (!variant) throw new Error(`Unsupported HLS height: ${height}`);

  const hlsDir = getMultibitrateHLSDirectory(filePath);
  await mkdir(join(hlsDir, `${variant.height}p`), { recursive: true });

  const [gpu, rotation] = await Promise.all([getGpuAcceleration(), getVideoRotationDegrees(filePath)]);
  await encodeVariant(filePath, hlsDir, variant, gpu, rotation, opts?.onSpawn);
};
