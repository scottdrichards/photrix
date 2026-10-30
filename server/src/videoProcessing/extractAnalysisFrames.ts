import { spawn } from "child_process";
import { readdir, rm } from "fs/promises";
import path from "path";
import { getGpuAcceleration } from "./gpuAcceleration.ts";
import { appendWithLimit } from "./videoUtils.ts";

/**
 * Picks a handful of frames out of a video for face detection.
 *
 * Running the detector on every frame would cost hours per video, and almost
 * every frame repeats its neighbour. So the frames are chosen cheaply, before
 * any model sees them:
 *
 * - **Short videos** (up to {@link LONG_VIDEO_SECONDS}) decode only their
 *   keyframes (`-skip_frame nokey`), which skips nearly all of the decode
 *   work. A video without B-frames also reads only them (`-discard:v nokey`):
 *   the container's index says where each keyframe is, so the demuxer skips
 *   the bytes between them, 90 %+ of a phone clip (see
 *   {@link reordersFrames} for why not with B-frames). Keyframes closer than
 *   {@link MIN_FRAME_SPACING_SECONDS}
 *   are dropped, then `mpdecimate` drops any frame that barely differs from
 *   the last one kept, so a tripod shot of a still scene shrinks to a frame or
 *   two.
 * - **Long videos** are sampled at evenly spaced seeks instead, each landing on
 *   the keyframe before its target rather than decoding up to the exact frame.
 *   Each seek reads only a few MB near that point, so a 40 GB recording off
 *   the media share costs {@link MAX_ANALYSIS_FRAMES} small reads rather than
 *   the whole file, and {@link SEEK_CONCURRENCY} run at once.
 *
 * Decoding is on the GPU when there is one: `-hwaccel` with the frames copied
 * back to memory, which keeps ffmpeg's auto-rotate working, so portrait video
 * still comes out upright, the way it plays (frames kept *on* the GPU are
 * where auto-rotate does nothing). A codec the GPU can't decode silently
 * decodes on the CPU, and a GPU failure retries on the CPU.
 */

/**
 * The file itself can't be read as video: truncated (an iPhone clip copied
 * before it finished has no `moov` atom), not a container ffmpeg knows, or
 * holding nothing it can decode, like Apple's 1 fps still-image streams.
 * Retrying can't help until the file changes on disk, and a change on disk
 * resyncs the file, which clears the mark and queues it again.
 */
export class VideoUnreadableError extends Error {}

/** ffmpeg can't open the input as media at all. */
const UNREADABLE_INPUT =
  /moov atom not found|Invalid data found when processing input|does not contain any stream/i;
/**
 * ffmpeg opened the input but decoded nothing. Only a verdict on the file when
 * reading from the start: a seek past the end says exactly the same thing.
 */
const NOTHING_DECODED = /Output file is empty|Nothing was written into output file/i;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Rethrows a keyframe-mode ffmpeg failure, as {@link VideoUnreadableError}
 * when the file is at fault.
 */
const classifyKeyframeError = (error: unknown): never => {
  const message = messageOf(error);
  if (UNREADABLE_INPUT.test(message) || NOTHING_DECODED.test(message)) {
    throw new VideoUnreadableError(message);
  }
  throw error;
};

/** Longer than this, sample by seeking rather than decoding every keyframe. */
export const LONG_VIDEO_SECONDS = 180;
/** At most this many frames per video reach the face detector. */
export const MAX_ANALYSIS_FRAMES = 24;
/** Two frames this close together are near-certain to show the same faces. */
const MIN_FRAME_SPACING_SECONDS = 1;
/**
 * Long edge of each extracted frame. The detector works at 640px, and the
 * Python worker caps any decode at 2048, so more pixels would only cost
 * disk and decode time.
 */
const FRAME_LONG_EDGE = 1920;
/** Ample for a one-frame seek, short enough that a wedged read can't hold the queue. */
const SEEK_TIMEOUT_MS = 2 * 60_000;
/**
 * Seeks in flight at once. Each mostly waits on the media share, and three at
 * once halved a long video's time (2026-10-27).
 */
const SEEK_CONCURRENCY = 3;
/**
 * A video longer than this that gives at most one keyframe through its index
 * is read again, every frame: its index may mark fewer keyframes than the
 * stream holds. A shorter one is believable as a single still scene.
 */
