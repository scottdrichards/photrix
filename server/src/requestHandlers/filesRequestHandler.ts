import * as http from "http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { QueryOptions } from "../indexDatabase/indexDatabase.type.ts";
import { stat } from "fs/promises";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { createReadStream } from "fs";
import path from "path/win32";
import { convertImage, convertImageToMultipleSizes, ImageConversionError } from "../imageProcessing/convertImage.ts";
import { generateVideoThumbnail } from "../videoProcessing/videoUtils.ts";
import { StandardHeight, standardHeights } from "../common/standardHeights.ts";
import { mediaProcessingQueue } from "../common/processingQueue.ts";

type Options = {
  database: IndexDatabase;
  storageRoot: string;
};

export const filesRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, storageRoot }: Options,
) => {
  try {
    // Pause background generation for 1 minute when a request comes in
    mediaProcessingQueue.pause(60_000);
    
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Extract path after /api/files/ and decode URL escape characters
    const pathMatch = url.pathname.match(/^\/api\/files\/(.*)/);
    if (!pathMatch){
      console.error("Invalid /api/files/ request path:", url.pathname);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
      return;
    }
    const subPath = decodeURIComponent(pathMatch[1]) || "/";

    // Determine if this is a query (as opposed to file request)
    const isQuery = subPath.endsWith("/");

    if (isQuery) {
      // QUERY MODE: Return list of files
      await queryHandler(url, subPath, database, res);
    } else {
      // FILE MODE: Serve individual file
      await fileHandler(req, url, subPath, storageRoot, res);
    }
  } catch (error) {
    console.error("Error processing files request:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
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

  if (typeof rangeHeader === "string") {
    const match = rangeHeader.match(/^bytes=(\d+)-(\d+)?$/);
    if (match) {
      const start = Number.parseInt(match[1] ?? "", 10);
      const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;

      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < size) {
        res.writeHead(206, {
          "Content-Type": contentType,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          ...(acceptRanges ? { "Accept-Ranges": "bytes" } : {}),
          "Cache-Control": cacheControl,
        });

        const fileStream = createReadStream(filePath, { start, end });
        fileStream.on("error", (error) => {
          console.error("Error streaming ranged file:", error);
          res.destroy(error);
        });
        fileStream.pipe(res);
        return;
      }

      res.writeHead(416, {
        "Content-Range": `bytes */${size}`,
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Requested Range Not Satisfiable" }));
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": size,
    ...(acceptRanges ? { "Accept-Ranges": "bytes" } : {}),
    "Cache-Control": cacheControl,
  });

  const fileStream = createReadStream(filePath);
  fileStream.on("error", (error) => {
    console.error("Error streaming file:", error);
    res.destroy(error);
  });
  fileStream.pipe(res);
};

const queryHandler = async (
  url: URL,
  directoryPath: string,
  database: IndexDatabase,
  res: http.ServerResponse,
) => {
  const filterParam = url.searchParams.get("filter");
  const metadataParam = url.searchParams.get("metadata");
  const pageSize = url.searchParams.get("pageSize");
  const page = url.searchParams.get("page");
  const countOnly = url.searchParams.get("count") === "true";
  const includeSubfolders = url.searchParams.get("includeSubfolders") === "true";
  const cluster = url.searchParams.get("cluster") === "true";
  const clusterSizeParam = url.searchParams.get("clusterSize");
  const westParam = url.searchParams.get("west");
  const eastParam = url.searchParams.get("east");
  const northParam = url.searchParams.get("north");
  const southParam = url.searchParams.get("south");
  const aggregate = url.searchParams.get("aggregate");

  const pathFilter:QueryOptions["filter"] = directoryPath? {
    folder: {
      folder: directoryPath,
      recursive: includeSubfolders,
    }
  } :{};

  const filter = filterParam ? {
    operation: "and" as const,
    conditions: [
      pathFilter,
      JSON.parse(filterParam) as QueryOptions["filter"],
    ],
  }: pathFilter;

  // Parse metadata (comma-separated list or JSON array)
  let metadata: Array<string> = [];
  if (metadataParam) {
    try {
      // Try parsing as JSON array first
      metadata = JSON.parse(metadataParam);
    } catch {
      // Fall back to comma-separated string
      metadata = metadataParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const queryOptions = {
    filter,
    metadata: metadata as QueryOptions["metadata"],
    ...(pageSize && { pageSize: parseInt(pageSize, 10) }),
    ...(page && { page: parseInt(page, 10) }),
  };

  if (aggregate === "dateRange") {
    const { minDate, maxDate } = database.getDateRange(filter);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        minDate: minDate ? minDate.getTime() : null,
        maxDate: maxDate ? maxDate.getTime() : null,
      }),
    );
    return;
  }

  if (aggregate === "dateHistogram") {
    const result = database.getDateHistogram(filter);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (cluster) {
    const parsedClusterSize = clusterSizeParam ? Number.parseFloat(clusterSizeParam) : NaN;
    const clusterSize = Number.isFinite(parsedClusterSize) && parsedClusterSize > 0 ? parsedClusterSize : 0.00002;
    const bounds = [westParam, eastParam, northParam, southParam].every((v) => v !== null)
      ? {
          west: Number.parseFloat(westParam ?? ""),
          east: Number.parseFloat(eastParam ?? ""),
          north: Number.parseFloat(northParam ?? ""),
          south: Number.parseFloat(southParam ?? ""),
        }
      : null;
    const { clusters, total } = database.queryGeoClusters({ filter, clusterSize, bounds });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ clusters, total }));
    return;
  }

  const result = await database.queryFiles(queryOptions);
  const responseBody = countOnly ? { count: result.total } : result;
  try {
    const payload = JSON.stringify(responseBody);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("invalid string length")) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Response too large",
          message:
            "The query result was too large to serialize. Try requesting fewer metadata fields or a smaller pageSize.",
        }),
      );
      return;
    }
    throw error;
  }
};

