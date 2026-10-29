import { spawn } from "child_process";
import { mkdir, readdir, rm, stat, writeFile, access } from "fs/promises";
import { join } from "path";
import { getMirroredHLSDirectory } from "../common/cacheUtils.ts";
import { pipeChildProcessLogs, appendWithLimit } from "./videoUtils.ts";
import { existsSync } from "fs";
import { getGpuAcceleration, type GpuAcceleration } from "./gpuAcceleration.ts";
import { HLS_SEGMENT_SECONDS } from "./buildHlsPlaylist.ts";
import { hlsOutputFrameRate } from "./hlsOutputFrameRate.ts";
import { getLogger } from "../observability/logger.ts";
import { pathToken } from "../observability/privacy.ts";
import {
  getVideoSourceProfile,
  isHighBitDepthPixelFormat,
  type VideoSourceProfile,
} from "./getVideoMetadata.ts";
import { queryGpuFreeMB } from "../observability/systemMetrics.ts";
import { reclaimGpuForUser } from "../taskOrchestrator/computeWorkers.ts";

const log = getLogger("HLS");

// Free VRAM (MB) a GPU transcode needs for NVDEC+NVENC of a 4K stream. Below
// this, a user playback request evicts the background ML workers' VRAM rather
// than letting ffmpeg OOM and fall back to realtime-starved libx264.
const GPU_HEADROOM_MB = 1500;
const RECLAIM_POLL_MS = 150;
const RECLAIM_TIMEOUT_MS = 1500;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ensure enough free VRAM for a GPU encode before spawning ffmpeg. Background ML
 * workers keep models resident in VRAM even while SIGSTOP-frozen for a user
 * request, so without this a transcode can't allocate CUDA memory and dies.
 * reclaimGpuForUser() kills the leaseless background workers; we then poll
 * briefly for the VRAM to actually come back before spawning. The orchestrator
 * releases the reclaim (letting them respawn) once the user goes idle.
 */
const ensureGpuHeadroom = async (): Promise<void> => {
  const free = await queryGpuFreeMB();
  if (free === undefined || free >= GPU_HEADROOM_MB) return;
  log.info(
    { freeMB: free, needMB: GPU_HEADROOM_MB },
    "GPU VRAM low; reclaiming from background workers for user transcode",
  );
  reclaimGpuForUser();
  const deadline = Date.now() + RECLAIM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(RECLAIM_POLL_MS);
    const now = await queryGpuFreeMB();
    if (now === undefined || now >= GPU_HEADROOM_MB) return;
  }
};

type Variant = {
  height: number;
  bitrate: number;
  maxrate: string;
  bufsize: string;
  audioBitrate: string;
};

/**
 * HLS quality variants: 360p fast-start, 720p standard, 1080p quality, each at the
 * source's own frame rate up to 30fps (see hlsOutputFrameRate).
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
  {
    height: 1080,
    bitrate: 5_000_000,
    maxrate: "8M",
    bufsize: "8M",
    audioBitrate: "128k",
  },
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
export const prepareMultibitrateHLSStructure = async (
  filePath: string,
): Promise<void> => {
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
 * Empties a variant's output (stale segments + playlist) so a restarted encode is
 * the sole author of that variant's cache, *without* removing the directory
 * itself.
 *
 * Deleting the directory is what crashed the server: a live recursive fs.watch on
 * the `abr` tree re-scans a directory on every event, so removing `abr/1080p`
 * out from under it made that re-scan throw ENOENT, which Node surfaces as an
 * "error" event — fatal on a watcher with no error listener. Keeping the
 * directory in place removes the race at the source; the watcher hardening in
 * hlsSegmentWatcher is the backstop.
 */
export const clearVariantOutput = async (
  hlsDir: string,
  height: number,
): Promise<void> => {
  const variantDir = join(hlsDir, `${height}p`);
  await mkdir(variantDir, { recursive: true });
  const entries = await readdir(variantDir).catch(() => [] as string[]);
  await Promise.all(
    entries.map((name) => rm(join(variantDir, name), { recursive: true, force: true })),
  );
};

