import { toRelative, walkFiles } from "../fileHandling/fileUtils.ts";
import { IndexDatabase } from "./indexDatabase.ts";

type DiscoverFilesProps = {
  /** Full path - defaults to root */
  directory?: string;
  root: string;
  db: IndexDatabase;
}
export const discoverFiles = async (props:DiscoverFilesProps): Promise<void> => {
  const { root, directory = root, db } = props;
    console.log(`[fileWatcher] Discovering existing files in ${directory}`);
    
    /** How many sqlite inserts to batch together. Doing them one at a time is way too slow */
    const batchSize = 500;
    let batch: string[] = [];
    let scannedFilesCount = 0;

    for (const absolutePath of walkFiles(directory)) {
      const relativePath = toRelative(root, absolutePath);
      batch.push(relativePath);
      if (batch.length >= batchSize) {
        db.addPaths(batch);
        batch = [];
      }

      scannedFilesCount++;

      if (scannedFilesCount % 10000 === 0) {
        console.log(`[fileWatcher] Discovered ${scannedFilesCount} files... Current: ${relativePath}`);
      }
    }

    if (batch.length) {
      db.addPaths(batch);
    }

    console.log(`[fileWatcher] Completed discovering ${scannedFilesCount} files`);
  }