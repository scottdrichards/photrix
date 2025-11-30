import * as http from "http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { FileScanner } from "../indexDatabase/fileScanner.ts";

type Options = {
  database: IndexDatabase;
  fileScanner: FileScanner;
};

export const statusRequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  { database, fileScanner }: Options,
) => {
  const status = {
    databaseSize: database.getSize(),
    queues: {
      info: {
        length: fileScanner.jobQueues.info.files.length,
        active: fileScanner.jobQueues.info.active,
        total: fileScanner.jobQueues.info.total,
      },
      exifMetadata: {
        length: fileScanner.jobQueues.exifMetadata.files.length,
        active: fileScanner.jobQueues.exifMetadata.active,
        total: fileScanner.jobQueues.exifMetadata.total,
      },
      aiMetadata: {
        length: fileScanner.jobQueues.aiMetadata.files.length,
        active: fileScanner.jobQueues.aiMetadata.active,
        total: fileScanner.jobQueues.aiMetadata.total,
      },
      faceMetadata: {
        length: fileScanner.jobQueues.faceMetadata.files.length,
        active: fileScanner.jobQueues.faceMetadata.active,
        total: fileScanner.jobQueues.faceMetadata.total,
      },
      thumbnail: {
        length: fileScanner.jobQueues.thumbnail.files.length,
        active: fileScanner.jobQueues.thumbnail.active,
        total: fileScanner.jobQueues.thumbnail.total,
      },
    },
    scannedFilesCount: fileScanner.scannedFilesCount,
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(status));
};
