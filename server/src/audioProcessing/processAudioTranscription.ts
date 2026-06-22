import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getLogger } from "../observability/logger.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";

const log = getLogger("processAudioTranscription");

const DB_BATCH_SIZE = 10;
const PARALLELISM = 2;

export const processAudioTranscription = (
  database: IndexDatabase,
  transcribe: (videoPath: string) => Promise<Array<{ start: number; end: number; text: string }>>,
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
          chunk.map(async ({ relativePath }) => {
            const fullPath = path.join(
              database.storagePath,
              stripLeadingSlash(relativePath),
            );
            try {
              const segments = await transcribe(fullPath);
              await database.saveAudioTranscription(relativePath, segments);
            } catch (error) {
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
