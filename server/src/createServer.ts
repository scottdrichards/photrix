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

const PORT = process.env.PORT || 3000;

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

  server.listen(PORT);
  return server;
};
