import { fetchWithDiagnostics, fetchJsonOrThrow } from "./http";
import { buildFileUrl } from "./photoItem";
import type { TranscriptSegment, VideoNegotiationResult } from "./types";

export const negotiateVideoPlayback = async (options: {
  path: string;
  bandwidthMbps: number | null;
  hevcSupported: boolean;
  forceTranscode?: boolean;
  /**
   * Grid hover preview. Tells the server this playback is disposable, so it must
   * answer from an already-cached low rendition or a cheap raw read and never
   * start a GPU transcode for it — an `error` result here just means "no
   * preview", not a failure.
   */
  preview?: boolean;
  signal?: AbortSignal;
  clientOperationId?: string;
}): Promise<VideoNegotiationResult> => {
  const {
    path,
    bandwidthMbps,
    hevcSupported,
    forceTranscode,
    preview,
    signal,
    clientOperationId,
  } = options;
  const params = new URLSearchParams();
  params.set("path", path);
  if (bandwidthMbps !== null && Number.isFinite(bandwidthMbps)) {
    params.set("bandwidthMbps", bandwidthMbps.toString());
  }
  params.set("hevcSupported", String(hevcSupported));
  if (forceTranscode) {
    params.set("forceTranscode", "true");
  }
  if (preview) {
    params.set("preview", "true");
  }

  const response = await fetchWithDiagnostics(
    `/api/video/negotiate?${params.toString()}`,
    "negotiate video playback",
    {
      signal,
      diagnostics: { clientOperationId },
    },
  );
  return (await response.json()) as VideoNegotiationResult;
};

export const fetchTranscriptSegments = async (
  path: string,
  signal?: AbortSignal,
  clientOperationId?: string,
): Promise<TranscriptSegment[]> => {
  const url = buildFileUrl(path, { representation: "transcript" });
  const result = await fetchJsonOrThrow<{ segments: TranscriptSegment[] }>(
    url,
    "fetch transcript",
    { signal, diagnostics: { clientOperationId } },
  );
  return result.segments;
};
