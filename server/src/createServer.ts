import http from "node:http";
import type { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import {
  bindCurrentRequestTrace,
  finishRequestTrace,
  getCurrentRequestId,
  runWithRequestTrace,
} from "./observability/requestTrace.ts";
import type { TaskOrchestrator } from "./taskOrchestrator/taskOrchestrator.ts";
import { writeJson } from "./utils.ts";
import { getLogger } from "./observability/logger.ts";
import { redactRequestPath } from "./observability/privacy.ts";
import {
  extractToken,
  getShareScope,
  isAuthEnabled,
  validateToken,
} from "./auth/authService.ts";
import { resolveShareFilter, ShareScopeError } from "./auth/shareScope.ts";
import { FilterCompileError } from "./indexDatabase/filterToSQL.ts";
import { bindRequestAbortSignal, isAbortError } from "./common/requestAbort.ts";
import { sharePreviewHandler } from "./requestHandlers/sharePreviewHandler.ts";
import type { FeatureFlagStore } from "./featureFlags/featureFlagStore.ts";
import { createRoutes, matchesRoute, type ApiRequest } from "./createRoutes.ts";

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
  featureFlags: FeatureFlagStore;
};

/** A request header's value, or its first value when repeated. */
const firstHeader = (req: http.IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * How a request holds off background work while it runs.
 *
 * - `"lease"`: heavy, interactive data requests (search, folder and file
 *   queries, suggestions, mutations). Background stays stopped for the whole
 *   request: a cold search can run many seconds on a busy box, and a one-shot
 *   cooldown would let workers resume mid-request and starve it again.
 * - `"cooldown"`: asset serving (thumbnails, image and video bytes, HLS) and
 *   the slow-but-bounded photo endpoints. These are frequent and often
 *   long-lived — a playing video fetches a segment every few seconds — so a
 *   lease per request would freeze background ingestion for as long as anyone
 *   watches or scrolls. The cooldown still yields briefly and then expires.
 *   Photo captions (~90 s of a vision model) and rotation suggestions (~1-4 s)
 *   are here for the same reason: a lease would stop every background task on
 *   every photo open.
 * - `"none"`: polling and health checks, including the long-lived status
 *   stream and the search UI's status poll, which only read in-process state.
 */
const userActivityFor = (method: string | undefined, pathname: string) => {
  if (
    pathname.startsWith("/api/status") ||
    pathname === "/api/search/status" ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/network-probe")
  ) {
    return "none";
  }
  // A file query ends in a slash; serving one file's bytes does not.
  const isAssetServe =
    method === "GET" && pathname.startsWith("/api/files/") && !pathname.endsWith("/");
  const isSlowPhotoEndpoint =
    method === "GET" &&
    (pathname.startsWith("/api/photos/caption") ||
      pathname.startsWith("/api/photos/suggest-rotation"));
  return isAssetServe || isSlowPhotoEndpoint ? "cooldown" : "lease";
};

export const createServer = (
  database: IndexDatabase,
  storagePath: string,
  options: ServerOptions,
) => {
  const { taskOrchestrator } = options;
  const routes = createRoutes({
    database,
    storageRoot: storagePath,
    taskOrchestrator,
    featureFlags: options.featureFlags,
  });

  const handleRequest = async (req: ApiRequest, res: http.ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Client-Session-Id, X-Client-Operation-Id, X-Client-Request-Id, X-Request-Id",
    );
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = req.url.split("?", 1)[0];

    // The link-preview page for a shared link. It validates the share token
    // itself, so it runs before the auth gate.
    if (req.method === "GET" && pathname === "/share") {
      await sharePreviewHandler(req, res, database);
      return;
    }

    // Auth gate. Health and sign-in are public; everything else needs a session,
    // an API token or a share token. A share token carries its scope.
    let token: string | null = null;
    if (
      isAuthEnabled() &&
      pathname !== "/api/health" &&
      !pathname.startsWith("/api/auth/")
    ) {
      token = extractToken(
        req.headers["authorization"],
        new URL(req.url, "http://localhost").searchParams.get("token"),
      );
      if (!token || !validateToken(token)) {
        writeJson(res, 401, { error: "Unauthorized" });
        return;
      }
    }
    const shareScope = token ? getShareScope(token) : null;

    const activity = userActivityFor(req.method, pathname);
    if (activity === "cooldown") {
      taskOrchestrator.noteUserActivity();
    } else if (activity === "lease") {
      const lease = taskOrchestrator.beginUserRequest(
        `${req.method} ${redactRequestPath(pathname)}`,
      );
      res.once("finish", lease.release);
      res.once("close", lease.release);
    }

    const route = routes.find((candidate) =>
      matchesRoute(candidate, req.method, pathname),
    );
    if (!route) {
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    let shareFilter: unknown = null;
    if (shareScope && route.shareLink === "forbidden") {
      writeJson(res, 403, { error: "Forbidden" });
      return;
    }
    if (shareScope && route.shareLink === "scoped") {
      try {
        shareFilter = await resolveShareFilter(shareScope, token ?? undefined);
      } catch (error) {
        if (!(error instanceof ShareScopeError)) throw error;
        writeJson(res, error.statusCode, { error: error.message });
        return;
      }
    }

    await route.handle({ req, res, pathname, shareScope, shareFilter });
  };

  const server = http.createServer((req, res) => {
    const requestId = firstHeader(req, "x-request-id");
    const clientSessionId = firstHeader(req, "x-client-session-id");
    const clientOperationId = firstHeader(req, "x-client-operation-id");
    const clientRequestId = firstHeader(req, "x-client-request-id");

    void runWithRequestTrace(
      {
        method: req.method ?? "UNKNOWN",
        url: req.url ?? "",
        ...(requestId ? { requestId } : {}),
        ...(clientSessionId ? { clientSessionId } : {}),
        ...(clientOperationId ? { clientOperationId } : {}),
        ...(clientRequestId ? { clientRequestId } : {}),
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

        // Abort server-side work (queued DB reads, most importantly) when the
        // client gives up on the request — fetch abort, tab close, a map zoom
        // superseding earlier zoom steps. `close` also fires after a normal
        // response, so only treat it as an abort when nothing was completed.
        const requestAbort = new AbortController();
        res.once("close", () => {
          if (!res.writableEnded) requestAbort.abort();
        });
        bindRequestAbortSignal(requestAbort.signal);

        if (!req.url) {
          writeJson(res, 400, { error: "Bad request" });
          return;
        }

        try {
          await handleRequest(req as ApiRequest, res);
        } catch (error) {
          if (isAbortError(error)) {
            // The client already disconnected; there is no one to answer and
            // nothing actually failed.
            res.destroy();
            return;
          }
          if (error instanceof FilterCompileError && !res.headersSent) {
            writeJson(res, 400, { error: `Invalid filter: ${error.message}` });
            return;
          }
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
