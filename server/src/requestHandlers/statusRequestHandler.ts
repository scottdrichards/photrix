import http from "node:http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { isExifMetadataProcessingActive } from "../indexDatabase/processExifMetadata.ts";
import { mediaProcessingQueue } from "../common/processingQueue.ts";
import { getHLSEncodingStatus } from "../indexDatabase/processHLSEncoding.ts";

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

const getStatusPayload = (database: IndexDatabase) => {
  const databaseSize = database.countAllEntries();
  const mediaEntries = database.countMediaEntries();
  const imageEntries = database.countImageEntries();

  const pendingInfo = database.countMissingInfo();
  const pendingExif = database.countMissingDateTaken();

  const infoCompleted = Math.max(databaseSize - pendingInfo, 0);
  const exifCompleted = Math.max(mediaEntries - pendingExif, 0);
  const overallCompleted = infoCompleted + exifCompleted;
  const overallTotal = databaseSize + mediaEntries;

  const lastExif = database.getMostRecentExifProcessedEntry();
  const queueSize = mediaProcessingQueue.getQueueSize();
  const queueProcessing = mediaProcessingQueue.getProcessing();
  const conversionStatus = mediaProcessingQueue.getConversionStatus();
  const hlsEncodingStatus = getHLSEncodingStatus();

  const imageConvertedInRun = Math.max(
    conversionStatus.overall.images.total - conversionStatus.overall.images.remaining,
    0,
  );
  const imageOverallTotal = imageEntries;
  const imageOverallRemaining = Math.max(imageOverallTotal - imageConvertedInRun, 0);

  const videoOverallRemainingSeconds =
    conversionStatus.overall.videoSeconds.remaining +
    hlsEncodingStatus.videoSeconds.remaining;
  const videoOverallTotalSeconds =
    conversionStatus.overall.videoSeconds.total + hlsEncodingStatus.videoSeconds.total;

  const videoQueuedRemainingSeconds =
    conversionStatus.queued.videoSeconds.remaining + hlsEncodingStatus.videoSeconds.queued;
  const videoQueuedTotalSeconds =
    conversionStatus.queued.videoSeconds.total + hlsEncodingStatus.videoSeconds.remaining;

  const secondsToMinutes = (seconds: number) => seconds / 60;

  return {
    databaseSize,
    scannedFilesCount: databaseSize,
    pending: {
      info: pendingInfo,
      exif: pendingExif,
    },
    maintenance: {
      exifActive: isExifMetadataProcessingActive() || pendingExif > 0,
    },
    queues: {
      pending: queueSize,
      processing: queueProcessing,
    },
    conversion: {
      overall: {
        images: {
          remaining: imageOverallRemaining,
          total: imageOverallTotal,
        },
        videoMinutes: {
          remaining: secondsToMinutes(videoOverallRemainingSeconds),
          total: secondsToMinutes(videoOverallTotalSeconds),
        },
      },
      queued: {
        images: conversionStatus.queued.images,
        videoMinutes: {
          remaining: secondsToMinutes(videoQueuedRemainingSeconds),
          total: secondsToMinutes(videoQueuedTotalSeconds),
        },
      },
    },
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

export const statusRequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  props: StatusRequestHandlerProps,
) => {
  const { database, stream } = props;

  if (!stream) {
    const payload = getStatusPayload(database);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendUpdate = () => {
    const payload = getStatusPayload(database);
    writeSSE(res, payload);
  };

  sendUpdate();
  const timer = setInterval(sendUpdate, 2_000);

  req.on("close", () => {
    clearInterval(timer);
    res.end();
  });
};
