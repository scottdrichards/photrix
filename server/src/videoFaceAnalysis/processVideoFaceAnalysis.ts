import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getLogger } from "../observability/logger.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";
import { isWorkerEvictedError } from "../taskOrchestrator/computeWorkers.ts";
import type { AnalyzeImage } from "../imageAnalysis/processImageAnalysis.ts";
import { PermanentImageError } from "../imageAnalysis/imageAnalysisWorker.ts";
import type { AnalysisFrame } from "../videoProcessing/extractAnalysisFrames.ts";
import { collapseFaceTracks, type FrameFaces } from "./collapseFaceTracks.ts";

const log = getLogger("processVideoFaceAnalysis");

const DB_BATCH_SIZE = 20;
/**
 * This many failures in a row stop the run. One bad file is the file; five in
 * a row is the model, the GPU or the media share, and carrying on would read
 * video after video off the share only to fail each one.
 */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** The progress counts scan `files`; the status poll doesn't need them fresher than this. */
const PROGRESS_CACHE_MS = 30_000;

export type ExtractFrames = (
  videoPath: string,
  durationSeconds: number | undefined,
  outDir: string,
) => Promise<AnalysisFrame[]>;

type VideoFaceDatabase = Pick<
  IndexDatabase,
  | "storagePath"
  | "getVideosNeedingFaceAnalysis"
  | "saveFaceDetectionResult"
  | "saveVideoFaceAnalysisError"
  | "saveImageAnalysisDecodeError"
  | "getVideoFaceAnalysisProgress"
>;

class WorkerEvicted extends Error {}

/**
 * Face detection for videos: sample a few frames (extractAnalysisFrames.ts),
 * run the same detector the photos use on each, and keep one face per person
 * (collapseFaceTracks.ts). Every stored face records the frame it came from in
 * `faces.frameTimeMs`.
 *
 * Shares the image-analysis Python worker and its budget, so it never runs
 * beside the photo pass. One video at a time, because the worker is serial and
 * a second request would only sit in its queue while its timeout ran.
 */
export const processVideoFaceAnalysis = (
  database: VideoFaceDatabase,
  analyzeImage: AnalyzeImage,
  extractFrames: ExtractFrames,
): TaskRunner => {
  const ctrl = createTaskController("Video face analysis cancelled");
  let progressCache: { at: number; value: { total: number; remaining: number } } | null =
    null;

  const detectInFrames = async (frames: AnalysisFrame[]): Promise<FrameFaces[]> => {
    const results: FrameFaces[] = [];
    for (const frame of frames) {
      ctrl.checkCancelled();
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();
      try {
        const result = await analyzeImage(frame.path, { faces: true, embed: false });
        if (result.facesError) throw new Error(result.facesError);
        results.push({ timeMs: frame.timeMs, faces: result.faces ?? [] });
      } catch (error) {
        if (isWorkerEvictedError(error)) throw new WorkerEvicted();
        // One frame ffmpeg wrote but Pillow can't read loses that frame only.
        if (error instanceof PermanentImageError) {
          log.warn({ err: error, frame: frame.path }, "Skipping unreadable video frame");
          continue;
        }
        throw error;
      }
    }
    return results;
  };

  /** Returns false when the video failed, so the run can count failures in a row. */
  const analyzeVideo = async (
    relativePath: string,
    durationSeconds?: number,
  ): Promise<boolean> => {
    const videoPath = path.join(database.storagePath, stripLeadingSlash(relativePath));
    const workDir = await mkdtemp(path.join(os.tmpdir(), "photrix-video-faces-"));
    try {
      let frames: AnalysisFrame[];
      try {
        frames = await extractFrames(videoPath, durationSeconds, workDir);
      } catch (error) {
        log.warn({ err: error, path: relativePath }, "Video frame extraction failed");
        await database.saveVideoFaceAnalysisError(relativePath);
        return false;
      }

      if (frames.length === 0) {
        // ffmpeg ran cleanly and found nothing to decode: that won't change.
        log.warn({ path: relativePath }, "Video has no decodable frames");
        await database.saveImageAnalysisDecodeError(relativePath);
        return true;
      }

      const frameFaces = await detectInFrames(frames);
      const faces = collapseFaceTracks(frameFaces);
      // No `regions` write, unlike photos: regions drive the box overlay in the
      // viewer, and a box from one frame means nothing over a playing video.
      await database.saveFaceDetectionResult(relativePath, faces);
      log.info(
        {
          path: relativePath,
          frames: frames.length,
          detections: frameFaces.reduce((sum, f) => sum + f.faces.length, 0),
          faces: faces.length,
        },
        "Video faces detected",
      );
      return true;
    } catch (error) {
      if (error instanceof WorkerEvicted) throw error;
      if (ctrl.state === "cancelled") throw error;
      log.warn({ err: error, path: relativePath }, "Video face analysis failed");
      await database.saveVideoFaceAnalysisError(relativePath);
      return false;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const completion: Promise<void> = (async () => {
    let consecutiveFailures = 0;
    while (true) {
      ctrl.checkCancelled();
      const videos = await database.getVideosNeedingFaceAnalysis(DB_BATCH_SIZE);
      if (!videos.length) {
        ctrl.markComplete();
        return;
      }

      for (const { relativePath, durationSeconds } of videos) {
        ctrl.checkCancelled();
        await ctrl.waitUntilResumed();
        ctrl.checkCancelled();
        try {
          const ok = await analyzeVideo(relativePath, durationSeconds);
          consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
        } catch (error) {
          if (!(error instanceof WorkerEvicted)) throw error;
          // The worker was killed for a user's sake, not because of this video,
          // so nothing is stamped and the video is retried on the next pass. It
          // still counts toward the breaker: a worker killed every time would
          // otherwise have each retry read the video off the share again.
          log.info(
            { path: relativePath },
            "Video face analysis interrupted by worker eviction",
          );
          consecutiveFailures += 1;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log.error(
            { consecutiveFailures },
            "Stopping video face analysis: too many failures in a row",
          );
          ctrl.markComplete();
          return;
        }
      }
    }
  })();

  return {
    pause: ctrl.pause,
    resume: ctrl.resume,
    cancel: ctrl.cancel,
    getStatus: async () => {
      if (!progressCache || Date.now() - progressCache.at > PROGRESS_CACHE_MS) {
        progressCache = {
          at: Date.now(),
          value: await database.getVideoFaceAnalysisProgress(),
        };
      }
      const { total, remaining } = progressCache.value;
      const done = Math.max(0, total - remaining);
      return {
        state: ctrl.state,
        itemsProcessed: done,
        total,
        portionComplete: total > 0 ? done / total : undefined,
        description: "Finding faces in videos",
      };
    },
    onComplete: () => completion,
  };
};
