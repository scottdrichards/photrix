import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { measureOperation } from "../observability/requestTrace.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import { stat } from "node:fs/promises";
import { FileInfo } from "./fileRecord.type.ts";

const getFileInfoMetadata = async (fullPath: string): Promise<FileInfo> => {
  const stats = await stat(fullPath);
  return {
    sizeInBytes: stats.size,
    created: new Date(stats.birthtimeMs),
    modified: new Date(stats.mtimeMs),
  };
};

export const startBackgroundProcessFileInfoMetadata = async (
  database: IndexDatabase,
  waitForEnabled: () => Promise<void>,
  onComplete?: () => void,
) => {
  let restartAtMS = 0;

  const processAll = async () => {
    while (true) {
      const batchSize = 200;
      const items = await database.getFilesNeedingMetadataUpdate("info", batchSize);
      if (!items.length) {
        onComplete?.();
        return;
      }

      for (const entry of items) {
        await waitForEnabled();

        const { relativePath } = entry;
        try {
          await measureOperation(
            "metadata.fileInfo.processEntry",
            async () => {
              const fullPath = path.join(
                database.storagePath,
                stripLeadingSlash(relativePath),
              );
              const metadata = await getFileInfoMetadata(fullPath);
              await database.addOrUpdateFileData(relativePath, metadata);
            },
            { category: "other", detail: relativePath, logWithoutRequest: true },
          );
        } catch {
          await database.addOrUpdateFileData(relativePath, {
            infoProcessedAt: new Date().toISOString(),
          });
        }

        while (restartAtMS && restartAtMS > Date.now()) {
          const timeoutDuration = restartAtMS - Date.now();
          await new Promise((resolve) => setTimeout(resolve, timeoutDuration));
        }
      }
    }
  };

  void processAll();

  const pause = (durationMS: number = 10_000) => {
    const localRestartMs = Date.now() + durationMS;
    restartAtMS = Math.max(restartAtMS, localRestartMs);
  };

  return pause;
};
