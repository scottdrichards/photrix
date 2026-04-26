import http from "node:http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";

type StatusRequestHandlerProps = {
  database: IndexDatabase;
  stream: boolean;
  taskOrchestrator: TaskOrchestrator;
};

const getStatusPayload = async (
  database: IndexDatabase,
  taskOrchestrator: TaskOrchestrator,
) => {
  const counts = await database.getStatusCounts();
  const backgroundTasksEnabled = taskOrchestrator.getProcessBackgroundTasks();

  return {
    files: {
      total: counts.allEntries,
      images: counts.imageEntries,
      videos: counts.videoEntries,
    },
    pending: {
      fileMetadata: counts.missingFileMetadata,
      mediaMetadata: counts.missingMediaMetadata,
      thumbnails: counts.missingThumbnails,
    },
    maintenance: {
      backgroundTasksEnabled,
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
    const payload = await getStatusPayload(database, taskOrchestrator);
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
      const payload = await getStatusPayload(database, taskOrchestrator);
      writeSSE(res, payload);
    } finally {
      updating = false;
    }
  };

  sendUpdate();
  const timer = setInterval(sendUpdate, 500);

  req.on("close", () => {
    clearInterval(timer);
    res.end();
  });
};
