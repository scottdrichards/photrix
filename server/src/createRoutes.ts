import type http from "node:http";
import type { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import type { TaskOrchestrator } from "./taskOrchestrator/taskOrchestrator.ts";
import type { FeatureFlagStore } from "./featureFlags/featureFlagStore.ts";
import type { ShareScope } from "../../shared/filter-contract/src/index.ts";
import type { FilterElement } from "./indexDatabase/indexDatabase.type.ts";
import { writeJson } from "./common/writeJson.ts";
import { decodeRequestPath } from "./common/decodeRequestPath.ts";
import { extractShareFolderRoots } from "./auth/shareFolderScope.ts";
import { buildDiagnosticsReport } from "./observability/buildDiagnosticsReport.ts";
import { analyzeImage } from "./imageAnalysis/imageAnalysisWorker.ts";
import { killAllSessions } from "./videoProcessing/hlsSession.ts";
import { createCoverageReporter } from "./requestHandlers/analysisCoverage.ts";
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
import { diagnosticsEventsRequestHandler } from "./requestHandlers/diagnosticsRequestHandler.ts";
import { diagnosticsReportRequestHandler } from "./requestHandlers/diagnosticsReportRequestHandler.ts";
import { statusRequestHandler } from "./requestHandlers/statusRequestHandler.ts";
import { statusBackgroundTasksRequestHandler } from "./requestHandlers/statusBackgroundTasksRequestHandler.ts";
import { featureFlagsRequestHandler } from "./requestHandlers/featureFlagsRequestHandler.ts";
import { networkProbeRequestHandler } from "./requestHandlers/networkProbeRequestHandler.ts";
import { dayPhotoRequestHandler } from "./requestHandlers/dayPhotoRequestHandler.ts";
import { foldersRequestHandler } from "./requestHandlers/foldersRequestHandler.ts";
import { pageTitleHandler } from "./requestHandlers/pageTitleHandler.ts";
import { photoCaptionRequestHandler } from "./requestHandlers/photoCaptionRequestHandler.ts";
import { suggestRotationRequestHandler } from "./requestHandlers/suggestRotationRequestHandler.ts";
import { feedbackHandler } from "./requestHandlers/feedbackHandler.ts";
import { suggestionsRequestHandler } from "./requestHandlers/suggestionsRequestHandler.ts";
import { videoNegotiationRequestHandler } from "./requestHandlers/video/videoNegotiation.ts";
import { searchInterpretHandler } from "./requestHandlers/searchInterpretHandler.ts";
import {
  searchRequestHandler,
  searchStatusRequestHandler,
} from "./requestHandlers/searchRequestHandler.ts";
import { faceIdentifyRequestHandler } from "./requestHandlers/faceIdentifyRequestHandler.ts";
import { peopleRequestHandler } from "./requestHandlers/peopleRequestHandler.ts";
import { settingsRequestHandler } from "./requestHandlers/settingsRequestHandler.ts";
import { momentClustersRequestHandler } from "./requestHandlers/momentClustersRequestHandler.ts";
import { updateFileMetadataHandler } from "./requestHandlers/files/updateMetadataHandler.ts";
import { filesEndpointRequestHandler } from "./requestHandlers/files/filesRequestHandler.ts";

export type ApiRequest = http.IncomingMessage & { url: string };

export type RouteContext = {
  req: ApiRequest;
  res: http.ServerResponse;
  pathname: string;
  /** The caller's share scope, or null for a signed-in session (or auth disabled). */
  shareScope: ShareScope<unknown> | null;
  /** The share's filter, resolved. Only set on a `"scoped"` route; null otherwise. */
  shareFilter: unknown;
};

/**
 * What a share-link caller may do on a route.
 *
 * - `"forbidden"`: 403. Owner-only state, the whole library's diagnostics, or
 *   anything that writes to the index.
 * - `"allowed"`: served as-is; the route reveals nothing outside the share.
 * - `"scoped"`: served, with the share's filter resolved into
 *   `ctx.shareFilter` first so the handler ANDs it into every query.
 */
export type ShareLinkAccess = "forbidden" | "allowed" | "scoped";

export type Route = {
  /** Omitted: any method. */
  method?: "GET" | "POST" | "PATCH";
  /** An exact pathname, or a prefix when it ends in `*`. Matched against the pathname, never the query. */
  path: string;
  shareLink: ShareLinkAccess;
  handle: (ctx: RouteContext) => Promise<void> | void;
};

export type RouteDeps = {
  database: IndexDatabase;
  storageRoot: string;
  taskOrchestrator: TaskOrchestrator;
  featureFlags: FeatureFlagStore;
};

export const matchesRoute = (
  route: Route,
  method: string | undefined,
  pathname: string,
) =>
  (!route.method || route.method === method) &&
  (route.path.endsWith("*")
    ? pathname.startsWith(route.path.slice(0, -1))
    : pathname === route.path);

/**
 * Every `/api` route, in match order: the first route whose method and path
 * match handles the request, so a specific route must come before a prefix
 * that covers it (`/api/status/stream` before `/api/status*`).
 *
 * Auth has already run by the time a route is reached; see `createServer`.
 */
export const createRoutes = ({
  database,
  storageRoot,
  taskOrchestrator,
  featureFlags,
}: RouteDeps): Route[] => {
  const getCoverage = createCoverageReporter(database.analysis);

  return [
    // --- Sign-in. These bypass the auth gate. ---
    {
      method: "POST",
      path: "/api/auth/login",
      shareLink: "allowed",
      handle: ({ req, res }) => authLoginHandler(req, res),
    },
    {
      method: "POST",
      path: "/api/auth/logout",
      shareLink: "allowed",
      handle: ({ req, res }) => authLogoutHandler(req, res),
    },
    // Takes `?dryRun=1`.
    {
      method: "POST",
      path: "/api/auth/share-token",
      shareLink: "allowed",
      handle: ({ req, res }) => authShareTokenHandler(req, res, database),
    },
    {
      method: "POST",
      path: "/api/auth/passkey/registration-options",
      shareLink: "allowed",
      handle: ({ req, res }) => passkeyRegistrationOptionsHandler(req, res),
    },
    {
      method: "POST",
      path: "/api/auth/passkey/registration-verify",
      shareLink: "allowed",
      handle: ({ req, res }) => passkeyRegistrationVerifyHandler(req, res),
    },
    {
      method: "POST",
      path: "/api/auth/passkey/authentication-options",
      shareLink: "allowed",
      handle: ({ req, res }) => passkeyAuthenticationOptionsHandler(req, res),
    },
    {
      method: "POST",
      path: "/api/auth/passkey/authentication-verify",
      shareLink: "allowed",
      handle: ({ req, res }) => passkeyAuthenticationVerifyHandler(req, res),
    },
    // The handler requires an interactive session itself, which a share token never is.
    {
      path: "/api/account*",
      shareLink: "allowed",
      handle: ({ req, res }) => accountRequestHandler(req, res),
    },

    // --- Health, status and diagnostics ---
    {
      method: "GET",
      path: "/api/health",
      shareLink: "allowed",
      handle: ({ res }) => {
        if (database.asyncSqlite?.failed) {
          writeJson(res, 503, {
            status: "error",
            message: "Database worker died; the server is restarting",
          });
        } else if (database.mediaRootUnavailable) {
          writeJson(res, 503, {
            status: "unloaded",
            message:
              "Media root unavailable — index left untouched, not serving live library state",
          });
        } else {
          writeJson(res, 200, { status: "ok", message: "Server is running" });
        }
      },
    },
    // A share-link viewer's client reports its own diagnostics, but may not read
    // the buffer back: it holds every other client's sessions and requests.
    {
      method: "POST",
      path: "/api/diagnostics/events*",
      shareLink: "allowed",
      handle: ({ req, res }) => diagnosticsEventsRequestHandler(req, res),
    },
    {
      path: "/api/diagnostics/events*",
      shareLink: "forbidden",
      handle: ({ req, res }) => diagnosticsEventsRequestHandler(req, res),
    },
    {
      method: "GET",
      path: "/api/diagnostics/perf",
      shareLink: "forbidden",
      handle: ({ req, res }) =>
        diagnosticsReportRequestHandler(req, res, taskOrchestrator),
    },
    {
      method: "GET",
      path: "/api/diagnostics/report",
      shareLink: "forbidden",
      handle: ({ req, res }) =>
        diagnosticsReportRequestHandler(req, res, taskOrchestrator),
    },
    {
      method: "GET",
      path: "/api/status/stream*",
      shareLink: "forbidden",
      handle: ({ req, res }) =>
        statusRequestHandler(req, res, { stream: true, taskOrchestrator, getCoverage }),
    },
    {
      method: "POST",
      path: "/api/status/background-tasks",
      shareLink: "forbidden",
      handle: ({ req, res }) =>
        statusBackgroundTasksRequestHandler(req, res, { taskOrchestrator }),
    },
    {
      method: "POST",
      path: "/api/status/clear-hls",
      shareLink: "forbidden",
      handle: ({ res }) => {
        killAllSessions();
        writeJson(res, 200, { ok: true });
      },
    },
    {
      method: "GET",
      path: "/api/status*",
      shareLink: "forbidden",
      handle: ({ req, res }) =>
        statusRequestHandler(req, res, { stream: false, taskOrchestrator, getCoverage }),
    },
    // Anyone may read the flags (the client needs them to render); only a
    // signed-in session may change one.
    {
      path: "/api/feature-flags*",
      shareLink: "allowed",
      handle: ({ req, res, shareScope }) =>
        featureFlagsRequestHandler(req, res, {
          store: featureFlags,
          canChange: !shareScope,
        }),
    },
    {
      method: "GET",
      path: "/api/network-probe*",
      shareLink: "allowed",
      handle: ({ req, res }) => networkProbeRequestHandler(req, res),
    },

    // --- Browsing the library ---
    // Picks from the whole library for any date, so it is outside every share.
    {
      method: "GET",
      path: "/api/day-photo/*",
      shareLink: "forbidden",
      handle: ({ req, res }) => dayPhotoRequestHandler(req, res),
    },
    // A share link browses its own subtree: the listing is ANDed with the share
    // filter and the requested path is clamped to the shared root.
    {
      method: "GET",
      path: "/api/folders/*",
      shareLink: "scoped",
      handle: ({ req, res, shareScope, shareFilter }) =>
        foldersRequestHandler(req, res, {
          database,
          shareFilter,
          shareFolderRoots: shareScope
            ? extractShareFolderRoots(shareScope.filter as FilterElement)
            : null,
        }),
    },
    {
      method: "POST",
      path: "/api/page-title",
      shareLink: "scoped",
      handle: ({ req, res, shareFilter }) =>
        pageTitleHandler(req, res, database, shareFilter),
    },
    // Calls a local vision model and reveals who and when is in the library.
    {
      method: "GET",
      path: "/api/photos/caption*",
      shareLink: "forbidden",
      handle: ({ req, res }) =>
        photoCaptionRequestHandler(req, res, { database, storageRoot }),
    },
    {
      method: "GET",
      path: "/api/photos/suggest-rotation*",
      shareLink: "forbidden",
      handle: ({ req, res }) =>
        suggestRotationRequestHandler(req, res, { database, storageRoot }),
    },
    {
      method: "GET",
      path: "/api/suggestions*",
      shareLink: "scoped",
      handle: ({ req, res, shareFilter }) =>
        suggestionsRequestHandler(req, res, { database, shareFilter }),
    },
    {
      method: "GET",
      path: "/api/video/negotiate*",
      shareLink: "scoped",
      handle: ({ req, res, shareFilter }) =>
        videoNegotiationRequestHandler(req, res, {
          database,
          storageRoot,
          taskOrchestrator,
          shareFilter,
        }),
    },
    // Grounds the model in every person and folder in the library.
    {
      method: "POST",
      path: "/api/search/interpret",
      shareLink: "forbidden",
      handle: ({ req, res }) => searchInterpretHandler(req, res, { database }),
    },
    {
      method: "GET",
      path: "/api/search/status",
      shareLink: "allowed",
      handle: ({ res }) => searchStatusRequestHandler(res),
    },
    {
      method: "GET",
      path: "/api/search*",
      shareLink: "scoped",
      handle: ({ req, res, shareScope, shareFilter }) =>
        searchRequestHandler(req, res, { database, shareFilter, shareScope }),
    },
    {
      method: "PATCH",
      path: "/api/files/*",
      shareLink: "scoped",
      handle: ({ req, res, pathname, shareFilter }) =>
        updateFileMetadataHandler(
          req,
          decodeRequestPath(pathname.slice("/api/files/".length)),
          res,
          database,
          shareFilter,
        ),
    },
    // A trailing slash queries a folder (`/api/files/sub/`); none serves a file (`/api/files/sub/a.jpg`).
    {
      method: "GET",
      path: "/api/files/*",
      shareLink: "scoped",
      handle: ({ req, res, shareFilter }) =>
        filesEndpointRequestHandler(req, res, {
          database,
          storageRoot,
          taskOrchestrator,
          shareFilter,
        }),
    },

    // --- Feedback ---
    // The global "Comments" button works from a shared link, so a share may
    // submit; it may not list or manage the triage queue.
    {
      method: "POST",
      path: "/api/feedback",
      shareLink: "allowed",
      handle: ({ req, res, shareScope }) =>
        feedbackHandler(req, res, database, {
          markExternal: Boolean(shareScope),
          buildDiagnosticsReport: (clientSessionId) =>
            buildDiagnosticsReport(clientSessionId, taskOrchestrator),
        }),
    },
    {
      path: "/api/feedback*",
      shareLink: "forbidden",
      handle: ({ req, res }) =>
        feedbackHandler(req, res, database, {
          markExternal: false,
          buildDiagnosticsReport: (clientSessionId) =>
            buildDiagnosticsReport(clientSessionId, taskOrchestrator),
        }),
    },

    // --- Owner-only management. Each handler checks its own methods and sub-routes. ---
    // Runs the shared analysis worker and enumerates every named person.
    {
      path: "/api/faces/*",
      shareLink: "forbidden",
      handle: ({ req, res }) =>
        faceIdentifyRequestHandler(req, res, { database, analyzeImage }),
    },
    {
      path: "/api/people/*",
      shareLink: "forbidden",
      handle: ({ req, res }) => peopleRequestHandler(req, res, database),
    },
    // The owner's default exclusions still apply to what a share sees (queryHandler.ts).
    {
      path: "/api/settings/*",
      shareLink: "forbidden",
      handle: ({ req, res }) => settingsRequestHandler(req, res, database),
    },
    {
      method: "POST",
      path: "/api/moment-clusters/*",
      shareLink: "forbidden",
      handle: ({ req, res }) => momentClustersRequestHandler(req, res, database),
    },
  ];
};
