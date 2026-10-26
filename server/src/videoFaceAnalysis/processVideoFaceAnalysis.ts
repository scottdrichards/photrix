import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getLogger } from "../observability/logger.ts";
import { recordServerDiagnosticEvent } from "../observability/diagnosticsStore.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";
import { isWorkerEvictedError } from "../taskOrchestrator/computeWorkers.ts";
import type { AnalyzeImage } from "../imageAnalysis/processImageAnalysis.ts";
import { PermanentImageError } from "../imageAnalysis/imageAnalysisWorker.ts";
import type { AnalysisFrame } from "../videoProcessing/extractAnalysisFrames.ts";
import { collapseFaceTracks, type FrameFaces } from "./collapseFaceTracks.ts";
import {
  createVideoFaceEta,
  orderVideoFaceQueue,
  type QueuedVideoFaces,
  type VideoFaceCostInputs,
} from "./videoFaceCost.ts";

const log = getLogger("processVideoFaceAnalysis");

/**
 * Videos taken per read of the queue. The queue is re-read and re-ordered
 * after each batch, so a video added meanwhile still lands in its place.
 */
const DB_BATCH_SIZE = 20;
/**
 * This many failures in a row stop the run. One bad file is the file; five in
 * a row is the model, the GPU or the media share, and carrying on would read
 * video after video off the share only to fail each one.
 */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** The progress counts scan `files`; the status poll doesn't need them fresher than this. */
const PROGRESS_CACHE_MS = 30_000;
/** The ETA's view of the queue: reading it costs one pass over the queued videos. */
const QUEUE_COST_CACHE_MS = 5 * 60_000;
/** How often a running pass writes a progress summary to the log. */
const SUMMARY_LOG_INTERVAL_MS = 10 * 60_000;

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
  | "getVideoFaceQueueCostInputs"
>;

type QueuedVideo = QueuedVideoFaces;

type VideoOutcome = "done" | "failed";

class WorkerEvicted extends Error {}

/**
 * Face detection for videos: sample a few frames (extractAnalysisFrames.ts),
 * run the same detector the photos use on each, and keep one face per person
 * (collapseFaceTracks.ts). Every stored face records the frame it came from in
 * `faces.frameTimeMs`, and when its person is on screen in `faceAppearances`.
 *
 * Shares the image-analysis Python worker and its budget, so it never runs
 * beside the photo pass. One video at a time, because the worker is serial and
 * a second request would only sit in its queue while its timeout ran.
 *
 * Videos differ in cost by orders of magnitude (a 3 s clip against a 3 min 4K
 * one read end to end off the share), so the ETA prices each queued video by
 * its length, size and resolution instead of counting videos (videoFaceCost.ts).
 */
