import type http from "node:http";
import { recordClientDiagnosticEvent, listDiagnosticsEvents } from "../observability/diagnosticsStore.ts";
import { writeJson } from "../utils.ts";

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

const readJsonBody = async <T>(req: http.IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf-8").trim();
  if (!body) {
    throw new Error("Request body is required");
  }

  return JSON.parse(body) as T;
};

export const diagnosticsEventsRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
) => {
  if (req.method === "POST") {
    try {
      const payload = await readJsonBody<ClientDiagnosticsPayload>(req);
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
          ...(event.clientOperationId ? { clientOperationId: event.clientOperationId } : {}),
          ...(event.clientRequestId ? { clientRequestId: event.clientRequestId } : {}),
          ...(event.method ? { method: event.method } : {}),
          ...(event.url ? { url: event.url } : {}),
          ...(event.statusCode != null ? { statusCode: event.statusCode } : {}),
          ...(event.data ? { data: event.data } : {}),
        });
      }

      writeJson(res, 202, { accepted: payload.events.length });
      return;
    } catch (error) {
      writeJson(res, 400, {
        error: "Invalid JSON payload",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
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