const RECHECK_INDEX_SECONDS = 10;
/** ffprobe reads only the header and index. */
const PROBE_TIMEOUT_MS = 30_000;

export type AnalysisFrame = {
  /** JPEG on disk, inside the caller's `outDir`. */
  path: string;
  /** Offset into the video, ms from the start. */
  timeMs: number;
  /**
   * The stretch of video this frame stands for, so whoever is in it can be
   * said to be on screen for that long. A keyframe stands for itself and the
   * near-duplicates `mpdecimate` dropped after it: from its own time to the
   * next keyframe that changed. A seek stands for halfway to its neighbours.
   */
  startMs: number;
  endMs: number;
};

type FramePlan =
  { mode: "keyframes"; maxSeconds?: number } | { mode: "seek"; timesSeconds: number[] };

/**
 * How to sample a video of this length. An unknown duration decodes keyframes
 * but stops reading after {@link LONG_VIDEO_SECONDS}, so a huge file whose
 * length the EXIF pass couldn't read still can't be streamed end to end.
 */
export const planFrameSampling = (durationSeconds: number | undefined): FramePlan => {
  if (
    durationSeconds === undefined ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return { mode: "keyframes", maxSeconds: LONG_VIDEO_SECONDS };
  }
  if (durationSeconds <= LONG_VIDEO_SECONDS) return { mode: "keyframes" };
  // 2%..98% skips a black lead-in and fade-out.
  const count = MAX_ANALYSIS_FRAMES;
  const timesSeconds = Array.from(
    { length: count },
    (_, i) => durationSeconds * (0.02 + (0.96 * i) / (count - 1)),
  );
  return { mode: "seek", timesSeconds };
};

/** Up to `max` items spread evenly across `items`, always keeping the first. */
export const selectEvenly = <T>(items: readonly T[], max: number): T[] => {
  if (items.length <= max) return [...items];
  if (max <= 0) return [];
  if (max === 1) return [items[0]];
  return Array.from(
    { length: max },
    (_, i) => items[Math.round((i * (items.length - 1)) / (max - 1))],
  );
};

/**
 * The `pts_time` of every frame `showinfo` reported, in output order. Each
 * output JPEG is one of these frames, so the nth value is the nth file's time.
 */
const SHOWINFO_TIME = /^\[Parsed_showinfo[^\]]*\][^\n]*?\bpts_time:\s*(-?[\d.]+)/;

/** The `pts_time` on one stderr line, or null when it isn't a showinfo frame line. */
const showinfoTime = (line: string): number | null => {
  const match = SHOWINFO_TIME.exec(line);
  return match ? Number(match[1]) : null;
};

export const parseShowinfoTimes = (stderr: string): number[] =>
  stderr
    .split(/\r?\n|\r/)
    .map(showinfoTime)
    .filter((time): time is number => time !== null);

/** Scales the long edge down to FRAME_LONG_EDGE, never up. */
const SCALE_FILTER =
  `scale='if(gte(iw,ih),min(${FRAME_LONG_EDGE},iw),-2)':` +
  `'if(gte(iw,ih),-2,min(${FRAME_LONG_EDGE},ih))'`;

/**
 * Keyframes long enough apart, minus near-duplicates. `select` runs first
 * because it is cheaper than `mpdecimate`'s block comparison. `showinfo` comes
 * last, so it reports exactly the frames that are written out.
 */
const KEYFRAME_FILTER = [
  `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${MIN_FRAME_SPACING_SECONDS})'`,
  SCALE_FILTER,
  "mpdecimate",
  "showinfo",
].join(",");

/**
 * Scales with the video's length, because the whole file is read: one second
 * of wall time per second of video, between 2 and 15 minutes.
 */
export const keyframeTimeoutMs = (durationSeconds: number | undefined): number => {
  const seconds =
    durationSeconds && Number.isFinite(durationSeconds)
      ? durationSeconds
      : LONG_VIDEO_SECONDS;
  // Whole ms: spawn rejects a fractional timeout outright, and 150.33 s of
  // video is 150330.00000000003 ms.
  return Math.round(Math.min(15 * 60_000, Math.max(2 * 60_000, seconds * 1_000)));
};

