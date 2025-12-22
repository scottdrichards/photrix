import * as http from "http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { FileScanner } from "../indexDatabase/fileScanner.ts";
import { getActiveTranscodes } from "../videoProcessing/videoUtils.ts";

type Options = {
  database: IndexDatabase;
  fileScanner: FileScanner;
};

const buildStatus = ({ database, fileScanner }: Options) => {
  const createProgress = (completed: number, total: number) => {
    const safeTotal = Math.max(total, 0);
    const positiveCompleted = Math.max(completed, 0);
    const boundedCompleted = Math.min(
      positiveCompleted,
      safeTotal > 0 ? safeTotal : positiveCompleted,
    );
    const percent = safeTotal === 0 ? 1 : Math.min(1, boundedCompleted / safeTotal);
    return { completed: boundedCompleted, total: safeTotal, percent };
  };

  const databaseSize = database.getSize();
  const mediaCount = database.countMediaEntries();

  const pendingInfo = database.countMissingInfo();
  const pendingExif = database.countMissingDateTaken();
  const pendingThumbnails = database.countNeedingThumbnails();

  const infoProgress = createProgress(databaseSize - pendingInfo, databaseSize);
  const exifProgress = createProgress(mediaCount - pendingExif, mediaCount);
  const thumbnailProgress = createProgress(mediaCount - pendingThumbnails, mediaCount);
  const scannedProgress = createProgress(fileScanner.scannedFilesCount, Math.max(databaseSize, fileScanner.scannedFilesCount));

  const progressValues = [infoProgress, exifProgress, thumbnailProgress].filter((entry) => entry.total > 0);
  const overallPercent = progressValues.length
    ? progressValues.reduce((sum, entry) => sum + entry.percent, 0) / progressValues.length
    : 1;

  const status = {
    databaseSize,
    scannedFilesCount: fileScanner.scannedFilesCount,
    pending: {
      info: pendingInfo,
      exif: pendingExif,
      thumbnails: pendingThumbnails,
    },
    maintenance: {
      thumbnailActive: (fileScanner as unknown as { thumbnailMaintenanceActive?: boolean }).thumbnailMaintenanceActive ?? false,
      exifActive: (fileScanner as unknown as { exifMaintenanceActive?: boolean }).exifMaintenanceActive ?? false,
    },
    progress: {
      overall: createProgress(overallPercent, 1),
      scanned: scannedProgress,
      info: infoProgress,
      exif: exifProgress,
      thumbnails: thumbnailProgress,
    },
    recent: {
      thumbnail: fileScanner.latestThumbnail ?? null,
      exif: fileScanner.latestExif ?? null,
    },
    transcodes: {
      active: getActiveTranscodes(),
    },
  };

  return status;
};

export const statusRequestHandler = (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  options: Options,
) => {
  const status = buildStatus(options);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(status));
};

export const statusStreamHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: Options,
) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendStatus = () => {
    const status = buildStatus(options);
    res.write(`data: ${JSON.stringify(status)}\n\n`);
  };

  sendStatus();
  const interval = setInterval(sendStatus, 1000);

  const close = () => {
    clearInterval(interval);
    res.end();
  };

  req.on("close", close);
  res.on("close", close);
};
