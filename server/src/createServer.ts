import http from "node:http";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { filesEndpointRequestHandler } from "./requestHandlers/files/filesRequestHandler.ts";
import { foldersRequestHandler } from "./requestHandlers/foldersRequestHandler.ts";
import { statusRequestHandler } from "./requestHandlers/statusRequestHandler.ts";
import { statusBackgroundTasksRequestHandler } from "./requestHandlers/statusBackgroundTasksRequestHandler.ts";
import { suggestionsRequestHandler } from "./requestHandlers/suggestionsRequestHandler.ts";
import { networkProbeRequestHandler } from "./requestHandlers/networkProbeRequestHandler.ts";
import { videoNegotiationRequestHandler } from "./requestHandlers/video/videoNegotiation.ts";
import { searchRequestHandler } from "./requestHandlers/searchRequestHandler.ts";
import {
  bindCurrentRequestTrace,
  finishRequestTrace,
  getCurrentRequestId,
  runWithRequestTrace,
} from "./observability/requestTrace.ts";
import type { TaskOrchestrator } from "./taskOrchestrator/taskOrchestrator.ts";
import { writeJson } from "./utils.ts";
import { getLogger } from "./observability/logger.ts";

const log = getLogger("httpServer");

const PORT = process.env.PORT || 3000;

// Bound how long a single connection may stay idle/slow so hung or malicious
// clients can't accumulate and exhaust sockets. The status SSE stream sends data
// well within these windows, so long-lived streams are unaffected.
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const HEADERS_TIMEOUT_MS = 60_000;
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

type ServerOptions = {
  taskOrchestrator: TaskOrchestrator;
};

export const createServer = (
  database: IndexDatabase,
  storagePath: string,
  options: ServerOptions,
) => {
  const { taskOrchestrator } = options;

  const server = http.createServer((req, res) => {
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

          // Let the orchestrator back background work off for the *entire* time a
          // real user request is in flight, freeing disk/CPU for it. A search can
          // run many seconds on a busy box; bracketing the request (rather than a
          // one-shot cooldown) keeps background workers suspended until it
          // actually finishes instead of resuming mid-request and re-starving it.
          // Exclude polling and health endpoints (especially the long-lived
          // status stream) so routine checks don't keep the backlog paused.
          const tracksActivity =
            !req.url.startsWith("/api/status") &&
            !req.url.startsWith("/api/health") &&
            !req.url.startsWith("/api/network-probe");
          if (tracksActivity) {
            taskOrchestrator.beginUserRequest();
            let ended = false;
            const endRequest = () => {
              if (ended) return;
              ended = true;
              taskOrchestrator.endUserRequest();
            };
            res.once("finish", endRequest);
            res.once("close", endRequest);
          }

          if (req.url === "/api/health" && req.method === "GET") {
            const payload = {
              status: "ok",
              message: "Server is running",
            };

            writeJson(res, 200, payload);
            return;
          }

          if (req.url?.startsWith("/api/status/stream") && req.method === "GET") {
            await statusRequestHandler(req, res, {
              stream: true,
              taskOrchestrator,
            });
            return;
          }

          if (req.url === "/api/status/background-tasks" && req.method === "POST") {
            await statusBackgroundTasksRequestHandler(req, res, { taskOrchestrator });
            return;
          }

          if (req.url?.startsWith("/api/status") && req.method === "GET") {
            await statusRequestHandler(req, res, {
              stream: false,
              taskOrchestrator,
            });
            return;
          }

          if (req.url?.startsWith("/api/network-probe") && req.method === "GET") {
            networkProbeRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
            );
            return;
          }

          // Get folders endpoint - list subfolders at a given path
          if (req.url?.startsWith("/api/folders/") && req.method === "GET") {
            await foldersRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              { database },
            );
            return;
          }

          if (req.url?.startsWith("/api/suggestions") && req.method === "GET") {
            await suggestionsRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              { database },
            );
            return;
          }

          if (req.url?.startsWith("/api/video/negotiate") && req.method === "GET") {
            await videoNegotiationRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              { database, storageRoot: storagePath },
            );
            return;
          }

          if (req.url?.startsWith("/api/search") && req.method === "GET") {
            await searchRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              { database },
            );
            return;
          }

          // Files endpoint - serves individual files or queries for multiple files
          // Query mode REQUIRES trailing slash: /api/files/ or /api/files/subfolder/
          // File serving has NO trailing slash: /api/files/image.jpg
          if (req.url?.startsWith("/api/files/") && req.method === "GET") {
            await filesEndpointRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              {
                database,
                storageRoot: storagePath,
                taskOrchestrator,
              },
            );
            return;
          }

          // Default 404
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        } catch (error) {
          if (!res.headersSent) {
            writeJson(res, 500, {
              error: "Internal server error",
              message: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          res.destroy(error instanceof Error ? error : undefined);
        }
      },
    );
  });

  // Surface listener-level failures (e.g. EADDRINUSE) instead of letting them
  // bubble up as an uncaught exception that takes the process down silently.
  server.on("error", (error) => {
    log.error({ err: error }, "HTTP server error");
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  server.listen(PORT, () => {
    log.info({ port: PORT }, "HTTP server listening");
  });
  return server;
};
