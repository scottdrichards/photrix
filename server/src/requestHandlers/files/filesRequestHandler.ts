import * as http from "http";
import { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import { stat, readFile } from "fs/promises";
import { mimeTypeForFilename } from "../../fileHandling/mimeTypes.ts";
import { createReadStream, existsSync, type Stats } from "fs";
import path from "path/win32";
import { convertImage, convertImageToMultipleSizes, ImageConversionError } from "../../imageProcessing/convertImage.ts";
import { generateVideoThumbnail } from "../../videoProcessing/videoUtils.ts";
import { generateHLS, getHLSInfo, getHLSSegmentPath } from "../../videoProcessing/generateHLS.ts";
import {
  generateMultibitrateHLS,
  getMultibitrateHLSInfo,
  getMasterPlaylistPath,
  getVariantPlaylistPath,
  getVariantSegmentPath,
  multibitrateHLSExists,
} from "../../videoProcessing/generateMultibitrateHLS.ts";
import { StandardHeight, standardHeights, parseToStandardHeight } from "../../common/standardHeights.ts";
import { mediaProcessingQueue } from "../../common/processingQueue.ts";
import { queryHandler } from "./queryHandler.ts";
import { writeJson } from "../../utils.ts";

type Options = { database: IndexDatabase; storageRoot: string };

export const filesEndpointRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, storageRoot }: Options,
) => {
  try {    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathMatch = url.pathname.match(/^\/api\/files\/(.*)/);
    if (!pathMatch) return writeJson(res, 400, { error: "Bad request" });
    const subPath = decodeURIComponent(pathMatch[1]) || "/";
    if (subPath.endsWith("/")) return queryHandler(url, subPath, database, res);
    await fileHandler(req, url, subPath, storageRoot, res, database);
  } catch (error) {
    console.error("Error processing files request:", error);
    if (!res.headersSent) writeJson(res, 500, { error: "Internal server error", message: error instanceof Error ? error.message : String(error) });
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

  const getRange = (rangeHeader: string | undefined, size: number): { start: number; end: number } | null => {
    const match = rangeHeader?.match(/^bytes=(\d+)-(\d+)?$/);
    if (!match) return null;

    const start = Number.parseInt(match[1] ?? "", 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < size) return { start, end };
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
  const fileStream = createReadStream(filePath, range ? { start: range.start, end: range.end } : undefined);
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

const streamCachedFile = (
  res: http.ServerResponse,
  filePath: string,
  opts: { contentType: string; size: number; cacheControl?: string },
) => {
  const { contentType, size, cacheControl = "public, max-age=31536000" } = opts;
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": size, "Cache-Control": cacheControl });

  const fileStream = createReadStream(filePath);
  fileStream.on("error", (error) => {
    console.error("Error streaming cached file:", error);
    res.destroy(error);
  });
  fileStream.pipe(res);
};

const logQueueStatus = (label: string, subPath: string) => {
  const queueSize = mediaProcessingQueue.getQueueSize();
  const processing = mediaProcessingQueue.getProcessing();
  console.log(`[filesRequest] ${label}: ${subPath} (queue: ${queueSize}, processing: ${processing})`);
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
};

const serveVideoThumb = async (ctx: FileHandlingContext, height: StandardHeight, label: string) => {
  const { normalizedPath, subPath, res } = ctx;
  try {
    logQueueStatus(label, subPath);
    const cachedPath = await generateVideoThumbnail(normalizedPath, height, { priority: "userBlocked" });
    const cachedStats = await stat(cachedPath);
    streamCachedFile(res, cachedPath, { contentType: "image/jpeg", size: cachedStats.size });
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
  const label = isPreview ? "Requesting preview thumbnail" : `Requesting ${ctx.height} thumbnail for video`;
  return serveVideoThumb(ctx, height, label);
};

const tryHLSStream = async (ctx: FileHandlingContext & { url: URL }): Promise<boolean> => {
  const { isVideo, representation, normalizedPath, subPath, height, res, url, database } = ctx;
  if (!isVideo || representation !== "hls") return false;

  const segment = url.searchParams.get("segment");
  const variant = url.searchParams.get("variant"); // e.g., "360" or "720"

  try {
    logQueueStatus(`Requesting HLS ${segment ? `segment ${segment}` : variant ? `${variant}p variant` : "playlist"}`, subPath);
    
    // Get duration from database for accurate playlist duration
    const fileRecord = await database.getFileRecord(subPath, ["duration"]);
    const knownDuration = fileRecord?.duration;

    // Check if multi-bitrate HLS is pre-encoded
    const multibitrateInfo = await getMultibitrateHLSInfo(normalizedPath);
    const hasMultibitrate = multibitrateInfo.exists;

    // If we have multi-bitrate HLS, serve from that
    if (hasMultibitrate) {
      // Serve variant segment
      if (segment && variant) {
        const variantHeight = parseInt(variant, 10);
        const segmentPath = getVariantSegmentPath(multibitrateInfo.hash, variantHeight, segment);
        
        if (!existsSync(segmentPath)) {
          writeJson(res, 404, { error: "HLS segment not found" });
          return true;
        }
        
        const segmentStats = await stat(segmentPath);
        res.writeHead(200, {
          "Content-Type": "video/mp2t",
          "Content-Length": segmentStats.size,
          "Cache-Control": "public, max-age=31536000",
        });
        createReadStream(segmentPath).pipe(res);
        return true;
      }

      // Serve variant playlist
      if (variant) {
        const variantHeight = parseInt(variant, 10);
        const variantPlaylistPath = getVariantPlaylistPath(multibitrateInfo.hash, variantHeight);
        
        if (!existsSync(variantPlaylistPath)) {
          writeJson(res, 404, { error: "HLS variant playlist not found" });
          return true;
        }
        
        let playlistContent = await readFile(variantPlaylistPath, "utf-8");
        
        // Rewrite segment paths to use API endpoint
        const baseUrl = `/api/files/${encodeURIComponent(subPath)}?representation=hls&variant=${variant}&segment=`;
        const modifiedPlaylist = playlistContent.replace(
          /^(segment_\d+\.ts)$/gm,
          (match) => `${baseUrl}${match}`
        );
        
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "public, max-age=31536000", // Pre-encoded, can cache
          "Content-Length": Buffer.byteLength(modifiedPlaylist, "utf-8"),
          ...(knownDuration && Number.isFinite(knownDuration) ? { "X-Content-Duration": String(knownDuration) } : {}),
        });
        res.end(modifiedPlaylist);
        return true;
      }

      // Serve master playlist
      let masterContent = await readFile(multibitrateInfo.masterPlaylistPath, "utf-8");
      
      // Rewrite variant playlist paths to use API endpoint
      const baseVariantUrl = `/api/files/${encodeURIComponent(subPath)}?representation=hls&variant=`;
      masterContent = masterContent.replace(
        /^(\d+)p\/playlist\.m3u8$/gm,
        (_, variantHeight) => `${baseVariantUrl}${variantHeight}`
      );
      
      res.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "public, max-age=31536000", // Pre-encoded, can cache
        "Content-Length": Buffer.byteLength(masterContent, "utf-8"),
        ...(knownDuration && Number.isFinite(knownDuration) ? { "X-Content-Duration": String(knownDuration) } : {}),
      });
      res.end(masterContent);
      return true;
    }

    // Fall back to on-demand single-stream HLS generation
    const hlsInfo = await getHLSInfo(normalizedPath, height);

    // If requesting a segment, serve it directly if it exists
    if (segment) {
      const segmentPath = getHLSSegmentPath(hlsInfo.hash, height, segment);
      
      // Wait for segment to appear (it might still be encoding)
      const maxWaitMs = 30_000;
      const pollIntervalMs = 200;
      let waited = 0;
      while (!existsSync(segmentPath) && waited < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        waited += pollIntervalMs;
      }
      
      if (!existsSync(segmentPath)) {
        writeJson(res, 404, { error: "HLS segment not found or timed out" });
        return true;
      }
      const segmentStats = await stat(segmentPath);
      res.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Content-Length": segmentStats.size,
        "Cache-Control": "public, max-age=31536000",
      });
      createReadStream(segmentPath).pipe(res);
      return true;
    }

    // Start HLS generation (returns immediately, transcoding happens in background)
    await generateHLS(normalizedPath, height, { priority: "userBlocked" });

    // Wait for playlist to have at least 3 segments for smooth initial playback
    const maxWaitMs = 30_000;
    const pollIntervalMs = 200;
    let waited = 0;
    const minSegments = 3;
    
    const countSegments = async (): Promise<number> => {
      if (!existsSync(hlsInfo.playlistPath)) return 0;
      const content = await readFile(hlsInfo.playlistPath, "utf-8");
      const matches = content.match(/segment_\d+\.ts/g);
      return matches?.length ?? 0;
    };
    
    while ((await countSegments()) < minSegments && waited < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      waited += pollIntervalMs;
    }
    
    if (!existsSync(hlsInfo.playlistPath)) {
      writeJson(res, 500, { error: "HLS playlist generation timed out" });
      return true;
    }

    // Read and serve the playlist, modifying segment URLs to include proper path
    let playlistContent = await readFile(hlsInfo.playlistPath, "utf-8");

    // Inject total duration into playlist if we know it from the database
    // This allows the player to show correct duration even during encoding
    if (knownDuration && Number.isFinite(knownDuration)) {
      // Add EXT-X-TARGETDURATION if not present or too low, and add a comment with total duration
      // The #EXT-X-TOTALDURATION is a custom tag that hls.js doesn't use, but we can also
      // manipulate the playlist to help the player
      if (!playlistContent.includes("#EXT-X-ENDLIST")) {
        // Still encoding - add a hint about total duration
        // Insert after #EXTM3U line
        playlistContent = playlistContent.replace(
          "#EXTM3U",
          `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES`
        );
      }
    }

    // Rewrite segment paths in playlist to use API endpoint
    const baseUrl = `/api/files/${encodeURIComponent(subPath)}?representation=hls&height=${height}&segment=`;
    const modifiedPlaylist = playlistContent.replace(
      /^(segment_\d+\.ts)$/gm,
      (match) => `${baseUrl}${match}`
    );

    res.writeHead(200, {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache", // Don't cache since playlist updates during encoding
      "Content-Length": Buffer.byteLength(modifiedPlaylist, "utf-8"),
      // Send the known duration as a custom header the client can use
      ...(knownDuration && Number.isFinite(knownDuration) ? { "X-Content-Duration": String(knownDuration) } : {}),
    });
    res.end(modifiedPlaylist);
    return true;
  } catch (error) {
    console.error(`Error generating HLS stream for: ${subPath}`, error);
    writeJson(res, 500, { error: "HLS generation failed", message: error instanceof Error ? error.message : String(error) });
    return true;
  }
};

