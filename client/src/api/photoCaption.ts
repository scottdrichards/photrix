import { fetchJsonOrThrow } from "./http";

/**
 * Fetches the <=6-word AI caption for a photo (fullscreen-viewer toast + tab
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
