import { spawn } from "child_process";
import { access, copyFile, mkdir, readdir, rename, rm, stat } from "fs/promises";
import { dirname, join } from "path";
import {
  STORYBOARD_FRAME_LONG_EDGE,
  planStoryboard,
  storyboardFrameTime,
  type StoryboardPlan,
} from "../../../shared/video-storyboard/src/index.ts";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import { scheduleMediaConversion } from "../common/mediaConversionScheduler.ts";
import { runWithoutRequestAbortSignal } from "../common/requestAbort.ts";
import { attempt } from "../common/result.ts";
import { getGpuAcceleration } from "./gpuAcceleration.ts";
import { appendWithLimit } from "./videoUtils.ts";

/**
 * A video's storyboard: one JPEG holding a grid of small frames spread evenly
 * through it, which the viewer shows while you drag through the video
 * (feedback #168). The layout comes from `shared/video-storyboard`, which the
 * client reads too.
 *
 * Each frame is its own short ffmpeg run that seeks to the keyframe before its
 * time and decodes only that one frame, on the GPU when there is one. Seeking
 * reads a few MB near each point instead of the whole file. Measured on this
 * project's dev host (Intel iGPU, 4K HEVC phone clips): 0.24–0.42 s per frame
 * on the GPU, 0.25–0.5 s on the CPU, against 5–8 s to decode every keyframe of
 * a 40-second clip in one pass. Three run at once, so a 40-second 4K clip (20
 * frames) takes about 2 s and an hour-long video (100 frames) 10–15 s. The
 * result is cached, so that happens once per video.
 *
 * HDR sources are not tonemapped here, unlike the grid thumbnails: libplacebo
 * would start a Vulkan context per frame, and these frames are on screen only
 * while a finger is dragging.
 */

const SEEK_CONCURRENCY = 3;
const SEEK_TIMEOUT_MS = 60_000;
const TILE_TIMEOUT_MS = 60_000;

/**
 * Scales the long edge to STORYBOARD_FRAME_LONG_EDGE, keeping the aspect
 * ratio, into the full-range YUV a JPEG holds. The encoder refuses the
 * limited-range frames a GPU decode hands back.
 */
const SCALE_FILTER =
  `scale='if(gte(iw,ih),${STORYBOARD_FRAME_LONG_EDGE},-2)':` +
  `'if(gte(iw,ih),-2,${STORYBOARD_FRAME_LONG_EDGE})':out_range=full,format=yuvj420p`;

const runFfmpeg = (args: string[], timeoutMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "2", ...args],
      { timeout: timeoutMs, killSignal: "SIGKILL", signal },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendWithLimit(stderr, chunk.toString());
    });
    child.on("error", reject);
    child.on("close", (code, killedBy) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `ffmpeg ${killedBy ? `killed by ${killedBy}` : `exited ${code}`}: ${stderr.slice(-2_000)}`,
          ),
        );
    });
  });

