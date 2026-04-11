import type http from "node:http";
import { isCudaAvailable } from "../../videoProcessing/cudaAvailability.ts";
import { getHLSInfo } from "../../videoProcessing/generateHLS.ts";
import { getMultibitrateHLSInfo } from "../../videoProcessing/generateMultibitrateHLS.ts";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import { mimeTypeForFilename } from "../../fileHandling/mimeTypes.ts";
import { writeJson } from "../../utils.ts";
import path from "path/win32";

type VideoPlaybackRequest = {
  path: string;
  bandwidthMbps: number | null;
  hevcSupported: boolean;
};

type VideoPlaybackResponse =
  | { mode: "hls"; url: string; reason: string }
  | { mode: "direct"; url: string; reason: string }
  | { mode: "error"; reason: string };

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

export type NegotiationDeps = {
  hasCachedHLS: (filePath: string) => Promise<boolean>;
  isCudaAvailable: () => Promise<boolean>;
  getFileMetadata: (
    subPath: string,
  ) => Promise<
    | { sizeInBytes?: number; duration?: number; videoCodec?: string }
    | undefined
  >;
  isVideoFile: (subPath: string) => boolean;
  fileExists: (filePath: string) => Promise<boolean>;
  resolveFilePath: (subPath: string) => string;
};

export const negotiateVideoPlayback = async (
  request: VideoPlaybackRequest,
  deps: NegotiationDeps,
): Promise<VideoPlaybackResponse> => {
  const { path: subPath, bandwidthMbps, hevcSupported } = request;

  if (!deps.isVideoFile(subPath)) {
    return { mode: "error", reason: "Not a video file" };
  }

  const filePath = deps.resolveFilePath(subPath);
  if (!(await deps.fileExists(filePath))) {
    return { mode: "error", reason: "File not found" };
  }

  const encodedPath = encodeURIComponent(subPath);
  const hlsUrl = `/api/files/${encodedPath}?representation=hls&height=original`;
  const directUrl = `/api/files/${encodedPath}`;

  // 1. Cached HLS available — always prefer (no compute cost)
  if (await deps.hasCachedHLS(filePath)) {
    return { mode: "hls", url: hlsUrl, reason: "Cached HLS available" };
  }

  // 2. CUDA available — can generate HLS on-the-fly
  if (await deps.isCudaAvailable()) {
    return { mode: "hls", url: hlsUrl, reason: "Hardware-accelerated HLS encoding available" };
  }

  // 3. No CUDA, no cached HLS — try raw/direct playback
  const metadata = await deps.getFileMetadata(subPath);
  const videoCodec = metadata?.videoCodec;

  if (!canClientPlayCodec(videoCodec, hevcSupported)) {
    return {
      mode: "error",
      reason: `No cached HLS, no hardware acceleration, and client cannot play codec "${videoCodec ?? "unknown"}"`,
    };
  }

  return { mode: "direct", url: directUrl, reason: "Direct playback — client supports codec" };
};

const buildDeps = (
  database: IndexDatabase,
  storageRoot: string,
): NegotiationDeps => ({
  hasCachedHLS: async (filePath: string) => {
    const multibitrate = await getMultibitrateHLSInfo(filePath);
    if (multibitrate.exists) return true;
    const singleBitrate = await getHLSInfo(filePath);
    return singleBitrate.exists;
  },
  isCudaAvailable,
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

type Options = { database: IndexDatabase; storageRoot: string };

export const videoNegotiationRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, storageRoot }: Options,
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

  const bandwidthParam = url.searchParams.get("bandwidthMbps");
  const bandwidthMbps =
    bandwidthParam !== null ? Number.parseFloat(bandwidthParam) : null;
  const hevcSupported = url.searchParams.get("hevcSupported") === "true";

  const request: VideoPlaybackRequest = {
    path: videoPath,
    bandwidthMbps:
      typeof bandwidthMbps === "number" && Number.isFinite(bandwidthMbps)
        ? bandwidthMbps
        : null,
    hevcSupported,
  };

  const deps = buildDeps(database, storageRoot);
  const result = await negotiateVideoPlayback(request, deps);

  if (result.mode === "error") {
    return writeJson(res, 422, result);
  }

  writeJson(res, 200, result);
};
