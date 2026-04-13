import "dotenv/config";
import { startTelemetry } from "./observability/telemetry.ts";
import path from "node:path";
import { fileScanner } from "./indexDatabase/fileScanner.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { initializeCacheDirectories } from "./common/cacheUtils.ts";
import { createServer } from "./createServer.ts";
import { runAuthStartupChecks } from "./auth/authStartupChecks.ts";
import { startBackgroundProcessExifMetadata } from "./indexDatabase/processExifMetadata.ts";
import { startBackgroundProcessFaceMetadata } from "./indexDatabase/processFaceMetadata.ts";
import { startBackgroundProcessFileInfoMetadata } from "./indexDatabase/processFileInfo.ts";
import { createConversionWorker } from "./indexDatabase/conversionWorker.ts";
import { measureOperation } from "./observability/requestTrace.ts";

const startServer = async () => {
      console.log("Starting photrix server...");
      runAuthStartupChecks();
      initializeCacheDirectories();
      console.log("[bootstrap] Cache directories initialized");

      const mediaRoot = process.env.MEDIA_ROOT || "./exampleFolder";
      console.log(`Starting indexing for: ${mediaRoot}`);

      const absolutePath = path.resolve(mediaRoot);

      console.log("[bootstrap] IndexDatabase starting...");
      const database = new IndexDatabase(absolutePath);
      await measureOperation(
        "bootstrap.indexDatabase",
        () => database.init(),
        { category: "db", logWithoutRequest: true },
      );
      console.log("[bootstrap] IndexDatabase done");

      const conversionWorker = createConversionWorker();

      const metadataProcessingPriorities = [
        {
          name: "discover-files",
          start: fileScanner,
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
          start: (db: IndexDatabase, onComplete?: () => void) =>
            conversionWorker.startBackgroundLoop(db, onComplete).then(() => () => conversionWorker.pause()),
        },
      ];

      let pauseBackgroundProcessMetadata: (() => void) = () => {};

      const startMetadataProcessingPipeline = async () => {
        for (const { name, start } of metadataProcessingPriorities) {
          console.log(`[pipeline] Starting ${name} processing`);

          let signalComplete!: () => void;
          const completed = new Promise<void>((resolve) => { signalComplete = resolve; });

          pauseBackgroundProcessMetadata = await start(database, () => {
            console.log(`[pipeline] ${name} complete`);
            signalComplete();
          });

          await completed;
        }
        console.log("[bootstrap] All metadata processing priorities scheduled");
      };

      startMetadataProcessingPipeline();

      await createServer(database, absolutePath, {
        onRequest: () => pauseBackgroundProcessMetadata(),
        conversionWorker,
      });

      console.log("[bootstrap] Server started - metadata processing will run in background");
      console.log("[bootstrap] Starting file discovery in background...");
    }



await startTelemetry()

await measureOperation(
  "bootstrap.startServer",
  startServer,
  { category: "other", detail: "server-bootstrap", logWithoutRequest: true }
);