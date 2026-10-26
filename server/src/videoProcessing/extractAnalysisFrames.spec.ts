import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractAnalysisFrames,
  keyframeTimeoutMs,
  LONG_VIDEO_SECONDS,
  MAX_ANALYSIS_FRAMES,
  parseShowinfoTimes,
  planFrameSampling,
  selectEvenly,
} from "./extractAnalysisFrames.ts";

describe("planFrameSampling", () => {
  it("decodes keyframes of a short video", () => {
    expect(planFrameSampling(15)).toEqual({ mode: "keyframes" });
    expect(planFrameSampling(LONG_VIDEO_SECONDS)).toEqual({ mode: "keyframes" });
  });

  it("seeks through a long video, skipping the first and last 2%", () => {
    const plan = planFrameSampling(1_000);
    if (plan.mode !== "seek") throw new Error("expected seek");
    expect(plan.timesSeconds).toHaveLength(MAX_ANALYSIS_FRAMES);
    expect(plan.timesSeconds[0]).toBeCloseTo(20);
    expect(plan.timesSeconds.at(-1)).toBeCloseTo(980);
  });

  it("caps how much of a video of unknown length is read", () => {
    expect(planFrameSampling(undefined)).toEqual({
      mode: "keyframes",
      maxSeconds: LONG_VIDEO_SECONDS,
    });
    expect(planFrameSampling(0)).toEqual({
      mode: "keyframes",
      maxSeconds: LONG_VIDEO_SECONDS,
    });
  });
});

describe("selectEvenly", () => {
  it("keeps everything under the cap and spreads picks over it, ends included", () => {
    expect(selectEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(selectEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8], 3)).toEqual([0, 4, 8]);
    expect(selectEvenly([1, 2, 3], 1)).toEqual([1]);
  });
});

describe("parseShowinfoTimes", () => {
  it("reads pts_time from showinfo lines only", () => {
    const stderr = [
      "[Parsed_showinfo_3 @ 0x55] config in time_base: 1/15360",
      "[Parsed_showinfo_3 @ 0x55] n:   0 pts:      0 pts_time:0       duration: 512",
      "[mpdecimate @ 0x56] pts_time:9.9 drop_count:1",
      "[Parsed_showinfo_3 @ 0x55] n:   1 pts:  30720 pts_time:2.5     duration: 512",
    ].join("\n");
    expect(parseShowinfoTimes(stderr)).toEqual([0, 2.5]);
  });
});

describe("keyframeTimeoutMs", () => {
  it("scales with length between 2 and 15 minutes", () => {
    expect(keyframeTimeoutMs(10)).toBe(2 * 60_000);
    expect(keyframeTimeoutMs(300)).toBe(300_000);
    expect(keyframeTimeoutMs(10_000)).toBe(15 * 60_000);
    expect(keyframeTimeoutMs(undefined)).toBe(LONG_VIDEO_SECONDS * 1_000);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const describeWithFfmpeg = hasFfmpeg ? describe : describe.skip;

const ffmpeg = (args: string[]) => {
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...args,
  ]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
};

const frameSize = (file: string): { width: number; height: number } => {
  const out = spawnSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    file,
  ])
    .stdout.toString()
    .trim();
  const [width, height] = out.split(",").map(Number);
  return { width, height };
};

describeWithFfmpeg("extractAnalysisFrames (real ffmpeg)", () => {
  let root: string;
  let clip: string;
  let portrait: string;
  let outDir: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "photrix-frames-spec-"));
    clip = path.join(root, "clip.mp4");
    // 6 s of a still grey frame, then 6 s of moving test pattern, a keyframe
    // every second: 12 keyframes, half of them identical.
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=320x240:r=30:d=6",
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=320x240:r=30:d=6",
      "-filter_complex",
      "[0][1]concat=n=2:v=1",
      "-g",
      "30",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      clip,
    ]);
    // A phone held upright: landscape pixels plus a 90° display rotation.
    portrait = path.join(root, "portrait.mp4");
    ffmpeg(["-display_rotation", "90", "-i", clip, "-c", "copy", portrait]);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const freshOutDir = () => {
    outDir = mkdtempSync(path.join(root, "out-"));
    return outDir;
  };

  it("keeps changing keyframes, drops the still stretch, and times every frame", async () => {
    const frames = await extractAnalysisFrames(clip, 12, freshOutDir());

    const times = frames.map((f) => f.timeMs);
    expect(times[0]).toBe(0);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // The grey half collapses to (about) one frame; the moving half survives.
    expect(times.filter((t) => t < 6_000).length).toBeLessThanOrEqual(2);
    expect(times.filter((t) => t >= 6_000).length).toBeGreaterThanOrEqual(5);
    for (const t of times) expect(t % 1_000).toBe(0);
    // Each frame stands for itself up to the next one that changed, and the
    // last for the rest of the clip, so the windows tile it without a gap.
    expect(frames[0].startMs).toBe(0);
    frames.slice(1).forEach((f, i) => expect(frames[i].endMs).toBe(f.startMs));
    expect(frames.every((f) => f.startMs === f.timeMs)).toBe(true);
    expect(frames.at(-1)!.endMs).toBe(12_000);
    // Every returned frame exists, and nothing else is left behind.
    expect(readdirSync(outDir).sort()).toEqual(
      frames.map((f) => path.basename(f.path)).sort(),
    );
  });

  it("hands over portrait video upright, as it plays", async () => {
    const frames = await extractAnalysisFrames(portrait, 12, freshOutDir());
    expect(frames.length).toBeGreaterThan(0);
    expect(frameSize(frames[0].path)).toEqual({ width: 240, height: 320 });
  });

  it("seeks through a long video and treats a seek past the end as no frame, not an error", async () => {
    // Claim 200 s so the clip is sampled by seeking; only seeks inside its
    // real 12 s can produce a frame.
    const frames = await extractAnalysisFrames(clip, 200, freshOutDir());
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.timeMs < 12_000)).toBe(true);
    // A seek stands for halfway to its neighbours on the planned grid.
    const spacing = (200 * 0.96) / (MAX_ANALYSIS_FRAMES - 1);
    expect(frames[0].startMs).toBe(0);
    expect(frames[0].endMs).toBe(Math.round((4 + spacing / 2) * 1_000));
    for (const f of frames)
      expect(f.startMs <= f.timeMs && f.timeMs <= f.endMs).toBe(true);
  }, 60_000);

  it("times every frame of a long keyframe run, past the 64 KB stderr cap", async () => {
    // 175 keyframes of moving pattern: showinfo writes well over 64 KB, which
    // once cost the first frames their timestamps (and failed the video).
    const long = path.join(root, "long.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=96x64:r=10:d=175",
      "-g",
      "10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      long,
    ]);
    const frames = await extractAnalysisFrames(long, 175, freshOutDir());
    expect(frames).toHaveLength(MAX_ANALYSIS_FRAMES);
    expect(frames[0].timeMs).toBe(0);
    expect(frames.at(-1)!.timeMs).toBeGreaterThan(170_000);
    // Thinned to 24, each kept frame still stands only for its own stretch,
    // up to the next keyframe; the gaps are what collapseFaceTracks bridges.
    expect(frames[0].endMs).toBe(1_000);
    expect(frames.at(-1)!.endMs).toBe(175_000);
  }, 60_000);

  it("throws when the file isn't a video", async () => {
    const bogus = path.join(root, "bogus.mp4");
    writeFileSync(bogus, "not a video");
    await expect(extractAnalysisFrames(bogus, 5, freshOutDir())).rejects.toThrow(
      /ffmpeg/,
    );
  });
});
