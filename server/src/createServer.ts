import http from "node:http";
import { AuthService } from "./auth/authService.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { filesEndpointRequestHandler } from "./requestHandlers/files/filesRequestHandler.ts";
import { facesRequestHandler } from "./requestHandlers/faces/facesRequestHandler.ts";
import { foldersRequestHandler } from "./requestHandlers/foldersRequestHandler.ts";
import { statusRequestHandler } from "./requestHandlers/statusRequestHandler.ts";
import { statusBackgroundTasksRequestHandler } from "./requestHandlers/statusBackgroundTasksRequestHandler.ts";
import { suggestionsRequestHandler } from "./requestHandlers/suggestionsRequestHandler.ts";
import {
  bindCurrentRequestTrace,
  finishRequestTrace,
  getCurrentRequestId,
  measureOperation,
  runWithRequestTrace,
} from "./observability/requestTrace.ts";
import { writeJson } from "./utils.ts";

const PORT = process.env.PORT || 3000;

type ServerOptions = {
  onRequest: () => void;
};

export const createServer = (
  database: IndexDatabase,
  storagePath: string,
  options: ServerOptions = { onRequest: () => {} },
) => {
  const { onRequest } = options;
  const authService = new AuthService();

  const server = http.createServer(async (req, res) => {
    const requestIdHeader = req.headers["x-request-id"];
    const requestId = Array.isArray(requestIdHeader)
      ? requestIdHeader[0]
      : requestIdHeader;

    await runWithRequestTrace(
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

        onRequest();
        const currentRequestId = getCurrentRequestId();
        if (currentRequestId && !res.headersSent) {
          res.setHeader("X-Request-Id", currentRequestId);
        }

        try {
          await measureOperation(
            "request.applyResponseHeaders",
            async () => authService.applyResponseHeaders(req, res),
            { category: "request" },
          );

          const requestRejection = await measureOperation(
            "request.validateRequest",
            async () => authService.validateRequest(req),
            { category: "request" },
          );
          if (requestRejection) {
            writeJson(res, requestRejection.status, { error: requestRejection.error });
            return;
          }

          // Handle preflight requests
          if (req.method === "OPTIONS") {
            authService.handlePreflight(req, res);
            return;
          }

          if (!req.url) {
            writeJson(res, 400, { error: "Bad request" });
            return;
          }

          const authHandled = await measureOperation(
            "request.auth.handleAuthRequest",
            () =>
              authService.handleAuthRequest(
                req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
                res,
              ),
            { category: "request" },
          );

          if (authHandled) {
            return;
          }

          const session = await measureOperation(
            "request.auth.requireAuthenticated",
            async () => authService.requireAuthenticated(req, res),
            { category: "request" },
          );
          if (!session) {
            return;
          }

          if (req.url === "/api/health" && req.method === "GET") {
            const payload = {
              status: "ok",
              message: "Server is running",
              ...(authService.enabled ? { user: session.username } : {}),
            };

            await measureOperation(
              "request.route.health",
              async () => writeJson(res, 200, payload),
              { category: "request", detail: "/api/health" },
            );
            return;
          }

          if (req.url?.startsWith("/api/status/stream") && req.method === "GET") {
            await measureOperation(
              "request.route.status.stream",
              async () => statusRequestHandler(req, res, { database, stream: true }),
              { category: "request", detail: "/api/status/stream" },
            );
            return;
          }

          if (req.url === "/api/status/background-tasks" && req.method === "POST") {
            await measureOperation(
              "request.route.status.backgroundTasks",
              () => statusBackgroundTasksRequestHandler(req, res),
              { category: "request", detail: "/api/status/background-tasks" },
            );
            return;
          }

          if (req.url?.startsWith("/api/status") && req.method === "GET") {
            await measureOperation(
              "request.route.status",
              async () => statusRequestHandler(req, res, { database, stream: false }),
              { category: "request", detail: "/api/status" },
            );
            return;
          }

          // Get folders endpoint - list subfolders at a given path
          if (req.url?.startsWith("/api/folders/") && req.method === "GET") {
            await measureOperation(
              "request.route.folders",
              () =>
                foldersRequestHandler(
                  req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
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
                  req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
                  res,
                  { database },
                ),
              { category: "request", detail: "/api/suggestions" },
            );
            return;
          }

          if (req.url?.startsWith("/api/faces/") && ["GET", "POST"].includes(req.method ?? "")) {
            await measureOperation(
              "request.route.faces",
              () =>
                facesRequestHandler(
                  req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
                  res,
                  { database },
                ),
              { category: "request", detail: "/api/faces/*" },
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
                  req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
                  res,
                  {
                    database,
                    storageRoot: storagePath,
                  },
                ),
              { category: "request", detail: "/api/files/*" },
            );
            return;
          }

          // Default 404
          await measureOperation(
            "request.route.notFound",
            async () => {
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
              async () =>
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

  server.on("close", () => {
    authService.close();
  });

  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
  return server;
};