const fileHandler = async (
  req: http.IncomingMessage,
  url: URL,
  subPath: string,
  storageRoot: string,
  res: http.ServerResponse,
) => {
  if (!subPath) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing file path" }));
    return;
  }

  const normalizedPath = path.join(storageRoot, subPath);

  // Security check: ensure the path is within the storage directory
  const relativeToStorage = path.relative(storageRoot, normalizedPath);
  if (relativeToStorage.startsWith("..") || path.isAbsolute(relativeToStorage)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Access denied" }));
    return;
  }

  // Check if file exists and is a file
  let fileStats;
  try {
    fileStats = await stat(normalizedPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "File not found" }));
      return;
    }
    throw err;
  }

  if (!fileStats.isFile()) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "File not found" }));
    return;
  }

  // Determine content type
  const mimeType = mimeTypeForFilename(subPath) || "application/octet-stream";
  const representation = url.searchParams.get("representation");
  const heightParam = url.searchParams.get("height");

  const parseToStandardHeight = (value: string | null): StandardHeight | null => {
    const parsed = value && parseInt(value, 10);
    const nearest = standardHeights.find(h => typeof h === 'number' && typeof parsed === 'number' && h >= parsed) ?? 'original';

    if (nearest !== parsed){
      console.log(`Height (${value}) does not match standard height, using `, nearest);
    }
    return nearest;
  }

  const height = parseToStandardHeight(heightParam) ?? "original";

  const needsResize = height !== "original";
  const needsFormatChange =
    representation === "webSafe" &&
    (mimeType === "image/heic" || mimeType === "image/heif");

  const isImage = mimeType.startsWith("image/");
  const isVideo = mimeType.startsWith("video/");

  // Video preview generation disabled - just use thumbnail
  if (representation === "preview" && isVideo) {
    try {
      const queueSize = mediaProcessingQueue.getQueueSize();
      const processing = mediaProcessingQueue.getProcessing();
      console.log(`[filesRequest] Requesting thumbnail for video preview: ${subPath} (queue: ${queueSize}, processing: ${processing})`);

      const cachedPath = await generateVideoThumbnail(normalizedPath, 320, { priority: "userBlocked" });
      const cachedStats = await stat(cachedPath);

      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": cachedStats.size,
        "Cache-Control": "public, max-age=31536000",
      });

      const fileStream = createReadStream(cachedPath);
      fileStream.pipe(res);
      return;
    } catch (error) {
      console.error(`Error generating video thumbnail for preview: ${subPath}`, error);
      // Fall through to stream the original file if conversion fails
    }
  }

  // Video conversion disabled - just generate thumbnail
  if (representation === "webSafe" && isVideo) {
    try {
      const queueSize = mediaProcessingQueue.getQueueSize();
      const processing = mediaProcessingQueue.getProcessing();
      console.log(
        `[filesRequest] Requesting ${height} thumbnail for video: ${subPath} (queue: ${queueSize}, processing: ${processing})`,
      );

      const cachedPath = await generateVideoThumbnail(normalizedPath, height, { priority: "userBlocked" });
      const cachedStats = await stat(cachedPath);

      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": cachedStats.size,
        "Cache-Control": "public, max-age=31536000",
      });

      const fileStream = createReadStream(cachedPath);
      fileStream.pipe(res);
      return;
    } catch (error) {
      console.error(`Error generating video thumbnail for: ${subPath}`, error);
      // Fall through to stream the original file if conversion fails
    }
  }

  if ((needsFormatChange || needsResize) && isImage) {
    try {
      const queueSize = mediaProcessingQueue.getQueueSize();
      const processing = mediaProcessingQueue.getProcessing();
      console.log(`[filesRequest] Requesting ${height} image for: ${subPath} (queue: ${queueSize}, processing: ${processing})`);

      // Generate all standard sizes in the background (except 'original') - low priority
      const allSizes = standardHeights.filter((h): h is Exclude<StandardHeight, "original"> => typeof h !== 'string');
      void convertImageToMultipleSizes(normalizedPath, allSizes, { priority: 'userImplicit' })
        .catch((error) => {
          console.error(`[filesRequest] Background size generation failed for ${subPath}:`, error);
        });
      
      // But wait for the requested size specifically - high priority
      const cachedPath = await convertImage(normalizedPath, height, { priority: 'userBlocked' });
      const cachedStats = await stat(cachedPath);

      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": cachedStats.size,
        "Cache-Control": "public, max-age=31536000",
      });

      const fileStream = createReadStream(cachedPath);
      fileStream.pipe(res);
      return;
    } catch (error) {
      console.error(`Error generating image for: ${subPath}`, error);

      if (error instanceof ImageConversionError) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Invalid image",
            message: error.message,
          }),
        );
        return;
      }

      // Fall through to stream the original file if conversion fails for other reasons
    }
  } else if (needsResize && isVideo) {
    // Legacy behavior: if a client asks for a sized video without specifying a representation,
    // return a JPEG thumbnail rather than attempting a transcode.
    try {
      const queueSize = mediaProcessingQueue.getQueueSize();
      const processing = mediaProcessingQueue.getProcessing();
      console.log(
        `[filesRequest] Requesting ${height} thumbnail for video: ${subPath} (queue: ${queueSize}, processing: ${processing})`,
      );

      const cachedPath = await generateVideoThumbnail(normalizedPath, height, { priority: "userBlocked" });
      const cachedStats = await stat(cachedPath);

      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": cachedStats.size,
        "Cache-Control": "public, max-age=31536000",
      });

      const fileStream = createReadStream(cachedPath);
      fileStream.pipe(res);
      return;
    } catch (error) {
      console.error(`Error generating video thumbnail for: ${subPath}`, error);
      // Fall through to stream the original file if conversion fails
    }
  }

  // Stream the file
  streamFile(req, res, normalizedPath, {
    contentType: mimeType,
    size: fileStats.size,
    cacheControl: "public, max-age=31536000",
    acceptRanges: isVideo,
  });
};
