import path from "path/win32";
import { walkFiles } from "../fileHandling/fileUtils.ts";
import { waitForBackgroundTasksEnabled } from "../common/backgroundTasksControl.ts";
import { IndexDatabase } from "./indexDatabase.ts";

export const fileScanner = async (
  database: IndexDatabase,
  onComplete?: () => void,
): Promise<() => void> => {
  const root = database.storagePath;

  const scan = async () => {
    console.log(`[fileWatcher] Discovering existing files in ${root}`);

    const batchSize = 500;
    let batch: string[] = [];
    let scannedFilesCount = 0;

    for (const absolutePath of walkFiles(root)) {
      await waitForBackgroundTasksEnabled();

      try {
        const relativePath = path.relative(root, absolutePath);
        batch.push(relativePath);
        if (batch.length >= batchSize) {
          await database.addPaths(batch);
          batch = [];
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[fileWatcher] failed to process ${absolutePath}: ${msg}`);
      }

      scannedFilesCount++;

      if (scannedFilesCount % 1_000 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      if (scannedFilesCount % 10000 === 0) {
        console.log(
          `[fileWatcher] Discovered ${scannedFilesCount} files... Current: ${absolutePath}`,
        );
      }
    }

    if (batch.length) {
      await database.addPaths(batch);
    }

    console.log(`[fileWatcher] Completed discovering ${scannedFilesCount} files`);
  };

  scan().then(() => onComplete?.());
  return () => {};
};
