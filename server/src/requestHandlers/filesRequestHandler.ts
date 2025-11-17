import * as http from "http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { QueryOptions } from "../indexDatabase/indexDatabase.type.ts";
import { stat } from "fs/promises";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { createReadStream } from "fs";
import path from "path/win32";
type Options = {
  database: IndexDatabase;
  storageRoot: string;
};
export const filesRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, storageRoot }: Options,
) => {
  {
    try {
      const { pathname: requestPath, searchParams } = new URL(
        req.url,
        `http://${req.headers.host}`,
      );

      const relativePath = requestPath.substring("/files/".length);
      const isQuery = relativePath === "" || relativePath.endsWith("/");

      if (isQuery) {
        // QUERY MODE: Return list of files
        console.log(`[filesRequest] Query mode: path="${relativePath}", params=${JSON.stringify(Object.fromEntries(searchParams))}`);
        await queryHandler(searchParams, relativePath, database, res);
      } else {
        console.log(`[filesRequest] File mode: serving "${relativePath}"`);
        await fileHandler(relativePath, storageRoot, res);
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
  }
};

const fileHandler = async (
  relativePath: string,
  storageRoot: string,
  res: http.ServerResponse,
) => {
  // FILE MODE: Serve individual file
  if (!relativePath) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing file path" }));
    return;
  }

  // Construct absolute path and check if it's within the storage path
  const normalizedPath = path.resolve(storageRoot, relativePath);

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
  const mimeType = mimeTypeForFilename(relativePath) || "application/octet-stream";

  // Stream the file
  console.log(`[filesRequest] Streaming file: ${relativePath} (${mimeType}, ${fileStats.size} bytes)`);
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

const queryHandler = async (
  searchParams: URLSearchParams,
  relativePath: string,
  database: IndexDatabase,
  res: http.ServerResponse<http.IncomingMessage>,
) => {
  const filterParam = searchParams.get("filter");
  const metadataParam = searchParams.get("metadata");
  const pageSize = searchParams.get("pageSize");
  const page = searchParams.get("page");
  const countOnly = searchParams.get("count") === "true";
  const includeSubfolders = searchParams.get("includeSubfolders") === "true";

  // Build filter
  let filter;
  if (filterParam) {
    // Use explicit filter from query string
    filter = JSON.parse(filterParam);
  } else if (relativePath) {
    // Convert path to filter
    // Remove trailing slash if present
    const cleanPath = relativePath.endsWith("/") ? relativePath.slice(0, -1) : relativePath;
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
  console.log(`[filesRequest] Query completed: ${result.total} total files, returned ${countOnly ? 'count only' : `${result.items.length} items`}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(countOnly ? { count: result.total } : result));
};
