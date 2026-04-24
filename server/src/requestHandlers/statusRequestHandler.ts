import http from "node:http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { isExifMetadataProcessingActive } from "../indexDatabase/processExifMetadata.ts";
import type {
  TaskOrchestrator,
  TaskQueueSummary,
} from "../taskOrchestrator/taskOrchestrator.ts";

type StatusRequestHandlerProps = {
  database: IndexDatabase;
  stream: boolean;
  taskOrchestrator: TaskOrchestrator;
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

const countQueueEntries = (queueSummary: TaskQueueSummary) => {
  const pending =
    queueSummary.userBlocked.image.count +
    queueSummary.userBlocked.video.count +
    queueSummary.userImplicit.image.count +
    queueSummary.userImplicit.video.count +
    queueSummary.background.image.count +
    queueSummary.background.video.count;
  const processing = queueSummary.active.image.count + queueSummary.active.video.count;
  return { pending, processing };
};

const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const start = Date.now();
  const result = await fn();
  console.log(`[status:timing] ${label}: ${Date.now() - start}ms`);
  return result;
};

const getStatusPayload = async (
  database: IndexDatabase,
  taskOrchestrator: TaskOrchestrator,
) => {
  const [statusCounts, lastExif, queueSummary] = await Promise.all([
    timed("getStatusCounts", () => database.getStatusCounts()),
    timed("getMostRecentExifProcessedEntry", () =>
      database.getMostRecentExifProcessedEntry(),
    ),
    timed("getQueueSummary", async () => taskOrchestrator.getQueueSummary()),
  ]);

  const databaseSize = statusCounts.allEntries;
  const mediaEntries = statusCounts.mediaEntries;
  const pendingInfo = statusCounts.missingInfo;
  const pendingExif = statusCounts.missingDateTaken;

  const infoCompleted = Math.max(databaseSize - pendingInfo, 0);
  const exifCompleted = Math.max(mediaEntries - pendingExif, 0);
  const overallCompleted = infoCompleted + exifCompleted;
  const overallTotal = databaseSize + mediaEntries;

  return {
    databaseSize,
    scannedFilesCount: databaseSize,
    pending: {
      info: pendingInfo,
      exif: pendingExif,
    },
    maintenance: {
      exifActive: isExifMetadataProcessingActive() || pendingExif > 0,
      backgroundTasksEnabled: taskOrchestrator.getProcessBackgroundTasks(),
    },
    queues: countQueueEntries(queueSummary),
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
  const { database, stream, taskOrchestrator } = props;

  if (!stream) {
    const statusStartTime = Date.now();
    const payload = await getStatusPayload(database, taskOrchestrator);
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

  let updating = false;
  const sendUpdate = async () => {
    if (updating) return;
    updating = true;
    try {
      const statusStartTime = Date.now();
      const payload = await getStatusPayload(database, taskOrchestrator);
      const elapsed = Date.now() - statusStartTime;
      if (elapsed > 200) {
        console.log(`[status] stream payload generation took ${elapsed}ms`);
      }
      writeSSE(res, payload);
    } finally {
      updating = false;
    }
  };

  sendUpdate();
  const timer = setInterval(sendUpdate, 2_000);

  req.on("close", () => {
    clearInterval(timer);
    res.end();
  });
};
