import path from "node:path";
import { walkFiles } from "../fileHandling/fileUtils.ts";
import { batch } from "../utils.ts";
import { IndexDatabase } from "./indexDatabase.ts";

const scanProgressIntervalMs = 250;

const fitLineToTerminalWidth = (line: string) => {
  if (!process.stdout.isTTY) {
    return line;
  }

  const maxWidth = Math.max(1, process.stdout.columns - 1);
  return line.length > maxWidth
    ? line.slice(0, maxWidth - 3) + "..."
    : line + " ".repeat(maxWidth - line.length);
};

const renderScanProgress = (
  scannedItemsCount: number,
  currentItem: string,
  state: "first" | "continuing" | "last",
) => {
  const prefix = state === "first" ? "" : "\u001b[2F";
  const countMessage = `Found ${scannedItemsCount.toLocaleString()} items`;
  const itemMessage =
    state === "last" ? "Scan complete!" : `Current item: ${currentItem}`;

  const message = [countMessage, itemMessage]
    .map((m) => fitLineToTerminalWidth(m) + "\n")
    .join("");
  process.stdout.write(prefix + message);
};

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
  let lastProgressRenderTime = 0;

  for (const absolutePathsBatch of batch(walkFiles(base), batchSize)) {
    const relativePathsBatch = absolutePathsBatch.map((absolutePath) =>
      path.relative(database.storagePath, absolutePath),
    );
    await database.addPaths(relativePathsBatch);
    scannedFilesCount += relativePathsBatch.length;

    const now = Date.now();
    if (now - lastProgressRenderTime >= scanProgressIntervalMs) {
      const firstRun = lastProgressRenderTime === 0;
      renderScanProgress(
        scannedFilesCount,
        relativePathsBatch[relativePathsBatch.length - 1],
        firstRun ? "first" : "continuing",
      );
      lastProgressRenderTime = now;
    }
  }
  renderScanProgress(scannedFilesCount, "", "last");
};
