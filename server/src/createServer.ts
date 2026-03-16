import http from "node:http";
import { AuthService } from "./auth/authService.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { filesEndpointRequestHandler } from "./requestHandlers/files/filesRequestHandler.ts";
import { facesRequestHandler } from "./requestHandlers/faces/facesRequestHandler.ts";
import { foldersRequestHandler } from "./requestHandlers/foldersRequestHandler.ts";
import { statusRequestHandler } from "./requestHandlers/statusRequestHandler.ts";
import { statusBackgroundTasksRequestHandler } from "./requestHandlers/statusBackgroundTasksRequestHandler.ts";
import { suggestionsRequestHandler } from "./requestHandlers/suggestionsRequestHandler.ts";
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
    onRequest();
    const requestStart = Date.now();
    console.log(`[server] ${req.method} ${req.url}`);

    // Intercept res.end to log timing
    const originalEnd = res.end.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.end = function (...args: any[]) {
      const elapsed = Date.now() - requestStart;
      console.log(
        `[server] ${req.method} ${req.url} completed in ${elapsed}ms (status: ${res.statusCode})`,
      );

      return originalEnd(...args);
    } as typeof res.end;

    authService.applyResponseHeaders(req, res);

    const requestRejection = authService.validateRequest(req);
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

    const authHandled = await authService.handleAuthRequest(
      req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
    );

    if (authHandled) {
      return;
    }

    const session = authService.requireAuthenticated(req, res);
    if (!session) {
      return;
    }

    if (req.url === "/api/health" && req.method === "GET") {
      const payload = {
        status: "ok",
        message: "Server is running",
        ...(authService.enabled ? { user: session.username } : {}),
      };

      writeJson(res, 200, payload);
      return;
    }

    if (req.url?.startsWith("/api/status/stream") && req.method === "GET") {
      statusRequestHandler(req, res, { database, stream: true });
      return;
    }

    if (req.url === "/api/status/background-tasks" && req.method === "POST") {
      await statusBackgroundTasksRequestHandler(req, res);
      return;
    }

    if (req.url?.startsWith("/api/status") && req.method === "GET") {
      statusRequestHandler(req, res, { database, stream: false });
      return;
    }

    // Get folders endpoint - list subfolders at a given path
    if (req.url?.startsWith("/api/folders/") && req.method === "GET") {
      foldersRequestHandler(
        req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
        res,
        { database },
      );
      return;
    }

    if (req.url?.startsWith("/api/suggestions") && req.method === "GET") {
      suggestionsRequestHandler(
        req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
        res,
        { database },
      );
      return;
    }

    if (req.url?.startsWith("/api/faces/") && ["GET", "POST"].includes(req.method ?? "")) {
      await facesRequestHandler(
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
      filesEndpointRequestHandler(
        req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
        res,
        {
          database,
          storageRoot: storagePath,
        },
      );
      return;
    }

    // Default 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
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
