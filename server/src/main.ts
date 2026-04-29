import "dotenv/config";
import { initializeCacheDirectories } from "./common/cacheUtils.ts";
import { createServer } from "./createServer.ts";
import { fileSystemScanFolder } from "./indexDatabase/fileSystemScanFolder.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { measureOperation } from "./observability/requestTrace.ts";
import { startTelemetry } from "./observability/telemetry.ts";
import { createTaskOrchestrator } from "./taskOrchestrator/taskOrchestrator.ts";

const startServer = async () => {
  await initializeCacheDirectories();

  const mediaRoot = process.env.MEDIA_ROOT || "./exampleFolder";
  const database = new IndexDatabase(mediaRoot);
  await database.init();

  const taskOrchestrator = createTaskOrchestrator();
  taskOrchestrator.addTask(async () => {
    await fileSystemScanFolder(database);
  }, "background");
  createServer(database, mediaRoot, {
    taskOrchestrator,
  });
};

await startTelemetry();

await measureOperation("bootstrap.startServer", startServer, {
  category: "other",
  detail: "server-bootstrap",
  logWithoutRequest: true,
});
