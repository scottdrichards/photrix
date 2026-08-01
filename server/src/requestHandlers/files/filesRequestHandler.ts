import * as http from "http";
import { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import type { FilterElement } from "../../indexDatabase/indexDatabase.type.ts";
import { stat, readFile } from "fs/promises";
import { mimeTypeForFilename } from "../../fileHandling/mimeTypes.ts";
import { createReadStream, existsSync, type Stats } from "fs";
import path from "path";
import {
  convertImage,
  convertImageCrop,
  contentTypeForImageFormat,
  IMAGE_OUTPUT_CONTENT_TYPE,
  ImageConversionError,
  type CropBox,
  type ImageOutputFormat,
} from "../../imageProcessing/convertImage.ts";
import { convertEmbeddedThumbnail } from "../../imageProcessing/embeddedThumbnail.ts";
import { generateVideoThumbnail } from "../../videoProcessing/videoUtils.ts";
import { markCacheAccess } from "../../common/cacheEviction.ts";
import {
  clampToSupportedHeight,
  clearVariantOutput,
  generateVariantHLS,
  getMultibitrateHLSInfo,
  getVariantPlaylistPath,
  getVariantSegmentPath,
  prepareMultibitrateHLSStructure,
} from "../../videoProcessing/generateMultibitrateHLS.ts";
import { waitForHlsFile } from "../../videoProcessing/hlsSegmentWatcher.ts";
import { buildVodVariantPlaylist } from "../../videoProcessing/buildHlsPlaylist.ts";
import {
  claimVariantEncode,
  registerHlsProcess,
  touchHlsSession,
  touchVariant,
} from "../../videoProcessing/hlsSession.ts";
import { getLogger } from "../../observability/logger.ts";

const hlsLog = getLogger("HLS");
import { getGpuAcceleration } from "../../videoProcessing/gpuAcceleration.ts";
import { getVideoMetadata } from "../../videoProcessing/getVideoMetadata.ts";
import { StandardHeight, parseToStandardHeight } from "../../common/standardHeights.ts";
import type { TaskOrchestrator } from "../../taskOrchestrator/taskOrchestrator.ts";
import { queryHandler } from "./queryHandler.ts";
import { writeJson } from "../../utils.ts";
import { recordServerDiagnosticEvent } from "../../observability/diagnosticsStore.ts";
import { decodeRequestPath } from "../../common/decodeRequestPath.ts";

type Options = {
  database: IndexDatabase;
  storageRoot: string;
  taskOrchestrator: TaskOrchestrator;
  shareFilter?: unknown;
};

export const filesEndpointRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, storageRoot, taskOrchestrator, shareFilter }: Options,
) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathMatch = url.pathname.match(/^\/api\/files\/(.*)/);
    if (!pathMatch) return writeJson(res, 400, { error: "Bad request" });
    const subPath = decodeRequestPath(pathMatch[1]) || "/";
    if (subPath.endsWith("/"))
      return queryHandler(url, subPath, database, res, shareFilter);
    await fileHandler(
      req,
      url,
      subPath,
      storageRoot,
      res,
      database,
      taskOrchestrator,
      shareFilter,
    );
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
  const {
    contentType,
    size,
    cacheControl = "public, max-age=31536000, immutable",
  } = opts;
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

/** Extracts the integer index N from an HLS segment name `segment_NNN.ts`. */
const parseSegmentIndex = (segment: string): number | null => {
  const match = segment.match(/segment_(\d+)\.ts$/);
  return match ? Number(match[1]) : null;
};

type FileHandlingContext = {
  normalizedPath: string;
  subPath: string;
  height: StandardHeight;
  res: http.ServerResponse;
  representation: string | null;
  outputFormat: ImageOutputFormat;
  needsResize: boolean;
  needsFormatChange: boolean;
  isImage: boolean;
  isVideo: boolean;
  crop: CropBox | null;
  database: IndexDatabase;
  taskOrchestrator: TaskOrchestrator;
};

/**
 * Parses a `crop=x,y,w,h` query param of normalized top-left fractions (0..1)
 * of the EXIF-oriented image. Returns null when absent, or throws a message when
 * malformed so the caller can respond with 400.
 */
