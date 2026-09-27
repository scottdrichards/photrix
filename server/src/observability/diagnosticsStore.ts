import { redactRequestPath, scrubDiagnostics } from "./privacy.ts";
import { getCurrentRequestLogFields } from "./requestTrace.ts";

const MAX_EVENTS = 2_000;

export type DiagnosticsEvent = {
  id: string;
  timestamp: string;
  source: "server" | "client";
  level: "debug" | "info" | "warn" | "error";
  event: string;
  message?: string;
  requestId?: string;
  clientSessionId?: string;
  clientOperationId?: string;
  clientRequestId?: string;
  method?: string;
  url?: string;
  statusCode?: number;
  data?: Record<string, unknown>;
};

type DiagnosticsEventInput = Omit<DiagnosticsEvent, "id" | "timestamp" | "source"> & {
  timestamp?: string;
};

type DiagnosticsFilters = {
  clientSessionId?: string | null;
  clientOperationId?: string | null;
  requestId?: string | null;
  limit?: number;
};

const events: DiagnosticsEvent[] = [];
let nextId = 1;

const trimEvents = () => {
  if (events.length <= MAX_EVENTS) {
    return;
  }

  events.splice(0, events.length - MAX_EVENTS);
};

const normalizeLimit = (limit: number | undefined) => {
  if (!Number.isFinite(limit) || limit == null) {
    return 200;
  }
  return Math.max(1, Math.min(Math.floor(limit), MAX_EVENTS));
};

const buildEvent = (
  source: DiagnosticsEvent["source"],
  input: DiagnosticsEventInput,
): DiagnosticsEvent => {
  const requestFields = source === "server" ? getCurrentRequestLogFields() : {};
  // Client events arrive with raw request URLs, and both sides describe video
  // playback by library path; none of that is kept (see privacy.ts).
  const { message, data } = scrubDiagnostics(input.message, input.data);
  const url = input.url ?? requestFields.url;

  return {
    id: String(nextId++),
    timestamp: input.timestamp ?? new Date().toISOString(),
    source,
    level: input.level,
    event: input.event,
    ...(message ? { message } : {}),
    ...((input.requestId ?? requestFields.requestId)
      ? { requestId: input.requestId ?? requestFields.requestId }
      : {}),
    ...((input.clientSessionId ?? requestFields.clientSessionId)
      ? { clientSessionId: input.clientSessionId ?? requestFields.clientSessionId }
      : {}),
    ...((input.clientOperationId ?? requestFields.clientOperationId)
      ? { clientOperationId: input.clientOperationId ?? requestFields.clientOperationId }
      : {}),
    ...((input.clientRequestId ?? requestFields.clientRequestId)
      ? { clientRequestId: input.clientRequestId ?? requestFields.clientRequestId }
      : {}),
    ...((input.method ?? requestFields.method)
      ? { method: input.method ?? requestFields.method }
      : {}),
    ...(url ? { url: redactRequestPath(url) } : {}),
    ...(input.statusCode != null ? { statusCode: input.statusCode } : {}),
    ...(data ? { data } : {}),
  };
};

const pushEvent = (event: DiagnosticsEvent) => {
  events.push(event);
  trimEvents();
  return event;
};

export const recordServerDiagnosticEvent = (
  input: DiagnosticsEventInput,
): DiagnosticsEvent => {
  return pushEvent(buildEvent("server", input));
};

export const recordClientDiagnosticEvent = (
  input: DiagnosticsEventInput,
): DiagnosticsEvent => {
  const event = pushEvent(buildEvent("client", input));
  return event;
};

export const listDiagnosticsEvents = (filters: DiagnosticsFilters = {}) => {
  const { clientSessionId, clientOperationId, requestId } = filters;
  const limit = normalizeLimit(filters.limit);

  return events
    .filter((event) => {
      if (clientSessionId && event.clientSessionId !== clientSessionId) {
        return false;
      }
      if (clientOperationId && event.clientOperationId !== clientOperationId) {
        return false;
      }
      if (requestId && event.requestId !== requestId) {
        return false;
      }
      return true;
    })
    .slice(-limit);
};

export const clearDiagnosticsEvents = () => {
  events.length = 0;
  nextId = 1;
};
