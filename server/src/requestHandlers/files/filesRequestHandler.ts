import * as http from "http";
import { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import { stat, readFile } from "fs/promises";
import { mimeTypeForFilename } from "../../fileHandling/mimeTypes.ts";
import { createReadStream, type Stats } from "fs";
import path from "path";
import {
  convertImage,
  ImageConversionError,
} from "../../imageProcessing/convertImage.ts";
import { generateVideoThumbnail } from "../../videoProcessing/videoUtils.ts";
import { markCacheAccess } from "../../common/cacheEviction.ts";
import {
  generateMultibitrateHLS,
  getMultibitrateHLSInfo,
  getVariantPlaylistPath,
  getVariantSegmentPath,
  prepareMultibitrateHLSStructure,
} from "../../videoProcessing/generateMultibitrateHLS.ts";
import { waitForHlsFile } from "../../videoProcessing/hlsSegmentWatcher.ts";
import { buildVodVariantPlaylist } from "../../videoProcessing/buildHlsPlaylist.ts";
import {
  registerHlsProcess,
  touchHlsSession,
} from "../../videoProcessing/hlsSession.ts";
import { getLogger } from "../../observability/logger.ts";

const hlsLog = getLogger("HLS");
import { getGpuAcceleration } from "../../videoProcessing/gpuAcceleration.ts";
import { getVideoMetadata } from "../../videoProcessing/getVideoMetadata.ts";
import { StandardHeight, parseToStandardHeight } from "../../common/standardHeights.ts";
import type { TaskOrchestrator } from "../../taskOrchestrator/taskOrchestrator.ts";
import { queryHandler } from "./queryHandler.ts";
import { writeJson } from "../../utils.ts";

type Options = {
  database: IndexDatabase;
  storageRoot: string;
  taskOrchestrator: TaskOrchestrator;
};

export const filesEndpointRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, storageRoot, taskOrchestrator }: Options,
) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathMatch = url.pathname.match(/^\/api\/files\/(.*)/);
    if (!pathMatch) return writeJson(res, 400, { error: "Bad request" });
    const subPath = decodeURIComponent(pathMatch[1]) || "/";
    if (subPath.endsWith("/")) return queryHandler(url, subPath, database, res);
    await fileHandler(req, url, subPath, storageRoot, res, database, taskOrchestrator);
  } catch (error) {
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
  // Bump the file's timestamp so the cache eviction policy treats it as
  // recently used (approximate LRU).
  markCacheAccess(filePath);
  streamStaticFile(filePath, {
    res,
    contentType,
    size,
    cacheControl,
  });
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

const streamHlsSegment = async (res: http.ServerResponse, segmentPath: string) => {
  const segmentStats = await stat(segmentPath);
  streamStaticFile(segmentPath, {
    res,
    contentType: "video/mp2t",
    // Ephemeral: segments are deleted after playback, so they must not be cached
    // by the browser or any intermediary.
    cacheControl: "no-store",
    size: segmentStats.size,
  });
};

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

const serveVideoThumb = async (ctx: FileHandlingContext, height: StandardHeight) => {
  const { normalizedPath, res } = ctx;
  try {
    const cachedPath = await generateVideoThumbnail(normalizedPath, height, {
      priority: "userBlocked",
    });
    const cachedStats = await stat(cachedPath);
    streamCachedFile(res, cachedPath, {
      contentType: "image/jpeg",
      size: cachedStats.size,
    });
    return true;
  } catch {
    return false;
  }
};

const tryVideoThumbnail = (ctx: FileHandlingContext) => {
  if (!ctx.isVideo) return false;
  const isPreview = ctx.representation === "preview";
  const wantsThumb = isPreview || ctx.representation === "webSafe" || ctx.needsResize;
  if (!wantsThumb) return false;
  const height = isPreview ? 320 : ctx.height;
  return serveVideoThumb(ctx, height);
};

const tryHLSStream = async (
  ctx: FileHandlingContext & { url: URL },
): Promise<boolean> => {
  const { isVideo, representation, normalizedPath, subPath, res, url, database } = ctx;
  if (!isVideo || representation !== "hls") return false;

  const segment = url.searchParams.get("segment");
  const variant = url.searchParams.get("variant"); // e.g., "360" or "720"

  try {
    // Get duration from database, falling back to ffprobe if not indexed yet
    const fileRecord = await database.getFileRecord(subPath);
    let knownDuration = fileRecord?.duration;

    if (typeof knownDuration !== "number" || !Number.isFinite(knownDuration)) {
      try {
        const probed = await getVideoMetadata(normalizedPath);
        if (typeof probed.duration === "number" && Number.isFinite(probed.duration)) {
          knownDuration = probed.duration;
        }
      } catch {
        // ffprobe failed — continue without duration
      }
    }

    // Check if multi-bitrate HLS structure is initialized (master.m3u8 exists)
    const multibitrateInfo = await getMultibitrateHLSInfo(normalizedPath);

    // Mark this HLS tree as actively in use so the reaper keeps it alive while the
    // player is fetching, then deletes it (and kills any running encode) once idle.
    touchHlsSession(multibitrateInfo.hlsDir);

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

      // Queue HLS generation as a user-blocking task. The output is ephemeral —
      // it is served while the player fetches, then deleted by the reaper once
      // playback goes idle (which may kill this encode mid-flight), so we don't
      // persist any "HLS generated" marker in the database.
      const hlsDir = multibitrateInfo.hlsDir;
      ctx.taskOrchestrator.addTask(
        {
          name: "HLS generation",
          type: "videoConversion",
          start: () => {
            const promise = generateMultibitrateHLS(normalizedPath, {
              onSpawn: (child) => registerHlsProcess(hlsDir, child),
            }).then(
              () => {},
              (error) => {
                // A reaped session kills ffmpeg on purpose; that's an expected
                // outcome for ephemeral HLS, not a real failure.
                hlsLog.debug({ err: error, hlsDir }, "HLS generation ended early");
              },
            );

            return {
              onComplete: async () => {
                await promise;
              },
            };
          },
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
      await streamHlsSegment(res, segmentPath);
      return true;
    }

    // Serve variant playlist
    if (variant) {
      const baseUrl = `/api/files/${encodeURIComponent(subPath)}?representation=hls&variant=${variant}&segment=`;

      // When the total duration is known, synthesize a complete VOD playlist that
      // lists every segment up front and ends with #EXT-X-ENDLIST. This gives the
      // player the true total length immediately, instead of FFmpeg's growing EVENT
      // playlist whose duration creeps up as segments are appended. Not-yet-encoded
      // segments are long-polled by the segment handler below until FFmpeg writes them.
      if (
        typeof knownDuration === "number" &&
        Number.isFinite(knownDuration) &&
        knownDuration > 0
      ) {
        const playlist = buildVodVariantPlaylist({
          durationSeconds: knownDuration,
          segmentBaseUrl: baseUrl,
        });
        // Ephemeral HLS: never cache playlists — the underlying segments are
        // deleted after playback and may be re-encoded on replay.
        writeHlsPlaylistResponse(res, playlist, "no-store", knownDuration);
        return true;
      }

      // Duration unknown — fall back to FFmpeg's growing EVENT playlist, waiting for
      // it to be written if it isn't ready yet.
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

      const playlistContent = await readFile(variantPlaylistPath, "utf-8");

      // Rewrite segment paths to use API endpoint
      const modifiedPlaylist = playlistContent.replace(
        /^(segment_\d+\.ts)$/gm,
        (match) => `${baseUrl}${match}`,
      );
      writeHlsPlaylistResponse(res, modifiedPlaylist, "no-store", knownDuration);
      return true;
    }

    // Serve master playlist
    let masterContent = await readFile(multibitrateInfo.masterPlaylistPath, "utf-8");

    // Rewrite variant playlist paths to use API endpoint
    const baseVariantUrl = `/api/files/${encodeURIComponent(subPath)}?representation=hls&variant=`;
    masterContent = masterContent.replace(
      /^(\d+)p\/playlist\.m3u8$/gm,
      (_, variantHeight) => `${baseVariantUrl}${variantHeight}`,
    );
    // Ephemeral HLS: never cache the master playlist.
    writeHlsPlaylistResponse(res, masterContent, "no-store", knownDuration);
    return true;
  } catch (error) {
    writeJson(res, 500, {
      error: "HLS generation failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
};

const tryImageVariant = async (ctx: FileHandlingContext) => {
  const { needsFormatChange, needsResize, isImage, normalizedPath, height, res } = ctx;
  if (!(needsFormatChange || needsResize) || !isImage) return false;

  try {
    const cachedPath = await convertImage(normalizedPath, height, {
      priority: "userBlocked",
    });
    const cachedStats = await stat(cachedPath);
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

  let fileStats: Stats | null = null;
  try {
    const stats = await stat(normalizedPath);
    if (stats.isFile()) {
      fileStats = stats;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
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
