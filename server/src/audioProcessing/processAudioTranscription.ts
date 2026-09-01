import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getLogger } from "../observability/logger.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";
import { isWorkerEvictedError } from "../taskOrchestrator/computeWorkers.ts";

const log = getLogger("processAudioTranscription");

const DB_BATCH_SIZE = 10;
// One at a time. There is a single Whisper worker process and it handles
// requests serially, so dispatching two buys no concurrency — it only starts
// the second request's timeout clock while it sits in the queue behind the
// first. With a long first file that guaranteed the second timed out having
// never been looked at, and then be recorded as a failure.
const PARALLELISM = 1;

export const processAudioTranscription = (
  database: IndexDatabase,
  transcribe: (
    videoPath: string,
    durationSeconds?: number,
  ) => Promise<Array<{ start: number; end: number; text: string }>>,
): TaskRunner => {
  const ctrl = createTaskController("Audio transcription cancelled");

  const completion: Promise<void> = (async () => {
    while (true) {
      ctrl.checkCancelled();

      const items = await database.getFilesNeedingAudioTranscription(DB_BATCH_SIZE);
      if (!items.length) {
        ctrl.markComplete();
        return;
      }

      for (const chunk of batch(items, PARALLELISM)) {
        ctrl.checkCancelled();
        await ctrl.waitUntilResumed();
        ctrl.checkCancelled();

        await Promise.all(
          chunk.map(async ({ relativePath, durationSeconds }) => {
            const fullPath = path.join(
              database.storagePath,
              stripLeadingSlash(relativePath),
            );
            try {
              const segments = await transcribe(fullPath, durationSeconds);
              await database.saveAudioTranscription(relativePath, segments);
            } catch (error) {
              if (isWorkerEvictedError(error)) {
                // The worker was killed by us (GPU reclaimed for playback /
                // shutdown), not because this file is bad. Leave it pending so
                // the next pass retries it instead of poisoning its record.
                log.info(
                  { path: relativePath },
                  "Audio transcription interrupted by worker eviction; will retry",
                );
                return;
              }
              log.warn({ err: error, path: relativePath }, "Audio transcription failed");
              await database.saveAudioTranscriptionError(relativePath);
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
      const [total, done] = await database.getAudioTranscriptionProgress();
      return {
        state: ctrl.state,
        itemsProcessed: done,
        total,
        portionComplete: total > 0 ? done / total : undefined,
      };
    },
    onComplete: () => completion,
  };
};
