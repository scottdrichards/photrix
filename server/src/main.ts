import "dotenv/config";
import { initializeCacheDirectories } from "./common/cacheUtils.ts";
import { createServer } from "./createServer.ts";
import { fileSystemScanFolder } from "./indexDatabase/fileSystemScanFolder.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { measureOperation } from "./observability/requestTrace.ts";
import { startTelemetry } from "./observability/telemetry.ts";
import { createTaskOrchestrator } from "./taskOrchestrator/taskOrchestrator.ts";

const startServer = async () => {
  console.log("Starting photrix server...");
  await initializeCacheDirectories();

  const mediaRoot = process.env.MEDIA_ROOT || "./exampleFolder";

  console.log("[bootstrap] IndexDatabase starting...");
  const database = new IndexDatabase(mediaRoot);
  await measureOperation("bootstrap.indexDatabase", () => database.init(), {
    category: "db",
    logWithoutRequest: true,
  });
  console.log("[bootstrap] IndexDatabase done");

  await fileSystemScanFolder(database);

  const taskOrchestrator = createTaskOrchestrator(database);

  taskOrchestrator.setProcessBackgroundTasks(false);
  createServer(database, mediaRoot, {
    taskOrchestrator,
  });

  console.log("[bootstrap] Server started");
};

await startTelemetry();

await measureOperation("bootstrap.startServer", startServer, {
  category: "other",
  detail: "server-bootstrap",
  logWithoutRequest: true,
});
