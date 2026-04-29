import path from "node:path";
import { walkFiles } from "../fileHandling/fileUtils.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "./indexDatabase.ts";

/**
 * Does an entire scan of the files in the database's storage path and adds them to the database.
 */
export const fileSystemScanFolder = async (
  database: IndexDatabase,
  subFolder?: string,
) => {
  const base = path.join(database.storagePath, subFolder ?? "");

  const batchSize = 500;
  let scannedFilesCount = 0;

  for (const absolutePathsBatch of batch(walkFiles(base), batchSize)) {
    const relativePathsBatch = absolutePathsBatch.map((absolutePath) =>
      path.relative(database.storagePath, absolutePath),
    );
    await database.addPaths(relativePathsBatch);
    scannedFilesCount += relativePathsBatch.length;
  }
};