/**
 * `onStderrLine` sees every line as it arrives. The returned/thrown stderr is
 * capped at 64 KB, which showinfo outgrows: it writes a few hundred bytes per
 * frame (more with HDR side data), so a 50-frame clip loses its first frames'
 * times. Anything that must see every line has to read them here.
 */
const runFfmpeg = (
  args: string[],
  timeoutMs: number,
  onStderrLine?: (line: string) => void,
): Promise<string> =>
  new Promise((resolve, reject) => {
    // Two threads: this is background work on a box that serves the site.
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-nostdin", "-threads", "2", ...args],
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
    );
    let stderr = "";
    let partialLine = "";
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = appendWithLimit(stderr, text);
      if (!onStderrLine) return;
      const lines = (partialLine + text).split(/\r?\n|\r/);
      partialLine = lines.pop() ?? "";
      lines.forEach(onStderrLine);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (partialLine) onStderrLine?.(partialLine);
      if (code === 0) resolve(stderr);
      else
        reject(
          new Error(
            `ffmpeg ${signal ? `killed by ${signal}` : `exited ${code}`}: ${stderr.slice(-2_000)}`,
          ),
        );
    });
  });

/**
 * Runs `attempt` with GPU decode arguments, and again with none when the GPU
 * is what failed. A codec the GPU can't decode never gets here: ffmpeg decodes
 * it on the CPU by itself.
 */
const withDecoder = async <T>(
  attempt: (decodeArgs: readonly string[]) => Promise<T>,
): Promise<T> => {
  const gpu = await getGpuAcceleration();
  if (!gpu) return attempt([]);
  try {
    return await attempt(gpu.hwaccelArgs);
  } catch (error) {
    if (!gpu.isHardwareFailure(messageOf(error))) throw error;
    return attempt([]);
  }
};

/**
 * Writes the frames to `outDir` (which must exist and be empty) and returns
 * them in time order. An empty list means ffmpeg ran but found no frame, which
 * is a property of the file, not a failure. Throws when ffmpeg fails.
 */
export const extractAnalysisFrames = async (
  videoPath: string,
  durationSeconds: number | undefined,
  outDir: string,
): Promise<AnalysisFrame[]> => {
  const plan = planFrameSampling(durationSeconds);
  if (plan.mode === "keyframes") {
    return extractKeyframes(videoPath, durationSeconds, plan.maxSeconds, outDir);
  }

  const { frames, lastError } = await extractBySeeking(
    videoPath,
    plan.timesSeconds,
    durationSeconds ?? 0,
    outDir,
  );
  if (frames.length > 0) return frames;
  if (lastError && UNREADABLE_INPUT.test(messageOf(lastError))) {
    throw new VideoUnreadableError(messageOf(lastError));
  }
  // Every seek missed. The stored length can be wrong (far longer than the
  // stream), and then every seek lands past the end, which ffmpeg reports just
  // like a file with nothing in it. Read from the start instead, capped like a
  // video of unknown length: a real video still gives frames, and only one
  // that gives nothing from the start is unreadable.
  return extractKeyframes(videoPath, undefined, LONG_VIDEO_SECONDS, outDir);
};

/** The input's own length from ffmpeg's banner ("Duration: 00:01:02.50"). */
const DURATION_LINE = /^\s*Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

export const bannerDurationSeconds = (line: string): number | null => {
  const match = DURATION_LINE.exec(line);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
};

