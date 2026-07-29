import { fetchWithDiagnostics, fetchJsonOrThrow } from "./http";
import { buildFileUrl } from "./photoItem";
import type { TranscriptSegment, VideoNegotiationResult } from "./types";

export const negotiateVideoPlayback = async (options: {
  path: string;
  bandwidthMbps: number | null;
  hevcSupported: boolean;
  forceTranscode?: boolean;
  clientOperationId?: string;
}): Promise<VideoNegotiationResult> => {
  const { path, bandwidthMbps, hevcSupported, forceTranscode, clientOperationId } =
    options;
  const params = new URLSearchParams();
  params.set("path", path);
  if (bandwidthMbps !== null && Number.isFinite(bandwidthMbps)) {
    params.set("bandwidthMbps", bandwidthMbps.toString());
  }
  params.set("hevcSupported", String(hevcSupported));
  if (forceTranscode) {
    params.set("forceTranscode", "true");
  }

  const response = await fetchWithDiagnostics(
    `/api/video/negotiate?${params.toString()}`,
    "negotiate video playback",
    {
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