const tryImageVariant = async (ctx: FileHandlingContext) => {
  const { needsFormatChange, needsResize, isImage, normalizedPath, subPath, height, res } = ctx;
  if (!(needsFormatChange || needsResize) || !isImage) return false;

  try {
    logQueueStatus(`Requesting ${height} image`, subPath);
    const allSizes = standardHeights.filter((size): size is Exclude<StandardHeight, "original"> => typeof size !== "string");
    void convertImageToMultipleSizes(normalizedPath, allSizes, { priority: "userImplicit" }).catch((error) => {
      console.error(`[filesRequest] Background size generation failed for ${subPath}:`, error);
    });

    const cachedPath = await convertImage(normalizedPath, height, { priority: "userBlocked" });
    const cachedStats = await stat(cachedPath);
    streamCachedFile(res, cachedPath, { contentType: "image/jpeg", size: cachedStats.size });
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
) => {
  if (!subPath){
    return writeJson(res, 400, { error: "Missing file path" });
  }

  const normalizedPath = path.join(storageRoot, subPath);

  if (!isPathInsideStorage(storageRoot, normalizedPath)){
    return writeJson(res, 403, { error: "Access denied" });
  }

  const fileStats: Stats | null = await (async ()=>{
    try{
      const stats = await stat(normalizedPath);
      if (!stats.isFile()){
        return null;
      }
      return stats;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT"){
        return null;
      }
      throw error;
    }
  })();
  if (!fileStats){
    return writeJson(res, 404, { error: "File not found" });
  }

  const mimeType = mimeTypeForFilename(subPath) || "application/octet-stream";
  const representation = url.searchParams.get("representation");
  const height = parseToStandardHeight(url.searchParams.get("height"));

  const needsResize = height !== "original";
  const needsFormatChange =
    representation === "webSafe" && (mimeType === "image/heic" || mimeType === "image/heif");
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
