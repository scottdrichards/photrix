import http from "node:http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { isExifMetadataProcessingActive } from "../indexDatabase/processExifMetadata.ts";
import { getFaceMetadataProcessingStats } from "../indexDatabase/processFaceMetadata.ts";
import { isBackgroundTasksEnabled } from "../common/backgroundTasksControl.ts";

type StatusRequestHandlerProps = {
  database: IndexDatabase;
  stream: boolean;
};

type ProgressEntry = {
  completed: number;
  total: number;
  percent: number;
};

const toProgressEntry = (completed: number, total: number): ProgressEntry => {
  if (total <= 0) {
    return { completed: 0, total: 0, percent: 1 };
  }

  const safeCompleted = Math.min(Math.max(completed, 0), total);
  return {
    completed: safeCompleted,
    total,
    percent: safeCompleted / total,
  };
};

const getStatusPayload = async (database: IndexDatabase) => {
  const statusCounts = await database.getStatusCounts();
  const databaseSize = statusCounts.allEntries;
  const mediaEntries = statusCounts.mediaEntries;
  const pendingInfo = statusCounts.missingInfo;
  const pendingExif = statusCounts.missingDateTaken;

  const infoCompleted = Math.max(databaseSize - pendingInfo, 0);
  const exifCompleted = Math.max(mediaEntries - pendingExif, 0);
  const overallCompleted = infoCompleted + exifCompleted;
  const overallTotal = databaseSize + mediaEntries;

  const lastExif = await database.getMostRecentExifProcessedEntry();
  const queueCounts = await database.getConversionQueueCounts();
  const queueSummary = await database.getConversionQueueSummary();
  const faceProcessingStatus = getFaceMetadataProcessingStats();

  return {
    databaseSize,
    scannedFilesCount: databaseSize,
    pending: {
      info: pendingInfo,
      exif: pendingExif,
    },
    maintenance: {
      exifActive: isExifMetadataProcessingActive() || pendingExif > 0,
      faceActive: faceProcessingStatus.active,
      backgroundTasksEnabled: isBackgroundTasksEnabled(),
    },
    faceProcessing: {
      processed: faceProcessingStatus.processed,
      workerSuccess: faceProcessingStatus.workerSuccess,
      fallbackCount: faceProcessingStatus.fallbackCount,
      workerFailures: faceProcessingStatus.workerFailures,
    },
    queues: {
      pending: queueCounts.pending,
      processing: queueCounts.processing,
    },
    queueSummary,
    progress: {
      overall: toProgressEntry(overallCompleted, overallTotal),
      scanned: toProgressEntry(databaseSize, databaseSize),
      info: toProgressEntry(infoCompleted, databaseSize),
      exif: toProgressEntry(exifCompleted, mediaEntries),
    },
    recent: {
      exif: lastExif,
    },
  };
};

const writeSSE = (res: http.ServerResponse, payload: unknown) => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

export const statusRequestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  props: StatusRequestHandlerProps,
) => {
  const { database, stream } = props;

  if (!stream) {
    const statusStartTime = Date.now();
    const payload = await getStatusPayload(database);
    const elapsed = Date.now() - statusStartTime;
    if (elapsed > 200) {
      console.log(`[status] payload generation took ${elapsed}ms`);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const sendUpdate = async () => {
    const statusStartTime = Date.now();
    const payload = await getStatusPayload(database);
    const elapsed = Date.now() - statusStartTime;
    if (elapsed > 200) {
      console.log(`[status] stream payload generation took ${elapsed}ms`);
    }
    writeSSE(res, payload);
  };

  sendUpdate();
  const timer = setInterval(sendUpdate, 2_000);

  req.on("close", () => {
    clearInterval(timer);
    res.end();
  });
};
