import * as http from "http";
import type { Stats } from "fs";
import { stat } from "fs/promises";
import path from "path";
import { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import { mimeTypeForFilename } from "../../fileHandling/mimeTypes.ts";
import {
  convertImage,
  convertImageCrop,
  contentTypeForImageFormat,
  IMAGE_OUTPUT_CONTENT_TYPE,
  ImageConversionError,
  type CropBox,
  type ImageOutputFormat,
} from "../../imageProcessing/convertImage.ts";
import { microThumbnailPath } from "../../imageProcessing/microThumbnail.ts";
import { parseToStandardHeight } from "../../common/standardHeights.ts";
import type { TaskOrchestrator } from "../../taskOrchestrator/taskOrchestrator.ts";
import { writeJson } from "../../common/writeJson.ts";
import { decodeRequestPath } from "../../common/decodeRequestPath.ts";
import { queryHandler } from "./queryHandler.ts";
import {
  messageOf,
  parseCrop,
  parseFrameTime,
  unsupported,
  type FileHandlingContext,
} from "./fileHandlingContext.ts";
import { streamCachedFile, streamFile } from "./streamFile.ts";
import {
  serveLivePhoto,
  serveScrubFrame,
  serveShareMp4,
  serveStoryboard,
  tryHLSStream,
  tryVideoFrameCrop,
  tryVideoThumbnail,
} from "./videoRepresentations.ts";

// `/api/files/…`: a folder query, or one file in the representation asked for.
// This file parses the request and checks access; the work is in
// imageProcessing/ and videoProcessing/ (see videoRepresentations.ts).

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
        message: messageOf(error),
      });
  }
};

const isPathInsideStorage = (storageRoot: string, targetPath: string) => {
  const relativeToStorage = path.relative(storageRoot, targetPath);
  return !relativeToStorage.startsWith("..") && !path.isAbsolute(relativeToStorage);
};

/**
 * Streams the cached image `produce` makes. An undecodable image is a 422; any
 * other failure returns false so the next handler gets a go.
 */
const serveConvertedImage = async (
  res: http.ServerResponse,
  contentType: string,
  produce: () => Promise<string>,
): Promise<boolean> => {
  try {
    await streamCachedFile(res, await produce(), { contentType });
    return true;
  } catch (error) {
    if (error instanceof ImageConversionError) {
      writeJson(res, 422, { error: "Invalid image", message: error.message });
      return true;
    }
    return false;
  }
};

const tryImageCrop = (ctx: FileHandlingContext) => {
  const { crop, isImage, normalizedPath, height, res } = ctx;
  if (!crop || !isImage) return false;
  return serveConvertedImage(res, IMAGE_OUTPUT_CONTENT_TYPE, () =>
    convertImageCrop(normalizedPath, crop, height, { priority: "userBlocked" }),
  );
};

const tryMicroThumbnail = (ctx: FileHandlingContext) => {
  if (ctx.representation !== "micro" || !ctx.isImage) return false;
  return serveConvertedImage(ctx.res, IMAGE_OUTPUT_CONTENT_TYPE, () =>
    microThumbnailPath(ctx.normalizedPath),
  );
};

const tryImageVariant = (ctx: FileHandlingContext) => {
  const { needsFormatChange, needsResize, isImage, normalizedPath, height, res, outputFormat } = ctx;
  const forcesFormat = outputFormat !== "webp";
  if (!(needsFormatChange || needsResize || forcesFormat) || !isImage) return false;
  return serveConvertedImage(res, contentTypeForImageFormat(outputFormat), () =>
    convertImage(normalizedPath, height, { priority: "userBlocked", format: outputFormat }),
  );
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
    const allowed = await database.fileMatchesFilter(subPath, shareFilter);
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
    return writeJson(res, 400, { error: "Invalid crop", message: messageOf(error) });
  }
  let frameTimeMs: number | null;
  try {
    frameTimeMs = parseFrameTime(url.searchParams.get("t"));
  } catch (error) {
    return writeJson(res, 400, { error: "Invalid t", message: messageOf(error) });
  }
  // A video has no single picture to crop; `t` names the frame (a face found
  // in a video carries it — see faces.frameTimeMs).
  if (crop && !isImage && !(isVideo && frameTimeMs !== null)) {
    return unsupported(
      res,
      isVideo
        ? "Cropping a video needs t, the frame time in ms"
        : "Crop is only supported for image and video files",
    );
  }

  const handlingContext: FileHandlingContext = {
    req,
    url,
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
    frameTimeMs: isVideo ? frameTimeMs : null,
    database,
    taskOrchestrator,
  };

  switch (representation) {
    case "transcript": {
      const segments = await database.analysis.getAudioSegments(subPath);
      return writeJson(res, 200, { segments });
    }
    case "live-photo":
      return serveLivePhoto(handlingContext, fileStats.size);
    case "scrub":
      return serveScrubFrame(handlingContext);
    case "storyboard":
      return serveStoryboard(handlingContext);
    case "shareMp4":
      return serveShareMp4(handlingContext);
    case null:
    default:
      // The original, or a representation one of the handlers below makes.
      break;
  }

  // tryVideoFrameCrop must precede tryVideoThumbnail, which would otherwise
  // answer a sized video request with the whole first frame.
  const handlers = [
    tryHLSStream,
    tryVideoFrameCrop,
    tryVideoThumbnail,
    tryImageCrop,
    tryMicroThumbnail,
    tryImageVariant,
  ];
  for (const handler of handlers) {
    const handled = await handler(handlingContext);
    if (handled) return;
  }

  if (representation === "preview" && !isVideo) {
    return unsupported(res, "Preview is only available for video files");
  }

  if (representation !== null && !isImage && !isVideo) {
    return unsupported(res, "Requested representation is not supported for this file type");
  }

  streamFile(req, res, normalizedPath, {
    contentType: mimeType,
    size: fileStats.size,
    cacheControl: "public, max-age=31536000, immutable",
    acceptRanges: isVideo,
  });
};
