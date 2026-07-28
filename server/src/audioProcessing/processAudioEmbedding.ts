import path from "node:path";
import { access } from "node:fs/promises";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { getLogger } from "../observability/logger.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";
import { isWorkerEvictedError } from "../taskOrchestrator/computeWorkers.ts";

const log = getLogger("processAudioEmbedding");

const DB_BATCH_SIZE = 10;
// CLAP runs in a single shared worker process. Dispatching multiple background
// embeds at once only queues them inside that worker, so later requests burn
// their timeout budget before they even start running.
const PARALLELISM = 1;

export const processAudioEmbedding = (
  database: IndexDatabase,
  embedAudio: (videoPath: string) => Promise<Float32Array>,
): TaskRunner => {
  const ctrl = createTaskController("Audio embedding cancelled");

  const completion: Promise<void> = (async () => {
    while (true) {
      ctrl.checkCancelled();

      const items = await database.getFilesNeedingAudioEmbedding(DB_BATCH_SIZE);
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
              await access(fullPath);
            } catch {
              log.warn(
                { path: relativePath },
                "Audio embedding skipped: file not found at storage path",
              );
              await database.markAudioEmbeddingSkipped(relativePath);
              return;
            }
            try {
              const embedding = await embedAudio(fullPath);
              await database.saveAudioEmbedding(relativePath, embedding);
            } catch (error) {
              if (isWorkerEvictedError(error)) {
                // The worker was killed by us (GPU reclaimed for playback /
                // shutdown), not because this file is bad. Leave it pending so
                // the next pass retries it instead of poisoning its record.
                log.info(
                  { path: relativePath },
                  "Audio embedding interrupted by worker eviction; will retry",
                );
                return;
              }
              log.warn({ err: error, path: relativePath }, "Audio embedding failed");
              await database.saveAudioEmbeddingError(relativePath);
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
      const [total, done] = await database.getAudioEmbeddingProgress();
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
