import "dotenv/config";
import path from "node:path";
import { discoverFiles } from "./indexDatabase/fileScanner.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { initializeCacheDirectories } from "./common/cacheUtils.ts";
import { createServer } from "./createServer.ts";
import { startBackgroundProcessExifMetadata } from "./indexDatabase/processExifMetadata.ts";
import { startBackgroundProcessFileInfoMetadata } from "./indexDatabase/processFileInfo.ts";

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

  console.log("[bootstrap] Doing file discovery ...");
  await discoverFiles({ root: absolutePath, db: database });
  console.log("[bootstrap] file discovery done");


  let pauseBackgroundProcessMetadata = () => {
    console.warn("[bootstrap] pauseBackgroundProcessMetadata called before being set");
  };

  createServer(database, absolutePath, {
    onRequest: pauseBackgroundProcessMetadata,
  });

  await new Promise<void>((resolve) => {
    pauseBackgroundProcessMetadata = startBackgroundProcessFileInfoMetadata(database, resolve);
  });
  await new Promise<void>((resolve) => {
    pauseBackgroundProcessMetadata = startBackgroundProcessExifMetadata(database, resolve);
  });
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
