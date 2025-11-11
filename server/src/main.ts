import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { FileWatcher } from "./indexDatabase/fileWatcher.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import type { QueryOptions } from "./indexDatabase/indexDatabase.type.ts";

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  console.log("Starting photrix server...");

  const mediaRoot = process.env.MEDIA_ROOT || "./exampleFolder";
  console.log(`Starting indexing for: ${mediaRoot}`);
  
  const absolutePath = path.resolve(mediaRoot);
  
  const database = new IndexDatabase(absolutePath); 
  
  new FileWatcher(absolutePath, database);

  const server = http.createServer((req, res) => {
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

    // Get file count endpoint
    if (req.url === "/files/count" && req.method === "GET") {
      const count = database.getFileCount();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count }));
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
        
        const folders = database.getFolders(cleanPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ folders }));
      } catch (error) {
        console.error("Error getting folders:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          error: "Internal server error", 
          message: error instanceof Error ? error.message : String(error) 
        }));
      }
      return;
    }

    // Query files endpoint - supports both path-based and query string filters
    if (req.url?.startsWith("/files") && req.method === "GET") {
      (async () => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          
          // Extract path after /files/ and decode URL escape characters
          const pathMatch = url.pathname.match(/^\/files\/(.+)/);
          const subPath = pathMatch ? decodeURIComponent(pathMatch[1]) : null;
          
          // Parse query parameters
          const filterParam = url.searchParams.get("filter");
          const metadataParam = url.searchParams.get("metadata");
          const pageSize = url.searchParams.get("pageSize");
          const page = url.searchParams.get("page");

          // Build filter
          let filter;
          if (filterParam) {
            // Use explicit filter from query string
            filter = JSON.parse(filterParam);
          } else if (subPath && subPath !== "count") {
            // Convert path to filter that matches files directly in this path only (no subfolders)
            // Remove trailing slash if present
            const cleanPath = subPath.endsWith("/") ? subPath.slice(0, -1) : subPath;
            filter = {
              relativePath: {
                regex: `^${cleanPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+$`
              }
            };
          } else {
            // Default: match files at root level only (no subfolders)
            filter = {
              relativePath: {
                regex: `^[^/]+$`
              }
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
              metadata = metadataParam.split(",").map(s => s.trim()).filter(Boolean);
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
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error("Error processing query:", error);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ 
            error: "Internal server error", 
            message: error instanceof Error ? error.message : String(error) 
          }));
        }
      })();
      return;
    }

    // Default 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
};

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
