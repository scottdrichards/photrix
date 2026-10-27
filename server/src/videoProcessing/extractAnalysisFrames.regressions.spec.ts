import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROKEN_VIDEO_KINDS,
  breakVideo,
  ffmpeg,
  hasFfmpeg,
  indexOnlyFirstKeyframe,
  makeClip,
  type BrokenVideoKind,
} from "./brokenVideos.fixture.ts";
import {
  extractAnalysisFrames,
  keyframeTimeoutMs,
  LONG_VIDEO_SECONDS,
  MAX_ANALYSIS_FRAMES,
  VideoUnreadableError,
} from "./extractAnalysisFrames.ts";

/**
 * Frame extraction against inputs that broke it on the real library. Each
 * case is a reproduction, not a guess: the file is made by breaking a fresh
 * copy of a generated clip (brokenVideos.fixture.ts) the way the real file
 * was broken. The everyday behaviour lives in extractAnalysisFrames.spec.ts.
 */
const describeWithFfmpeg = hasFfmpeg ? describe : describe.skip;

describeWithFfmpeg("extractAnalysisFrames regressions", () => {
  let root: string;
  let sources: { indexLast: string; indexFirst: string };
  let n = 0;
  const outDir = () => mkdtempSync(path.join(root, `out${n++}-`));

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "photrix-broken-videos-"));
    sources = {
      indexLast: makeClip(root, "index-last.mp4"),
      indexFirst: makeClip(root, "index-first.mp4", { faststart: true }),
    };
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // 2026-10-26: 52 broken iPhone files counted as retryable failures, five in
  // a row stopped the whole video-face run. They must say "unreadable" instead,
  // in both sampling modes: a known short length decodes keyframes, a long one
  // seeks, and no known length (what these files have) decodes keyframes too.
  const kinds = Object.keys(BROKEN_VIDEO_KINDS) as BrokenVideoKind[];
  const lengths = [
    ["no known length", undefined],
    ["short", 4],
    ["long", LONG_VIDEO_SECONDS * 2],
  ] as const;

  for (const kind of kinds) {
    for (const [label, durationSeconds] of lengths) {
      it(`reports ${kind} as unreadable (${label})`, async () => {
        const source = kind === "blankFrames" ? sources.indexFirst : sources.indexLast;
        const broken = breakVideo(
          source,
          root,
          kind,
          `${kind}-${label.replace(/ /g, "-")}`,
        );
        const extraction = extractAnalysisFrames(broken, durationSeconds, outDir());
        await expect(extraction).rejects.toBeInstanceOf(VideoUnreadableError);
      }, 120_000);
    }
  }

  // Found while fixing the above: a seek past the end fails exactly like a
  // file with nothing in it ("Nothing was written into output file"). A
  // healthy video whose stored length is far too long must not be dropped as
  // unreadable: every seek misses, so extraction reads from the start instead.
  it("still finds frames in a healthy clip whose stored length is far too long", async () => {
    const frames = await extractAnalysisFrames(sources.indexLast, 600, outDir());
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].timeMs).toBe(0);
  }, 120_000);

  // 2026-10-27: reading only the keyframes the index marks (-discard:v nokey)
  // cut what a clip reads off the share by 90 %+, but trusts the index. One
  // that marks too few keyframes must not cost the video its faces.
  it("reads every frame when the index marks only the first keyframe", async () => {
    // Without B-frames, so the index alone is read (see the next case).
    const twelveSeconds = makeClip(root, "twelve.mp4", { seconds: 12, bFrames: false });
    const misleading = indexOnlyFirstKeyframe(twelveSeconds, root, "first-key-only");
    const honest = await extractAnalysisFrames(twelveSeconds, 12, outDir());
    const frames = await extractAnalysisFrames(misleading, 12, outDir());
    expect(honest.length).toBeGreaterThan(5);
    expect(frames.map((f) => f.timeMs)).toEqual(honest.map((f) => f.timeMs));
  }, 60_000);

  // 2026-10-27: reading only the indexed keyframes of a video with B-frames
  // mis-times them (an ffmpeg demuxer bug, see reordersFrames): a keyframe at
  // 3 s came back at 3.1 s, the next at 3.9 s, and the spacing filter then
  // dropped it. 10 of 25 library clips have B-frames. Their frames must keep
  // the times they play at, or a face crop seeks to the wrong frame.
  it("keeps every keyframe's true time in a video with B-frames", async () => {
    const withBFrames = makeClip(root, "b-frames.mp4", { seconds: 8 });
    const frames = await extractAnalysisFrames(withBFrames, 8, outDir());
    expect(frames.map((f) => f.timeMs)).toEqual([
      0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000,
    ]);
  }, 60_000);

  // 2026-10-27: 97 healthy videos of 2 to 3 minutes failed every try with
  // The value of timeout is out of range: the keyframe timeout scales with
  // the length, and a fractional length made it a fractional ms count, which
  // spawn rejects before ffmpeg ever runs.
  it("reads a video whose stored length is a fraction of a second", async () => {
    expect(Number.isInteger(keyframeTimeoutMs(150.3337))).toBe(true);
    const frames = await extractAnalysisFrames(sources.indexLast, 150.3337, outDir());
    expect(frames.length).toBeGreaterThan(0);
  });

  it("reads the unbroken sources, so the breaks are what fail", async () => {
    for (const source of Object.values(sources)) {
      expect((await extractAnalysisFrames(source, 4, outDir())).length).toBeGreaterThan(
        0,
      );
    }
  });

  // 2026-10-26: 4 of 14 real videos failed with "wrote N frames but reported
  // M timestamps". showinfo writes a few hundred bytes per frame, and the
  // 64 KB stderr buffer dropped the first frames' lines. 175 keyframes of
  // moving pattern write well over 64 KB.
  it("times every frame of a long keyframe run, past the 64 KB stderr cap", async () => {
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
    const frames = await extractAnalysisFrames(long, 175, outDir());
    expect(frames).toHaveLength(MAX_ANALYSIS_FRAMES);
    expect(frames[0].timeMs).toBe(0);
    expect(frames.at(-1)!.timeMs).toBeGreaterThan(170_000);
    // Thinned to 24, each kept frame still stands only for its own stretch,
    // up to the next keyframe; the gaps are what collapseFaceTracks bridges.
    expect(frames[0].endMs).toBe(1_000);
    expect(frames.at(-1)!.endMs).toBe(175_000);
  }, 60_000);
});
