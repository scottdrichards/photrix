import "dotenv/config";
import { realpath, stat, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileScanner } from "./indexDatabase/fileScanner.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import type { QueryOptions } from "./indexDatabase/indexDatabase.type.ts";
import { mimeTypeForFilename } from "./fileHandling/mimeTypes.ts";
import convert from "heic-convert";

const PORT = process.env.PORT || 3000;

export const createServer = (database: IndexDatabase, storagePath: string) => {
  const server = http.createServer((req, res) => {
    const requestStart = Date.now();
    console.log(`[server] ${req.method} ${req.url}`);
    
    // Intercept res.end to log timing
    const originalEnd = res.end.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.end = function(...args: any[]) {
      const elapsed = Date.now() - requestStart;
      console.log(`[server] ${req.method} ${req.url} completed in ${elapsed}ms (status: ${res.statusCode})`);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return originalEnd(...args);
    } as typeof res.end;
    
    // Enable CORS for client
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Basic health check endpoint
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", message: "Server is running" }));
      return;
    }

    // Get folders endpoint - list subfolders at a given path
    if (req.url?.startsWith("/folders") && req.method === "GET") {
      try {
        const url = new URL(req.url!, `http://${req.headers.host}`);

        // Extract path after /folders/ and decode URL escape characters
        const pathMatch = url.pathname.match(/^\/folders\/(.+)/);
        const subPath = pathMatch ? decodeURIComponent(pathMatch[1]) : "";

        // Remove trailing slash if present
        const cleanPath = subPath.endsWith("/") ? subPath.slice(0, -1) : subPath;

        console.log(`[folders] Getting folders for path: "${cleanPath}"`);
        const folders = database.getFolders(cleanPath);
        console.log(`[folders] Found ${folders.length} folders`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ folders }));
      } catch (error) {
        console.error("Error getting folders:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Internal server error",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return;
    }

    // Files endpoint - serves individual files or queries for multiple files
    // Query mode REQUIRES trailing slash: /files/ or /files/subfolder/
    // File serving has NO trailing slash: /files/image.jpg
    if (req.url?.startsWith("/files/") && req.method === "GET") {
      (async () => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);

          // Extract path after /files/ and decode URL escape characters
          const pathMatch = url.pathname.match(/^\/files\/(.+)/);
          const subPath = pathMatch ? decodeURIComponent(pathMatch[1]) : null;

          // Determine if this is a query (ends with /) or file request (no trailing slash)
          // Query mode REQUIRES trailing slash (e.g., /files/ or /files/subfolder/)
          const isQuery = !subPath || subPath.endsWith("/");

          if (isQuery) {
            // QUERY MODE: Return list of files
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
          } else {
            // FILE MODE: Serve individual file
            if (!subPath) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing file path" }));
              return;
            }

            // Construct absolute path and check if it's within the storage path
            const normalizedPath = path.resolve(storagePath, subPath);
            
            // Security check: ensure the path is within the storage directory
            // Use path.relative to check - if it starts with "..", it's outside
            const relativeToStorage = path.relative(storagePath, normalizedPath);
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
      })();
      return;
    }

    // Default 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return server;
};

const startServer = async () => {
  console.log("Starting photrix server...");

  const mediaRoot = process.env.MEDIA_ROOT || "./exampleFolder";
  console.log(`Starting indexing for: ${mediaRoot}`);

  const absolutePath = path.resolve(mediaRoot);

  const database = new IndexDatabase(absolutePath);

  new FileScanner(absolutePath, database);

  const server = createServer(database, absolutePath);

  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });

  return server;
};

const modulePath = fileURLToPath(import.meta.url);
let isMain = true;
if (!process.argv[1]) isMain = false;

try {
  const mainPath = await realpath(process.argv[1]);
  const currentPath = await realpath(modulePath);
  isMain = mainPath === currentPath;
} catch {
  isMain = false;
}

if (isMain) {
  startServer();
}
