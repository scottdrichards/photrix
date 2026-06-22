import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getLogger } from "../observability/logger.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";
import type { DetectedFace } from "../faceDetection/faceDetector.type.ts";
import type { AnalyzeImageOptions, ImageAnalysisResult } from "./imageAnalysisWorker.ts";

const log = getLogger("processImageAnalysis");

const DB_BATCH_SIZE = 50;
// The combined Python worker decodes once and runs both models sequentially, so
// it is the real throttle. A small Node-side fan-out just keeps its input pipe
// from starving without flooding the box.
const PARALLELISM = 3;

export type AnalyzeImage = (
  imagePath: string,
  options: AnalyzeImageOptions,
) => Promise<ImageAnalysisResult>;

const faceDetectionsToRegions = (faces: DetectedFace[]) =>
  faces.map((face) => ({
    type: "Face",
    area: {
      // Detector outputs top-left; regions use center-based coordinates.
      x: face.box.x + face.box.width / 2,
      y: face.box.y + face.box.height / 2,
      width: face.box.width,
      height: face.box.height,
    },
  }));

/**
 * Combined face-detection + semantic-embedding pass.
 *
 * Each image is loaded and decoded exactly once by the worker, which runs face
 * detection, CLIP embedding, or both depending on which results the file is
 * still missing. Per-stage failures are recorded independently (`facesLastErrorAt`
 * / `embeddingErrorAt`) so a model fault on one stage does not block the other,
 * and successfully stored results are never recomputed.
 */
export const processImageAnalysis = (
  database: IndexDatabase,
  analyzeImage: AnalyzeImage,
): TaskRunner => {
  const ctrl = createTaskController("Image analysis processing cancelled");

  const saveFaceResult = async (relativePath: string, result: ImageAnalysisResult) => {
    if (result.facesError) {
      log.warn(
        { err: result.facesError, path: relativePath },
        "Face detection failed",
      );
      await database.addOrUpdateFileData(relativePath, {
        facesLastErrorAt: new Date().toISOString(),
      });
      return;
    }
    if (result.faces) {
      await database.saveFaceDetectionResult(relativePath, result.faces);
      await database.addOrUpdateFileData(relativePath, {
        regions: faceDetectionsToRegions(result.faces),
      });
    }
  };

  const saveEmbeddingResult = async (
    relativePath: string,
    result: ImageAnalysisResult,
  ) => {
    if (result.embeddingError) {
      log.warn(
        { err: result.embeddingError, path: relativePath },
        "Image embedding failed",
      );
      await database.saveImageEmbeddingError(relativePath);
      return;
    }
    if (result.embedding) {
      await database.saveImageEmbedding(relativePath, result.embedding);
    }
  };

  const completion: Promise<void> = (async () => {
    // Models lazy-load on first use inside the worker, so the first image in the
    // run pays warmup for whichever stages it needs. No explicit warmup needed.
    while (true) {
      ctrl.checkCancelled();

      const items = await database.getImagesNeedingAnalysis(DB_BATCH_SIZE);
      if (!items.length) {
        ctrl.markComplete();
        return;
      }

      for (const chunk of batch(items, PARALLELISM)) {
        ctrl.checkCancelled();
        await ctrl.waitUntilResumed();
        ctrl.checkCancelled();

        await Promise.all(
          chunk.map(async ({ relativePath, needsFaces, needsEmbedding }) => {
            const fullPath = path.join(
              database.storagePath,
              stripLeadingSlash(relativePath),
            );
            try {
              const result = await analyzeImage(fullPath, {
                faces: needsFaces,
                embed: needsEmbedding,
              });
              if (needsFaces) await saveFaceResult(relativePath, result);
              if (needsEmbedding) await saveEmbeddingResult(relativePath, result);
            } catch (error) {
              // A decode/transport failure fails every requested stage; mark
              // each so the file is retried after the rest of the backlog.
              log.warn({ err: error, path: relativePath }, "Image analysis failed");
              if (needsFaces) {
                await database.addOrUpdateFileData(relativePath, {
                  facesLastErrorAt: new Date().toISOString(),
                });
              }
              if (needsEmbedding) {
                await database.saveImageEmbeddingError(relativePath);
              }
            }
          }),
        );
      }
    }
  })();

  return {
    pause: ctrl.pause,
    resume: ctrl.resume,
    cancel: ctrl.cancel,
    getStatus: async () => {
      const counts = await database.getStatusCounts();
      const facesTotal = counts.imageEntries;
      const facesDone = Math.max(0, facesTotal - counts.missingFaceDetection);
      const [embedTotal, embedDone] = await database.getEmbeddingProgress();

      const stages = [
        counts.missingFaceDetection > 0 ? "faces" : null,
        embedTotal - embedDone > 0 ? "embeddings" : null,
      ].filter((stage): stage is string => stage !== null);

      const total = facesTotal + embedTotal;
      const done = facesDone + embedDone;

      return {
        state: ctrl.state,
        itemsProcessed: done,
        total,
        portionComplete: total > 0 ? done / total : undefined,
        ...(stages.length
          ? { description: `Processing ${stages.join(" + ")}` }
          : {}),
      };
    },
    onComplete: () => completion,
  };
};
