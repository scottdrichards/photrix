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
import {
  analyzeFaceAttributes,
  analyzeImage,
  embedText,
} from "./imageAnalysis/imageAnalysisWorker.ts";
import { processImageAnalysis } from "./imageAnalysis/processImageAnalysis.ts";
import { processFaceAttributes } from "./imageAnalysis/processFaceAttributes.ts";
import { fileSystemScanFolder } from "./indexDatabase/fileSystemScanFolder.ts";
import { fileSystemMonitorFolder } from "./indexDatabase/fileSystemMonitorFolder.ts";
import { startPeriodicRescan } from "./indexDatabase/fileSystemRescanRecent.ts";
import { processExifMetadata } from "./indexDatabase/processExifMetadata.ts";
import { processFileInfoMetadata } from "./indexDatabase/processFileInfo.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { processFaceClustering } from "./indexDatabase/processFaceClustering.ts";
import { processMomentClustering } from "./indexDatabase/processMomentClustering.ts";
import { initAuthService } from "./auth/authService.ts";
import { initPasskeyService } from "./auth/passkeyService.ts";
import { measureOperation } from "./observability/requestTrace.ts";
import { startTelemetry } from "./observability/telemetry.ts";
import { createTaskOrchestrator } from "./taskOrchestrator/taskOrchestrator.ts";
import {
  resumeComputeWorkers,
  suspendComputeWorkers,
  releaseGpuReclaim,
  shutdownComputeWorkers,
} from "./taskOrchestrator/computeWorkers.ts";
import { reapOrphanedComputeWorkers } from "./taskOrchestrator/reapOrphanedWorkers.ts";
import { transcribeWithWhisper } from "./audioProcessing/whisperWorker.ts";
import { processAudioTranscription } from "./audioProcessing/processAudioTranscription.ts";
import { embedAudioWithClap, embedTextWithClap } from "./audioProcessing/clapWorker.ts";
import { processAudioEmbedding } from "./audioProcessing/processAudioEmbedding.ts";
import {
  detectCuda,
  detectOnnxRuntimeCudaProvider,
} from "./audioProcessing/detectCuda.ts";
import { registerBackgroundTasks } from "./backgroundTasks/registerBackgroundTasks.ts";
import { setPlaybackLifecycleHooks } from "./videoProcessing/hlsSession.ts";
import { resolveDetectedImageAnalysisEnv } from "./imageAnalysis/imageAnalysisRuntime.ts";
import {
  ensureImageConversionReady,
  shutdownImageConversionWorkers,
} from "./imageProcessing/convertImage.ts";
import { startMcpServer } from "./mcp/mcpServer.ts";