const parseCrop = (raw: string | null): CropBox | null => {
  if (raw === null) return null;
  const parts = raw.split(",").map((p) => Number.parseFloat(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error("crop must be four comma-separated numbers: x,y,w,h");
  }
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) {
    throw new Error("crop width and height must be positive");
  }
  if (x < 0 || y < 0 || x >= 1 || y >= 1) {
    throw new Error("crop x and y must be in [0, 1)");
  }
  return { x, y, width, height };
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
  // Propagate the auth token through rewritten playlist/segment URLs so that
  // native HLS players (Safari) and any client that can't add Authorization
  // headers can still authenticate sub-requests.
  const tokenSuffix = url.searchParams.get("token")
    ? `&token=${encodeURIComponent(url.searchParams.get("token")!)}`
    : "";

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

    const hlsDir = multibitrateInfo.hlsDir;

    // If not initialized, set up the directory structure immediately so the master
    // playlist can be returned to the client right away. Encodes are started lazily
    // per variant when the client requests segments (see ensureEncoding below);
    // segments become available as FFmpeg writes them and are served via the watcher.
    if (!multibitrateInfo.initialized) {
      if (!(await getGpuAcceleration())) {
        writeJson(res, 422, {
          error: "HLS not available",
          message:
            "No cached HLS and hardware acceleration is not available for on-the-fly encoding",
        });
        return true;
      }

      // Create dirs + write the multi-variant master.m3u8 synchronously so the
      // response is immediate.
      await prepareMultibitrateHLSStructure(normalizedPath);
    }

    // Ensure a live encode is running for `variantHeight`. Encodes always start from
    // segment 0 — no offset encodes. When a dead encode is restarted, we first clear
    // the variant's cached segments so the new encode starts with a clean slate (no
    // stale segments from a previous encode session causing inconsistent playback).
    // Queued as a user-blocking task. The output is ephemeral — served while the
    // player fetches, then reaped once that variant goes idle (an ABR switch away) or
    // the whole tree goes idle, so we persist no DB marker.
    const ensureEncoding = (variantHeight: number): void => {
      const needsStart = claimVariantEncode(hlsDir, variantHeight);
      if (!needsStart) return;
      recordServerDiagnosticEvent({
        level: "warn",
        event: "video.hls.encode.queued",
        message: `Queued ${variantHeight}p encode (from start)`,
        data: {
          path: subPath,
          hlsDir,
          variantHeight,
          queueSnapshot: ctx.taskOrchestrator.getDiagnosticsSnapshot(),
        },
      });
      ctx.taskOrchestrator.addTask(
        {
          name: `HLS encode ${variantHeight}p`,
          type: "videoConversion",
          start: () => {
            const promise = (async () => {
              // Clear stale segments so the new encode is the sole author of this
              // variant's cache — prevents mixed-session segments causing stutter.
              // Empties the directory rather than deleting it: removing a variant
              // directory that the live recursive fs.watch on this tree is watching
              // made its internal re-scan throw ENOENT, which killed the process.
              await clearVariantOutput(hlsDir, variantHeight);
              await generateVariantHLS(normalizedPath, variantHeight, {
                onSpawn: (child) => registerHlsProcess(hlsDir, variantHeight, child),
              });
            })().then(
              () => {},
              (error) => {
                // A reaped session/variant kills ffmpeg on purpose; expected for
                // ephemeral HLS, not a real failure.
                hlsLog.debug(
                  { err: error, hlsDir, variantHeight },
                  "HLS encode ended early",
                );
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
    };

    // Serve variant segment — wait for FFmpeg to write it if not ready yet
    if (segment && variant) {
      const variantHeight = clampToSupportedHeight(parseInt(variant, 10));
      const segmentPath = getVariantSegmentPath(hlsDir, variantHeight, segment);
      const segmentIndex = parseSegmentIndex(segment);
      touchVariant(hlsDir, variantHeight);

      // If the segment isn't on disk yet, make sure an encode is running.
      if (!existsSync(segmentPath) && segmentIndex !== null) {
        ensureEncoding(variantHeight);
      }

      recordServerDiagnosticEvent({
        level: "info",
        event: "video.hls.segment.requested",
        message: `Requested HLS segment ${segment}`,
        data: {
          path: subPath,
          hlsDir,
          variantHeight,
          segment,
          segmentIndex,
          queueSnapshot: ctx.taskOrchestrator.getDiagnosticsSnapshot(),
        },
      });

      const available = await waitForHlsFile(hlsDir, segmentPath);
      if (!available) {
        recordServerDiagnosticEvent({
          level: "error",
          event: "video.hls.segment.timeout",
          message: `Timed out waiting for HLS segment ${segment}`,
          data: {
            path: subPath,
            hlsDir,
            variantHeight,
            segment,
            segmentIndex,
            queueSnapshot: ctx.taskOrchestrator.getDiagnosticsSnapshot(),
          },
        });
        writeJson(res, 404, { error: "HLS segment not found or timed out" });
        return true;
      }
      recordServerDiagnosticEvent({
        level: "info",
        event: "video.hls.segment.ready",
        message: `Served HLS segment ${segment}`,
        data: {
          path: subPath,
          hlsDir,
          variantHeight,
          segment,
        },
      });
      await streamHlsSegment(res, segmentPath);
      return true;
    }

    // Serve variant playlist
    if (variant) {
      const variantHeight = clampToSupportedHeight(parseInt(variant, 10));
      touchVariant(hlsDir, variantHeight);
      const baseUrl = `/api/files/${encodeURIComponent(subPath)}?representation=hls&variant=${variant}${tokenSuffix}&segment=`;

      // When the total duration is known, synthesize a complete VOD playlist that
      // lists every segment up front and ends with #EXT-X-ENDLIST. This gives the
      // player the true total length immediately, instead of FFmpeg's growing EVENT
      // playlist whose duration creeps up as segments are appended. The encode runs
      // from segment 0; the segment handler waits for each segment to be produced.
      if (
        typeof knownDuration === "number" &&
        Number.isFinite(knownDuration) &&
        knownDuration > 0
      ) {
        recordServerDiagnosticEvent({
          level: "info",
          event: "video.hls.variant.playlist",
          message: `Served synthetic VOD playlist for ${variantHeight}p`,
          data: { path: subPath, hlsDir, variantHeight, knownDuration },
        });
        const playlist = buildVodVariantPlaylist({
          durationSeconds: knownDuration,
          segmentBaseUrl: baseUrl,
        });
        // Ephemeral HLS: never cache playlists — the underlying segments are
        // deleted after playback and may be re-encoded on replay.
        writeHlsPlaylistResponse(res, playlist, "no-store", knownDuration);
        return true;
      }

      // Duration unknown — fall back to FFmpeg's own growing EVENT playlist.
      ensureEncoding(variantHeight);
      const variantPlaylistPath = getVariantPlaylistPath(
        multibitrateInfo.hlsDir,
        variantHeight,
      );

      const available = await waitForHlsFile(
        multibitrateInfo.hlsDir,
        variantPlaylistPath,
      );
      if (!available) {
        recordServerDiagnosticEvent({
          level: "error",
          event: "video.hls.variant.playlist.timeout",
          message: `Timed out waiting for ${variantHeight}p playlist`,
          data: {
            path: subPath,
            hlsDir,
            variantHeight,
            queueSnapshot: ctx.taskOrchestrator.getDiagnosticsSnapshot(),
          },
        });
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
    recordServerDiagnosticEvent({
      level: "info",
      event: "video.hls.master.playlist",
      message: `Served HLS master playlist for ${subPath}`,
      data: {
        path: subPath,
        hlsDir,
        queueSnapshot: ctx.taskOrchestrator.getDiagnosticsSnapshot(),
      },
    });
    let masterContent = await readFile(multibitrateInfo.masterPlaylistPath, "utf-8");

    // Rewrite variant playlist paths to use API endpoint
    const baseVariantUrl = `/api/files/${encodeURIComponent(subPath)}?representation=hls${tokenSuffix}&variant=`;
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

const tryImageCrop = async (ctx: FileHandlingContext) => {
  const { crop, isImage, normalizedPath, height, res } = ctx;
  if (!crop || !isImage) return false;

  try {
    const cachedPath = await convertImageCrop(normalizedPath, crop, height, {
      priority: "userBlocked",
    });
    const cachedStats = await stat(cachedPath);
    streamCachedFile(res, cachedPath, {
      contentType: IMAGE_OUTPUT_CONTENT_TYPE,
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

// Fixed size for the progressive-grid micro thumbnail. Matches the largest
// commonly-available embedded EXIF thumbnail; the grid upgrades to the 320 tile
// lazily on dwell/hover.
const MICRO_THUMBNAIL_HEIGHT = 160;

// Instant, I/O-cheap grid tile: serve a JPEG's embedded EXIF thumbnail (a
// header-only read) instead of decoding the full source. Falls back to a normal
// 160 full-decode conversion for files without an embedded thumbnail (all HEIC,
// ~11% of JPEGs), so a `micro` request always resolves to a 160 tile.
const tryMicroThumbnail = async (ctx: FileHandlingContext) => {
  const { representation, isImage, normalizedPath, res } = ctx;
  if (representation !== "micro" || !isImage) return false;

  try {
    const embeddedPath = await convertEmbeddedThumbnail(
      normalizedPath,
      MICRO_THUMBNAIL_HEIGHT,
    );
    const cachedPath =
      embeddedPath ??
      (await convertImage(normalizedPath, MICRO_THUMBNAIL_HEIGHT, {
        priority: "userBlocked",
      }));
    const cachedStats = await stat(cachedPath);
    streamCachedFile(res, cachedPath, {
      contentType: IMAGE_OUTPUT_CONTENT_TYPE,
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

const tryImageVariant = async (ctx: FileHandlingContext) => {
  const { needsFormatChange, needsResize, isImage, normalizedPath, height, res } = ctx;
  const forcesFormat = ctx.outputFormat !== "webp";
  if (!(needsFormatChange || needsResize || forcesFormat) || !isImage) return false;

  try {
    const cachedPath = await convertImage(normalizedPath, height, {
      priority: "userBlocked",
      format: ctx.outputFormat,
    });
    const cachedStats = await stat(cachedPath);
    streamCachedFile(res, cachedPath, {
      contentType: contentTypeForImageFormat(ctx.outputFormat),
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
  shareFilter: unknown = null,
) => {
  if (!subPath) {
    return writeJson(res, 400, { error: "Missing file path" });
  }

  const normalizedPath = path.join(storageRoot, subPath);

  if (!isPathInsideStorage(storageRoot, normalizedPath)) {
    return writeJson(res, 403, { error: "Access denied" });
  }

  if (shareFilter) {
    const allowed = await database.fileMatchesFilter(
      subPath,
      shareFilter as FilterElement,
    );
    if (!allowed) {
      return writeJson(res, 403, { error: "Access denied" });
    }
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
    (mimeType === "image/heic" ||
      mimeType === "image/heif" ||
      mimeType === "image/x-canon-cr3");
  const isImage = mimeType.startsWith("image/");
  const isVideo = mimeType.startsWith("video/");
  // Link-unfurl bots (Teams/Outlook) can't decode WebP and drop the whole
  // preview card; og:image URLs request `format=jpeg` for a universal encoding.
  const outputFormat: ImageOutputFormat =
    url.searchParams.get("format") === "jpeg" ? "jpeg" : "webp";

  let crop: CropBox | null;
  try {
    crop = parseCrop(url.searchParams.get("crop"));
  } catch (error) {
    return writeJson(res, 400, {
      error: "Invalid crop",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (crop && !isImage) {
    return writeJson(res, 415, {
      error: "Unsupported Media Type",
      message: "Crop is only supported for image files",
    });
  }

  const handlingContext: FileHandlingContext = {
    normalizedPath,
    subPath,
    height,
    res,
    representation,
    outputFormat,
    needsResize,
    needsFormatChange,
    isImage,
    isVideo,
    crop,
    database,
    taskOrchestrator,
  };

  if (representation === "transcript") {
    const segments = await database.getAudioSegments(subPath);
    writeJson(res, 200, { segments });
    return;
  }

  if (representation === "live-photo") {
    const fileRecord = await database.getFileRecord(subPath);
    const videoLength = fileRecord?.embeddedVideoLength;
    if (!videoLength) {
      return writeJson(res, 404, { error: "No embedded motion photo video" });
    }
    const videoStart = fileStats.size - videoLength;
    if (videoStart < 0) {
      return writeJson(res, 500, { error: "Embedded video length exceeds file size" });
    }
    // Stream only the tail slice; treat it as a standalone video for range requests.
    const rangeHeader = req.headers.range;
    const getSliceRange = (rangeHeader: string | undefined) => {
      const match = rangeHeader?.match(/^bytes=(\d+)-(\d+)?$/);
      if (!match) return null;
      const start = parseInt(match[1] ?? "", 10);
      const end = match[2] ? parseInt(match[2], 10) : videoLength - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < videoLength)
        return { start, end };
      return null;
    };
    const range = getSliceRange(rangeHeader);
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": "video/mp4",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
      "content-length": range ? range.end - range.start + 1 : videoLength,
    };
    if (range) {
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${videoLength}`;
    }
    res.writeHead(range ? 206 : 200, headers);
    const fileStart = videoStart + (range?.start ?? 0);
    const fileEnd = videoStart + (range?.end ?? videoLength - 1);
    createReadStream(normalizedPath, { start: fileStart, end: fileEnd }).pipe(res);
    return;
  }

  // HLS handler needs URL for segment parameter
  const hlsHandled = await tryHLSStream({ ...handlingContext, url });
  if (hlsHandled) return;

  const handlers = [tryVideoThumbnail, tryImageCrop, tryMicroThumbnail, tryImageVariant];
  for (const handler of handlers) {
    const handled = await handler(handlingContext);
    if (handled) return;
  }

  if (representation === "preview" && !isVideo) {
    return writeJson(res, 415, {
      error: "Unsupported Media Type",
      message: "Preview is only available for video files",
    });
  }

  if (representation !== null && !isImage && !isVideo) {
    return writeJson(res, 415, {
      error: "Unsupported Media Type",
      message: "Requested representation is not supported for this file type",
    });
  }

  streamFile(req, res, normalizedPath, {
    contentType: mimeType,
    size: fileStats.size,
    cacheControl: "public, max-age=31536000, immutable",
    acceptRanges: isVideo,
  });
};
