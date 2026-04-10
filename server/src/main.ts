import "dotenv/config";
import path from "node:path";
import { discoverFiles } from "./indexDatabase/fileScanner.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { initializeCacheDirectories } from "./common/cacheUtils.ts";
import { createServer } from "./createServer.ts";
import { runAuthStartupChecks } from "./auth/authStartupChecks.ts";
import { startBackgroundProcessExifMetadata } from "./indexDatabase/processExifMetadata.ts";
import { startBackgroundProcessFaceMetadata } from "./indexDatabase/processFaceMetadata.ts";
import { startBackgroundProcessFileInfoMetadata } from "./indexDatabase/processFileInfo.ts";
import { startBackgroundConversionWorker } from "./indexDatabase/processHLSEncoding.ts";
import { measureOperation } from "./observability/requestTrace.ts";

const startServer = async () => {
  await measureOperation(
    "bootstrap.startServer",
    async () => {
      console.log("Starting photrix server...");
      runAuthStartupChecks();

      await measureOperation(
        "bootstrap.initializeCacheDirectories",
        () => initializeCacheDirectories(),
        { category: "file", logWithoutRequest: true },
      );
      console.log("[bootstrap] Cache directories initialized");

      const mediaRoot = process.env.MEDIA_ROOT || "./exampleFolder";
      console.log(`Starting indexing for: ${mediaRoot}`);

      const absolutePath = path.resolve(mediaRoot);

      console.log("[bootstrap] IndexDatabase starting...");
      const database = await measureOperation(
        "bootstrap.indexDatabase",
        () => IndexDatabase.create(absolutePath),
        { category: "db", logWithoutRequest: true },
      );
      console.log("[bootstrap] IndexDatabase done");

      const metadataProcessingPriorities = [
        {
          name: "discover-files",
          start: async (db: IndexDatabase, onComplete?: () => void) => {
            measureOperation(
              "pipeline.discoverFiles",
              () => discoverFiles({ root: absolutePath, db }),
              { category: "file", logWithoutRequest: true },
            ).then(() => {
              onComplete?.();
            });
            // discoverFiles doesn't support pause, return no-op
            return () => {};
          },
        },
        {
          name: "file-info",
          start: startBackgroundProcessFileInfoMetadata,
        },
        {
          name: "exif",
          start: startBackgroundProcessExifMetadata,
        },
        ...(process.env.PHOTRIX_ENABLE_FACE_METADATA?.toLowerCase() !== "false"
          ? [
              {
                name: "face",
                start: startBackgroundProcessFaceMetadata,
              },
            ]
          : []),
        {
          name: "conversion",
          start: startBackgroundConversionWorker,
        },
      ];

      // Execute metadata processors in sequence
      let pauseBackgroundProcessMetadata: (() => void) =
        () => {
          // No-op until metadata processing starts
        };

      const startMetadataProcessingPipeline = async () => {
        for (const metadataProcess of metadataProcessingPriorities) {
          console.log(`[pipeline] Starting ${metadataProcess.name} processing`);
          pauseBackgroundProcessMetadata = await new Promise<() => void>(
            (resolve, reject) => {
              let pauseFn: () => void = () => {};
              metadataProcess
                .start(database, () => {
                  console.log(`[pipeline] ${metadataProcess.name} complete`);
                  resolve(pauseFn);
                })
                .then((fn) => {
                  pauseFn = fn;
                })
                .catch(reject);
            },
          );
        }
        console.log("[bootstrap] All metadata processing priorities scheduled");
      };

      startMetadataProcessingPipeline();

      await createServer(database, absolutePath, {
        onRequest: () => pauseBackgroundProcessMetadata(),
      });

      console.log("[bootstrap] Server started - metadata processing will run in background");
      console.log("[bootstrap] Starting file discovery in background...");
    },
    { category: "other", detail: "server-bootstrap", logWithoutRequest: true },
  );
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