/** `count` tasks, at most `limit` at a time. */
const inPool = async (
  count: number,
  limit: number,
  task: (index: number) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const worker = async () => {
    while (next < count) await task(next++);
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
};

/** Lands on the keyframe before the time and decodes only that frame. */
const KEYFRAME_SEEK = ["-skip_frame", "nokey", "-noaccurate_seek"] as const;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const framePath = (dir: string, index: number) =>
  join(dir, `f${String(index).padStart(3, "0")}.jpg`);

/** Where the storyboard for this file and plan is cached. */
const storyboardCachePath = (filePath: string, plan: StoryboardPlan): string =>
  getMirroredCachedFilePath(
    filePath,
    `storyboard.v1.${plan.frames}x${Math.round(plan.intervalSeconds * 1000)}`,
    "jpg",
  );

/**
 * Writes one frame per planned time into `dir`. A frame that can't be found
 * either way (past the real end of a stream whose stored length is too long)
 * leaves a gap for fillFrameGaps.
 */
const extractFrames = async (
  filePath: string,
  plan: StoryboardPlan,
  durationSeconds: number,
  dir: string,
  signal: AbortSignal,
): Promise<Error | null> => {
  const gpu = await getGpuAcceleration();
  let lastError: Error | null = null;

  const seek = async (index: number) => {
    const out = framePath(dir, index);
    const seconds = storyboardFrameTime(plan, index, durationSeconds).toFixed(3);
    const args = (decodeArgs: readonly string[], seekArgs: readonly string[]) => [
      ...decodeArgs,
      ...seekArgs,
      "-ss",
      seconds,
      "-i",
      filePath,
      "-an",
      "-sn",
      "-dn",
      "-frames:v",
      "1",
      "-vf",
      SCALE_FILTER,
      "-q:v",
      "5",
      "-update",
      "1",
      "-y",
      out,
    ];
    const run = async (seekArgs: readonly string[]) => {
      let result = await attempt(
        runFfmpeg(args(gpu?.hwaccelArgs ?? [], seekArgs), SEEK_TIMEOUT_MS, signal),
      );
      if (!result.ok && gpu?.isHardwareFailure(result.error.message)) {
        result = await attempt(runFfmpeg(args([], seekArgs), SEEK_TIMEOUT_MS, signal));
      }
      if (!result.ok) lastError = result.error;
    };
    await run(KEYFRAME_SEEK);
    // A video with few keyframes (one at the start is not unusual) gives the
    // keyframe seek nothing to land on: ffmpeg succeeds and writes no frame.
    // Seeking exactly decodes from the keyframe before, which is slower but
    // finds the frame.
    if (!(await exists(out))) await run([]);
  };

  await inPool(plan.frames, SEEK_CONCURRENCY, seek);
  return lastError;
};

/**
 * Fills each missing frame with the nearest one before it (or after it, at
 * the start), so the tile filter sees an unbroken sequence and a scrub over a
 * gap shows something close. Returns how many frames were really decoded.
 */
export const fillFrameGaps = async (dir: string, frames: number): Promise<number> => {
  const present = new Set(await readdir(dir));
  const have = Array.from({ length: frames }, (_, i) =>
    present.has(framePath(dir, i).slice(dir.length + 1)),
  );
  const decoded = have.filter(Boolean).length;
  if (decoded === 0) return 0;
  for (let i = 0; i < frames; i++) {
    if (have[i]) continue;
    let source = -1;
    for (let back = i - 1; back >= 0 && source < 0; back--) if (have[back]) source = back;
    for (let ahead = i + 1; ahead < frames && source < 0; ahead++) if (have[ahead]) source = ahead;
    await copyFile(framePath(dir, source), framePath(dir, i));
  }
  return decoded;
};

/**
 * The storyboard for a video, built on first request and cached. Null when the
 * video's length is unknown. Throws when not a single frame could be decoded.
 */
export const generateVideoStoryboard = async (
  filePath: string,
  durationSeconds: number,
): Promise<string | null> => {
  const plan = planStoryboard(durationSeconds);
  if (!plan) return null;
  await stat(filePath);
  const cachedPath = storyboardCachePath(filePath, plan);
  if (await exists(cachedPath)) return cachedPath;

  await runWithoutRequestAbortSignal(() =>
    scheduleMediaConversion(`video-storyboard:${cachedPath}`, async (signal) => {
      if (await exists(cachedPath)) return;
      const workDir = `${cachedPath}.parts`;
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      try {
        const lastError = await extractFrames(filePath, plan, durationSeconds, workDir, signal);
        if ((await fillFrameGaps(workDir, plan.frames)) === 0) {
          throw new Error(
            `No storyboard frame could be decoded: ${lastError?.message ?? "no output"}`,
          );
        }
        const partial = `${cachedPath}.tmp.jpg`;
        await mkdir(dirname(cachedPath), { recursive: true });
        await runFfmpeg(
          [
            "-framerate",
            "1",
            "-start_number",
            "0",
            "-i",
            join(workDir, "f%03d.jpg"),
            "-vf",
            `tile=${plan.columns}x${plan.rows}`,
            "-frames:v",
            "1",
            "-q:v",
            "4",
            "-update",
            "1",
            "-y",
            partial,
          ],
          TILE_TIMEOUT_MS,
          signal,
        );
        // Renamed into place so a half-written sprite is never served.
        await rename(partial, cachedPath);
      } finally {
        // Best-effort cleanup of the per-frame scratch files.
        await rm(workDir, { recursive: true, force: true });
      }
    }),
  );
  return cachedPath;
};
