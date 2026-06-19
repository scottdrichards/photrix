import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";
import type { DetectFaces, DetectedFace } from "./faceDetector.type.ts";

const dbBatchSize = 50;
const parallelism = 2;

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
 * Processes pending face detection updates with pause/resume/cancel controls.
 *
 * For each image that has not yet been processed (`facesProcessedAt IS NULL`)
 * the detector is invoked, results are persisted to the `faces` table, and
 * `facesProcessedAt` is stamped on the file row. An empty result list still
 * stamps the timestamp so the file is not retried — that maps directly to the
 * "scanned, no faces" state the user wants represented as `[]`.
 *
 * Detector failures are persisted in the database as `facesLastErrorAt` and
 * are retried after other pending files have been attempted. Success clears
 * the error marker and stamps `facesProcessedAt`.
 */
export const processFaceDetection = (
  database: IndexDatabase,
  detectFaces: DetectFaces,
): TaskRunner => {
  const ctrl = createTaskController("Face detection processing cancelled");

  const completion: Promise<void> = (async () => {
    // The detect function lazy-loads models + the tfjs backend on first call
    // (cached via a module-scope promise), so the first file in the first
    // batch pays the warmup cost. No explicit warmup step is needed.
    while (true) {
      ctrl.checkCancelled();

      const items = await database.getFilesNeedingMetadataUpdate("faces", dbBatchSize);
      if (!items.length) {
        ctrl.markComplete();
        return;
      }

      for (const chunk of batch(items, parallelism)) {
        ctrl.checkCancelled();
        await ctrl.waitUntilResumed();
        ctrl.checkCancelled();

        await Promise.all(
          chunk.map(async (entry) => {
            const { relativePath } = entry;
            const fullPath = path.join(
              database.storagePath,
              stripLeadingSlash(relativePath),
            );
            try {
              const faces = await detectFaces(fullPath);
              await database.saveFaceDetectionResult(relativePath, faces);
              await database.addOrUpdateFileData(relativePath, {
                regions: faceDetectionsToRegions(faces),
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(`[faceDetection] Failed to scan ${relativePath}: ${message}`);
              await database.addOrUpdateFileData(relativePath, {
                facesLastErrorAt: new Date().toISOString(),
              });
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
      const totalEligible = counts.imageEntries;
      const done = Math.max(0, totalEligible - counts.missingFaceDetection);
      return {
        state: ctrl.state,
        itemsProcessed: done,
        total: totalEligible,
        portionComplete: totalEligible > 0 ? done / totalEligible : undefined,
      };
    },
    onComplete: () => completion,
  };
};