/** `count` tasks, at most `limit` at a time; results in task order. */
const inPool = async <T>(
  count: number,
  limit: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> => {
  const results: T[] = new Array<T>(count);
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const index = next++;
      results[index] = await task(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return results;
};

const extractBySeeking = async (
  videoPath: string,
  times: readonly number[],
  durationSeconds: number,
  outDir: string,
): Promise<{ frames: AnalysisFrame[]; lastError: Error | null }> => {
  // Halfway to each neighbour, from the planned grid: a failed seek leaves a
  // hole rather than stretching its neighbours over what nobody looked at.
  const halfway = (a: number, b: number) => Math.round(((a + b) / 2) * 1_000);
  let lastError: Error | null = null;

  /** The time of the frame actually written, or null when there was none. */
  const seek = async (index: number): Promise<number | null> => {
    const framePath = path.join(outDir, `s${String(index).padStart(4, "0")}.jpg`);
    // Set from ffmpeg's output, in a callback; `as` keeps them from narrowing to null.
    let frameSeconds = null as number | null;
    let realSeconds = null as number | null;
    try {
      await withDecoder((decodeArgs) => {
        frameSeconds = null;
        realSeconds = null;
        return runFfmpeg(
          [
            ...decodeArgs,
            // The keyframe before the target, not the exact frame: an exact
            // seek decodes everything from that keyframe on, and one frame in
            // a second makes no difference to who is in the video.
            "-skip_frame",
            "nokey",
            "-noaccurate_seek",
            "-ss",
            times[index].toFixed(3),
            // So showinfo reports where the frame really is. A face crop seeks
            // to that time exactly, so it must be the frame's, not the plan's.
            "-copyts",
            "-i",
            videoPath,
            "-an",
            "-sn",
            "-dn",
            "-frames:v",
            "1",
            "-vf",
            `${SCALE_FILTER},showinfo`,
            "-q:v",
            "3",
            "-update",
            "1",
            "-y",
            framePath,
          ],
          SEEK_TIMEOUT_MS,
          (line) => {
            frameSeconds ??= showinfoTime(line);
            realSeconds ??= bannerDurationSeconds(line);
          },
        );
      });
    } catch (error) {
      // A seek past the last decodable frame fails ("Could not open encoder
      // before EOF") rather than writing nothing, and the stored duration is
      // sometimes longer than the stream. One bad seek costs one frame.
      // runFfmpeg only rejects with an Error.
      lastError = error as Error;
      return null;
    }
    const written = (await readdir(outDir)).includes(path.basename(framePath));
    // A seek past the end lands on the last keyframe rather than failing, so
    // a stored length far longer than the stream would give one frame from its
    // end. Past the file's own length is a miss, as an exact seek made it.
    const pastEnd = realSeconds !== null && times[index] > realSeconds;
    if (written && (frameSeconds === null || pastEnd)) {
      await rm(framePath, { force: true });
      return null;
    }
    return written ? frameSeconds : null;
  };

  const landed = await inPool(times.length, SEEK_CONCURRENCY, seek);
  const frames: AnalysisFrame[] = [];
  for (const [index, seconds] of landed.entries()) {
    if (seconds === null) continue;
    const timeMs = Math.max(0, Math.round(seconds * 1_000));
    const framePath = path.join(outDir, `s${String(index).padStart(4, "0")}.jpg`);
    // Two seeks inside one long GOP land on the same keyframe.
    if (frames.at(-1)?.timeMs === timeMs) {
      await rm(framePath, { force: true });
      continue;
    }
    const startMs = index === 0 ? 0 : halfway(times[index - 1], times[index]);
    const endMs =
      index === times.length - 1
        ? Math.round(durationSeconds * 1_000)
        : halfway(times[index], times[index + 1]);
    frames.push({
      path: framePath,
      timeMs,
      startMs: Math.min(startMs, timeMs),
      endMs: Math.max(endMs, timeMs),
    });
  }
  return { frames, lastError };
};

/**
 * Whether the video reorders frames (has B-frames). Reading only the indexed
 * keyframes of such a video (`-discard:v nokey`) mis-times them in ffmpeg
 * 7.1's MP4 demuxer: it steps through the per-sample display offsets (`ctts`)
 * once per packet it hands over, not per sample it skips, so each keyframe
 * after the first gets another sample's offset and lands a frame or two off.
 * The frames are right, their times are not, and a face crop seeks to that
 * time. 10 of 25 library clips have B-frames (2026-10-27); all 10 were
 * mis-timed, the 15 without were exact. Unknown counts as reordering.
 */
const reordersFrames = (videoPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=has_b_frames",
        "-of",
        "csv=p=0",
        videoPath,
      ],
      { timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL" },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", () => {});
    child.on("error", () => resolve(true));
    child.on("close", (code) =>
      resolve(code !== 0 || /^\s*(\d+)/.exec(out)?.[1] !== "0"),
    );
  });