/**
 * Applies `rotation` (clockwise degrees, as reported by getVideoSourceProfile)
 * to already-scaled system-memory frames.
 *
 * Rotation is applied *after* the scale deliberately: rotating commutes with
 * scaling, and doing it second means the flip/transpose walks a 1280x720 frame
 * instead of a 3840x2160 one. Measured on a 4K 10-bit source: 0.26x realtime
 * rotating first vs 0.52x rotating last. For a 90/270 turn the scale target is
 * given as a *width* (`scale=720:-2`) so that the post-transpose height is the
 * variant height.
 *
 * The mapping is the inverse of ffmpeg's own auto-rotate: getVideoSourceProfile
 * normalizes the display matrix without ffmpeg's sign flip, so a phone-portrait
 * clip (display matrix -90) arrives here as 270 and needs transpose=clock.
 */
const rotationFilters = (rotation: number): string => {
  if (rotation === 90) return ",transpose=cclock";
  // Through planar yuv420p first: ffmpeg's hflip on semi-planar NV12 (what a
  // VAAPI download hands back) wipes the chroma and the clip comes out green.
  // Measured on a 180° clip: U-plane mean 57.6 against 126.4 in the source,
  // 3.6 dB PSNR; via yuv420p 45.6 dB. transpose is unaffected.
  if (rotation === 180) return ",format=yuv420p,hflip,vflip";
  if (rotation === 270) return ",transpose=clock";
  return "";
};

/** Scale filter for a variant, expressed pre-rotation (see rotationFilters). */
const scaleFilter = (height: number, rotation: number): string =>
  rotation === 90 || rotation === 270 ? `scale=${height}:-2` : `scale=-2:${height}`;

/**
 * Builds the Intel filter chain for a driver that can scale on the GPU: the
 * frames never leave the device at all — decode, fps drop, scale and rotate all
 * happen there and `h264_vaapi` encodes the surface in place. Measured on LXC
 * 124 at 720p: 3.1x realtime from a 4K60 8-bit source and 2.0x from 4K 10-bit,
 * against 1.8x / 0.7x for the same sources when the frames have to come back to
 * system memory to be scaled.
 *
 * Rotation is explicit here for the same reason as in the transfer chain, but
 * for a sharper failure mode: ffmpeg's auto-rotate silently does *nothing* to
 * VAAPI-resident frames (verified — a portrait clip comes out landscape, no
 * warning), so `-noautorotate` plus transpose_vaapi is the only correct shape.
 */
const buildIntelVppFilters = (height: number, rotation: number, fps: string): string => {
  const turned = rotation === 90 || rotation === 270;
  const scale = turned
    ? `scale_vaapi=${height}:-2:format=nv12`
    : `scale_vaapi=-2:${height}:format=nv12`;
  const rotate =
    rotation === 90
      ? ",transpose_vaapi=cclock"
      : rotation === 180
        ? ",transpose_vaapi=reversal"
        : rotation === 270
          ? ",transpose_vaapi=clock"
          : "";
  // No hwupload tail here (gpu.vfExtra): the frames are already VAAPI surfaces.
  return `fps=${fps},${scale}${rotate}`;
};

/**
 * Builds the Intel filter chain that takes GPU-resident decoded frames down to
 * an encodable NV12 surface at the variant's size.
 *
 * The order is load-bearing:
 *  - `fps` runs first, while frames are still on the GPU, so half of a 60fps
 *    source's frames are dropped before anything is copied.
 *  - the copy back to system memory must name the *surface's own* format.
 *    Downloading a P010 (10-bit) surface as NV12 does not error — it produces
 *    silent green/purple garbage — so high-bit-depth sources must say p010le
 *    and convert to 8-bit afterwards, on the CPU, as part of the scale.
 *  - 8-bit sources use `hwmap` instead of `hwdownload`: on an iGPU the frame
 *    already lives in memory the CPU can address, so mapping it read-only skips
 *    the copy entirely (1.24x → 1.77x realtime on a 4K60 source). P010 surfaces
 *    can't be mapped this way (the encoder's hwupload then fails to write the
 *    surface), so they keep the copy.
 */
