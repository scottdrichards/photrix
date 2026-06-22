import "dotenv/config";
import { initializeCacheDirectories } from "./common/cacheUtils.ts";
import { startCacheEviction } from "./common/cacheEviction.ts";
import { logger } from "./observability/logger.ts";

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception — shutting down");
  process.exit(1);
});
import { createServer } from "./createServer.ts";
import { analyzeImage } from "./imageAnalysis/imageAnalysisWorker.ts";
import { processImageAnalysis } from "./imageAnalysis/processImageAnalysis.ts";
import { fileSystemScanFolder } from "./indexDatabase/fileSystemScanFolder.ts";
import { processExifMetadata } from "./indexDatabase/processExifMetadata.ts";
import { processFileInfoMetadata } from "./indexDatabase/processFileInfo.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { measureOperation } from "./observability/requestTrace.ts";
import { startTelemetry } from "./observability/telemetry.ts";
import { createTaskOrchestrator } from "./taskOrchestrator/taskOrchestrator.ts";
import { transcribeWithWhisper } from "./audioProcessing/whisperWorker.ts";
import { processAudioTranscription } from "./audioProcessing/processAudioTranscription.ts";
import { embedAudioWithClap } from "./audioProcessing/clapWorker.ts";
import { processAudioEmbedding } from "./audioProcessing/processAudioEmbedding.ts";

const startServer = async () => {
  await initializeCacheDirectories();
  startCacheEviction();

  const mediaRoot = process.env.MEDIA_ROOT || "./exampleFolder";
  const database = new IndexDatabase(mediaRoot);
  await database.init();

  const taskOrchestrator = createTaskOrchestrator();

  // When the background queue drains, the read connection goes quiet — the ideal
  // moment for a blocking WAL checkpoint to fully write back and truncate the WAL
  // (passive autocheckpoints get starved while background readers are busy). The
  // periodic timer in IndexDatabase covers the steady-state; this covers the gaps.
  taskOrchestrator.onQueueExhausted(() => {
    void database.checkpointWal();
  });

  taskOrchestrator.addTask(
    {
      name: "File system scan",
      start: () => fileSystemScanFolder(database),
      type: "diskInfo",
      // Discovering files is foundational for everything else, so it keeps
      // running under load and only yields to in-flight user requests.
      priority: "high",
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
      name: "Image analysis (faces + CLIP)",
      start: () => processImageAnalysis(database, analyzeImage),
      type: "imageAnalysis",
    },
    "background",
  );

  taskOrchestrator.addTask(
    {
      name: "Audio transcription (Whisper)",
      start: () => processAudioTranscription(database, transcribeWithWhisper),
      type: "audioTranscription",
    },
    "background",
  );

  taskOrchestrator.addTask(
    {
      name: "Audio embedding (CLAP)",
      start: () => processAudioEmbedding(database, embedAudioWithClap),
      type: "audioEmbedding",
    },
    "background",
  );

  const server = createServer(database, mediaRoot, {
    taskOrchestrator,
  });

  logger.info({ mediaRoot, port: process.env.PORT ?? 3000 }, "Server started");

  // Graceful shutdown: stop accepting new connections and let in-flight requests
  // drain, then exit. A hard timeout guards against connections that never close.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");

    const forceExit = setTimeout(() => {
      logger.warn("Forced exit after shutdown timeout");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close((err) => {
      if (err) {
        logger.error({ err }, "Error while closing server");
        process.exit(1);
      }
      logger.info("Shutdown complete");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

await startTelemetry();

await measureOperation("bootstrap.startServer", startServer, {
  category: "other",
  detail: "server-bootstrap",
  logWithoutRequest: true,
});
