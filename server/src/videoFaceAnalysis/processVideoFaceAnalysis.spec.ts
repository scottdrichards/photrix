import { describe, it, expect } from "@jest/globals";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DetectedFace } from "../faceDetection/faceDetector.type.ts";
import { PermanentImageError } from "../imageAnalysis/imageAnalysisWorker.ts";
import type { ImageAnalysisResult } from "../imageAnalysis/imageAnalysisWorker.ts";
import { markWorkerEvictedError } from "../taskOrchestrator/computeWorkers.ts";
import type { AnalysisFrame } from "../videoProcessing/extractAnalysisFrames.ts";
import {
  MAX_CONSECUTIVE_FAILURES,
  processVideoFaceAnalysis,
  type ExtractFrames,
} from "./processVideoFaceAnalysis.ts";

type Video = { relativePath: string; durationSeconds?: number };

/** An in-memory stand-in for the queue: a video leaves it once anything is stamped. */
const fakeDatabase = (videos: Video[]) => {
  const queue = [...videos];
  const saved = new Map<string, Array<DetectedFace & { frameTimeMs?: number }>>();
  const errors: string[] = [];
  const decodeErrors: string[] = [];
  const take = (relativePath: string) => {
    const i = queue.findIndex((v) => v.relativePath === relativePath);
    if (i >= 0) queue.splice(i, 1);
  };
  return {
    saved,
    errors,
    decodeErrors,
    db: {
      storagePath: "/media",
      getVideosNeedingFaceAnalysis: async (limit = 20) => queue.slice(0, limit),
      saveFaceDetectionResult: async (relativePath: string, faces: DetectedFace[]) => {
        saved.set(relativePath, faces);
        take(relativePath);
      },
      saveVideoFaceAnalysisError: async (relativePath: string) => {
        errors.push(relativePath);
        take(relativePath);
      },
      saveImageAnalysisDecodeError: async (relativePath: string) => {
        decodeErrors.push(relativePath);
        take(relativePath);
      },
      getVideoFaceAnalysisProgress: async () => ({
        total: videos.length,
        remaining: queue.length,
      }),
    },
  };
};

const embedding = (base: number) => {
  const v = new Float64Array(8);
  v[base] = 1;
  return v;
};
const detected = (base: number, size = 0.2): DetectedFace => ({
  box: { x: 0.1, y: 0.1, width: size, height: size },
  confidence: 0.9,
  embedding: embedding(base),
});

/** Frames at the given times, written nowhere: the fake detector never reads them. */
const framesAt =
  (...times: number[]): ExtractFrames =>
  async (_video, _duration, outDir) =>
    times.map((timeMs, i): AnalysisFrame => ({
      path: path.join(outDir, `f${i}.jpg`),
      timeMs,
    }));

const run = async (
  videos: Video[],
  extract: ExtractFrames,
  analyze: (framePath: string) => Promise<ImageAnalysisResult>,
) => {
  const fake = fakeDatabase(videos);
  const runner = processVideoFaceAnalysis(fake.db, (p) => analyze(p), extract);
  await runner.onComplete();
  return { ...fake, runner };
};

