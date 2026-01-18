import path from "path/win32";
import { walkFiles } from "../fileHandling/fileUtils.ts";
import { IndexDatabase } from "./indexDatabase.ts";

type DiscoverFilesProps = {
  /** Full path - defaults to root */
  directory?: string;
  root: string;
  db: IndexDatabase;
}

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

    const relativePath = path.relative(root, absolutePath);
    batch.push(relativePath);
    if (batch.length >= batchSize) {
      db.addPaths(batch);
      batch = [];
    }

    scannedFilesCount++;

    if (scannedFilesCount % 1_000 === 0) {
      // Free up the stack to allow handling interrupts
      await new Promise((resolve) => setImmediate(resolve));
    }

    if (scannedFilesCount % 10000 === 0) {
      console.log(`[fileWatcher] Discovered ${scannedFilesCount} files... Current: ${relativePath}`);
    }
  }

  // Add any remaining files in the batch
  if (batch.length) {
    db.addPaths(batch);
  }

  console.log(`[fileWatcher] Completed discovering ${scannedFilesCount} files`);
}