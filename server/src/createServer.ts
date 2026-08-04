import http from "node:http";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { filesEndpointRequestHandler } from "./requestHandlers/files/filesRequestHandler.ts";
import { updateFileMetadataHandler } from "./requestHandlers/files/updateMetadataHandler.ts";
import { foldersRequestHandler } from "./requestHandlers/foldersRequestHandler.ts";
import { statusRequestHandler } from "./requestHandlers/statusRequestHandler.ts";
import { statusBackgroundTasksRequestHandler } from "./requestHandlers/statusBackgroundTasksRequestHandler.ts";
import { suggestionsRequestHandler } from "./requestHandlers/suggestionsRequestHandler.ts";
import { networkProbeRequestHandler } from "./requestHandlers/networkProbeRequestHandler.ts";
import { dayPhotoRequestHandler } from "./requestHandlers/dayPhotoRequestHandler.ts";
import { diagnosticsEventsRequestHandler } from "./requestHandlers/diagnosticsRequestHandler.ts";
import { videoNegotiationRequestHandler } from "./requestHandlers/video/videoNegotiation.ts";
import { searchRequestHandler } from "./requestHandlers/searchRequestHandler.ts";
import { searchInterpretHandler } from "./requestHandlers/searchInterpretHandler.ts";
import {
  authLoginHandler,
  authLogoutHandler,
  authShareTokenHandler,
  passkeyAuthenticationOptionsHandler,
  passkeyAuthenticationVerifyHandler,
  passkeyRegistrationOptionsHandler,
  passkeyRegistrationVerifyHandler,
} from "./requestHandlers/authRequestHandler.ts";
import { accountRequestHandler } from "./requestHandlers/accountRequestHandler.ts";
import {
  bindCurrentRequestTrace,
  finishRequestTrace,
  getCurrentRequestId,
  runWithRequestTrace,
} from "./observability/requestTrace.ts";
import type { TaskOrchestrator } from "./taskOrchestrator/taskOrchestrator.ts";
import { writeJson } from "./utils.ts";
import { getLogger } from "./observability/logger.ts";
import {
  extractToken,
  getShareScope,
  initAuthService,
  isAuthEnabled,
  validateToken,
} from "./auth/authService.ts";
import { initPasskeyService } from "./auth/passkeyService.ts";
import { resolveShareFilter, ShareScopeError } from "./auth/shareScope.ts";
import { bindRequestAbortSignal, isAbortError } from "./common/requestAbort.ts";
import { peopleRequestHandler } from "./requestHandlers/peopleRequestHandler.ts";
import { sharePreviewHandler } from "./requestHandlers/sharePreviewHandler.ts";
import { decodeRequestPath } from "./common/decodeRequestPath.ts";
import { extractShareFolderRoots } from "./auth/shareFolderScope.ts";
import type { FilterElement } from "./indexDatabase/indexDatabase.type.ts";
import { pageTitleHandler } from "./requestHandlers/pageTitleHandler.ts";
import { feedbackHandler } from "./requestHandlers/feedbackHandler.ts";
import { faceIdentifyRequestHandler } from "./requestHandlers/faceIdentifyRequestHandler.ts";
import { analyzeImage } from "./imageAnalysis/imageAnalysisWorker.ts";
import { killAllSessions } from "./videoProcessing/hlsSession.ts";

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
    const clientSessionIdHeader = req.headers["x-client-session-id"];
    const clientOperationIdHeader = req.headers["x-client-operation-id"];
    const clientRequestIdHeader = req.headers["x-client-request-id"];
    const clientSessionId = Array.isArray(clientSessionIdHeader)
      ? clientSessionIdHeader[0]
      : clientSessionIdHeader;
    const clientOperationId = Array.isArray(clientOperationIdHeader)
      ? clientOperationIdHeader[0]
      : clientOperationIdHeader;
    const clientRequestId = Array.isArray(clientRequestIdHeader)
      ? clientRequestIdHeader[0]
      : clientRequestIdHeader;

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

        try {
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

          if (!req.url) {
            writeJson(res, 400, { error: "Bad request" });
            return;
          }

          // Share preview page — serves OG meta tags for rich link previews.
          // Handles its own token validation; must be checked before the auth gate.
          if (req.method === "GET" && req.url.split("?")[0] === "/share") {
            await sharePreviewHandler(req, res, database);
            return;
          }

          // Auth gate — bypass for health check and auth endpoints themselves
          let shareFilter: unknown = null;
          let shareScope: ReturnType<typeof getShareScope> = null;
          let shareFilterResolved = false;
          let shareToken: string | null = null;
          if (
            isAuthEnabled() &&
            req.url !== "/api/health" &&
            !req.url.startsWith("/api/auth/")
          ) {
            const parsedUrl = new URL(req.url, "http://localhost");
            const token = extractToken(
              req.headers["authorization"],
              parsedUrl.searchParams.get("token"),
            );
            if (!token || !validateToken(token)) {
              writeJson(res, 401, { error: "Unauthorized" });
              return;
            }
            shareToken = token;
            shareScope = getShareScope(token);
          }

          const getResolvedShareFilter = async (): Promise<unknown> => {
            if (!shareScope) {
              return null;
            }
            if (shareFilterResolved) {
              return shareFilter;
            }
            try {
              shareFilter = await resolveShareFilter(shareScope, shareToken ?? undefined);
              shareFilterResolved = true;
              return shareFilter;
            } catch (error) {
              if (error instanceof ShareScopeError) {
                writeJson(res, error.statusCode, { error: error.message });
                return null;
              }
              throw error;
            }
          };

          // Background work backs off for user activity, but *how* depends on the
          // request. Two tiers:
          //
          //  - Heavy/interactive data requests (search, folder/file queries,
          //    suggestions, mutations) get the full bracket: background stays
          //    stopped for the request's *entire* duration. A cold search can run
          //    many seconds on a busy box, and a one-shot cooldown lets background
          //    workers resume mid-request and re-starve it.
          //
          //  - Asset serving (thumbnails, image/video bytes, HLS playlists and
          //    segments) gets only the bounded activity cooldown. These are
          //    high-frequency and often long-lived (a playing video fetches a
          //    segment every few seconds for its whole runtime); bracketing each
          //    one would pin the whole box in a full stop for as long as the user
          //    watches/scrolls, so background ingestion never progresses while the
          //    app is merely in use. The cooldown still yields briefly to an
          //    in-flight heavy request, but self-expires so a single long stream
          //    can't freeze the backlog for its entire duration.
          //
          // Exclude polling and health endpoints (especially the long-lived status
          // stream) entirely so routine checks don't keep the backlog paused.
          const pathname = req.url.split("?", 1)[0];
          const tracksActivity =
            !req.url.startsWith("/api/status") &&
            !req.url.startsWith("/api/health") &&
            !req.url.startsWith("/api/network-probe");
          // Asset serving is a GET under /api/files/ whose path has no trailing
          // slash — query mode requires the trailing slash (see filesRequestHandler).
          const isAssetServe =
            req.method === "GET" &&
            pathname.startsWith("/api/files/") &&
            !pathname.endsWith("/");
          if (tracksActivity && isAssetServe) {
            taskOrchestrator.noteUserActivity();
          } else if (tracksActivity) {
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

          if (req.url === "/api/auth/login" && req.method === "POST") {
            await authLoginHandler(req, res);
            return;
          }

          if (req.url === "/api/auth/logout" && req.method === "POST") {
            await authLogoutHandler(req, res);
            return;
          }

          if (req.url === "/api/auth/share-token" && req.method === "POST") {
            await authShareTokenHandler(req, res, database);
            return;
          }

          if (
            req.url === "/api/auth/passkey/registration-options" &&
            req.method === "POST"
          ) {
            await passkeyRegistrationOptionsHandler(req, res);
            return;
          }

          if (
            req.url === "/api/auth/passkey/registration-verify" &&
            req.method === "POST"
          ) {
            await passkeyRegistrationVerifyHandler(req, res);
            return;
          }

          if (
            req.url === "/api/auth/passkey/authentication-options" &&
            req.method === "POST"
          ) {
            await passkeyAuthenticationOptionsHandler(req, res);
            return;
          }

          if (
            req.url === "/api/auth/passkey/authentication-verify" &&
            req.method === "POST"
          ) {
            await passkeyAuthenticationVerifyHandler(req, res);
            return;
          }

          if (req.url.startsWith("/api/account")) {
            await accountRequestHandler(req, res);
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

          if (req.url?.startsWith("/api/diagnostics/events")) {
            await diagnosticsEventsRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
            );
            return;
          }

          if (req.url?.startsWith("/api/status/stream") && req.method === "GET") {
            if (shareScope) {
              writeJson(res, 403, { error: "Forbidden" });
              return;
            }
            await statusRequestHandler(req, res, {
              stream: true,
              taskOrchestrator,
            });
            return;
          }

          if (req.url === "/api/status/background-tasks" && req.method === "POST") {
            if (shareScope) {
              writeJson(res, 403, { error: "Forbidden" });
              return;
            }
            await statusBackgroundTasksRequestHandler(req, res, { taskOrchestrator });
            return;
          }

          if (req.url === "/api/status/clear-hls" && req.method === "POST") {
            if (shareScope) {
              writeJson(res, 403, { error: "Forbidden" });
              return;
            }
            killAllSessions();
            writeJson(res, 200, { ok: true });
            return;
          }

          if (req.url?.startsWith("/api/status") && req.method === "GET") {
            if (shareScope) {
              writeJson(res, 403, { error: "Forbidden" });
              return;
            }
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

          if (req.url?.startsWith("/api/day-photo/") && req.method === "GET") {
            await dayPhotoRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
            );
            return;
          }

          // Get folders endpoint - list subfolders at a given path
          if (req.url?.startsWith("/api/folders/") && req.method === "GET") {
            // A share link browses its own subtree: the listing is ANDed with the
            // share filter (so only folders holding shared items exist at all) and
            // the requested path is clamped to the shared root. Both checks live
            // in the handler; an ordinary session passes neither and sees the
            // whole library as before.
            const resolvedShareFilter = await getResolvedShareFilter();
            if (res.writableEnded) return;
            await foldersRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              {
                database,
                shareFilter: resolvedShareFilter,
                shareFolderRoots: shareScope
                  ? extractShareFolderRoots(shareScope.filter as FilterElement)
                  : null,
              },
            );
            return;
          }

          if (req.url === "/api/page-title" && req.method === "POST") {
            await pageTitleHandler(req, res, database);
            return;
          }

          if (req.url?.startsWith("/api/feedback")) {
            if (shareScope) {
              writeJson(res, 403, { error: "Forbidden" });
              return;
            }
            await feedbackHandler(
              req as http.IncomingMessage & { url: string },
              res,
              database,
            );
            return;
          }

          if (req.url?.startsWith("/api/suggestions") && req.method === "GET") {
            const resolvedShareFilter = await getResolvedShareFilter();
            if (res.writableEnded) return;
            await suggestionsRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              { database, shareFilter: resolvedShareFilter },
            );
            return;
          }

          if (req.url?.startsWith("/api/video/negotiate") && req.method === "GET") {
            const resolvedShareFilter = await getResolvedShareFilter();
            if (res.writableEnded) return;
            await videoNegotiationRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              {
                database,
                storageRoot: storagePath,
                taskOrchestrator,
                shareFilter: resolvedShareFilter,
              },
            );
            return;
          }

          // Natural-language query -> structured filters. Read-only, but it
          // enumerates the library's people and folders to ground the model, so
          // a scoped share link may not call it.
          if (req.url === "/api/search/interpret" && req.method === "POST") {
            if (shareScope) {
              writeJson(res, 403, { error: "Forbidden" });
              return;
            }
            await searchInterpretHandler(req, res, { database });
            return;
          }

          if (req.url?.startsWith("/api/search") && req.method === "GET") {
            const resolvedShareFilter = await getResolvedShareFilter();
            if (res.writableEnded) return;
            await searchRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              { database, shareFilter: resolvedShareFilter, shareScope },
            );
            return;
          }

          // Classify faces in a caller-supplied image against the named people
          // in the library. Read-only and never indexed, but it runs the shared
          // analysis worker and enumerates every named person, so a scoped
          // share link may not call it.
          if (req.url?.startsWith("/api/faces/")) {
            if (shareScope) {
              writeJson(res, 403, { error: "Forbidden" });
              return;
            }
            await faceIdentifyRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              { database, analyzeImage },
            );
            return;
          }

          if (req.url?.startsWith("/api/people/") && req.method === "POST") {
            if (shareScope) {
              // People management (rename/merge/separate) mutates face clusters;
              // a read-only share view may never persist changes.
              writeJson(res, 403, { error: "Forbidden" });
              return;
            }
            await peopleRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              database,
            );
            return;
          }

          // Files endpoint - serves individual files or queries for multiple files
          // Query mode REQUIRES trailing slash: /api/files/ or /api/files/subfolder/
          // File serving has NO trailing slash: /api/files/image.jpg
          // Tag a single file (star rating / labels). Path has no trailing slash,
          // same shape as file serving: PATCH /api/files/subfolder/image.jpg
          if (req.url?.startsWith("/api/files/") && req.method === "PATCH") {
            const resolvedShareFilter = await getResolvedShareFilter();
            if (res.writableEnded) return;
            const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
            const pathMatch = parsedUrl.pathname.match(/^\/api\/files\/(.*)/);
            const subPath = pathMatch ? decodeRequestPath(pathMatch[1]) : "";
            await updateFileMetadataHandler(
              req,
              subPath,
              res,
              database,
              resolvedShareFilter,
            );
            return;
          }

          if (req.url?.startsWith("/api/files/") && req.method === "GET") {
            const resolvedShareFilter = await getResolvedShareFilter();
            if (res.writableEnded) return;
            await filesEndpointRequestHandler(
              req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
              res,
              {
                database,
                storageRoot: storagePath,
                taskOrchestrator,
                shareFilter: resolvedShareFilter,
              },
            );
            return;
          }

          // Default 404
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        } catch (error) {
          if (isAbortError(error)) {
            // The client already disconnected; there is no one to answer and
            // nothing actually failed.
            res.destroy();
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
