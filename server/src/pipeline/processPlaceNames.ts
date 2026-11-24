import { getLogger } from "../observability/logger.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { placeTextFor } from "../places/placeNames.ts";

const log = getLogger("processPlaceNames");

// A lookup is microseconds; the batch only bounds the write transaction and
// how often the task can pause or be cancelled.
const BATCH_SIZE = 500;

/** Writes searchable place text onto geotagged files that do not have it yet (feedback #203). */
export const processPlaceNames = (database: IndexDatabase): TaskRunner => {
  const ctrl = createTaskController("Place naming cancelled");

  const completion: Promise<void> = (async () => {
    let total = 0;
    while (true) {
      ctrl.checkCancelled();
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();

      const files = await database.places.getPlaceBackfillBatch(BATCH_SIZE);
      if (files.length === 0) break;
      await database.places.setPlaceTexts(
        files.map(({ folder, fileName, lat, lon }) => ({
          folder,
          fileName,
          placeText: placeTextFor(lat, lon),
        })),
      );
      total += files.length;
    }
    if (total > 0) log.info({ total }, "Place names backfilled");
    ctrl.markComplete();
  })();

  return {
    pause: ctrl.pause,
    resume: ctrl.resume,
    cancel: ctrl.cancel,
    getStatus: async () => {
      const { processed, pending } = await database.places.getPlaceProgress();
      const total = processed + pending;
      return {
        state: ctrl.state,
        itemsProcessed: processed,
        total,
        portionComplete: total > 0 ? processed / total : undefined,
      };
    },
    onComplete: () => completion,
  };
};
