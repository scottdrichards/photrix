import http from "node:http";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { filesEndpointRequestHandler } from "./requestHandlers/files/filesRequestHandler.ts";
import { foldersRequestHandler } from "./requestHandlers/foldersRequestHandler.ts";
import { statusRequestHandler } from "./requestHandlers/statusRequestHandler.ts";
import { statusBackgroundTasksRequestHandler } from "./requestHandlers/statusBackgroundTasksRequestHandler.ts";
import { suggestionsRequestHandler } from "./requestHandlers/suggestionsRequestHandler.ts";
import { networkProbeRequestHandler } from "./requestHandlers/networkProbeRequestHandler.ts";
import { videoNegotiationRequestHandler } from "./requestHandlers/video/videoNegotiation.ts";
import {
  bindCurrentRequestTrace,
  finishRequestTrace,
  getCurrentRequestId,
  measureOperation,
  runWithRequestTrace,
} from "./observability/requestTrace.ts";
import type { TaskOrchestrator } from "./taskOrchestrator/taskOrchestrator.ts";
import { writeJson } from "./utils.ts";

const PORT = process.env.PORT || 3000;

type ServerOptions = {
  taskOrchestrator: TaskOrchestrator;
};

// Monitors event-loop lag by scheduling a timer and measuring actual delay
const startEventLoopLagMonitor = () => {
  if (process.env.VITEST_WORKER_ID || process.env.JEST_WORKER_ID) return;
  let lastCheck = process.hrtime.bigint();
  const check = () => {
    const now = process.hrtime.bigint();
    const lagMs = Number(now - lastCheck) / 1_000_000 - 500; // subtract the interval
    if (lagMs > 50) {
      console.warn(`[event-loop] lag: ${lagMs.toFixed(0)}ms`);
    }
    lastCheck = now;
  };
  setInterval(check, 500).unref();
};

export const createServer = (
  database: IndexDatabase,
  storagePath: string,
  options: ServerOptions,
) => {
  const { taskOrchestrator } = options;
  startEventLoopLagMonitor();

  const server = http.createServer((req, res) => {
    const arrivalTime = process.hrtime.bigint();
    const requestIdHeader = req.headers["x-request-id"];
    const requestId = Array.isArray(requestIdHeader)
      ? requestIdHeader[0]
      : requestIdHeader;

    void runWithRequestTrace(
      {
        method: req.method ?? "UNKNOWN",
        url: req.url ?? "",
        ...(requestId ? { requestId } : {}),
      },
      async () => {
        const handlerStartTime = process.hrtime.bigint();
        const queueMs = Number(handlerStartTime - arrivalTime) / 1_000_000;
        if (queueMs > 20) {
          console.warn(
            `[event-loop] request queued ${queueMs.toFixed(0)}ms before handler: ${req.method} ${req.url}`,
          );
        }

        let requestLogged = false;
        const logRequestCompletion = bindCurrentRequestTrace(() => {
          if (requestLogged) {
            return;
          }
          requestLogged = true;
          finishRequestTrace(res.statusCode);
        });

        res.once("finish", logRequestCompletion);
        res.once("close", logRequestCompletion);

        const currentRequestId = getCurrentRequestId();
        if (currentRequestId && !res.headersSent) {
          res.setHeader("X-Request-Id", currentRequestId);
        }

        try {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
          res.setHeader("Vary", "Origin");

          if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
          }

          if (!req.url) {
            writeJson(res, 400, { error: "Bad request" });
            return;
          }

          if (req.url === "/api/health" && req.method === "GET") {
            const payload = {
              status: "ok",
              message: "Server is running",
            };

            await measureOperation(
              "request.route.health",
              () => writeJson(res, 200, payload),
              { category: "request", detail: "/api/health" },
            );
            return;
          }

          if (req.url?.startsWith("/api/status/stream") && req.method === "GET") {
            await measureOperation(
              "request.route.status.stream",
              async () =>
                statusRequestHandler(req, res, {
                  database,
                  stream: true,
                  taskOrchestrator,
                }),
              { category: "request", detail: "/api/status/stream" },
            );
            return;
          }

          if (req.url === "/api/status/background-tasks" && req.method === "POST") {
            await measureOperation(
              "request.route.status.backgroundTasks",
              () => statusBackgroundTasksRequestHandler(req, res, { taskOrchestrator }),
              { category: "request", detail: "/api/status/background-tasks" },
            );
            return;
          }

          if (req.url?.startsWith("/api/status") && req.method === "GET") {
            await measureOperation(
              "request.route.status",
              async () =>
                statusRequestHandler(req, res, {
                  database,
                  stream: false,
                  taskOrchestrator,
                }),
              { category: "request", detail: "/api/status" },
            );
            return;
          }

          if (req.url?.startsWith("/api/network-probe") && req.method === "GET") {
            await measureOperation(
              "request.route.networkProbe",
              () =>
                networkProbeRequestHandler(
                  req as http.IncomingMessage &
                    Required<Pick<http.IncomingMessage, "url">>,
                  res,
                ),
              { category: "request", detail: "/api/network-probe" },
            );
            return;
          }

          // Get folders endpoint - list subfolders at a given path
          if (req.url?.startsWith("/api/folders/") && req.method === "GET") {
            await measureOperation(
              "request.route.folders",
              () =>
                foldersRequestHandler(
                  req as http.IncomingMessage &
                    Required<Pick<http.IncomingMessage, "url">>,
                  res,
                  { database },
                ),
              { category: "request", detail: "/api/folders/*" },
            );
            return;
          }

          if (req.url?.startsWith("/api/suggestions") && req.method === "GET") {
            await measureOperation(
              "request.route.suggestions",
              () =>
                suggestionsRequestHandler(
                  req as http.IncomingMessage &
                    Required<Pick<http.IncomingMessage, "url">>,
                  res,
                  { database },
                ),
              { category: "request", detail: "/api/suggestions" },
            );
            return;
          }

          if (req.url?.startsWith("/api/video/negotiate") && req.method === "GET") {
            await measureOperation(
              "request.route.video.negotiate",
              () =>
                videoNegotiationRequestHandler(
                  req as http.IncomingMessage &
                    Required<Pick<http.IncomingMessage, "url">>,
                  res,
                  { database, storageRoot: storagePath },
                ),
              { category: "request", detail: "/api/video/negotiate" },
            );
            return;
          }

          // Files endpoint - serves individual files or queries for multiple files
          // Query mode REQUIRES trailing slash: /api/files/ or /api/files/subfolder/
          // File serving has NO trailing slash: /api/files/image.jpg
          if (req.url?.startsWith("/api/files/") && req.method === "GET") {
            await measureOperation(
              "request.route.files",
              () =>
                filesEndpointRequestHandler(
                  req as http.IncomingMessage &
                    Required<Pick<http.IncomingMessage, "url">>,
                  res,
                  {
                    database,
                    storageRoot: storagePath,
                    taskOrchestrator,
                  },
                ),
              { category: "request", detail: "/api/files/*" },
            );
            return;
          }

          // Default 404
          await measureOperation(
            "request.route.notFound",
            () => {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Not found" }));
            },
            { category: "request", detail: "404" },
          );
        } catch (error) {
          console.error("[server] Unhandled request error", error);
          if (!res.headersSent) {
            await measureOperation(
              "request.route.unhandledError",
              () =>
                writeJson(res, 500, {
                  error: "Internal server error",
                  message: error instanceof Error ? error.message : String(error),
                }),
              { category: "request", detail: "500" },
            );
            return;
          }
          res.destroy(error instanceof Error ? error : undefined);
        }
      },
    );
  });

  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
  return server;
};
