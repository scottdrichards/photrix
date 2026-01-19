import "dotenv/config";
import path from "node:path";
import { discoverFiles } from "./indexDatabase/fileScanner.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { initializeCacheDirectories } from "./common/cacheUtils.ts";
import { createServer } from "./createServer.ts";
import { startBackgroundProcessExifMetadata } from "./indexDatabase/processExifMetadata.ts";
import { startBackgroundProcessFileInfoMetadata } from "./indexDatabase/processFileInfo.ts";
import { startBackgroundHLSEncoding } from "./indexDatabase/processHLSEncoding.ts";

const startServer = async () => {
  console.log("Starting photrix server...");

  await initializeCacheDirectories();
  console.log("[bootstrap] Cache directories initialized");

  const mediaRoot = process.env.MEDIA_ROOT || "./exampleFolder";
  console.log(`Starting indexing for: ${mediaRoot}`);

  const absolutePath = path.resolve(mediaRoot);

  console.log("[bootstrap] IndexDatabase starting...");
  const database = new IndexDatabase(absolutePath);
  console.log("[bootstrap] IndexDatabase done");

  // Start file discovery in the background (non-blocking)
  console.log("[bootstrap] Starting file discovery in background...");
  discoverFiles({ root: absolutePath, db: database }).then(() => {
    console.log("[bootstrap] File discovery complete, starting metadata processing...");
    startBackgroundMetadataProcessing(database, pauseBackgroundProcessMetadata);
  });

  let pauseBackgroundProcessMetadata = () => {
    // No-op until metadata processing starts
  };

  const startBackgroundMetadataProcessing = (db: IndexDatabase, currentPause: () => void) => {
    // Chain the metadata processors: file info → EXIF → HLS encoding
    const pauseFileInfo = startBackgroundProcessFileInfoMetadata(db, () => {
      // File info complete, start EXIF processing
      const pauseExif = startBackgroundProcessExifMetadata(db, () => {
        // EXIF complete, start HLS encoding for videos
        console.log("[bootstrap] Metadata processing complete, starting background HLS encoding...");
        pauseBackgroundProcessMetadata = startBackgroundHLSEncoding(db);
      });
      pauseBackgroundProcessMetadata = pauseExif;
    });
    pauseBackgroundProcessMetadata = pauseFileInfo;
  };

  createServer(database, absolutePath, {
    onRequest: () => pauseBackgroundProcessMetadata(),
  });

  console.log("[bootstrap] Server started - metadata processing will run in background");
};

// For testing etc,  you may wish to prevent it from starting
const noAutoStart = process.env.PHOTRIX_NO_AUTOSTART || process.env.VITEST_WORKER_ID;

if (!noAutoStart) {
  console.log("[bootstrap] Starting server");
  startServer().catch((error) => {
    console.error("[bootstrap] Failed to start server", error);
    process.exit(1);
  });
}
