import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DetectedFace } from "../faceDetection/faceDetector.type.ts";
import {
  BROKEN_VIDEO_KINDS,
  breakVideo,
  hasFfmpeg,
  makeClip,
  type BrokenVideoKind,
} from "../videoProcessing/brokenVideos.fixture.ts";
import { extractAnalysisFrames } from "../videoProcessing/extractAnalysisFrames.ts";
import {
  MAX_CONSECUTIVE_FAILURES,
  processVideoFaceAnalysis,
} from "./processVideoFaceAnalysis.ts";

/**
 * The video-face run against failures it has hit on the real library, with
 * real files and real frame extraction. Only the database and the face model
 * are stand-ins. The everyday behaviour lives in processVideoFaceAnalysis.spec.ts.
 */
const describeWithFfmpeg = hasFfmpeg ? describe : describe.skip;

type Queued = { relativePath: string; durationSeconds?: number; sizeBytes?: number };

const fakeDatabase = (storagePath: string, videos: Queued[]) => {
  const queue = [...videos];
  const saved = new Map<string, DetectedFace[]>();
  const failed: string[] = [];
  const unreadable: string[] = [];
  const take = (relativePath: string) => {
    const i = queue.findIndex((v) => v.relativePath === relativePath);
    if (i >= 0) queue.splice(i, 1);
  };
  return {
    saved,
    failed,
    unreadable,
    db: {
      storagePath,
      getVideosNeedingFaceAnalysis: async () =>
        queue.map((v) => ({ ...v, failedBefore: false })),
      saveFaceDetectionResult: async (relativePath: string, faces: DetectedFace[]) => {
        saved.set(relativePath, faces);
        take(relativePath);
      },
      saveVideoFaceAnalysisError: async (relativePath: string) => {
        failed.push(relativePath);
        take(relativePath);
      },
      saveImageAnalysisDecodeError: async (relativePath: string) => {
        unreadable.push(relativePath);
        take(relativePath);
      },
      getVideoFaceAnalysisProgress: async () => ({
        total: videos.length,
        remaining: queue.length,
        coolingDown: failed.length,
        unreadable: unreadable.length,
      }),
      getVideoFaceQueueCostInputs: async () => queue,
    },
  };
};

const aFace = (): DetectedFace => {
  const embedding = new Float64Array(8);
  embedding[0] = 1;
  return { box: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, confidence: 0.9, embedding };
};

describeWithFfmpeg("processVideoFaceAnalysis regressions", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "photrix-video-faces-regressions-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // 2026-10-26: the first live run stopped after 472 videos. Cheapest first
  // put a folder of broken iPhone files (no stored length, a few KB to a few MB)
  // at the front, they failed five in a row, and the breaker ended the run as
  // if the pipeline were broken. Each broken file must be dropped for good, and
  // the good video queued behind them must still get its faces.
  it("drops a run of broken files and carries on to the good video behind them", async () => {
    const good = makeClip(root, "good.mp4");
    const indexFirst = makeClip(root, "index-first.mp4", { faststart: true });
    const kinds = Object.keys(BROKEN_VIDEO_KINDS) as BrokenVideoKind[];
    const broken = Array.from({ length: MAX_CONSECUTIVE_FAILURES + 2 }, (_, i) => {
      const kind = kinds[i % kinds.length];
      return breakVideo(
        kind === "blankFrames" ? indexFirst : good,
        root,
        kind,
        `IMG_${i}`,
      );
    });
    const relative = (file: string) => path.relative(root, file);

    const fake = fakeDatabase(root, [
      // As in the library: the good clip has a known length and size, the
      // broken ones have neither, so they sort first.
      {
        relativePath: relative(good),
        durationSeconds: 4,
        sizeBytes: statSync(good).size,
      },
      ...broken.map((file) => ({ relativePath: relative(file) })),
    ]);
    const runner = processVideoFaceAnalysis(
      fake.db,
      async () => ({ faces: [aFace()] }),
      extractAnalysisFrames,
    );
    await runner.onComplete();

    expect(fake.unreadable.sort()).toEqual(broken.map(relative).sort());
    expect(fake.failed).toEqual([]);
    expect(fake.saved.get(relative(good))).toHaveLength(1);
  }, 180_000);
});
