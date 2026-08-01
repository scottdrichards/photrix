import { getToken } from "../auth";
import { fetchJsonOrThrow } from "./http";
import type { ServerStatus } from "./types";

export const subscribeStatusStream = (
  onUpdate: (status: ServerStatus) => void,
  onError?: (error: unknown) => void,
) => {
  const token = getToken();
  const url = token
    ? `/api/status/stream?token=${encodeURIComponent(token)}`
    : "/api/status/stream";
  const source = new EventSource(url);

  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as ServerStatus;
      onUpdate(data);
    } catch (error) {
      onError?.(error);
    }
  };

  source.onerror = (error) => {
    onError?.(error);
  };

  return () => source.close();
};

export const fetchStatus = async (): Promise<ServerStatus> => {
  return await fetchJsonOrThrow<ServerStatus>("/api/status", "fetch status");
};

export const setBackgroundTasksEnabled = async (
  enabled: boolean,
): Promise<{ enabled: boolean }> => {
  return await fetchJsonOrThrow<{ enabled: boolean }>(
    "/api/status/background-tasks",
    "update background task setting",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled }),
    },
  );
};

export const clearHlsSessions = async (): Promise<void> => {
  await fetchJsonOrThrow<{ ok: boolean }>(
    "/api/status/clear-hls",
    "clear HLS sessions",
    { method: "POST" },
  );
};