const startServer = async () => {
  // Kill any ML workers left resident by a prior instance before we spawn our
  // own. Node doesn't reap its attached children on exit, so every restart
  // (graceful or hard-killed) otherwise leaks a full set of GPU-resident
  // workers; on a small card those orphans starve user video transcodes off
  // NVENC/NVDEC and into a buffering libx264 fallback. Must run before any of
  // our own workers spawn (below) so it can't kill them.
  await reapOrphanedComputeWorkers();

  await initializeCacheDirectories();
  startCacheEviction();

  // Serving photos is core, and the conversion path shells out to Python. Validate
  // the interpreter and its image dependencies up front so a broken setup fails
  // loudly at boot with an actionable message, rather than silently 422-ing every
  // image request once the app is already "up".
  try {
    await ensureImageConversionReady();
  } catch (err) {
    logger.fatal({ err }, "Image conversion unavailable — refusing to start");
    process.exit(1);
  }

  const mediaRoot = process.env.MEDIA_ROOT || "./exampleFolder";
  const database = new IndexDatabase(mediaRoot);
  await database.init();
  await initAuthService(database.asyncSqlite);
  initPasskeyService(database.asyncSqlite);

  const taskOrchestrator = createTaskOrchestrator({
    // Freeze the heavy ML worker processes (SIGSTOP) while a user request is in
    // flight so their in-flight native passes yield the CPU immediately, and
    // thaw them (SIGCONT) once the request window lapses. Restartable by design:
    // models stay loaded, so this is far cheaper than killing and respawning.
    computeThrottle: {
      suspend: suspendComputeWorkers,
      resume: resumeComputeWorkers,
      releaseReclaim: releaseGpuReclaim,
    },
  });
  // An active HLS playback counts as user activity for its entire session
  // lifetime (until the idle reaper fires), not just per segment fetch. A
  // buffering player goes HTTP-quiet for seconds at a time; without this the
  // 2s activity cooldown lapses mid-playback, background ML workers respawn
  // and refill the VRAM that was reclaimed for the transcode, and the next
  // ABR variant switch loses NVENC to a libx264 fallback that can't sustain
  // realtime above ~360p.
  setPlaybackLifecycleHooks({
    onSessionStart: () => taskOrchestrator.beginUserRequest(),
    onSessionEnd: () => taskOrchestrator.endUserRequest(),
  });

  // Bind the HTTP port now, before the GPU probes, model warmups, and background
  // ingestion wiring below. None of those are preconditions for serving the
  // library: CUDA detection only feeds background-ML scheduling, the warmups are
  // best-effort, and the ingestion tasks process *new* work. So anything that
  // blocks here is pure dead time during which the client gets connection-refused
  // (surfaced as a proxy 500) — and a cold `import torch` in detectCuda alone can
  // take several seconds. Everything after this line runs with the socket already
  // accepting requests, so existing photos load immediately and the rest warms in
  // behind it.
  const server = createServer(database, mediaRoot, {
    taskOrchestrator,
  });
  logger.info({ mediaRoot, port: process.env.PORT ?? 3000 }, "Server started");

  // Start the MCP server in-process alongside the main app by default, so AI
  // agents wired to it don't depend on a second process (`npm run mcp`) being
  // started and kept alive separately — a past source of orphaned processes
  // across restarts. Set MCP_AUTOSTART=false to keep running it standalone
  // instead (e.g. deploying it on a different host, per its README). Best
  // effort: a failure here (e.g. MCP_PORT already bound by a standalone
  // instance) is logged, not fatal — it never blocks serving photos.
  let mcpServer: Awaited<ReturnType<typeof startMcpServer>> | undefined;
  if (process.env.MCP_AUTOSTART !== "false") {
    try {
      mcpServer = await startMcpServer();
    } catch (err) {
      logger.warn({ err }, "MCP server failed to start (continuing without it)");
    }
  }

  const [cudaAvailable, faceCudaAvailable] = await Promise.all([
    detectCuda(),
    detectOnnxRuntimeCudaProvider(),
  ]);
  logger.info({ cudaAvailable, faceCudaAvailable }, "CUDA detection complete");
  // Emergency kill switch for the CLAP/Whisper worker class of bug (repeated
  // CUDA-init-failure/VRAM-exhaustion incidents, 2026-08-25/08-27): flipping
  // this skips spawning both audio workers entirely — no CLAP text warmup, no
  // audioTranscription/audioEmbedding background tasks — while still
  // satisfying `BackgroundTaskPlan`'s required keys (registerBackgroundTasks
  // gets a no-op runner for each instead of the real one). Meant to be
  // temporary on hardware with tight VRAM if this class of bug recurs, not a
  // permanent config knob.
  const audioDisabled = process.env.PHOTRIX_DISABLE_AUDIO === "1";
  if (audioDisabled) {
    logger.warn(
      "PHOTRIX_DISABLE_AUDIO=1: audio transcription and embedding are disabled for this run",
    );
  }
  Object.assign(
    process.env,
    resolveDetectedImageAnalysisEnv(process.env, {
      cudaAvailable,
      faceCudaAvailable,
    }),
  );
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
    audioDisabled
      ? Promise.resolve()
      : embedTextWithClap("warmup").then(() =>
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

  const { notifyFilesChanged } = registerBackgroundTasks(taskOrchestrator, {
    fileSystemScan: {
      name: "File system scan",
      start: () => fileSystemScanFolder(database),
      type: "diskInfo",
      // Discovering files is foundational for everything else, so it keeps
      // running under load and only yields to in-flight user requests.
      priority: "high",
    },
    fileMetadata: {
      name: "File metadata processing",
      start: () => processFileInfoMetadata(database),
      type: "mediaMedatadata",
    },
    exifMetadata: {
      name: "EXIF metadata processing",
      start: () => processExifMetadata(database),
      type: "mediaMedatadata",
    },
    imageAnalysis: {
      name: "Image analysis (faces + CLIP)",
      start: () => processImageAnalysis(database, analyzeImage),
      type: "imageAnalysis",
    },
    faceAttributes: {
      name: "Face attributes (photo ready)",
      start: () => processFaceAttributes(database, analyzeFaceAttributes),
      // Same shared Python worker and the same decode-bound profile as image
      // analysis, so it books the same resources rather than a second budget.
      type: "imageAnalysis",
    },
    faceClustering: {
      name: "Face clustering",
      start: () => processFaceClustering(database),
      resources: { cpu: 0.25 },
    },
    momentClustering: {
      name: "Moment clustering (burst/near-duplicate stacks)",
      start: () => processMomentClustering(database),
      // Each file also pays for a small sharp() decode + sharpness pass, not
      // just the in-memory embedding comparison faceClustering does.
      resources: { cpu: 0.5 },
    },
    audioTranscription: {
      name: "Audio transcription (Whisper)",
      // `BackgroundTaskPlan` requires this key present even when audio is
      // disabled (see PHOTRIX_DISABLE_AUDIO above) — swap in an immediately-
      // resolved no-op runner rather than trying to omit the key.
      start: audioDisabled
        ? () => ({ onComplete: () => Promise.resolve() })
        : () => processAudioTranscription(database, transcribeWithWhisper),
      type: "audioTranscription",
      resources: { ...audioComputeResources, memoryMB: 3500 },
    },
    audioEmbedding: {
      name: "Audio embedding (CLAP)",
      start: audioDisabled
        ? () => ({ onComplete: () => Promise.resolve() })
        : () => processAudioEmbedding(database, embedAudioWithClap),
      type: "audioEmbedding",
      resources: { ...audioComputeResources, memoryMB: 2000 },
    },
  });

  // Keep the index live: after the initial scan, a recursive watcher tracks
  // creates, deletes, moves, and in-place edits, re-queueing the processing
  // pipeline so changes on disk are reflected without a restart.
  const stopFileSystemMonitor = fileSystemMonitorFolder(database, {
    onChange: notifyFilesChanged,
  });

  // Complements the watcher above: inotify never sees writes made directly to
  // the NAS over CIFS from another client, so a periodic scoped rescan (dir
  // mtimes only, not a full recursive file scan) catches what the watcher
  // misses. See fileSystemRescanRecent.ts.
  const stopPeriodicRescan = startPeriodicRescan(database, notifyFilesChanged);

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

    stopFileSystemMonitor();
    stopPeriodicRescan();
    // Free the GPU on the way out so the next instance isn't starved by our
    // orphaned, still-VRAM-resident workers.
    shutdownComputeWorkers();
    shutdownImageConversionWorkers();
    // In-process, so there's no separate PID to orphan — but close its
    // listener explicitly so a fast restart can rebind MCP_PORT immediately.
    mcpServer?.close();

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
  // SIGHUP fires when the controlling terminal closes (window closed, SSH
  // dropped). node's default is to exit without our cleanup, orphaning the ML
  // workers' VRAM; route it through the same shutdown so they're killed too.
  process.on("SIGHUP", () => shutdown("SIGHUP"));
};

await startTelemetry();

await measureOperation("bootstrap.startServer", startServer, {
  category: "other",
  detail: "server-bootstrap",
  logWithoutRequest: true,
});
