import "dotenv/config";
import { initializeCacheDirectories } from "./common/cacheUtils.ts";
import { createServer } from "./createServer.ts";
import { detectFacesWithInsightFace } from "./faceDetection/insightFaceDetector.ts";
import { processFaceDetection } from "./faceDetection/processFaceDetection.ts";
import { fileSystemScanFolder } from "./indexDatabase/fileSystemScanFolder.ts";
import { processExifMetadata } from "./indexDatabase/processExifMetadata.ts";
import { processFileInfoMetadata } from "./indexDatabase/processFileInfo.ts";
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

  taskOrchestrator.addTask(
    {
      name: "File system scan",
      start: () => fileSystemScanFolder(database),
      type: "diskInfo",
    },
    "background",
  );

  taskOrchestrator.addTask(
    {
      name: "File metadata processing",
      start: () => processFileInfoMetadata(database),
      type: "mediaMedatadata",
    },
    "background",
  );

  taskOrchestrator.addTask(
    {
      name: "EXIF metadata processing",
      start: () => processExifMetadata(database),
      type: "mediaMedatadata",
    },
    "background",
  );

  taskOrchestrator.addTask(
    {
      name: "Face detection",
      start: () => processFaceDetection(database, detectFacesWithInsightFace),
      type: "faceDetection",
    },
    "background",
  );

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
