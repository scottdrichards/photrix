import * as http from "http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { QueryOptions } from "../indexDatabase/indexDatabase.type.ts";
import { stat } from "fs/promises";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { createReadStream } from "fs";
import path from "path/win32";
import { convertImage } from "../imageProcessing/convertImage.ts";
import { generateVideoPreview, generateVideoThumbnail } from "../videoProcessing/videoUtils.ts";
import { StandardHeight, standardHeights } from "../common/standardHeights.ts";

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
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Extract path after /api/files/ and decode URL escape characters
    const pathMatch = url.pathname.match(/^\/api\/files\/(.+)/);
    const subPath = pathMatch ? decodeURIComponent(pathMatch[1]) : null;

    // Determine if this is a query (ends with /) or file request (no trailing slash)
    // Query mode REQUIRES trailing slash (e.g., /api/files/ or /api/files/subfolder/)
    const isQuery = !subPath || subPath.endsWith("/");

    if (isQuery) {
      // QUERY MODE: Return list of files
      await queryHandler(url, subPath, database, res);
    } else {
      // FILE MODE: Serve individual file
      await fileHandler(url, subPath, storageRoot, res);
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

const queryHandler = async (
  url: URL,
  subPath: string | null,
  database: IndexDatabase,
  res: http.ServerResponse,
) => {
  const filterParam = url.searchParams.get("filter");
  const metadataParam = url.searchParams.get("metadata");
  const pageSize = url.searchParams.get("pageSize");
  const page = url.searchParams.get("page");
  const countOnly = url.searchParams.get("count") === "true";
  const includeSubfolders = url.searchParams.get("includeSubfolders") === "true";

  // Build filter
  let pathFilter;
  if (subPath) {
    // Convert path to filter
    // Remove trailing slash if present
    const cleanPath = subPath.endsWith("/") ? subPath.slice(0, -1) : subPath;
    if (includeSubfolders) {
      // Match files in this folder and all subfolders
      pathFilter = {
        relativePath: {
          regex: `^${cleanPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
        },
      };
    } else {
      // Match files directly in this path only (no subfolders)
      pathFilter = {
        relativePath: {
          regex: `^${cleanPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/]+$`,
        },
      };
    }
  } else {
    // Default: match files at root level only (no subfolders)
    pathFilter = {
      relativePath: {
        regex: `^[^/]+$`,
      },
    };
  }

  // Combine path filter with any additional filters from query string
  let filter;
  if (filterParam) {
    const additionalFilter = JSON.parse(filterParam);
    // Combine both filters using AND operation
    filter = {
      operation: "and" as const,
      conditions: [pathFilter, additionalFilter],
    };
  } else {
    filter = pathFilter;
  }

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

  const result = await database.queryFiles(queryOptions);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(countOnly ? { count: result.total } : result));
};

const fileHandler = async (
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

  // Construct absolute path and check if it's within the storage path
  const normalizedPath = path.resolve(storageRoot, subPath);

  // Security check: ensure the path is within the storage directory
  // Use path.relative to check - if it starts with "..", it's outside
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

  if (representation === "preview" && isVideo) {
    try {
      console.log(`[filesRequest] Requesting video preview for: ${subPath}`);

      const cachedPath = await generateVideoPreview(normalizedPath);
      const cachedStats = await stat(cachedPath);

      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": cachedStats.size,
        "Cache-Control": "public, max-age=31536000",
      });

      const fileStream = createReadStream(cachedPath);
      fileStream.pipe(res);
      return;
    } catch (error) {
      console.error(`Error generating video preview for: ${subPath}`, error);
      // Fall through to stream the original file if conversion fails
    }
  }

  if ((needsFormatChange || needsResize) && isImage) {
    try {
      console.log(`[filesRequest] Requesting ${height} image for: ${subPath}`);

      const cachedPath = await convertImage(normalizedPath, height);
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
      // Fall through to stream the original file if conversion fails
    }
  } else if (needsResize && isVideo) {
    try {
      console.log(`[filesRequest] Requesting ${height} thumbnail for video: ${subPath}`);

      const cachedPath = await generateVideoThumbnail(normalizedPath, height);
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
  res.writeHead(200, {
    "Content-Type": mimeType,
    "Content-Length": fileStats.size,
    "Cache-Control": "public, max-age=31536000", // Cache for 1 year
  });

  const fileStream = createReadStream(normalizedPath);
  fileStream.pipe(res);

  fileStream.on("error", (error) => {
    console.error("Error streaming file:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Error streaming file" }));
    }
  });
};
