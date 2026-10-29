import path from "node:path";
import type { DetectedFace } from "../faceDetection/faceDetector.type.ts";
import type { AnalysisFrame } from "../videoProcessing/extractAnalysisFrames.ts";
import type { ExtractFrames } from "./processVideoFaceAnalysis.ts";

/**
 * Stand-ins shared by the processVideoFaceAnalysis specs: the database queue,
 * a face, and frames that exist only as paths.
 */

export type QueuedTestVideo = {
  relativePath: string;
  durationSeconds?: number;
  sizeBytes?: number;
};

type SavedFace = DetectedFace & {
  frameTimeMs?: number;
  appearances?: ReadonlyArray<{ startMs: number; endMs: number }>;
};

/** An in-memory stand-in for the queue: a video leaves it once anything is stamped. */
export const fakeDatabase = (videos: QueuedTestVideo[], storagePath = "/media") => {
  const queue = [...videos];
  const saved = new Map<string, SavedFace[]>();
  /** Stamped as failed: retried after the cooldown. */
  const errors: string[] = [];
  /** Stamped as unreadable: dropped for good. */
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
      storagePath,
      analysis: {
        getVideosNeedingFaceAnalysis: async () =>
          queue.map((v) => ({ failedBefore: false, ...v })),
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
          coolingDown: errors.length,
          unreadable: decodeErrors.length,
        }),
        getVideoFaceQueueCostInputs: async () =>
          queue.map(({ relativePath: _, ...cost }) => cost),
      },
      faces: {
        saveFaceDetectionResult: async (relativePath: string, faces: DetectedFace[]) => {
          saved.set(relativePath, faces);
          take(relativePath);
        },
      },
    },
  };
};

/** A face whose embedding points along axis `base`: same base, same person. */
export const detected = (base: number, size = 0.2): DetectedFace => {
  const embedding = new Float64Array(8);
  embedding[base] = 1;
  return {
    box: { x: 0.1, y: 0.1, width: size, height: size },
    confidence: 0.9,
    embedding,
  };
};

/** Frames at the given times, written nowhere: the fake detector never reads them. */
export const framesAt =
  (...times: number[]): ExtractFrames =>
  async (_video, _duration, outDir) =>
    times.map((timeMs, i): AnalysisFrame => ({
      path: path.join(outDir, `f${i}.jpg`),
      timeMs,
      startMs: timeMs,
      endMs: times[i + 1] ?? timeMs + 1_000,
    }));
