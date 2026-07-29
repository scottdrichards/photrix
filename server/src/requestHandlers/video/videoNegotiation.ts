import type http from "node:http";
import { getGpuAcceleration } from "../../videoProcessing/gpuAcceleration.ts";
import { getHLSInfo } from "../../videoProcessing/generateHLS.ts";
import {
  getMultibitrateHLSDirectory,
  getVariantSegmentPath,
  multibitrateHLSInitialized,
} from "../../videoProcessing/generateMultibitrateHLS.ts";
import { HLS_SEGMENT_SECONDS } from "../../videoProcessing/buildHlsPlaylist.ts";
import { existsSync } from "fs";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import type { FilterElement } from "../../indexDatabase/indexDatabase.type.ts";
import { mimeTypeForFilename } from "../../fileHandling/mimeTypes.ts";
import { writeJson } from "../../utils.ts";
import path from "path";
import { recordServerDiagnosticEvent } from "../../observability/diagnosticsStore.ts";
import type { TaskOrchestrator } from "../../taskOrchestrator/taskOrchestrator.ts";
import { getLogger } from "../../observability/logger.ts";
import { reclaimGpuForUser } from "../../taskOrchestrator/computeWorkers.ts";

const log = getLogger("videoNegotiation");

type VideoPlaybackRequest = {
  path: string;
  bandwidthMbps: number | null;
  hevcSupported: boolean;
  // Set when the client has already tried direct playback and it stalled on
  // buffering. Skips the direct branch so we hand back an adaptive HLS stream
  // (or a visible error) instead of the same un-adaptive original.
  forceTranscode?: boolean;
  // Set for the grid's throwaway hover preview. A preview is a nice-to-have, so
  // it is never worth a fresh GPU encode on the shared card: only an already
  // cached low rendition or a cheap raw read qualifies, otherwise we say no.
  preview?: boolean;
};

type VideoPlaybackResponse =
  | { mode: "hls"; url: string; reason: string; previewMaxSeconds?: number }
  | { mode: "direct"; url: string; reason: string; previewMaxSeconds?: number }
  | { mode: "error"; reason: string };

// Reason strings are also used by the handler to tell the on-the-fly GPU encode
// apart from a cached-HLS hit (only the former should evict background ML VRAM).
export const REASON_DIRECT = "Direct playback — connection can carry the original";
export const REASON_CACHED_HLS = "Cached HLS available";
export const REASON_GPU_HLS = "Hardware-accelerated HLS encoding available";
export const REASON_NO_PATH =
  "Connection too slow for the original and no GPU to transcode";
export const REASON_PREVIEW_CACHED = "Preview from cached low rendition";
export const REASON_PREVIEW_DIRECT = "Preview from the original — cheap enough to read";
export const REASON_PREVIEW_TRANSCODE = "Preview via live 360p transcode";
export const REASON_PREVIEW_UNAVAILABLE = "No preview available — no GPU to transcode";

const H264_CODECS = new Set(["h264", "avc", "avc1"]);
const HEVC_CODECS = new Set(["hevc", "h265", "hev1", "hvc1"]);
const canClientPlayCodec = (
  videoCodec: string | undefined,
  hevcSupported: boolean,
): boolean => {
  if (!videoCodec) return false;
  const normalized = videoCodec.toLowerCase();
  if (H264_CODECS.has(normalized)) return true;
  if (HEVC_CODECS.has(normalized) && hevcSupported) return true;
  return false;
};

// Measured throughput must clear the file's average bitrate by this margin before
// we stream the raw original — VBR peaks run above average and playback needs a
// little buffer headroom, so matching the average alone would stall.
const RAW_BANDWIDTH_SAFETY_FACTOR = 1.5;

/**
 * True when the client's *measured* downlink (Mbps) can comfortably carry the raw
 * file. Uses the file's real average bitrate (size / duration), so a fast WAN link
 * qualifies for a small clip while a slow VPN that merely looks like LAN does not.
 * Unknown bandwidth or missing size/duration ⇒ false (fall back to transcoding).
 */
