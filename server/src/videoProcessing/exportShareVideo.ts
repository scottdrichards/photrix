import { spawn } from "child_process";
import { access, mkdir, rename, rm, stat } from "fs/promises";
import { dirname } from "path";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import { getLogger } from "../observability/logger.ts";
import { pathToken } from "../observability/privacy.ts";
import { appendWithLimit, pipeChildProcessLogs } from "./videoUtils.ts";
import { getGpuAcceleration, type GpuAcceleration } from "./gpuAcceleration.ts";
import { getVideoSourceProfile, type VideoSourceProfile } from "./getVideoMetadata.ts";
import { hlsOutputFrameRate } from "./hlsOutputFrameRate.ts";
import {
  nextEncodeTier,
  selectEncodePipeline,
  type EncodeTier,
} from "./generateMultibitrateHLS.ts";

const log = getLogger("ShareVideo");

/**
 * Short-side sizes the share dialog offers for a video: "web-safe, original
 * size" caps at 1080p, "smaller size" at 720p. The short side, not the height,
 * so a portrait phone clip comes out 1080x1920 rather than 608x1080.
 */
export const SHARE_VIDEO_SHORT_SIDES = [720, 1080] as const;
export type ShareVideoShortSide = (typeof SHARE_VIDEO_SHORT_SIDES)[number];

export const parseShareVideoShortSide = (value: string | null): ShareVideoShortSide =>
  value === "720" ? 720 : 1080;

// Better than HLS playback's 28: this is a file someone keeps, not a stream
// that has to start fast, and it is still far smaller than a 4K original.
const SHARE_QUALITY = 23;

// Every encoder's rate control expects these (GpuAcceleration.vbrArgs): VBR
// modes refuse to open without a target, and CQ/CRF modes treat them as a cap.
// Above HLS's 5M/2.5M ladder for the same reason as SHARE_QUALITY.
const SHARE_BITRATES: Record<ShareVideoShortSide, readonly string[]> = {
  1080: ["-b:v", "8M", "-maxrate", "12M", "-bufsize", "16M"],
  720: ["-b:v", "4M", "-maxrate", "6M", "-bufsize", "8M"],
};

const evenFloor = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

/**
 * Output height *as displayed* for a requested short side. The encode
 * pipeline's height is the displayed height (it scales after rotation), so a
 * portrait clip needs the long side here. Never upscales.
 */
export const shareOutputHeight = (
  shortSide: ShareVideoShortSide,
  source: Pick<VideoSourceProfile, "width" | "height" | "rotation">,
): number => {
  const { width, height } = source;
  if (!width || !height) return shortSide;
  const turned = source.rotation === 90 || source.rotation === 270;
  const displayHeight = turned ? width : height;
  const sourceShort = Math.min(width, height);
  const target = Math.min(shortSide, sourceShort);
  return evenFloor((displayHeight * target) / sourceShort);
};

export const getShareVideoPath = (
  filePath: string,
  shortSide: ShareVideoShortSide,
): string => getMirroredCachedFilePath(filePath, `share.${shortSide}`, "mp4");

/** ffmpeg arguments for one attempt; exported for tests. */
export const buildShareVideoArgs = (
  filePath: string,
  outputPath: string,
  shortSide: ShareVideoShortSide,
  outputHeight: number,
  gpu: GpuAcceleration | null,
  source: VideoSourceProfile,
  tier: EncodeTier,
) => {
  const pipeline = selectEncodePipeline(outputHeight, gpu, source, tier, SHARE_QUALITY);
  // A pipeline that turns the frames itself (`-noautorotate` + transpose)
  // would otherwise copy the source's display matrix into the MP4, and a
  // player would rotate the already-upright picture a second time. Measured:
  // a 90° phone clip came out 1080x1920 *and* flagged 90°. HLS never hit this
  // because MPEG-TS has nowhere to put the matrix. Autorotating pipelines
  // drop it themselves, and resetting it there would cancel the rotation.
  const rotatesExplicitly = pipeline.hwaccelArgs.includes("-noautorotate");
  const args = [
    "-y",
    ...pipeline.hwaccelArgs,
    ...(rotatesExplicitly ? ["-display_rotation", "0"] : []),
    "-i",
    filePath,
    // One video and (if present) one audio stream: camera files also carry
    // timecode/telemetry data streams the MP4 muxer can't take.
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    pipeline.vf,
    // The CUDA path keeps frames on the GPU, where the fps filter cannot run.
    ...(pipeline.useCudaPipeline ? ["-r", hlsOutputFrameRate(source.frameRate)] : []),
    "-c:v",
    pipeline.videoCodec,
    ...pipeline.encoderArgs,
    ...SHARE_BITRATES[shortSide],
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    // Keep the capture date.
    "-map_metadata",
    "0",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outputPath,
  ];
  return { args, pipeline };
};

