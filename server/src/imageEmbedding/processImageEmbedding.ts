import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";

const DB_BATCH_SIZE = 50;
const PARALLELISM = 16;

export const processImageEmbedding = (
  database: IndexDatabase,
  embedImage: (imagePath: string) => Promise<Float32Array>,
): TaskRunner => {
  let state: "running" | "paused" | "cancelled" | "complete" = "running";
  let resumeSignal: (() => void) | null = null;

  const cancelledError = new Error("Image embedding processing cancelled");

  const waitUntilResumed = async () => {
    if (state !== "paused") return;
    await new Promise<void>((resolve) => {
      resumeSignal = resolve;
    });
  };

  const completion: Promise<void> = (async () => {
    while (true) {
      // @ts-expect-error - false positive type narrowing with mutable captured variable in async context
      if (state === "cancelled") throw cancelledError;

      const items = await database.getFilesNeedingEmbedding(DB_BATCH_SIZE);
      if (!items.length) {
        state = "complete";
        return;
      }

      for (const chunk of batch(items, PARALLELISM)) {
        // @ts-expect-error - false positive type narrowing with mutable captured variable in async context
        if (state === "cancelled") throw cancelledError;
        await waitUntilResumed();
        // @ts-expect-error - false positive type narrowing with mutable captured variable in async context
        if (state === "cancelled") throw cancelledError;

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
    pause: () => {
      if (state === "running") state = "paused";
    },
    resume: () => {
      if (state === "paused") state = "running";
      resumeSignal?.();
      resumeSignal = null;
      return Promise.resolve();
    },
    cancel: () => {
      state = "cancelled";
      resumeSignal?.();
      resumeSignal = null;
    },
    getStatus: async () => {
      const [total, done] = await database.getEmbeddingProgress();
      return {
        state,
        itemsProcessed: done,
        total,
        portionComplete: total > 0 ? done / total : undefined,
      };
    },
    onComplete: () => completion,
  };
};