export const bandwidthCoversRawFile = (
  bandwidthMbps: number | null,
  metadata: { sizeInBytes?: number; duration?: number } | undefined,
): boolean => {
  if (bandwidthMbps === null || !Number.isFinite(bandwidthMbps)) return false;
  const size = metadata?.sizeInBytes;
  const duration = metadata?.duration;
  if (!size || !duration || duration <= 0) return false;
  const rawBitrateMbps = (size * 8) / duration / 1_000_000;
  return bandwidthMbps >= rawBitrateMbps * RAW_BANDWIDTH_SAFETY_FACTOR;
};

/**
 * Cheap-read ceiling for previewing the raw original (Mbps of average bitrate).
 * A hover preview is throwaway, so even on a link that could carry a 4K 50 Mbps
 * original we refuse to spend those bytes on it — the owner browses over a
 * metered WAN link. Combined with PREVIEW_MAX_SECONDS this bounds a preview to
 * roughly 9 MB of transfer.
 */
export const PREVIEW_MAX_RAW_MBPS = 12;

/**
 * Hard cap on how long a grid preview may run. Also the ceiling on how many
 * cached HLS segments we will advertise: playing past the cached tail would make
 * the segment handler start an encode, which is exactly what preview mode exists
 * to avoid.
 */
export const PREVIEW_MAX_SECONDS = 6;

/** Lowest advertised HLS variant — the only one a preview is ever allowed to use. */
export const PREVIEW_VARIANT_HEIGHT = 360;

export type NegotiationDeps = {
  hasCachedHLS: (filePath: string) => Promise<boolean>;
  /**
   * Seconds of contiguous, already-encoded low-variant HLS sitting on disk for
   * this file (0 when there is none). Never triggers an encode — it only looks.
   */
  getCachedPreviewSeconds: (filePath: string) => Promise<number>;
  isGpuAvailable: () => Promise<boolean>;
  getFileMetadata: (
    subPath: string,
  ) => Promise<
    { sizeInBytes?: number; duration?: number; videoCodec?: string } | undefined
  >;
  isVideoFile: (subPath: string) => boolean;
  fileExists: (filePath: string) => Promise<boolean>;
  resolveFilePath: (subPath: string) => string;
};

