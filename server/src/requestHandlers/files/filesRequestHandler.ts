import * as http from "http";
import { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import { stat, readFile, access } from "fs/promises";
import { mimeTypeForFilename } from "../../fileHandling/mimeTypes.ts";
import { createReadStream, type Stats } from "fs";
import path from "path/win32";
import {
  convertImage,
  ImageConversionError,
} from "../../imageProcessing/convertImage.ts";
import { generateVideoThumbnail } from "../../videoProcessing/videoUtils.ts";
import {
  getMultibitrateHLSInfo,
  getVariantPlaylistPath,
  getVariantSegmentPath,
  prepareMultibitrateHLSStructure,
} from "../../videoProcessing/generateMultibitrateHLS.ts";
import { waitForHlsFile } from "../../videoProcessing/hlsSegmentWatcher.ts";
import { getGpuAcceleration } from "../../videoProcessing/gpuAcceleration.ts";
import { getVideoMetadata } from "../../videoProcessing/getVideoMetadata.ts";
import { StandardHeight, parseToStandardHeight } from "../../common/standardHeights.ts";
import { measureOperation } from "../../observability/requestTrace.ts";
import { scheduleWork } from "../../common/scheduleWork.ts";
import type { TaskOrchestrator } from "../../taskOrchestrator/taskOrchestrator.ts";
import { queryHandler } from "./queryHandler.ts";
import { writeJson } from "../../utils.ts";

type Options = {
  database: IndexDatabase;
  storageRoot: string;
  taskOrchestrator?: TaskOrchestrator;
  orchestrator?: TaskOrchestrator;
};

export const filesEndpointRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, storageRoot, taskOrchestrator, orchestrator }: Options,
) => {
  try {
    const effectiveOrchestrator = taskOrchestrator ?? orchestrator;
    if (!effectiveOrchestrator) {
      writeJson(res, 500, { error: "Task orchestrator is required" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathMatch = url.pathname.match(/^\/api\/files\/(.*)/);
    if (!pathMatch) return writeJson(res, 400, { error: "Bad request" });
    const subPath = decodeURIComponent(pathMatch[1]) || "/";
    if (subPath.endsWith("/")) return queryHandler(url, subPath, database, res);
    await fileHandler(
      req,
      url,
      subPath,
      storageRoot,
      res,
      database,
      effectiveOrchestrator,
    );
  } catch (error) {
    console.error("Error processing files request:", error);
    if (!res.headersSent)
      writeJson(res, 500, {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      });
  }
};

const streamFile = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  opts: {
    contentType: string;
    size: number;
    cacheControl: string;
    acceptRanges?: boolean;
  },
) => {
  const { contentType, size, cacheControl, acceptRanges = false } = opts;
  const rangeHeader = req.headers.range;

  const getRange = (
    rangeHeader: string | undefined,
    size: number,
  ): { start: number; end: number } | null => {
    const match = rangeHeader?.match(/^bytes=(\d+)-(\d+)?$/);
    if (!match) return null;

    const start = Number.parseInt(match[1] ?? "", 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < size)
      return { start, end };
    return null;
  };

  const range: { start: number; end: number } | null = getRange(rangeHeader, size);

  const statusCode = range ? 206 : 200;
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "content-length": range ? range.end - range.start + 1 : size,
  };

  if (acceptRanges) {
    headers["Accept-Ranges"] = "bytes";
  }

  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  }

  res.writeHead(statusCode, headers);
  const fileStream = createReadStream(
    filePath,
    range ? { start: range.start, end: range.end } : undefined,
  );
  fileStream.on("error", (error) => {
    console.error("Error streaming file:", error);
    res.destroy(error);
  });
  fileStream.pipe(res);
};

const isPathInsideStorage = (storageRoot: string, targetPath: string) => {
  const relativeToStorage = path.relative(storageRoot, targetPath);
  return !relativeToStorage.startsWith("..") && !path.isAbsolute(relativeToStorage);
};