const buildIntelGpuFrameFilters = (
  height: number,
  rotation: number,
  fps: string,
  highBitDepth: boolean,
  vfExtra: string,
): string => {
  const [transfer, transferFormat] = highBitDepth
    ? ["hwdownload", "p010le"]
    : ["hwmap=mode=read+direct", "nv12"];
  const chain = [
    `fps=${fps}`,
    transfer,
    `format=${transferFormat}`,
    scaleFilter(height, rotation),
    "format=nv12",
  ].join(",");
  // vfExtra is ",format=nv12,hwupload" — the push back onto the VAAPI surface.
  return `${chain}${rotationFilters(rotation)}${vfExtra}`;
};

/** Which pipeline an encode attempt uses; retried left to right as each fails. */
export type EncodeTier = "gpu-frames" | "system-frames" | "software";

/**
 * The decode → filter → encode pipeline for one output height, chosen from the
 * GPU that is present, the source's codec/rotation/bit depth, and the retry
 * tier. Shared by HLS playback and the MP4 share export so both get the same
 * GPU paths and the same fallbacks; only the muxer arguments differ.
 */
export type EncodePipeline = {
  hwaccelArgs: string[];
  vf: string;
  videoCodec: string;
  encoderArgs: readonly string[];
  useCudaPipeline: boolean;
  useNvidia: boolean;
  useIntel: boolean;
  useIntelGpuFrames: boolean;
  /** Human-readable encoder name for logs. */
  encoderLabel: string;
};