describe("processVideoFaceAnalysis", () => {
  it("stores one face per person, tagged with the frame it was best in", async () => {
    const byFrame: Record<string, DetectedFace[]> = {
      "f0.jpg": [detected(0, 0.1)],
      "f1.jpg": [detected(0, 0.3), detected(4)],
      "f2.jpg": [],
    };
    const { saved } = await run(
      [{ relativePath: "v/party.mp4", durationSeconds: 10 }],
      framesAt(0, 3_000, 6_000),
      async (p) => ({ faces: byFrame[path.basename(p)] }),
    );
    const faces = saved.get("v/party.mp4")!;
    expect(faces).toHaveLength(2);
    expect(faces.map((f) => f.frameTimeMs)).toEqual([3_000, 3_000]);
    expect(faces.find((f) => f.embedding[0] === 1)?.box.width).toBe(0.3);
  });

  it("records a video with no faces as done, so it isn't scanned again", async () => {
    const { saved } = await run(
      [{ relativePath: "v/empty.mp4" }],
      framesAt(0),
      async () => ({
        faces: [],
      }),
    );
    expect(saved.get("v/empty.mp4")).toEqual([]);
  });

  it("passes the duration through and gives each video its own scratch directory, removed after", async () => {
    const seen: Array<{ duration?: number; outDir: string }> = [];
    await run(
      [{ relativePath: "v/a.mp4", durationSeconds: 42 }],
      async (_video, duration, outDir) => {
        seen.push({ duration, outDir });
        return [];
      },
      async () => ({ faces: [] }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].duration).toBe(42);
    expect(existsSync(seen[0].outDir)).toBe(false);
  });

  it("drops a video ffmpeg finds no frames in for good", async () => {
    const { decodeErrors, saved } = await run(
      [{ relativePath: "v/blank.mp4" }],
      framesAt(),
      async () => ({
        faces: [],
      }),
    );
    expect(decodeErrors).toEqual(["v/blank.mp4"]);
    expect(saved.size).toBe(0);
  });

  it("starts the retry cooldown when ffmpeg fails, and moves on", async () => {
    const { errors, saved } = await run(
      [{ relativePath: "v/bad.mp4" }, { relativePath: "v/good.mp4" }],
      async (video, duration, outDir) => {
        if (video.endsWith("bad.mp4")) throw new Error("ffmpeg exited 1");
        return framesAt(0)(video, duration, outDir);
      },
      async () => ({ faces: [detected(0)] }),
    );
    expect(errors).toEqual(["v/bad.mp4"]);
    expect(saved.has("v/good.mp4")).toBe(true);
  });

  it("starts the cooldown when the face model fails, without saving a partial result", async () => {
    const { errors, saved } = await run(
      [{ relativePath: "v/a.mp4" }],
      framesAt(0, 1_000),
      async (p) =>
        p.endsWith("f1.jpg") ? { facesError: "CUDA error" } : { faces: [detected(0)] },
    );
    expect(errors).toEqual(["v/a.mp4"]);
    expect(saved.size).toBe(0);
  });

  it("skips one unreadable frame and keeps the rest", async () => {
    const { saved } = await run(
      [{ relativePath: "v/a.mp4" }],
      framesAt(0, 1_000),
      async (p) => {
        if (p.endsWith("f0.jpg")) throw new PermanentImageError("truncated");
        return { faces: [detected(0)] };
      },
    );
    expect(saved.get("v/a.mp4")?.map((f) => f.frameTimeMs)).toEqual([1_000]);
  });

  it("stops after too many failures in a row instead of reading the whole library", async () => {
    const videos = Array.from({ length: MAX_CONSECUTIVE_FAILURES + 5 }, (_, i) => ({
      relativePath: `v/${i}.mp4`,
    }));
    let extractions = 0;
    const { errors, runner } = await run(
      videos,
      async () => {
        extractions += 1;
        throw new Error("media share gone");
      },
      async () => ({ faces: [] }),
    );
    expect(extractions).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(errors).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect((await runner.getStatus!()).state).toBe("complete");
  });

  it("leaves a video queued, unstamped, when the worker is evicted mid-video", async () => {
    let calls = 0;
    const { errors, saved, decodeErrors } = await run(
      [{ relativePath: "v/a.mp4" }],
      framesAt(0),
      async () => {
        calls += 1;
        throw markWorkerEvictedError(new Error("worker killed"));
      },
    );
    // Retried until the breaker trips, and never marked as failed or done.
    expect(calls).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(errors).toEqual([]);
    expect(decodeErrors).toEqual([]);
    expect(saved.size).toBe(0);
  });

  it("reports progress over all videos", async () => {
    const { runner } = await run(
      [{ relativePath: "v/a.mp4" }, { relativePath: "v/b.mp4" }],
      framesAt(0),
      async () => ({ faces: [] }),
    );
    expect(await runner.getStatus!()).toMatchObject({
      itemsProcessed: 2,
      total: 2,
      portionComplete: 1,
    });
  });
});
