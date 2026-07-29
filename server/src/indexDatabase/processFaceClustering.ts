import { getLogger } from "../observability/logger.ts";
import type { IndexDatabase } from "./indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";

const log = getLogger("processFaceClustering");

// Chunk boundary for pause/cancel. Late in a large backfill a face can cost
// several milliseconds (it scans every cluster centroid), so a modest batch
// keeps the task responsive to the orchestrator's duty cycle; the engine
// itself yields the event loop within a batch.
const BATCH_SIZE = 64;

/**
 * Assigns persistent cluster ids to faces that don't have one yet — the
 * one-time migration for faces detected before clustering was persisted, and
 * the retry path for faces whose inline assignment (at detection time) failed.
 * The People tab reads whatever is assigned so far, so progress is visible
 * while this runs.
 */
export const processFaceClustering = (database: IndexDatabase): TaskRunner => {
  const ctrl = createTaskController("Face clustering cancelled");

  const completion: Promise<void> = (async () => {
    let totalAssigned = 0;
    while (true) {
      ctrl.checkCancelled();
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();

      const processed = await database.clusterPendingFaces(BATCH_SIZE);
      if (!processed) break;
      totalAssigned += processed;
    }

    await database.pruneEmptyFaceClusters();
    if (totalAssigned > 0) {
      log.info({ totalAssigned }, "Face clustering backlog drained");
    }

    // Now that membership is settled, rescore drifted clusters' stored
    // similarities so the People tab's representative tracks the real centroid
    // instead of the (stale) seed face. Cheap when nothing is stale — it's an
    // in-memory weight check that reads no embeddings unless a cluster grew
    // past the refresh threshold.
    let totalRefreshed = 0;
    while (true) {
      ctrl.checkCancelled();
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();

      const refreshed = await database.refreshStaleClusterSimilarities();
      if (!refreshed) break;
      totalRefreshed += refreshed;
    }
    if (totalRefreshed > 0) {
      log.info({ totalRefreshed }, "Refreshed drifted cluster similarities");
    }

    ctrl.markComplete();
  })();

  return {
    pause: ctrl.pause,
    resume: ctrl.resume,
    cancel: ctrl.cancel,
    getStatus: async () => {
      const { assigned, pending } = await database.getFaceClusteringProgress();
      const total = assigned + pending;
      return {
        state: ctrl.state,
        itemsProcessed: assigned,
        total,
        portionComplete: total > 0 ? assigned / total : undefined,
      };
    },
    onComplete: () => completion,
  };
};