export const selectEncodePipeline = (
  height: number,
  gpu: GpuAcceleration | null,
  source: VideoSourceProfile,
  tier: EncodeTier = "gpu-frames",
  /** Encoder quality on the vendor's CQ/QP/CRF scale; lower is better. HLS uses 28. */
  quality = 28,
): EncodePipeline => {
  const rotation = source.rotation;
  const fps = hlsOutputFrameRate(source.frameRate);
  // Encode pipelines, in order of preference:
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
  // 3. Intel Quick Sync, GPU frames (VAAPI, server2's iGPU-only box): VAAPI
  //    decode with frames left on the device and `fps` dropped there. If the
  //    driver has VPP, scale and rotation run on the GPU too and nothing ever
  //    reaches system memory (buildIntelVppFilters); if it doesn't, the frames
  //    are mapped or copied out for a CPU scale and pushed back with
  //    `hwupload` (buildIntelGpuFrameFilters). Needs a codec the iGPU can
  //    decode and explicit rotation handling either way. No dedicated VRAM,
  //    so no ensureGpuHeadroom reclaim.
  //
  // 4. Intel Quick Sync, system frames: as above but ffmpeg copies every
  //    decoded frame back itself and auto-rotates. Slower (a full-resolution
  //    copy per source frame), but tolerant of any codec — the retry tier.
  //
  // 5. CPU (no GPU or GPU-only-decode failed): libx264, all filters on CPU.
  //
  // All paths force 8-bit 4:2:0 output. Sources are frequently 10-bit HEVC
  // (HDR/HLG — default for iPhone and much GoPro footage). h264_nvenc/h264_vaapi
  // reject 10-bit outright, and browsers can't play 10-bit H.264 anyway. The GPU
  // paths convert on-chip; the CPU path uses format=yuv420p.
  const useNvidia = gpu?.vendor === "nvidia";
  const useCudaPipeline = useNvidia && rotation === 0;
  const useIntel = gpu?.vendor === "intel";
  const useIntelGpuFrames =
    useIntel &&
    tier === "gpu-frames" &&
    gpu.hardwareDecodableCodecs.includes(source.codec);

  let hwaccelArgs: string[];
  let vf: string;
  let videoCodec: string;
  let encoderArgs: readonly string[];

  if (useCudaPipeline) {
    // Full CUDA: frames never leave the GPU.
    hwaccelArgs = [...(gpu?.hwaccelArgs ?? []), "-hwaccel_output_format", "cuda"];
    vf = `scale_cuda=-2:${height}:format=yuv420p`;
    videoCodec = gpu?.h264Codec ?? "libx264";
    encoderArgs = gpu?.vbrArgs(quality) ?? [
      "-preset",
      "veryfast",
      "-crf",
      String(quality),
    ];
  } else if (useNvidia) {
    // NVDEC + CPU filters + NVENC: GPU decode, CPU auto-rotate, GPU encode.
    hwaccelArgs = [...(gpu?.hwaccelArgs ?? [])]; // -hwaccel cuda, no output format
    vf = `fps=${fps},scale=-2:${height},format=yuv420p`;
    videoCodec = gpu?.h264Codec ?? "libx264";
    encoderArgs = gpu?.vbrArgs(quality) ?? [
      "-preset",
      "veryfast",
      "-crf",
      String(quality),
    ];
  } else if (useIntelGpuFrames) {
    // VAAPI decode with frames left on the iGPU. With VPP the whole chain
    // runs there; without it, frames are mapped/copied out for a CPU scale
    // and pushed back for the encode.
    hwaccelArgs = [...gpu.hwaccelArgs, ...gpu.gpuFrameArgs];
    vf = gpu.supportsVideoProc
      ? buildIntelVppFilters(height, rotation, fps)
      : buildIntelGpuFrameFilters(
          height,
          rotation,
          fps,
          isHighBitDepthPixelFormat(source.pixelFormat),
          gpu.vfExtra,
        );
    videoCodec = gpu.h264Codec;
    encoderArgs = gpu.vbrArgs(quality);
  } else if (useIntel) {
    // VAAPI decode → system memory → CPU scale/rotate → hwupload → VAAPI
    // encode. See INTEL.hwaccelArgs for why scaling can't move onto this iGPU.
    // Rotation is explicit rather than ffmpeg's auto-rotate, which for a 180°
    // clip flips the downloaded NV12 frames directly (see rotationFilters).
    hwaccelArgs = [...(gpu?.hwaccelArgs ?? []), "-noautorotate"];
    vf = `fps=${fps},${scaleFilter(height, rotation)}${rotationFilters(rotation)}${gpu?.vfExtra ?? ""}`;
    videoCodec = gpu?.h264Codec ?? "libx264";
    encoderArgs = gpu?.vbrArgs(quality) ?? [
      "-preset",
      "veryfast",
      "-crf",
      String(quality),
    ];
  } else {
    // Pure CPU.
    hwaccelArgs = [];
    vf = `fps=${fps},scale=-2:${height},format=yuv420p`;
    videoCodec = "libx264";
    encoderArgs = ["-preset", "veryfast", "-crf", String(quality)];
  }

  const encoderLabel = useCudaPipeline
    ? `${gpu?.label ?? "NVIDIA"} (full CUDA)`
    : useNvidia
      ? `${gpu?.label ?? "NVIDIA"} (NVDEC+NVENC)`
      : useIntelGpuFrames
        ? `${gpu?.label ?? "Intel Quick Sync"} (${gpu?.supportsVideoProc ? "full VAAPI" : "GPU frames+CPU scale"})`
        : useIntel
          ? `${gpu?.label ?? "Intel Quick Sync"} (system frames+VAAPI)`
          : "software (libx264)";

  return {
    hwaccelArgs,
    vf,
    videoCodec,
    encoderArgs,
    useCudaPipeline,
    useNvidia,
    useIntel,
    useIntelGpuFrames: Boolean(useIntelGpuFrames),
    encoderLabel,
  };
};

/** The tier to retry on after a hardware failure of `pipeline`. */
export const nextEncodeTier = (pipeline: EncodePipeline): EncodeTier =>
  pipeline.useIntelGpuFrames ? "system-frames" : "software";

/** Last few ffmpeg stderr lines, for logs and error messages. */
const stderrTail = (stderr: string): string =>
  stderr.trim().split("\n").slice(-3).join(" | ");

/**
 * ffmpeg's stderr quotes its input file and output directory; swap both for
 * tokens so a failed encode's diagnostics don't record which video was played.
 */
const scrubEncodePaths = (text: string, filePath: string, hlsDir: string): string =>
  text.split(filePath).join(pathToken(filePath)).split(hlsDir).join(pathToken(hlsDir));