const extractKeyframes = async (
  videoPath: string,
  durationSeconds: number | undefined,
  maxSeconds: number | undefined,
  outDir: string,
): Promise<AnalysisFrame[]> => {
  const readAll = () =>
    readKeyframes(videoPath, durationSeconds, maxSeconds, outDir, false).catch(
      classifyKeyframeError,
    );
  if (await reordersFrames(videoPath)) return readAll();
  let frames: AnalysisFrame[];
  try {
    frames = await readKeyframes(videoPath, durationSeconds, maxSeconds, outDir, true);
  } catch (error) {
    // Nothing decoded from the indexed keyframes alone: only a verdict on the
    // file once every frame has been read too.
    if (!NOTHING_DECODED.test(messageOf(error))) return classifyKeyframeError(error);
    return readAll();
  }
  const length = durationSeconds ?? maxSeconds ?? 0;
  if (frames.length <= 1 && length > RECHECK_INDEX_SECONDS) {
    // The index can mark fewer keyframes than the stream holds (it lists only
    // what the muxer called a sync sample), and a frame or none from a video
    // this long may be that rather than a still scene. Read every frame.
    return readAll();
  }
  return frames;
};

const clearFrames = async (outDir: string) => {
  const names = (await readdir(outDir)).filter((name) => /^k\d+\.jpg$/.test(name));
  await Promise.all(names.map((name) => rm(path.join(outDir, name), { force: true })));
};

/**
 * Decodes the keyframes. `indexedOnly` reads only those the container's index
 * marks, skipping the bytes between them; otherwise every frame is read and
 * the decoder picks out the keyframes.
 */
const readKeyframes = async (
  videoPath: string,
  durationSeconds: number | undefined,
  maxSeconds: number | undefined,
  outDir: string,
  indexedOnly: boolean,
): Promise<AnalysisFrame[]> => {
  let times: number[] = [];
  await withDecoder(async (decodeArgs) => {
    // A GPU attempt that failed part way may have left frames behind.
    times = [];
    await clearFrames(outDir);
    return runFfmpeg(
      [
        ...decodeArgs,
        ...(indexedOnly ? ["-discard:v", "nokey"] : []),
        "-skip_frame",
        "nokey",
        ...(maxSeconds ? ["-t", String(maxSeconds)] : []),
        "-i",
        videoPath,
        "-an",
        "-sn",
        "-dn",
        "-vf",
        KEYFRAME_FILTER,
        "-fps_mode",
        "vfr",
        "-q:v",
        "3",
        "-y",
        path.join(outDir, "k%05d.jpg"),
      ],
      keyframeTimeoutMs(durationSeconds),
      (line) => {
        const time = showinfoTime(line);
        if (time !== null) times.push(time);
      },
    );
  });

  const files = (await readdir(outDir)).filter((name) => /^k\d+\.jpg$/.test(name)).sort();
  if (times.length !== files.length) {
    // Without a time per file the boxes can't be tied to a frame, and a face
    // crop would come from the wrong moment. Fail loudly rather than guess.
    throw new Error(
      `ffmpeg wrote ${files.length} frames but reported ${times.length} timestamps`,
    );
  }
  const frameTimes = times.map((time) => Math.max(0, Math.round(time * 1_000)));
  // The last frame runs to the end of the video. With no known length (or a
  // `-t` cap), it gets the minimum spacing, the least it can stand for.
  const lastEndMs =
    maxSeconds === undefined && durationSeconds
      ? Math.round(durationSeconds * 1_000)
      : (frameTimes.at(-1) ?? 0) + MIN_FRAME_SPACING_SECONDS * 1_000;
  const all: AnalysisFrame[] = files.map((name, i) => ({
    path: path.join(outDir, name),
    timeMs: frameTimes[i],
    startMs: frameTimes[i],
    endMs: Math.max(
      frameTimes[i],
      i + 1 < frameTimes.length ? frameTimes[i + 1] : lastEndMs,
    ),
  }));
  const kept = selectEvenly(all, MAX_ANALYSIS_FRAMES);
  const keptPaths = new Set(kept.map((frame) => frame.path));
  await Promise.all(
    all
      .filter((frame) => !keptPaths.has(frame.path))
      .map((frame) => rm(frame.path, { force: true })),
  );
  return kept;
};