export const processVideoFaceAnalysis = (
  database: VideoFaceDatabase,
  analyzeImage: AnalyzeImage,
  extractFrames: ExtractFrames,
  now: () => number = Date.now,
): TaskRunner => {
  const ctrl = createTaskController("Video face analysis cancelled");
  const eta = createVideoFaceEta(now);
  let progressCache: {
    at: number;
    value: Awaited<ReturnType<VideoFaceDatabase["getVideoFaceAnalysisProgress"]>>;
  } | null = null;
  let queueCostCache: { at: number; value: VideoFaceCostInputs[] } | null = null;
  const run = { done: 0, failed: 0, faces: 0, lastSummaryAt: now() };

  const readProgress = async () => {
    if (!progressCache || now() - progressCache.at > PROGRESS_CACHE_MS) {
      progressCache = { at: now(), value: await database.getVideoFaceAnalysisProgress() };
    }
    return progressCache.value;
  };

  const readEtaMs = async (): Promise<number | undefined> => {
    if (!queueCostCache || now() - queueCostCache.at > QUEUE_COST_CACHE_MS) {
      queueCostCache = { at: now(), value: await database.getVideoFaceQueueCostInputs() };
    }
    return eta.estimateMs(queueCostCache.value);
  };

  const logSummary = async (force = false) => {
    if (!force && now() - run.lastSummaryAt < SUMMARY_LOG_INTERVAL_MS) return;
    run.lastSummaryAt = now();
    try {
      const [progress, etaMs] = await Promise.all([readProgress(), readEtaMs()]);
      log.info(
        {
          videosDone: run.done,
          videosFailed: run.failed,
          facesStored: run.faces,
          remaining: progress.remaining,
          coolingDown: progress.coolingDown,
          unreadable: progress.unreadable,
          etaMinutes: etaMs === undefined ? undefined : Math.round(etaMs / 60_000),
          ...eta.snapshot(),
        },
        "Video face analysis progress",
      );
    } catch (error) {
      log.debug({ err: error }, "Video face progress summary failed");
    }
  };

  /** Frames analysed, with the time spent in the face model. */
  const detectInFrames = async (
    frames: AnalysisFrame[],
  ): Promise<{ frameFaces: FrameFaces[]; detectMs: number }> => {
    const frameFaces: FrameFaces[] = [];
    let detectMs = 0;
    for (const frame of frames) {
      ctrl.checkCancelled();
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();
      const startedAt = now();
      try {
        const result = await analyzeImage(frame.path, { faces: true, embed: false });
        if (result.facesError) throw new Error(result.facesError);
        frameFaces.push({
          timeMs: frame.timeMs,
          startMs: frame.startMs,
          endMs: frame.endMs,
          faces: result.faces ?? [],
        });
      } catch (error) {
        if (isWorkerEvictedError(error)) throw new WorkerEvicted();
        // One frame ffmpeg wrote but Pillow can't read loses that frame only.
        if (error instanceof PermanentImageError) {
          log.warn({ err: error, frame: frame.path }, "Skipping unreadable video frame");
          continue;
        }
        throw error;
      } finally {
        detectMs += now() - startedAt;
      }
    }
    return { frameFaces, detectMs };
  };

  const analyzeVideo = async (video: QueuedVideo): Promise<VideoOutcome> => {
    const { relativePath, durationSeconds } = video;
    const videoPath = path.join(database.storagePath, stripLeadingSlash(relativePath));
    const workDir = await mkdtemp(path.join(os.tmpdir(), "photrix-video-faces-"));
    try {
      let frames: AnalysisFrame[];
      const extractStartedAt = now();
      try {
        frames = await extractFrames(videoPath, durationSeconds, workDir);
      } catch (error) {
        log.warn({ err: error, path: relativePath }, "Video frame extraction failed");
        await database.saveVideoFaceAnalysisError(relativePath);
        return "failed";
      }
      const extractMs = now() - extractStartedAt;

      if (frames.length === 0) {
        // ffmpeg ran cleanly and found nothing to decode: that won't change.
        log.warn({ path: relativePath }, "Video has no decodable frames");
        await database.saveImageAnalysisDecodeError(relativePath);
        eta.record(video, { extractMs, detectMs: 0, frames: 0 });
        return "done";
      }

      const { frameFaces, detectMs } = await detectInFrames(frames);
      const faces = collapseFaceTracks(frameFaces);
      // No `regions` write, unlike photos: regions drive the box overlay in the
      // viewer, and a box from one frame means nothing over a playing video.
      await database.saveFaceDetectionResult(relativePath, faces);
      const predicted = eta.record(video, {
        extractMs,
        detectMs,
        frames: frameFaces.length,
      });
      run.faces += faces.length;
      log.info(
        {
          path: relativePath,
          durationSeconds,
          sizeMB:
            video.sizeBytes === undefined ? undefined : Math.round(video.sizeBytes / 1e6),
          frames: frames.length,
          detections: frameFaces.reduce((sum, f) => sum + f.faces.length, 0),
          faces: faces.length,
          extractMs,
          detectMs,
          predictedMs: Math.round(predicted),
        },
        "Video faces detected",
      );
      return "done";
    } catch (error) {
      if (error instanceof WorkerEvicted) throw error;
      if (ctrl.state === "cancelled") throw error;
      log.warn({ err: error, path: relativePath }, "Video face analysis failed");
      await database.saveVideoFaceAnalysisError(relativePath);
      return "failed";
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const stopForFailures = async (consecutiveFailures: number) => {
    log.error(
      { consecutiveFailures },
      "Stopping video face analysis: too many failures in a row",
    );
    // The run ends looking like any finished task, so leave a trace in the
    // diagnostics stream as well as the log.
    recordServerDiagnosticEvent({
      level: "error",
      event: "videoFaces.stopped",
      message: `Video faces stopped after ${consecutiveFailures} failures in a row`,
      data: { consecutiveFailures, videosDone: run.done, videosFailed: run.failed },
    });
    await logSummary(true);
    ctrl.markComplete();
  };

  const completion: Promise<void> = (async () => {
    let consecutiveFailures = 0;
    while (true) {
      ctrl.checkCancelled();
      const videos = orderVideoFaceQueue(
        await database.getVideosNeedingFaceAnalysis(),
        now(),
      ).slice(0, DB_BATCH_SIZE);
      if (!videos.length) {
        await logSummary(true);
        ctrl.markComplete();
        return;
      }

      for (const video of videos) {
        ctrl.checkCancelled();
        await ctrl.waitUntilResumed();
        ctrl.checkCancelled();
        try {
          const outcome = await analyzeVideo(video);
          if (outcome === "done") run.done += 1;
          else run.failed += 1;
          consecutiveFailures = outcome === "done" ? 0 : consecutiveFailures + 1;
        } catch (error) {
          if (!(error instanceof WorkerEvicted)) throw error;
          // The worker was killed for a user's sake, not because of this video,
          // so nothing is stamped and the video is retried on the next pass. It
          // still counts toward the breaker: a worker killed every time would
          // otherwise have each retry read the video off the share again.
          log.info(
            { path: video.relativePath },
            "Video face analysis interrupted by worker eviction",
          );
          consecutiveFailures += 1;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await stopForFailures(consecutiveFailures);
          return;
        }
        await logSummary();
      }
    }
  })();

  return {
    pause: ctrl.pause,
    resume: ctrl.resume,
    cancel: ctrl.cancel,
    getStatus: async () => {
      const [progress, etaMs] = await Promise.all([readProgress(), readEtaMs()]);
      const { total, remaining, coolingDown, unreadable } = progress;
      const done = Math.max(0, total - remaining);
      const notes = [
        coolingDown > 0
          ? `${coolingDown.toLocaleString()} failed, retrying in a week`
          : null,
        unreadable > 0 ? `${unreadable.toLocaleString()} unreadable` : null,
      ].filter(Boolean);
      return {
        state: ctrl.state,
        itemsProcessed: done,
        total,
        portionComplete: total > 0 ? done / total : undefined,
        description: ["Finding faces in videos", ...notes].join(" • "),
        ...(etaMs !== undefined ? { etaMs } : {}),
      };
    },
    onComplete: () => completion,
  };
};
