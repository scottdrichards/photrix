import { spawn } from "child_process";
import { access, mkdir, stat } from "fs/promises";
import { dirname } from "path";
import { StandardHeight } from "../common/standardHeights.ts";
import { bindChildProcessAbort } from "../common/abortableChildProcess.ts";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import { type ConversionPriority } from "../common/conversionPriority.ts";
import { scheduleMediaConversion } from "../common/mediaConversionScheduler.ts";
import {
  createAbortError,
  getRequestAbortSignal,
  runWithoutRequestAbortSignal,
} from "../common/requestAbort.ts";
import { getGpuAcceleration } from "./gpuAcceleration.ts";

const MAX_CAPTURED_LOG_CHARS = 64_000;

export const appendWithLimit = (current: string, chunk: string): string => {
  if (chunk.length >= MAX_CAPTURED_LOG_CHARS) {
    return chunk.slice(-MAX_CAPTURED_LOG_CHARS);
  }
  const combined = current + chunk;
  return combined.length > MAX_CAPTURED_LOG_CHARS
    ? combined.slice(combined.length - MAX_CAPTURED_LOG_CHARS)
    : combined;
};

export const pipeChildProcessLogs = (
  child: ReturnType<typeof spawn>,
  onCapturedStderr: (chunk: string) => void,
) => {
  child.stdout?.on("data", () => {});

  child.stderr?.on("data", (data) => {
    onCapturedStderr(data.toString());
  });
};

/** Generates a video preview and caches the result. Returns the cached file path. */
export const generateVideoPreview = async (
  filePath: string,
  height: StandardHeight = 320,
  durationMS: number = 5_000,
  _opts?: { priority?: ConversionPriority },
): Promise<string> => {
  await stat(filePath);
  const durationSeconds = Math.round(durationMS / 1000);
  const cachedPath = getMirroredCachedFilePath(
    filePath,
    `preview.${height}.${durationSeconds}s.audio`,
    "mp4",
  );

  if (
    await access(cachedPath).then(
      () => true,
      () => false,
    )
  ) {
    return cachedPath;
  }
  await scheduleMediaConversion(
    `video-preview:${cachedPath}`,
    async (signal) => {
      if (
        await access(cachedPath).then(
          () => true,
          () => false,
        )
      ) {
        return;
      }

      await mkdir(dirname(cachedPath), { recursive: true });
      const gpu = await getGpuAcceleration();
      await new Promise<void>((resolve, reject) => {
        const args = [
          "-y",
          ...(gpu ? gpu.hwaccelArgs : []),
          "-ss",
          "00:00:00",
          "-i",
          filePath,
          "-t",
          `${durationMS / 1000}`,
          "-vf",
          `scale=-2:${height === "original" ? -1 : height}`,
          "-c:v",
          gpu ? gpu.h264Codec : "libx264",
          ...(gpu ? gpu.cqArgs(23) : ["-preset", "fast", "-crf", "23"]),
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          "-movflags",
          "+faststart",
          cachedPath,
        ];

        const process = spawn("ffmpeg", args);
        const abortBinding = bindChildProcessAbort(process, signal);

        let stderr = "";

        pipeChildProcessLogs(process, (chunk) => {
          stderr = appendWithLimit(stderr, chunk);
        });

        process.on("close", (code) => {
          abortBinding.cleanup();
          if (abortBinding.wasAborted()) {
            reject(createAbortError());
            return;
          }
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`Video preview generation failed: ${stderr}`));
        });

        process.on("error", (error) => {
          abortBinding.cleanup();
          if (abortBinding.wasAborted()) {
            reject(createAbortError());
            return;
          }
          reject(error);
        });
      });
    },
    {
      signal: getRequestAbortSignal(),
    },
  );
  return cachedPath;
};

/** Generates a static image thumbnail from the video and caches the result. Returns the cached file path. */
export const generateVideoThumbnail = async (
  filePath: string,
  height: StandardHeight = 320,
  _opts?: { priority?: ConversionPriority },
): Promise<string> => {
  await stat(filePath);
  const cachedPath = getMirroredCachedFilePath(filePath, height, "jpg");

  if (
    await access(cachedPath).then(
      () => true,
      () => false,
    )
  ) {
    return cachedPath;
  }

  // A single cheap frame-extract that populates a cache shared by every future
  // viewer of this video — let it run to completion even if the requester that
  // triggered it disconnects (e.g. a grid card scrolling out of view mid-decode
  // for a large/slow-to-decode file), otherwise the thumbnail can never win the
  // race and gets regenerated-and-aborted on every subsequent view.
  await runWithoutRequestAbortSignal(() =>
    scheduleMediaConversion(`video-thumbnail:${cachedPath}`, async (signal) => {
      if (
        await access(cachedPath).then(
          () => true,
          () => false,
        )
      ) {
        return;
      }

      const gpu = await getGpuAcceleration();

      const generateWithMode = async (useHardware: boolean): Promise<void> => {
        await mkdir(dirname(cachedPath), { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const args = [
            "-y",
            ...(useHardware && gpu ? gpu.hwaccelArgs : []),
            "-ss",
            "00:00:00",
            "-i",
            filePath,
            "-vframes",
            "1",
            "-vf",
            `scale=-2:${height === "original" ? -1 : height}`,
            cachedPath,
          ];

          const process = spawn("ffmpeg", args);
          const abortBinding = bindChildProcessAbort(process, signal);

          let stderr = "";

          pipeChildProcessLogs(process, (chunk) => {
            stderr = appendWithLimit(stderr, chunk);
          });

          process.on("close", (code) => {
            abortBinding.cleanup();
            if (abortBinding.wasAborted()) {
              reject(createAbortError());
              return;
            }
            if (code === 0) {
              resolve();
              return;
            }

            if (useHardware && gpu?.isHardwareFailure(stderr)) {
              generateWithMode(false).then(resolve).catch(reject);
              return;
            }

            reject(new Error(`Video thumbnail generation failed: ${stderr}`));
          });

          process.on("error", (error) => {
            abortBinding.cleanup();
            if (abortBinding.wasAborted()) {
              reject(createAbortError());
              return;
            }
            reject(error);
          });
        });
      };

      await generateWithMode(gpu !== null);
    }),
  );
  return cachedPath;
};

