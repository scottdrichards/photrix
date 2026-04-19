import { walkFiles } from "../fileHandling/fileUtils.ts";
import { IndexDatabase } from "./indexDatabase.ts";

export function* batchGenerator<T>(
  generator: Generator<T>,
  batchSize: number,
): Generator<T[]> {
  while (true) {
    const batch = generator.take(batchSize).toArray();
    if (batch.length === 0) {
      break;
    }
    yield batch;
  }
}

export const fileScanner = async (database: IndexDatabase, onComplete?: () => void) => {
  const root = database.storagePath;

  console.log(`[fileWatcher] Discovering existing files in ${root}`);

  const batchSize = 500;
  let scannedFilesCount = 0;

  for (const batch of batchGenerator(walkFiles(root), batchSize)) {
    await database.addPaths(batch);
    scannedFilesCount += batch.length;
    console.log(
      `[fileWatcher] Discovered ${scannedFilesCount.toLocaleString()} files... Current: ${batch[batch.length - 1]}`,
    );
  }

  console.log(
    `[fileWatcher] Completed discovering ${scannedFilesCount.toLocaleString()} files`,
  );
  onComplete?.();
};