const streamStaticFile = (
  filePath: string,
  opts: {
    res: http.ServerResponse;
    contentType: string;
    size: number;
    cacheControl: string;
  },
) => {
  const { res, contentType, size, cacheControl } = opts;
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": size,
    "Cache-Control": cacheControl,
  });

  const fileStream = createReadStream(filePath);
  fileStream.on("error", (error) => {
    console.error("Error streaming cached file:", error);
    res.destroy(error);
  });
  fileStream.pipe(res);
};

const streamCachedFile = (
  res: http.ServerResponse,
  filePath: string,
  opts: { contentType: string; size: number; cacheControl?: string },
) => {
  const { contentType, size, cacheControl = "public, max-age=31536000" } = opts;
  streamStaticFile(filePath, {
    res,
    contentType,
    size,
    cacheControl,
  });
};

const logQueueStatus = (label: string, subPath: string) => {
  console.log(`[filesRequest] ${label}: ${subPath}`);
};

const getDurationHeader = (knownDuration: number | null | undefined) =>
  typeof knownDuration === "number" && Number.isFinite(knownDuration)
    ? { "X-Content-Duration": String(knownDuration) }
    : {};

const writeHlsPlaylistResponse = (
  res: http.ServerResponse,
  playlistContent: string,
  cacheControl: string,
  knownDuration: number | null | undefined,
) => {
  res.writeHead(200, {
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": cacheControl,
    "Content-Length": Buffer.byteLength(playlistContent, "utf-8"),
    ...getDurationHeader(knownDuration),
  });
  res.end(playlistContent);
};

const streamHlsSegment = async (
  res: http.ServerResponse,
  segmentPath: string,
  metricName: string,
) => {
  const segmentStats = await measureOperation(metricName, () => stat(segmentPath), {
    category: "file",
  });
  streamStaticFile(segmentPath, {
    res,
    contentType: "video/mp2t",
    size: segmentStats.size,
    cacheControl: "public, max-age=31536000",
  });
};

const fileExists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

type FileHandlingContext = {
  normalizedPath: string;
  subPath: string;
  height: StandardHeight;
  res: http.ServerResponse;
  representation: string | null;
  needsResize: boolean;
  needsFormatChange: boolean;
  isImage: boolean;
  isVideo: boolean;
  database: IndexDatabase;
  taskOrchestrator: TaskOrchestrator;
};

const serveVideoThumb = async (
  ctx: FileHandlingContext,
  height: StandardHeight,
  label: string,
) => {
  const { normalizedPath, subPath, res } = ctx;
  try {
    logQueueStatus(label, subPath);
    const cachedPath = await measureOperation(
      "generateVideoThumbnail",
      () =>
        scheduleWork(`videoThumb:${normalizedPath}:${height}`, () =>
          generateVideoThumbnail(normalizedPath, height, { priority: "userBlocked" }),
        ),
      { category: "conversion", detail: String(height) },
    );
    const cachedStats = await measureOperation(
      "statCachedVideoThumbnail",
      () => stat(cachedPath),
      { category: "file" },
    );
    streamCachedFile(res, cachedPath, {
      contentType: "image/jpeg",
      size: cachedStats.size,
    });
    return true;
  } catch (error) {
    console.error(`Error generating video thumbnail for: ${subPath}`, error);
    return false;
  }
};

const tryVideoThumbnail = (ctx: FileHandlingContext) => {
  if (!ctx.isVideo) return false;
  const isPreview = ctx.representation === "preview";
  const wantsThumb = isPreview || ctx.representation === "webSafe" || ctx.needsResize;
  if (!wantsThumb) return false;
  const height = isPreview ? 320 : ctx.height;
  const label = isPreview
    ? "Requesting preview thumbnail"
    : `Requesting ${ctx.height} thumbnail for video`;
  return serveVideoThumb(ctx, height, label);
};

