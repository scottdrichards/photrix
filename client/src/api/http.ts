import { getAuthHeaders, notifyUnauthorized } from "../auth";
import {
  createClientOperationId,
  getClientSessionId,
  logClientEvent,
} from "../diagnostics";

export const fetchWithDiagnostics = async (
  url: string,
  errorLabel: string,
  init?: RequestInit & { diagnostics?: { clientOperationId?: string } },
): Promise<Response> => {
  const clientRequestId = createClientOperationId();
  const clientOperationId = init?.diagnostics?.clientOperationId;

  logClientEvent({
    level: "info",
    event: "client.request.started",
    message: `Started ${errorLabel}`,
    clientOperationId,
    clientRequestId,
    method: init?.method ?? "GET",
    url,
  });

  const startedAt = performance.now();
  const elapsedMs = () => Math.round(performance.now() - startedAt);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...getAuthHeaders(),
        "X-Client-Session-Id": getClientSessionId(),
        "X-Client-Request-Id": clientRequestId,
        ...(clientOperationId ? { "X-Client-Operation-Id": clientOperationId } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    logClientEvent({
      level: (error as Error).name === "AbortError" ? "warn" : "error",
      event:
        (error as Error).name === "AbortError"
          ? "client.request.aborted"
          : "client.request.failed",
      message: `Failed to ${errorLabel}`,
      clientOperationId,
      clientRequestId,
      method: init?.method ?? "GET",
      url,
      data: {
        error: error instanceof Error ? error.message : String(error),
        durationMs: elapsedMs(),
      },
      immediate: true,
    });
    throw error;
  }

  const requestId = response.headers?.get?.("X-Request-Id") ?? undefined;
  logClientEvent({
    level: response.ok ? "info" : response.status >= 500 ? "error" : "warn",
    event: response.ok ? "client.request.completed" : "client.request.rejected",
    message: `${errorLabel} returned ${response.status}`,
    requestId,
    clientOperationId,
    clientRequestId,
    method: init?.method ?? "GET",
    url,
    statusCode: response.status,
    // Time to response headers: compare with the server's request log /
    // `server.request.slow` event for the same requestId to split network from server time.
    data: { durationMs: elapsedMs() },
    immediate: !response.ok,
  });

  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error(`Unauthorized`);
  }

  return response;
};

export const fetchJsonOrThrow = async <T>(
  url: string,
  errorLabel: string,
  init?: RequestInit & { diagnostics?: { clientOperationId?: string } },
): Promise<T> => {
  const response = await fetchWithDiagnostics(url, errorLabel, init);
  if (!response.ok) {
    throw new Error(`Failed to ${errorLabel} (status ${response.status})`);
  }
  return (await response.json()) as T;
};