export const negotiateVideoPlayback = async (
  request: VideoPlaybackRequest,
  deps: NegotiationDeps,
): Promise<VideoPlaybackResponse> => {
  const { path: subPath, hevcSupported } = request;

  if (!deps.isVideoFile(subPath)) {
    return { mode: "error", reason: "Not a video file" };
  }

  const filePath = deps.resolveFilePath(subPath);
  if (!(await deps.fileExists(filePath))) {
    return { mode: "error", reason: "File not found" };
  }

  const encodedPath = encodeURIComponent(subPath);
  // The HLS master advertises every quality variant; the player adapts between them
  // mid-stream from its own measured throughput (real ABR), so no height is chosen here.
  const hlsUrl = `/api/files/${encodedPath}?representation=hls`;
  const directUrl = `/api/files/${encodedPath}`;

  const metadata = await deps.getFileMetadata(subPath);

  // Grid hover preview: cached segments first (already paid for, and 360p is
  // the kindest thing we can put on the link), then a raw read but only for
  // genuinely small files, then a live 360p transcode — same GPU-evicting path
  // as full playback, just pinned to the lowest variant — so hovering an
  // ordinary high-bitrate camera original still gets a preview instead of a
  // static thumbnail. No previewMaxSeconds on that last path: unlike the two
  // cheap paths above, this one is a real ongoing encode, so it keeps playing
  // for as long as the hover holds the slot instead of looping every few
  // seconds. Only a missing GPU forces the clean "no".
  if (request.preview) {
    const cachedSeconds = await deps.getCachedPreviewSeconds(filePath);
    if (cachedSeconds > 0) {
      return {
        mode: "hls",
        url: `${hlsUrl}&variant=${PREVIEW_VARIANT_HEIGHT}`,
        reason: REASON_PREVIEW_CACHED,
        previewMaxSeconds: Math.min(cachedSeconds, PREVIEW_MAX_SECONDS),
      };
    }

    const rawBitrateMbps =
      metadata?.sizeInBytes && metadata.duration && metadata.duration > 0
        ? (metadata.sizeInBytes * 8) / metadata.duration / 1_000_000
        : Number.POSITIVE_INFINITY;

    if (
      canClientPlayCodec(metadata?.videoCodec, hevcSupported) &&
      rawBitrateMbps <= PREVIEW_MAX_RAW_MBPS &&
      bandwidthCoversRawFile(request.bandwidthMbps, metadata)
    ) {
      return {
        mode: "direct",
        url: directUrl,
        reason: REASON_PREVIEW_DIRECT,
        previewMaxSeconds: PREVIEW_MAX_SECONDS,
      };
    }

    if (await deps.isGpuAvailable()) {
      return {
        mode: "hls",
        url: `${hlsUrl}&variant=${PREVIEW_VARIANT_HEIGHT}`,
        reason: REASON_PREVIEW_TRANSCODE,
      };
    }

    return { mode: "error", reason: REASON_PREVIEW_UNAVAILABLE };
  }

  // 1. The link can carry the raw original and the client can play its codec: send
  //    it untranscoded. Preferred over the GPU path so a fast connection (LAN or
  //    fast WAN) leaves the shared card entirely free for other users. This is
  //    gated on *measured* throughput vs the file's real bitrate, so a slow VPN
  //    that merely looks local does not qualify.
  if (
    !request.forceTranscode &&
    canClientPlayCodec(metadata?.videoCodec, hevcSupported) &&
    bandwidthCoversRawFile(request.bandwidthMbps, metadata)
  ) {
    return { mode: "direct", url: directUrl, reason: REASON_DIRECT };
  }

  // 2. Cached HLS available — cheaper than a fresh encode and lighter on the link.
  if (await deps.hasCachedHLS(filePath)) {
    return { mode: "hls", url: hlsUrl, reason: REASON_CACHED_HLS };
  }

  // 3. A GPU exists — generate HLS on the fly. isGpuAvailable() reports capability,
  //    not momentary free VRAM: a full card is still HLS-capable because the request
  //    evicts background ML workers to make headroom (see the handler).
  if (await deps.isGpuAvailable()) {
    return { mode: "hls", url: hlsUrl, reason: REASON_GPU_HLS };
  }

  // 4. Link too slow for the raw file and no GPU to transcode — fail. There is
  //    deliberately no raw fallback here: the original would only buffer endlessly.
  return { mode: "error", reason: REASON_NO_PATH };
};

const buildDeps = (database: IndexDatabase, storageRoot: string): NegotiationDeps => ({
  hasCachedHLS: async (filePath: string) => {
    // On-the-fly HLS is ephemeral (reaped after playback), so the only persisted
    // cache is a fully-encoded single-bitrate stream, if one was ever produced.
    const singleBitrate = await getHLSInfo(filePath);
    return singleBitrate.exists;
  },
  getCachedPreviewSeconds: async (filePath: string) => {
    // Pure disk inspection: count contiguous already-written 360p segments from
    // segment_000 up. Stopping at the first gap is what keeps a preview inside
    // the encoded region, so the segment handler never has to spawn ffmpeg.
    const hlsDir = getMultibitrateHLSDirectory(filePath);
    if (!(await multibitrateHLSInitialized(hlsDir))) return 0;
    const maxSegments = Math.ceil(PREVIEW_MAX_SECONDS / HLS_SEGMENT_SECONDS);
    let segments = 0;
    while (segments < maxSegments) {
      const name = `segment_${String(segments).padStart(3, "0")}.ts`;
      if (!existsSync(getVariantSegmentPath(hlsDir, PREVIEW_VARIANT_HEIGHT, name))) break;
      segments += 1;
    }
    return segments * HLS_SEGMENT_SECONDS;
  },
  isGpuAvailable: async () => (await getGpuAcceleration()) !== null,
  getFileMetadata: async (subPath: string) => {
    const record = await database.getFileRecord(subPath);
    if (!record) return undefined;
    return {
      sizeInBytes: record.sizeInBytes,
      duration: record.duration,
      videoCodec: record.videoCodec,
    };
  },
  isVideoFile: (subPath: string) => {
    const mime = mimeTypeForFilename(subPath);
    return mime?.startsWith("video/") ?? false;
  },
  fileExists: async (filePath: string) => {
    const { stat } = await import("fs/promises");
    try {
      const s = await stat(filePath);
      return s.isFile();
    } catch {
      return false;
    }
  },
  resolveFilePath: (subPath: string) => path.join(storageRoot, subPath),
});

