import { fetchJsonOrThrow, fetchWithDiagnostics } from "./http";

/**
 * Fetches the short AI caption for a photo (the viewer's tab
 * title). A real (uncached) generation takes ~90-100s on the current Ollama
 * host — callers must support a long-pending request and cancel via `signal`
 * if the user moves on before it resolves. Returns null on any server-side
 * failure (best-effort feature, never throws for that case) but still
 * rejects on network/abort errors so callers can distinguish "no caption"
 * from "request cancelled".
 */
export const fetchPhotoCaption = async (
  path: string,
  signal?: AbortSignal,
): Promise<string | null> => {
  const params = new URLSearchParams({ path });
  const payload = await fetchJsonOrThrow<{ caption?: string | null }>(
    `/api/photos/caption?${params.toString()}`,
    "fetch photo caption",
    { signal },
  );
  return payload.caption ?? null;
};

/**
 * Streams the long AI description for the file-info panel (feedback #148).
 * `onDelta` receives the text as the model writes it; resolves with the
 * cleaned final description (which can differ slightly from the concatenated
 * deltas, e.g. a stripped "This image shows" preamble), or null for a photo
 * that has none. Rejects on failure or abort.
 */
export const streamPhotoDescription = async (
  path: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<string | null> => {
  const params = new URLSearchParams({ path, kind: "description" });
  const response = await fetchWithDiagnostics(
    `/api/photos/caption?${params.toString()}`,
    "stream photo description",
    { signal },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Failed to stream photo description (status ${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const events = buffered.split("\n\n");
    buffered = events.pop() ?? "";
    for (const event of events) {
      const data = event.replace(/^data: /, "");
      if (!data.trim()) continue;
      const payload = JSON.parse(data) as {
        delta?: string;
        description?: string | null;
        error?: string;
      };
      if (payload.error) throw new Error(payload.error);
      if (payload.delta) onDelta(payload.delta);
      if ("description" in payload) return payload.description ?? null;
    }
  }
  throw new Error("Photo description stream ended early");
};