const tryHLSStream = async (
  ctx: FileHandlingContext & { url: URL },
): Promise<boolean> => {
  const { isVideo, representation, normalizedPath, subPath, height, res, url, database } =
    ctx;
  if (!isVideo || representation !== "hls") return false;

  const segment = url.searchParams.get("segment");
  const variant = url.searchParams.get("variant"); // e.g., "360" or "720"

  try {
    logQueueStatus(
      `Requesting HLS ${segment ? `segment ${segment}` : variant ? `${variant}p variant` : "playlist"}`,
      subPath,
    );

    // Get duration from database, falling back to ffprobe if not indexed yet
    const fileRecord = await measureOperation(
      "getFileRecord",
      () => database.getFileRecord(subPath),
      { category: "db", detail: "duration" },
    );
    let knownDuration = fileRecord?.duration;

    if (typeof knownDuration !== "number" || !Number.isFinite(knownDuration)) {
      try {
        const probed = await measureOperation(
          "ffprobeDuration",
          () => getVideoMetadata(normalizedPath),
          { category: "conversion", detail: "ffprobe" },
        );
        if (typeof probed.duration === "number" && Number.isFinite(probed.duration)) {
          knownDuration = probed.duration;
        }
      } catch {
        // ffprobe failed — continue without duration
      }
    }

    // Check if multi-bitrate HLS structure is initialized (master.m3u8 exists)
    const multibitrateInfo = await measureOperation(
      "getMultibitrateHLSInfo",
      () => getMultibitrateHLSInfo(normalizedPath),
      { category: "conversion" },
    );

    // If not initialized, set up the directory structure immediately and queue FFmpeg.
    // The master playlist is returned to the client right away; segments become available
    // as FFmpeg encodes them and are served via the segment watcher.
    if (!multibitrateInfo.initialized) {
      if (!(await getGpuAcceleration())) {
        writeJson(res, 422, {
          error: "HLS not available",
          message:
            "No cached HLS and hardware acceleration is not available for on-the-fly encoding",
        });
        return true;
      }

      // Create dirs + write master.m3u8 synchronously so the response is immediate
      await prepareMultibitrateHLSStructure(normalizedPath);

      // Queue HLS generation as a user-blocking task.
      ctx.taskOrchestrator.addTask(
        {
          type: "hls",
          relativePath: subPath,
        },
        "blocking",
      );
    }

    // Serve variant segment — wait for FFmpeg to write it if not ready yet
    if (segment && variant) {
      const variantHeight = parseInt(variant, 10);
      const segmentPath = getVariantSegmentPath(
        multibitrateInfo.hlsDir,
        variantHeight,
        segment,
      );

      const available = await waitForHlsFile(multibitrateInfo.hlsDir, segmentPath);
      if (!available) {
        writeJson(res, 404, { error: "HLS segment not found or timed out" });
        return true;
      }
      await streamHlsSegment(res, segmentPath, "statHlsVariantSegment");
      return true;
    }

    // Serve variant playlist — wait for FFmpeg to write it if not ready yet
    if (variant) {
      const variantHeight = parseInt(variant, 10);
      const variantPlaylistPath = getVariantPlaylistPath(
        multibitrateInfo.hlsDir,
        variantHeight,
      );

      const available = await waitForHlsFile(
        multibitrateInfo.hlsDir,
        variantPlaylistPath,
      );
      if (!available) {
        writeJson(res, 404, { error: "HLS variant playlist not found or timed out" });
        return true;
      }

      const playlistContent = await measureOperation(
        "readHlsVariantPlaylist",
        () => readFile(variantPlaylistPath, "utf-8"),
        { category: "file" },
      );

      // Rewrite segment paths to use API endpoint
      const baseUrl = `/api/files/${encodeURIComponent(subPath)}?representation=hls&variant=${variant}&segment=`;
      const modifiedPlaylist = playlistContent.replace(
        /^(segment_\d+\.ts)$/gm,
        (match) => `${baseUrl}${match}`,
      );
      const isVariantDone = playlistContent.includes("#EXT-X-ENDLIST");
      writeHlsPlaylistResponse(
        res,
        modifiedPlaylist,
        isVariantDone ? "public, max-age=31536000" : "no-cache",
        knownDuration,
      );
      return true;
    }

    // Serve master playlist
    let masterContent = await measureOperation(
      "readHlsMasterPlaylist",
      () => readFile(multibitrateInfo.masterPlaylistPath, "utf-8"),
      { category: "file" },
    );

    // Rewrite variant playlist paths to use API endpoint
    const baseVariantUrl = `/api/files/${encodeURIComponent(subPath)}?representation=hls&variant=`;
    masterContent = masterContent.replace(
      /^(\d+)p\/playlist\.m3u8$/gm,
      (_, variantHeight) => `${baseVariantUrl}${variantHeight}`,
    );
    // Cache forever once complete; no-cache while encoding is in progress
    writeHlsPlaylistResponse(
      res,
      masterContent,
      multibitrateInfo.complete ? "public, max-age=31536000" : "no-cache",
      knownDuration,
    );
    return true;
  } catch (error) {
    console.error(`Error generating HLS stream for: ${subPath}`, error);
    writeJson(res, 500, {
      error: "HLS generation failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
};

const tryImageVariant = async (ctx: FileHandlingContext) => {
  const {
    needsFormatChange,
    needsResize,
    isImage,
    normalizedPath,
    subPath,
    height,
    res,
  } = ctx;
  if (!(needsFormatChange || needsResize) || !isImage) return false;

  try {
    logQueueStatus(`Requesting ${height} image`, subPath);
    const cachedPath = await measureOperation(
      "convertImage",
      () =>
        scheduleWork(`thumbnail:${normalizedPath}:${height}`, () =>
          convertImage(normalizedPath, height, { priority: "userBlocked" }),
        ),
      { category: "conversion", detail: String(height) },
    );
    const cachedStats = await measureOperation(
      "statCachedImage",
      () => stat(cachedPath),
      { category: "file" },
    );
    streamCachedFile(res, cachedPath, {
      contentType: "image/jpeg",
      size: cachedStats.size,
    });
    return true;
  } catch (error) {
    if (error instanceof ImageConversionError) {
      writeJson(res, 422, { error: "Invalid image", message: error.message });
      return true;
    }
    console.error(`Error generating image for: ${subPath}`, error);
    return false;
  }
};

const fileHandler = async (
  req: http.IncomingMessage,
  url: URL,
  subPath: string,
  storageRoot: string,
  res: http.ServerResponse,
  database: IndexDatabase,
  taskOrchestrator: TaskOrchestrator,
) => {
  if (!subPath) {
    return writeJson(res, 400, { error: "Missing file path" });
  }

  const normalizedPath = path.join(storageRoot, subPath);

  if (!isPathInsideStorage(storageRoot, normalizedPath)) {
    return writeJson(res, 403, { error: "Access denied" });
  }

  const fileStats: Stats | null = await measureOperation(
    "statRequestedFile",
    async () => {
      try {
        const stats = await stat(normalizedPath);
        if (!stats.isFile()) {
          return null;
        }
        return stats;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    { category: "file" },
  );
  if (!fileStats) {
    return writeJson(res, 404, { error: "File not found" });
  }

  const mimeType = mimeTypeForFilename(subPath) || "application/octet-stream";
  const representation = url.searchParams.get("representation");
  const height = parseToStandardHeight(url.searchParams.get("height"));

  const needsResize = height !== "original";
  const needsFormatChange =
    representation === "webSafe" &&
    (mimeType === "image/heic" || mimeType === "image/heif");
  const isImage = mimeType.startsWith("image/");
  const isVideo = mimeType.startsWith("video/");

  const handlingContext: FileHandlingContext = {
    normalizedPath,
    subPath,
    height,
    res,
    representation,
    needsResize,
    needsFormatChange,
    isImage,
    isVideo,
    database,
    taskOrchestrator,
  };

  // HLS handler needs URL for segment parameter
  const hlsHandled = await tryHLSStream({ ...handlingContext, url });
  if (hlsHandled) return;

  const handlers = [tryVideoThumbnail, tryImageVariant];
  for (const handler of handlers) {
    const handled = await handler(handlingContext);
    if (handled) return;
  }

  streamFile(req, res, normalizedPath, {
    contentType: mimeType,
    size: fileStats.size,
    cacheControl: "public, max-age=31536000",
    acceptRanges: isVideo,
  });
};
