import { describe, it, expect } from "@jest/globals";
import { MAX_ANALYSIS_FRAMES } from "../videoProcessing/extractAnalysisFrames.ts";
import {
  createVideoFaceEta,
  orderVideoFaceQueue,
  RECENT_VIDEO_MS,
  predictVideoFaceCost,
  VIDEO_FACE_COST_PRIORS as P,
} from "./videoFaceCost.ts";

describe("predictVideoFaceCost", () => {
  it("prices a short clip by the bytes it reads and the frames it decodes", () => {
    const small = predictVideoFaceCost({ durationSeconds: 10, sizeBytes: 5e6 });
    const big = predictVideoFaceCost({
      durationSeconds: 10,
      sizeBytes: 500e6,
      width: 3840,
      height: 2160,
    });
    expect(big.extractMs - small.extractMs).toBeGreaterThan(495 * P.keyframeMsPerMB);
    expect(small.frames).toBe(8);
    expect(predictVideoFaceCost({ durationSeconds: 120 }).frames).toBe(
      MAX_ANALYSIS_FRAMES,
    );
  });

  it("prices a long video per seek, more for a higher bitrate, not per byte read", () => {
    const tenMinutes = 600;
    const low = predictVideoFaceCost({ durationSeconds: tenMinutes, sizeBytes: 1.5e9 });
    const high = predictVideoFaceCost({ durationSeconds: tenMinutes, sizeBytes: 7.5e9 });
    expect(low.frames).toBe(MAX_ANALYSIS_FRAMES);
    expect(high.extractMs).toBeGreaterThan(low.extractMs);
    // Five times the bytes is nowhere near five times the cost.
    expect(high.extractMs).toBeLessThan(low.extractMs * 3);
  });

  it("guesses a length from the size when none is stored, capped like the read", () => {
    const unknown = predictVideoFaceCost({ sizeBytes: 10e9 });
    const capped = predictVideoFaceCost({ durationSeconds: 180, sizeBytes: 10e9 });
    expect(unknown.extractMs).toBeLessThan(capped.extractMs);
    expect(unknown.frames).toBe(MAX_ANALYSIS_FRAMES);
  });
});

describe("createVideoFaceEta", () => {
  const clip = { durationSeconds: 20, sizeBytes: 100e6 };

  it("starts from the measured priors", () => {
    const eta = createVideoFaceEta(() => 0);
    const { extractMs, frames } = predictVideoFaceCost(clip);
    expect(eta.estimateMs([clip, clip])).toBeCloseTo(
      2 * (extractMs + frames * P.detectMsPerFrame),
    );
  });

  it("follows a run that is slower than the priors", () => {
    const eta = createVideoFaceEta(() => 0);
    const { extractMs, frames } = predictVideoFaceCost(clip);
    for (let i = 0; i < 60; i++) {
      eta.record(clip, { extractMs: extractMs * 3, detectMs: frames * 1_000, frames });
    }
    const { extractScale, detectMsPerFrame } = eta.snapshot();
    expect(extractScale).toBeGreaterThan(2.8);
    expect(detectMsPerFrame).toBeGreaterThan(950);
  });

  it("is not thrown far by one stalled video", () => {
    const eta = createVideoFaceEta(() => 0);
    const { frames } = predictVideoFaceCost(clip);
    eta.record(clip, { extractMs: 3_600_000, detectMs: frames * 600_000, frames });
    const { extractScale, detectMsPerFrame } = eta.snapshot();
    expect(extractScale).toBeLessThan(1.3);
    expect(detectMsPerFrame).toBeLessThan(P.detectMsPerFrame * 2);
  });

  it("prices in the time the task spends paused", () => {
    let now = 0;
    const eta = createVideoFaceEta(() => now);
    const before = eta.estimateMs([clip]);
    const { extractMs, frames } = predictVideoFaceCost(clip);
    // Worked a quarter of the last hour; the rest it was paused for users.
    eta.record(clip, { extractMs, detectMs: frames * P.detectMsPerFrame, frames });
    now = 60 * 60_000;
    const busyMs = extractMs + frames * P.detectMsPerFrame;
    expect(eta.snapshot().workShare).toBeCloseTo(Math.max(0.05, busyMs / now), 2);
    expect(eta.estimateMs([clip])).toBeGreaterThan(before * 10);
  });
});

describe("orderVideoFaceQueue", () => {
  const now = Date.UTC(2026, 9, 26);
  const video = (
    relativePath: string,
    ageDays: number,
    sizeMB: number,
    extra: { durationSeconds?: number; failedBefore?: boolean } = {},
  ) => ({
    relativePath,
    durationSeconds: extra.durationSeconds ?? 20,
    sizeBytes: sizeMB * 1e6,
    takenAt: now - ageDays * 24 * 60 * 60 * 1_000,
    failedBefore: extra.failedBefore ?? false,
  });

  it("does the last 30 days first, then the rest, cheapest first in each", () => {
    const ordered = orderVideoFaceQueue(
      [
        video("old-big", 400, 900),
        video("recent-big", 3, 900),
        video("old-tiny", 400, 2),
        video("recent-tiny", 10, 2),
        video("recent-long", 1, 4_000, { durationSeconds: 900 }),
        video("old-failed-tiny", 400, 1, { failedBefore: true }),
      ],
      now,
    );
    expect(ordered.map((v) => v.relativePath)).toEqual([
      "recent-tiny",
      "recent-big",
      "recent-long",
      "old-tiny",
      "old-big",
      "old-failed-tiny",
    ]);
  });

  it("counts a video with no date as old, and the cutoff as recent", () => {
    const ordered = orderVideoFaceQueue(
      [
        {
          relativePath: "undated",
          durationSeconds: 5,
          sizeBytes: 1e6,
          failedBefore: false,
        },
        { ...video("edge", 0, 900), takenAt: now - RECENT_VIDEO_MS },
      ],
      now,
    );
    expect(ordered.map((v) => v.relativePath)).toEqual(["edge", "undated"]);
  });
});