/**
 * How many still frames make up the hover/scrub preview strip (feedback
 * #76). The original ask was true 15fps scrubbing, which would mean
 * decoding the whole video on every hover — not worth it on this host's
 * weak CPU (see AGENTS.md's HLS-transcode notes on LXC 124's iGPU-only
 * headroom). This ships the scoped-down version the feedback itself
 * flagged as acceptable: a handful of low-res frames extracted and cached
 * once at generation time (same pattern as generateVideoThumbnail's single
 * frame), then cycled client-side as the pointer moves across the tile —
 * "coarse scrubbing", not true per-frame decode.
 */
export const VIDEO_SCRUB_FRAME_COUNT: number = 5;

/** Resolution for scrub frames — matches the feedback's own "160p" suggestion. */
export const VIDEO_SCRUB_HEIGHT = 160;

/**
 * Generates (or returns already-cached) the scrub-preview frame at `index`
 * (0-based, < VIDEO_SCRUB_FRAME_COUNT). Each frame is a fast `-ss` seek, as
 * cheap as the existing single-frame thumbnail, and cached individually so a
 * repeat request for any one frame is free. Frames are spread across the
 * middle 80% of the video's duration (10%..90%) to skip black lead-in/
 * fade-out. `durationSeconds` comes from the caller (the `files.duration`
 * column, already populated by the EXIF scan) rather than an extra ffprobe
 * call here — this file stays a pure "run ffmpeg, cache the result" layer.
 */
export const generateVideoScrubFrame = async (
  filePath: string,
  index: number,
  durationSeconds: number,
  _opts?: { priority?: ConversionPriority },
): Promise<string | null> => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  await stat(filePath);
  const cachedPath = getMirroredCachedFilePath(
    filePath,
    `scrub.${index}.${VIDEO_SCRUB_HEIGHT}`,
    "jpg",
  );

  if (
    await access(cachedPath).then(
      () => true,
      () => false,
    )
  ) {
    return cachedPath;
  }

  const duration = durationSeconds;
  const offsetSeconds =
    VIDEO_SCRUB_FRAME_COUNT === 1
      ? duration / 2
      : duration * (0.1 + (0.8 * index) / (VIDEO_SCRUB_FRAME_COUNT - 1));

  await runWithoutRequestAbortSignal(() =>
    scheduleMediaConversion(`video-scrub:${cachedPath}`, async (signal) => {
      if (
        await access(cachedPath).then(
          () => true,
          () => false,
        )
      ) {
        return;
      }

      const gpu = await getGpuAcceleration();

      const generateWithMode = async (useHardware: boolean): Promise<void> => {
        await mkdir(dirname(cachedPath), { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const args = [
            "-y",
            ...(useHardware && gpu ? gpu.hwaccelArgs : []),
            "-ss",
            offsetSeconds.toFixed(2),
            "-i",
            filePath,
            "-vframes",
            "1",
            "-vf",
            `scale=-2:${VIDEO_SCRUB_HEIGHT}`,
            cachedPath,
          ];

          const process = spawn("ffmpeg", args);
          const abortBinding = bindChildProcessAbort(process, signal);

          let stderr = "";

          pipeChildProcessLogs(process, (chunk) => {
            stderr = appendWithLimit(stderr, chunk);
          });

          process.on("close", (code) => {
            abortBinding.cleanup();
            if (abortBinding.wasAborted()) {
              reject(createAbortError());
              return;
            }
            if (code === 0) {
              resolve();
              return;
            }

            if (useHardware && gpu?.isHardwareFailure(stderr)) {
              generateWithMode(false).then(resolve).catch(reject);
              return;
            }

            reject(new Error(`Video scrub frame generation failed: ${stderr}`));
          });

          process.on("error", (error) => {
            abortBinding.cleanup();
            if (abortBinding.wasAborted()) {
              reject(createAbortError());
              return;
            }
            reject(error);
          });
        });
      };

      await generateWithMode(gpu !== null);
    }),
  );
  return cachedPath;
};
