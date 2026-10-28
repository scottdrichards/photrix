import type http from "node:http";
import {
  recordClientDiagnosticEvent,
  listDiagnosticsEvents,
} from "../observability/diagnosticsStore.ts";
import { writeJson } from "../utils.ts";
import { readJsonRequest } from "../common/readBody.ts";

type ClientDiagnosticsPayload = {
  events: Array<{
    timestamp?: string;
    level?: "debug" | "info" | "warn" | "error";
    event?: string;
    message?: string;
    requestId?: string;
    clientSessionId?: string;
    clientOperationId?: string;
    clientRequestId?: string;
    method?: string;
    url?: string;
    statusCode?: number;
    data?: Record<string, unknown>;
  }>;
};

export const diagnosticsEventsRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
) => {
  if (req.method === "POST") {
    const payload = await readJsonRequest<ClientDiagnosticsPayload>(req, res);
    if (!payload) return;
    if (!Array.isArray(payload.events) || payload.events.length === 0) {
      writeJson(res, 400, { error: "'events' must be a non-empty array" });
      return;
    }

    for (const event of payload.events) {
      if (!event || typeof event !== "object") {
        writeJson(res, 400, { error: "Each event must be an object" });
        return;
      }

      if (!event.event || typeof event.event !== "string") {
        writeJson(res, 400, { error: "Each event requires a string 'event'" });
        return;
      }

      recordClientDiagnosticEvent({
        level: event.level ?? "info",
        event: event.event,
        ...(event.timestamp ? { timestamp: event.timestamp } : {}),
        ...(event.message ? { message: event.message } : {}),
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.clientSessionId ? { clientSessionId: event.clientSessionId } : {}),
        ...(event.clientOperationId
          ? { clientOperationId: event.clientOperationId }
          : {}),
        ...(event.clientRequestId ? { clientRequestId: event.clientRequestId } : {}),
        ...(event.method ? { method: event.method } : {}),
        ...(event.url ? { url: event.url } : {}),
        ...(event.statusCode != null ? { statusCode: event.statusCode } : {}),
        ...(event.data ? { data: event.data } : {}),
      });
    }

    writeJson(res, 202, { accepted: payload.events.length });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam != null ? Number.parseInt(limitParam, 10) : undefined;

  writeJson(res, 200, {
    events: listDiagnosticsEvents({
      clientSessionId: url.searchParams.get("clientSessionId"),
      clientOperationId: url.searchParams.get("clientOperationId"),
      requestId: url.searchParams.get("requestId"),
      limit,
    }),
  });
};
