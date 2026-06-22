import http from "node:http";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";
import { getSystemMetrics } from "../observability/systemMetrics.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("statusRequestHandler");

type StatusRequestHandlerProps = {
  stream: boolean;
  taskOrchestrator: TaskOrchestrator;
};

const computeStatusPayload = async (taskOrchestrator: TaskOrchestrator) => {
  const backgroundTasksEnabled = taskOrchestrator.getPerformBackgroundTasks();
  const [backgroundTasks, systemMetrics] = await Promise.all([
    taskOrchestrator.getBackgroundTaskStatus(),
    getSystemMetrics(),
  ]);

  return {
    backgroundTasks,
    maintenance: {
      backgroundTasksEnabled,
    },
    system: systemMetrics,
  };
};

// Background-task status runs full-table-scan COUNT queries. Every connected SSE
// client polls on its own interval, so without coordination the DB load scales
// with the number of open browser tabs. De-duplicating in-flight computations
// collapses pollers that overlap onto a single computation; system-metric
// sampling is additionally bounded by the TTL cache inside getSystemMetrics.
// (No time-based cache here on purpose: there is a single orchestrator in
// production, but a stale shared payload would otherwise mask per-request state.)
let payloadInflight: ReturnType<typeof computeStatusPayload> | undefined;

const getStatusPayload = (taskOrchestrator: TaskOrchestrator) => {
  if (payloadInflight) return payloadInflight;

  payloadInflight = computeStatusPayload(taskOrchestrator).finally(() => {
    payloadInflight = undefined;
  });

  return payloadInflight;
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
  let closed = false;

  const sendUpdate = async () => {
    if (updating || closed) return;
    updating = true;
    try {
      const payload = await getStatusPayload(taskOrchestrator);
      // The client may have disconnected while the payload was being computed;
      // writing after end throws, so bail out instead.
      if (closed || res.writableEnded) return;
      writeSSE(res, payload);
    } catch (error) {
      log.warn({ err: error }, "Failed to push status update");
      cleanup();
    } finally {
      updating = false;
    }
  };

  const timer = setInterval(() => void sendUpdate(), 500);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (!res.writableEnded) res.end();
  };

  void sendUpdate();

  // Without an error handler, a reset SSE socket emits an unhandled 'error' that
  // can take down the process.
  res.on("error", cleanup);
  req.on("error", cleanup);
  req.on("close", cleanup);
};