type Options = {
  database: IndexDatabase;
  storageRoot: string;
  taskOrchestrator: TaskOrchestrator;
  shareFilter?: unknown;
};

export const videoNegotiationRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, storageRoot, taskOrchestrator, shareFilter }: Options,
) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const videoPath = url.searchParams.get("path");

  if (!videoPath) {
    return writeJson(res, 400, { error: "Missing 'path' query parameter" });
  }

  const normalizedPath = path.join(storageRoot, videoPath);
  const relativeToStorage = path.relative(storageRoot, normalizedPath);
  if (relativeToStorage.startsWith("..") || path.isAbsolute(relativeToStorage)) {
    return writeJson(res, 403, { error: "Access denied" });
  }

  if (shareFilter) {
    const allowed = await database.fileMatchesFilter(
      videoPath,
      shareFilter as FilterElement,
    );
    if (!allowed) {
      return writeJson(res, 403, { error: "Access denied" });
    }
  }

  const bandwidthParam = url.searchParams.get("bandwidthMbps");
  const bandwidthMbps =
    bandwidthParam !== null ? Number.parseFloat(bandwidthParam) : null;
  const hevcSupported = url.searchParams.get("hevcSupported") === "true";
  const forceTranscode = url.searchParams.get("forceTranscode") === "true";
  const preview = url.searchParams.get("preview") === "true";

  const request: VideoPlaybackRequest = {
    path: videoPath,
    bandwidthMbps:
      typeof bandwidthMbps === "number" && Number.isFinite(bandwidthMbps)
        ? bandwidthMbps
        : null,
    hevcSupported,
    forceTranscode,
    preview,
  };

  const deps = buildDeps(database, storageRoot);
  const result = await negotiateVideoPlayback(request, deps);

  // On-the-fly GPU HLS is imminent: evict the background ML workers now so their
  // VRAM is freed by the time the player fetches the first segment and ffmpeg
  // spawns, instead of racing the encoder's own reclaim. A cached-HLS hit or a
  // raw/direct decision needs no GPU, so we leave the workers alone there.
  if (
    result.mode === "hls" &&
    (result.reason === REASON_GPU_HLS || result.reason === REASON_PREVIEW_TRANSCODE)
  ) {
    reclaimGpuForUser();
  }

  const fileName = path.basename(videoPath);
  const metadata = await deps.getFileMetadata(videoPath);
  const gpuAvailable = (await getGpuAcceleration()) !== null;

  const logData = {
    file: fileName,
    mode: result.mode,
    reason: result.reason,
    videoCodec: metadata?.videoCodec ?? "unknown",
    gpuAvailable,
    hevcSupported,
  };

  // A declined grid preview is a normal outcome (we chose not to spend GPU), so
  // it must not look like a playback failure in the logs or diagnostics feed.
  const isFailure = result.mode === "error" && !preview;

  if (isFailure) {
    log.warn(logData, "Video negotiation failed — no compatible stream");
  } else {
    log.info(logData, "Video negotiation succeeded");
  }

  recordServerDiagnosticEvent({
    level: isFailure ? "warn" : "info",
    event: "video.negotiation.result",
    message: `Negotiated ${result.mode} playback for ${videoPath}`,
    data: {
      path: videoPath,
      bandwidthMbps: request.bandwidthMbps,
      hevcSupported,
      result,
      queueSnapshot: taskOrchestrator.getDiagnosticsSnapshot(),
    },
  });

  if (result.mode === "error") {
    return writeJson(res, 422, result);
  }

  writeJson(res, 200, result);
};
