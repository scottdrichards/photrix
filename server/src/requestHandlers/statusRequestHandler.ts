import http from "node:http";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";

type StatusRequestHandlerProps = {
  stream: boolean;
  taskOrchestrator: TaskOrchestrator;
};

const getStatusPayload = async (taskOrchestrator: TaskOrchestrator) => {
  const backgroundTasksEnabled = taskOrchestrator.getPerformBackgroundTasks();
  const backgroundTasks = await taskOrchestrator.getBackgroundTaskStatus();

  return {
    backgroundTasks,
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
  const { stream, taskOrchestrator } = props;

  if (!stream) {
    const payload = await getStatusPayload(taskOrchestrator);
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
      const payload = await getStatusPayload(taskOrchestrator);
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
