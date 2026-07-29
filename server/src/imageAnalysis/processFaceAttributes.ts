import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getLogger } from "../observability/logger.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";
import type { FaceAttributes } from "../faceDetection/faceDetector.type.ts";
import type { FaceAttributeRequest } from "./imageAnalysisWorker.ts";
import { PermanentImageError } from "./imageAnalysisWorker.ts";
import { isWorkerEvictedError } from "../taskOrchestrator/computeWorkers.ts";

const log = getLogger("processFaceAttributes");

const DB_BATCH_SIZE = 50;
// Matches processImageAnalysis: the single Python worker is the real throttle,
// so a small Node-side fan-out just keeps its input pipe from starving.
const PARALLELISM = 3;

export type AnalyzeFaceAttributes = (
  imagePath: string,
  faces: FaceAttributeRequest[],
) => Promise<Map<number, FaceAttributes>>;

/**
 * Backfills "photo ready" attributes onto faces detected before the attributes
 * existed.
 *
 * Newly detected faces get their attributes inline with detection, for free —
 * this task exists only to catch up the ~360k faces already in the index. It is
 * deliberately *not* a re-detection pass: re-running the detector would replace
 * the face rows and discard every cluster assignment. Instead each stored box is
 * handed back to the landmark models, and only the attribute columns are
 * written.
 *
 * Runs on the background queue like every other processor, claiming work in
 * small batches from a partial index of unscored faces, so it is fully
 * resumable, never blocks startup, and yields to user requests.
 */
export const processFaceAttributes = (
  database: IndexDatabase,
  analyzeFaceAttributes: AnalyzeFaceAttributes,
): TaskRunner => {
  const ctrl = createTaskController("Face attribute processing cancelled");

  const processFile = async (relativePath: string) => {
    const faces = await database.getFaceBoxesForAttributes(relativePath);
    if (faces.length === 0) return;

    const fullPath = path.join(database.storagePath, stripLeadingSlash(relativePath));
    let derived: Map<number, FaceAttributes>;
    try {
      derived = await analyzeFaceAttributes(fullPath, faces);
    } catch (error) {
      if (isWorkerEvictedError(error)) {
        // We killed the worker to hand the GPU to a user request. Nothing is
        // wrong with this file — leave it queued rather than marking it done.
        log.info(
          { path: relativePath },
          "Face attribute pass interrupted by worker eviction; will retry",
        );
        return;
      }
      if (error instanceof PermanentImageError) {
        // The image can no longer be decoded (moved, truncated, corrupt). Its
        // faces can never be scored, so retire them from the queue with every
        // attribute unknown instead of retrying forever.
        log.warn(
          { err: error, path: relativePath },
          "Face attribute source image unreadable; recording attributes as unknown",
        );
        await database.saveFaceAttributes(
          faces.map(({ id }) => ({ id, attributes: {} })),
        );
        return;
      }
      throw error;
    }

    // Faces the worker skipped are stamped with no attributes: "we looked and
    // could not tell". Without this a face the models never answer for would be
    // re-fetched on every pass and the backfill would never drain.
    const results = faces.map(({ id }) => ({
      id,
      attributes: derived.get(id) ?? {},
    }));
    await database.saveFaceAttributes(results);
  };

  const completion: Promise<void> = (async () => {
    while (true) {
      ctrl.checkCancelled();

      const paths = await database.getFilesNeedingFaceAttributes(DB_BATCH_SIZE);
      if (!paths.length) {
        ctrl.markComplete();
        return;
      }

      for (const chunk of batch(paths, PARALLELISM)) {
        ctrl.checkCancelled();
        await ctrl.waitUntilResumed();
        ctrl.checkCancelled();

        await Promise.all(
          chunk.map(async (relativePath) => {
            try {
              await processFile(relativePath);
            } catch (error) {
              // A transient worker fault (timeout, crash) leaves the file
              // queued. The batch query is ordered, so a file that fails every
              // time would stall the queue head — cap that by scoring it as
              // unknown after the failure is reported.
              log.warn(
                { err: error, path: relativePath },
                "Face attribute derivation failed; marking faces unknown",
              );
              const faces = await database
                .getFaceBoxesForAttributes(relativePath)
                .catch(() => []);
              if (faces.length > 0) {
                await database
                  .saveFaceAttributes(faces.map(({ id }) => ({ id, attributes: {} })))
                  .catch(() => undefined);
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
      const [total, pending] = await Promise.all([
        database.countFacesTotal(),
        database.countFacesNeedingAttributes(),
      ]);
      const done = Math.max(0, total - pending);
      return {
        state: ctrl.state,
        itemsProcessed: done,
        total,
        portionComplete: total > 0 ? done / total : undefined,
        ...(pending > 0 ? { description: "Scoring faces for photo-ready filters" } : {}),
      };
    },
    onComplete: () => completion,
  };
};