/**
 * ffmpeg arguments that start an encode at `startSegment` instead of 0. Input
 * `-ss` seeks; `-output_ts_offset` puts the output back on the whole file's
 * timeline and `-start_number` keeps the file names, so a segment written by a
 * seek-started encode is interchangeable with the same segment from an encode
 * from 0 (measured: same frame count and cut points, first PTS within ~20 ms).
 * Forced keyframes count from the seek point, and the seek lands on a segment
 * boundary, so segment cuts stay on whole seconds.
 */
export const seekStartArgs = (
  startSegment: number,
): { input: string[]; output: string[] } => {
  if (startSegment <= 0) return { input: [], output: ["-start_number", "0"] };
  const seconds = String(startSegment * HLS_SEGMENT_SECONDS);
  return {
    input: ["-ss", seconds],
    output: ["-output_ts_offset", seconds, "-start_number", String(startSegment)],
  };
};

const segmentFileName = (index: number): string =>
  `segment_${String(index).padStart(3, "0")}.ts`;

/**
 * Runs a single-variant HLS encode for one height, from `startSegment` (0, or
 * where a seek landed). Writes segments + playlist into `{height}p/`. Falls back
 * down the tiers if hardware encoding fails.
 */
const encodeVariant = (
  filePath: string,
  hlsDir: string,
  variant: Variant,
  gpu: GpuAcceleration | null,
  source: VideoSourceProfile,
  onSpawn?: (child: ReturnType<typeof spawn>) => void,
  tier: EncodeTier = "gpu-frames",
  startSegment = 0,
): Promise<void> => {
  const rotation = source.rotation;
  const fps = hlsOutputFrameRate(source.frameRate);
  const [fpsNum, fpsDen] = fps.split("/").map(Number);
  const maxGopFrames = Math.ceil((fpsNum / fpsDen) * HLS_SEGMENT_SECONDS);
  const pipeline = selectEncodePipeline(variant.height, gpu, source, tier);
  return new Promise((resolve, reject) => {
    const {
      hwaccelArgs,
      vf,
      videoCodec,
      encoderArgs,
      useCudaPipeline,
      useNvidia,
      useIntel,
      encoderLabel,
    } = pipeline;

    const variantDir = join(hlsDir, `${variant.height}p`);
    const seek = seekStartArgs(startSegment);

    const args: string[] = [
      "-y",
      ...hwaccelArgs,
      ...seek.input,
      "-i",
      filePath,
      "-vf",
      vf,
      // `-r` is only needed for the full CUDA pipeline: frames stay on the GPU so the
      // CPU `fps` filter can't run. All other paths have `fps=` in the vf chain above.
      ...(useCudaPipeline ? ["-r", fps] : []),
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
      // Upper bound only (one segment's worth of frames); the forced keyframes
      // above are what align segments, at any frame rate.
      "-g",
      String(maxGopFrames),
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
      ...seek.output,
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

    const launch = async () => {
      // Re-assert the output directory on every spawn, including the software
      // retry after a GPU failure: the tree is ephemeral and can be reaped or
      // cleared between attempts, and ffmpeg's HLS muxer fails outright if the
      // directory behind -hls_segment_filename is missing.
      await mkdir(variantDir, { recursive: true });

      // Evict background ML VRAM before a GPU encode so ffmpeg can allocate
      // NVDEC/NVENC memory instead of OOMing into realtime-starved libx264.
      if (useCudaPipeline || useNvidia) await ensureGpuHeadroom();

      const spawnedAt = Date.now();
      const process = spawn("ffmpeg", args);
      onSpawn?.(process);

      log.info(
        {
          hlsDir: pathToken(hlsDir),
          variant: `${variant.height}p`,
          encoder: encoderLabel,
          rotation,
          startSegment,
        },
        "HLS encode spawned",
      );

      // Time-to-first-segment: the user-perceived startup latency.
      const firstSegment = join(variantDir, segmentFileName(startSegment));
      const firstSegmentPoll = setInterval(() => {
        if (!existsSync(firstSegment)) return;
        clearInterval(firstSegmentPoll);
        log.info(
          {
            hlsDir: pathToken(hlsDir),
            variant: `${variant.height}p`,
            ms: Date.now() - spawnedAt,
          },
          "HLS first segment ready",
        );
      }, 100);
      firstSegmentPoll.unref?.();

      let stderr = "";
      pipeChildProcessLogs(process, (chunk) => {
        stderr = appendWithLimit(stderr, chunk);
      });

      process.on("close", (code, signal) => {
        clearInterval(firstSegmentPoll);
        if (code === 0) {
          log.info(
            {
              hlsDir: pathToken(hlsDir),
              variant: `${variant.height}p`,
              ms: Date.now() - spawnedAt,
            },
            "HLS encode complete",
          );
          resolve();
          return;
        }

        // Killed by a signal means *we* killed it — the idle reaper retiring a
        // variant the player switched away from, a session reap, or a
        // replacement encode. That is a cancellation, not a failure, and must
        // not be retried: every hardware encode's stderr mentions "vaapi"
        // (device init, encoder name), so isHardwareFailure says yes to any
        // non-zero exit, and an ABR switch would silently respawn the variant
        // the user just left as libx264 — burning every core at ~0.1x realtime
        // and starving the variant they switched *to*.
        if (signal) {
          log.debug(
            { hlsDir: pathToken(hlsDir), variant: `${variant.height}p`, signal },
            "HLS encode cancelled",
          );
          resolve();
          return;
        }

        if (
          (useCudaPipeline || useNvidia || useIntel) &&
          gpu &&
          gpu.isHardwareFailure(stderr)
        ) {
          // Step down one tier rather than straight to CPU: on Intel the
          // GPU-frame pipeline is the fragile one (it needs a decodable codec
          // and a mappable surface), while the system-frame pipeline still
          // encodes on the iGPU and is many times faster than libx264.
          const nextTier = nextEncodeTier(pipeline);
          log.warn(
            {
              hlsDir: pathToken(hlsDir),
              variant: `${variant.height}p`,
              nextTier,
              stderr: scrubEncodePaths(stderrTail(stderr), filePath, hlsDir),
            },
            "GPU encode failed, retrying on a lower tier",
          );
          encodeVariant(
            filePath,
            hlsDir,
            variant,
            nextTier === "software" ? null : gpu,
            source,
            onSpawn,
            nextTier,
            startSegment,
          )
            .then(resolve)
            .catch(reject);
          return;
        }
        // Surface the ffmpeg stderr tail so a failed encode is diagnosable
        // rather than an opaque "generation failed" with no cause.
        const detail = scrubEncodePaths(stderrTail(stderr), filePath, hlsDir);
        reject(
          new Error(
            `HLS ABR generation failed (exit ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
          ),
        );
      });

      process.on("error", (err) => {
        clearInterval(firstSegmentPoll);
        reject(err);
      });
    };

    launch().catch(reject);
  });
};

/**
 * Generates a single HLS variant (one of SUPPORTED_HLS_HEIGHTS) on the fly,
 * from `startSegment` (default 0, the beginning of the file). Segments not yet written are
 * long-polled by the segment handler (see waitForHlsFile) until ffmpeg produces them.
 * The output is ephemeral and is reaped once playback goes idle.
 */
export const generateVariantHLS = async (
  filePath: string,
  height: number,
  opts?: {
    onSpawn?: (child: ReturnType<typeof spawn>) => void;
    startSegment?: number;
  },
): Promise<void> => {
  await stat(filePath);
  const variant = VARIANT_BY_HEIGHT.get(clampToSupportedHeight(height));
  if (!variant) throw new Error(`Unsupported HLS height: ${height}`);

  const hlsDir = getMultibitrateHLSDirectory(filePath);
  await mkdir(join(hlsDir, `${variant.height}p`), { recursive: true });

  const [gpu, source] = await Promise.all([
    getGpuAcceleration(),
    getVideoSourceProfile(filePath),
  ]);
  await encodeVariant(
    filePath,
    hlsDir,
    variant,
    gpu,
    source,
    opts?.onSpawn,
    "gpu-frames",
    opts?.startSegment ?? 0,
  );
};
