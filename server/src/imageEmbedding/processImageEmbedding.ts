import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";

const DB_BATCH_SIZE = 50;
const PARALLELISM = 16;

export const processImageEmbedding = (
  database: IndexDatabase,
  embedImage: (imagePath: string) => Promise<Float32Array>,
): TaskRunner => {
  const ctrl = createTaskController("Image embedding processing cancelled");

  const completion: Promise<void> = (async () => {
    while (true) {
      ctrl.checkCancelled();

      const items = await database.getFilesNeedingEmbedding(DB_BATCH_SIZE);
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
              const embedding = await embedImage(fullPath);
              await database.saveImageEmbedding(relativePath, embedding);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(`[imageEmbedding] Failed to embed ${relativePath}: ${message}`);
              await database.saveImageEmbeddingError(relativePath);
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
      const [total, done] = await database.getEmbeddingProgress();
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
