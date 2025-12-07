import "dotenv/config";
import path from "node:path";
import { FileScanner } from "./indexDatabase/fileScanner.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { initializeCacheDirectories } from "./common/cacheUtils.ts";
import { createServer } from "./createServer.ts";

const startServer = async () => {
  console.log("Starting photrix server...");

  await initializeCacheDirectories();
  console.log("[bootstrap] Cache directories initialized");

  const mediaRoot = process.env.MEDIA_ROOT || "./exampleFolder";
  console.log(`Starting indexing for: ${mediaRoot}`);

  const absolutePath = path.resolve(mediaRoot);

  console.log("[bootstrap] IndexDatabase starting...");
  const database = new IndexDatabase(absolutePath);
  await database.load();
  console.log("[bootstrap] IndexDatabase done");

  console.log("[bootstrap] FileScanner starting...");
  const fileScanner = new FileScanner(absolutePath, database);
  console.log("[bootstrap] FileScanner done");

  createServer(database, absolutePath, fileScanner);
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