const runEncode = (
  filePath: string,
  outputPath: string,
  shortSide: ShareVideoShortSide,
  outputHeight: number,
  gpu: GpuAcceleration | null,
  source: VideoSourceProfile,
  tier: EncodeTier = "gpu-frames",
): Promise<void> =>
  new Promise((resolve, reject) => {
    const { args, pipeline } = buildShareVideoArgs(
      filePath,
      outputPath,
      shortSide,
      outputHeight,
      gpu,
      source,
      tier,
    );
    const startedAt = Date.now();
    const child = spawn("ffmpeg", args);
    let stderr = "";
    pipeChildProcessLogs(child, (chunk) => {
      stderr = appendWithLimit(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        log.info(
          {
            file: pathToken(filePath),
            encoder: pipeline.encoderLabel,
            ms: Date.now() - startedAt,
          },
          "Share video encoded",
        );
        resolve();
        return;
      }
      const hardware =
        pipeline.useCudaPipeline || pipeline.useNvidia || pipeline.useIntel;
      if (hardware && gpu?.isHardwareFailure(stderr)) {
        const next = nextEncodeTier(pipeline);
        log.warn(
          { file: pathToken(filePath), nextTier: next },
          "Share video GPU encode failed, retrying",
        );
        runEncode(
          filePath,
          outputPath,
          shortSide,
          outputHeight,
          next === "software" ? null : gpu,
          source,
          next,
        ).then(resolve, reject);
        return;
      }
      const tail = stderr
        .trim()
        .split("\n")
        .slice(-3)
        .join(" | ")
        .split(filePath)
        .join("<source>");
      reject(new Error(`Share video encode failed (exit ${code ?? "unknown"}): ${tail}`));
    });
  });

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const inFlight = new Map<string, Promise<string>>();
// One export at a time: each one saturates the GPU encoder (or every core on
// the software path), and live playback shares that encoder.
let queue: Promise<unknown> = Promise.resolve();

/**
 * An H.264/AAC MP4 of `filePath` at the given short side, for handing to an
 * OS share sheet or a download. Cached beside the other derivatives (and
 * evicted with them); concurrent requests for the same output share one encode.
 * Written to a temp name and renamed, so a cached file is always complete.
 */
export const exportShareVideo = (
  filePath: string,
  shortSide: ShareVideoShortSide,
): Promise<string> => {
  const outputPath = getShareVideoPath(filePath, shortSide);
  const pending = inFlight.get(outputPath);
  if (pending) return pending;

  const work = async (): Promise<string> => {
    await stat(filePath);
    if (await exists(outputPath)) return outputPath;
    const [gpu, source] = await Promise.all([
      getGpuAcceleration(),
      getVideoSourceProfile(filePath),
    ]);
    const partialPath = `${outputPath}.partial.mp4`;
    await mkdir(dirname(outputPath), { recursive: true });
    try {
      await runEncode(
        filePath,
        partialPath,
        shortSide,
        shareOutputHeight(shortSide, source),
        gpu,
        source,
      );
      await rename(partialPath, outputPath);
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }
    return outputPath;
  };

  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  const tracked = run.finally(() => inFlight.delete(outputPath));
  inFlight.set(outputPath, tracked);
  return tracked;
};
