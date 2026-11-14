import { rm } from "fs/promises";
import { getMirroredCacheBaseDirectory, getMirroredHLSDirectory } from "../common/cacheUtils.ts";
import { closeHlsWatchersUnder } from "../videoProcessing/hlsSegmentWatcher.ts";

/**
 * Removes every cached derivative (thumbnails, image variants, HLS segments) for
 * a source file. The mirrored media cache is keyed by path only — unlike
 * {@link getHash} it does not fold in the modified time — so when a file's bytes
 * change in place the old derivatives must be deleted explicitly or they would
 * be served stale.
 */
export const clearMirroredCacheForFile = async (filePath: string): Promise<void> => {
  // Close any live HLS watcher inside the tree first. A recursive fs.watch whose
  // directories are deleted underneath it throws ENOENT from its internal
  // re-scan, which Node raises as a watcher "error" — fatal if unhandled.
  closeHlsWatchersUnder(getMirroredHLSDirectory(filePath));
  await Promise.all([
    rm(getMirroredCacheBaseDirectory(filePath), { recursive: true, force: true }),
    rm(getMirroredHLSDirectory(filePath), { recursive: true, force: true }),
  ]);
};
