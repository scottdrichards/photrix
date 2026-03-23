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
        () => new IndexDatabase(absolutePath),
        { category: "db", logWithoutRequest: true },
      );
      console.log("[bootstrap] IndexDatabase done");

      // Start file discovery in the background (non-blocking)
      console.log("[bootstrap] Starting file discovery in background...");
      measureOperation(
        "pipeline.discoverFiles",
        () => discoverFiles({ root: absolutePath, db: database }),
        { category: "file", logWithoutRequest: true },
      ).then(() => {
        console.log("[pipeline] file-discovery complete → metadata:file-info start");
        startBackgroundMetadataProcessing(database);
      });

      let pauseBackgroundProcessMetadata = () => {
        // No-op until metadata processing starts
      };

      const startBackgroundMetadataProcessing = (db: IndexDatabase) => {
        // Face metadata runs by default. Set PHOTRIX_ENABLE_FACE_METADATA=false to opt out.
        const runFaceMetadataPipeline =
          process.env.PHOTRIX_ENABLE_FACE_METADATA?.toLowerCase() !== "false";

        // Chain the metadata processors: file info → EXIF → optional face metadata → conversion worker
        const pauseFileInfo = startBackgroundProcessFileInfoMetadata(db, () => {
          console.log("[pipeline] metadata:file-info complete → metadata:exif start");
          // File info complete, start EXIF processing
          const pauseExif = startBackgroundProcessExifMetadata(db, () => {
            if (runFaceMetadataPipeline) {
              console.log("[pipeline] metadata:exif complete → metadata:face start");
              const pauseFace = startBackgroundProcessFaceMetadata(db, () => {
                console.log("[pipeline] metadata:face complete → conversion-worker start");
                pauseBackgroundProcessMetadata = startBackgroundConversionWorker(db);
              });
              pauseBackgroundProcessMetadata = pauseFace;
              return;
            }

            // EXIF complete, start conversion worker (thumbnails + HLS)
            console.log("[pipeline] metadata:exif complete → conversion-worker start");
            pauseBackgroundProcessMetadata = startBackgroundConversionWorker(db);
          });
          pauseBackgroundProcessMetadata = pauseExif;
        });
        pauseBackgroundProcessMetadata = pauseFileInfo;
      };

      createServer(database, absolutePath, {
        onRequest: () => pauseBackgroundProcessMetadata(),
      });

      console.log("[bootstrap] Server started - metadata processing will run in background");
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
