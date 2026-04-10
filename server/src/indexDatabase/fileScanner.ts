import path from "path/win32";
import { walkFiles } from "../fileHandling/fileUtils.ts";
import { waitForBackgroundTasksEnabled } from "../common/backgroundTasksControl.ts";
import { IndexDatabase } from "./indexDatabase.ts";

type DiscoverFilesProps = {
  /** Full path - defaults to root */
  directory?: string;
  root: string;
  db: IndexDatabase;
};

export const discoverFiles = async (props: DiscoverFilesProps): Promise<void> => {
  const { root, directory = root, db } = props;

  if (path.relative(root, directory).startsWith("..")) {
    throw new Error(`Directory ${directory} is outside of root ${root}`);
  }

  console.log(`[fileWatcher] Discovering existing files in ${directory}`);

  /** How many sqlite inserts to batch together. Doing them one at a time is way too slow */
  const batchSize = 500;
  let batch: string[] = [];
  let scannedFilesCount = 0;

  for (const absolutePath of walkFiles(directory)) {
    await waitForBackgroundTasksEnabled();

    try {
      const relativePath = path.relative(root, absolutePath);
      batch.push(relativePath);
      if (batch.length >= batchSize) {
        await db.addPaths(batch);
        batch = [];
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[fileWatcher] failed to process ${absolutePath}: ${msg}`);
    }

    scannedFilesCount++;

    if (scannedFilesCount % 1_000 === 0) {
      // Free up the stack to allow handling interrupts
      await new Promise((resolve) => setImmediate(resolve));
    }

    if (scannedFilesCount % 10000 === 0) {
      console.log(
        `[fileWatcher] Discovered ${scannedFilesCount} files... Current: ${absolutePath}`,
      );
    }
  }

  // Add any remaining files in the batch
  if (batch.length) {
    await db.addPaths(batch);
  }

  console.log(`[fileWatcher] Completed discovering ${scannedFilesCount} files`);
};
