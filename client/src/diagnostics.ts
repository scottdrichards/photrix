import { getAuthHeaders } from "./auth";

type DiagnosticsLevel = "debug" | "info" | "warn" | "error";

type ClientDiagnosticsEvent = {
  timestamp?: string;
  level: DiagnosticsLevel;
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

type LogClientEventOptions = Omit<ClientDiagnosticsEvent, "timestamp" | "clientSessionId"> & {
  immediate?: boolean;
};

const SESSION_STORAGE_KEY = "photrix_client_session_id";
// Browsers reject a `keepalive` fetch whose body exceeds 64 KiB. Sending the
// whole queue in one keepalive request meant that once it grew past that (say
// after a spell offline) every flush threw, re-queued the batch and retried,
// forever, while the queue kept growing. So send bounded batches, only ask for
// keepalive when the body fits, and drop the oldest events past a cap.
const MAX_PENDING_EVENTS = 500;
const MAX_BATCH_EVENTS = 50;
const KEEPALIVE_MAX_BODY_BYTES = 60 * 1024;
const pendingEvents: ClientDiagnosticsEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight = false;
let fallbackSessionId: string | null = null;

const createId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const getClientSessionId = () => {
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) {
      return existing;
    }

    const created = createId();
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    if (fallbackSessionId) {
      return fallbackSessionId;
    }

    fallbackSessionId = createId();
    return fallbackSessionId;
  }
};

export const createClientOperationId = () => createId();

const scheduleFlush = (delayMs = 250) => {
  if (flushTimer) {
    return;
  }

  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushClientDiagnostics();
  }, delayMs);
};

const trimPendingEvents = () => {
  if (pendingEvents.length > MAX_PENDING_EVENTS) {
    pendingEvents.splice(0, pendingEvents.length - MAX_PENDING_EVENTS);
  }
};

export const flushClientDiagnostics = async () => {
  if (flushInFlight || pendingEvents.length === 0) {
    return;
  }

  flushInFlight = true;
  const batch = pendingEvents.splice(0, MAX_BATCH_EVENTS);
  const body = JSON.stringify({ events: batch });

  try {
    await fetch("/api/diagnostics/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      keepalive: new TextEncoder().encode(body).byteLength <= KEEPALIVE_MAX_BODY_BYTES,
      body,
    });
  } catch {
    pendingEvents.unshift(...batch);
    trimPendingEvents();
  } finally {
    flushInFlight = false;
    if (pendingEvents.length > 0) {
      scheduleFlush(1_000);
    }
  }
};

export const logClientEvent = (options: LogClientEventOptions) => {
  pendingEvents.push({
    timestamp: new Date().toISOString(),
    clientSessionId: getClientSessionId(),
    level: options.level,
    event: options.event,
    ...(options.message ? { message: options.message } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.clientOperationId ? { clientOperationId: options.clientOperationId } : {}),
    ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
    ...(options.method ? { method: options.method } : {}),
    ...(options.url ? { url: options.url } : {}),
    ...(options.statusCode != null ? { statusCode: options.statusCode } : {}),
    ...(options.data ? { data: options.data } : {}),
  });
  trimPendingEvents();

  if (options.immediate) {
    void flushClientDiagnostics();
    return;
  }

  scheduleFlush();
};

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    void flushClientDiagnostics();
  });
}
