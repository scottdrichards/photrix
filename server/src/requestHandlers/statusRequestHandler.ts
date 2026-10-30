import http from "node:http";
import type {
  AnalysisCoverage,
  BackgroundTaskStatus,
} from "../../../shared/filter-contract/src/index.ts";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";
import { getSystemMetrics } from "../observability/systemMetrics.ts";
import { isGpuReclaimed } from "../taskOrchestrator/computeWorkers.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("statusRequestHandler");

const EXIF_TASK_NAME = "EXIF metadata processing";
const SYNTHETIC_VIDEO_STAGES = [
  {
    id: "status:background:audio-transcription",
    name: "Audio transcription (Whisper)",
  },
  {
    id: "status:background:audio-embedding",
    name: "Audio embedding (CLAP)",
  },
] as const;

const withQueuedVideoStages = (
  backgroundTasks: BackgroundTaskStatus[],
): BackgroundTaskStatus[] => {
  const exifVisible = backgroundTasks.some(({ name }) => name === EXIF_TASK_NAME);
  if (!exifVisible) return backgroundTasks;

  const visibleNames = new Set(backgroundTasks.map(({ name }) => name));
  const synthesized = SYNTHETIC_VIDEO_STAGES.filter(
    ({ name }) => !visibleNames.has(name),
  ).map(({ id, name }) => ({
    id,
    name,
    queue: "background" as const,
    state: "queued" as const,
    description: "Waiting on EXIF",
  }));

  return synthesized.length > 0 ? [...backgroundTasks, ...synthesized] : backgroundTasks;
};

type StatusRequestHandlerProps = {
  stream: boolean;
  taskOrchestrator: TaskOrchestrator;
  /** How far each library-wide pass has got; see analysisCoverage.ts. */
  getCoverage?: () => Promise<AnalysisCoverage[]>;
};

/** Coverage is extra: a failed count leaves it out rather than failing the status. */
const readCoverage = async (
  getCoverage: StatusRequestHandlerProps["getCoverage"],
): Promise<AnalysisCoverage[] | undefined> => {
  if (!getCoverage) return undefined;
  try {
    return await getCoverage();
  } catch (error) {
    log.warn({ err: error }, "analysis coverage unavailable");
    return undefined;
  }
};

const computeStatusPayload = async (
  taskOrchestrator: TaskOrchestrator,
  getCoverage?: StatusRequestHandlerProps["getCoverage"],
) => {
  const backgroundTasksEnabled = taskOrchestrator.getPerformBackgroundTasks();
  const [backgroundTasks, systemMetrics, coverage] = await Promise.all([
    taskOrchestrator.getBackgroundTaskStatus(),
    getSystemMetrics(),
    readCoverage(getCoverage),
  ]);

  const snapshot = taskOrchestrator.getDiagnosticsSnapshot();

  return {
    backgroundTasks: withQueuedVideoStages(backgroundTasks),
    ...(coverage ? { coverage } : {}),
    maintenance: {
      backgroundTasksEnabled,
    },
    system: systemMetrics,
    arbitration: {
      userActive: snapshot.userActive,
      workersSuspended: snapshot.workersSuspended,
      gpuReclaimed: isGpuReclaimed(),
      overloaded: snapshot.overloaded,
      runningTasks: snapshot.runningTasks,
    },
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

const getStatusPayload = (
  taskOrchestrator: TaskOrchestrator,
  getCoverage?: StatusRequestHandlerProps["getCoverage"],
) => {
  if (payloadInflight) return payloadInflight;

  payloadInflight = computeStatusPayload(taskOrchestrator, getCoverage).finally(() => {
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
  const { stream, taskOrchestrator, getCoverage } = props;

  if (!stream) {
    const payload = await getStatusPayload(taskOrchestrator, getCoverage);
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
      const payload = await getStatusPayload(taskOrchestrator, getCoverage);
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
