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
import { analyzeImage, embedText } from "./imageAnalysis/imageAnalysisWorker.ts";
import { processImageAnalysis } from "./imageAnalysis/processImageAnalysis.ts";
import { fileSystemScanFolder } from "./indexDatabase/fileSystemScanFolder.ts";
import { processExifMetadata } from "./indexDatabase/processExifMetadata.ts";
import { processFileInfoMetadata } from "./indexDatabase/processFileInfo.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { measureOperation } from "./observability/requestTrace.ts";
import { startTelemetry } from "./observability/telemetry.ts";
import { createTaskOrchestrator } from "./taskOrchestrator/taskOrchestrator.ts";
import {
  resumeComputeWorkers,
  suspendComputeWorkers,
} from "./taskOrchestrator/computeWorkers.ts";
import { transcribeWithWhisper } from "./audioProcessing/whisperWorker.ts";
import { processAudioTranscription } from "./audioProcessing/processAudioTranscription.ts";
import { embedAudioWithClap, embedTextWithClap } from "./audioProcessing/clapWorker.ts";
import { processAudioEmbedding } from "./audioProcessing/processAudioEmbedding.ts";
import { detectCuda } from "./audioProcessing/detectCuda.ts";

const startServer = async () => {
  await initializeCacheDirectories();
  startCacheEviction();

  const mediaRoot = process.env.MEDIA_ROOT || "./exampleFolder";
  const database = new IndexDatabase(mediaRoot);
  await database.init();

  const taskOrchestrator = createTaskOrchestrator({
    // Freeze the heavy ML worker processes (SIGSTOP) while a user request is in
    // flight so their in-flight native passes yield the CPU immediately, and
    // thaw them (SIGCONT) once the request window lapses. Restartable by design:
    // models stay loaded, so this is far cheaper than killing and respawning.
    computeThrottle: {
      suspend: suspendComputeWorkers,
      resume: resumeComputeWorkers,
    },
  });
  // Prime semantic search before the background backlog starts churning, so the
  // first query after a restart is fast instead of timing out. Three independent
  // cold costs are warmed:
  //   - the vector scan reads every image-embedding BLOB; cold, that read alone
  //     can exceed the search timeout (warmSemanticSearch);
  //   - the CLIP text model loads lazily on first use (~seconds);
  //   - the CLAP audio model likewise — and a search awaits all enabled sources,
  //     so a cold CLAP that times out at 15s pins the whole response there even
  //     when the image results already resolved.
  // Bracketed as a user request so background ML work stays suspended while the
  // models load: cold, those loads otherwise lose the CPU to the analysis
  // backlog and take a minute-plus, during which early queries time out. Tasks
  // are added below *after* this begins, so none churn until warmup completes.
  // Best-effort: failures are logged, never block startup, and always release
  // the request bracket so background work resumes.
  // The vector scan warm must run AFTER the ML model warmups — model weight
  // files are several GBs and their page-cache footprint evicts the 347 MB of
  // embedding blobs that a concurrent warmSemanticSearch would have just loaded.
  // Running the scan last (sequentially) ensures it warms pages that will
  // actually stay hot for the first real queries.
  taskOrchestrator.beginUserRequest();
  void Promise.allSettled([
    embedText("warmup").then(() => logger.info("CLIP text-embedding model warmed")),
    embedTextWithClap("warmup").then(() =>
      logger.info("CLAP text-embedding model warmed"),
    ),
  ]).then(async (modelResults) => {
    const scanResult = await Promise.allSettled([
      database
        .warmSemanticSearch()
        .then(() => logger.info("Semantic search vector cache warmed")),
    ]);
    taskOrchestrator.endUserRequest();
    for (const r of [...modelResults, ...scanResult]) {
      if (r.status === "rejected") {
        logger.warn({ err: r.reason }, "Search warmup step failed (non-fatal)");
      }
    }
    logger.info("Semantic search warmup complete");
  });

  const cudaAvailable = await detectCuda();
  logger.info({ cudaAvailable }, "CUDA detection complete");
  // On GPU the audio workers run on the GPU and barely touch CPU, so they don't
  // conflict with the CPU-bound image-analysis task and can run concurrently.
  const audioComputeResources = cudaAvailable ? { gpu: 0.5 } : { cpu: 0.5 };

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
      resources: { ...audioComputeResources, memoryMB: 3500 },
    },
    "background",
  );

  taskOrchestrator.addTask(
    {
      name: "Audio embedding (CLAP)",
      start: () => processAudioEmbedding(database, embedAudioWithClap),
      type: "audioEmbedding",
      resources: { ...audioComputeResources, memoryMB: 2000 },
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
