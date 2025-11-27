import * as http from "http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { QueryOptions } from "../indexDatabase/indexDatabase.type.ts";
import { stat, readFile } from "fs/promises";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { createReadStream } from "fs";
import path from "path/win32";
import convert from "heic-convert";

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

    // Extract path after /files/ and decode URL escape characters
    const pathMatch = url.pathname.match(/^\/files\/(.+)/);
    const subPath = pathMatch ? decodeURIComponent(pathMatch[1]) : null;

    // Determine if this is a query (ends with /) or file request (no trailing slash)
    // Query mode REQUIRES trailing slash (e.g., /files/ or /files/subfolder/)
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
  let filter;
  if (filterParam) {
    // Use explicit filter from query string
    filter = JSON.parse(filterParam);
  } else if (subPath) {
    // Convert path to filter
    // Remove trailing slash if present
    const cleanPath = subPath.endsWith("/") ? subPath.slice(0, -1) : subPath;
    if (includeSubfolders) {
      // Match files in this folder and all subfolders
      filter = {
        relativePath: {
          regex: `^${cleanPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
        },
      };
    } else {
      // Match files directly in this path only (no subfolders)
      filter = {
        relativePath: {
          regex: `^${cleanPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/]+$`,
        },
      };
    }
  } else {
    // Default: match files at root level only (no subfolders)
    filter = {
      relativePath: {
        regex: `^[^/]+$`,
      },
    };
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

  // Convert HEIC/HEIF to JPEG if webSafe representation is requested
  if (representation === "webSafe" && (mimeType === "image/heic" || mimeType === "image/heif")) {
    try {
      console.log(`[filesRequest] Converting HEIC/HEIF to JPEG: ${subPath}`);
      const inputBuffer = await readFile(normalizedPath);
      const outputBuffer = await convert({
        buffer: inputBuffer as unknown as ArrayBufferLike,
        format: "JPEG",
        quality: 0.9,
      });

      const outputBufferNode = Buffer.from(outputBuffer);
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": outputBufferNode.length,
        "Cache-Control": "public, max-age=31536000",
      });
      res.end(outputBufferNode);
      console.log(`[filesRequest] HEIC converted successfully: ${subPath} (${outputBufferNode.length} bytes)`);
      return;
    } catch (error) {
      console.error(`Error converting HEIC/HEIF file: ${subPath}`, error);
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
