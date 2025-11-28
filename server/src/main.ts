import "dotenv/config";
import { realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileScanner } from "./indexDatabase/fileScanner.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { healthRequestHandler } from "./requestHandlers/healthRequestHandler.ts";
import { foldersRequestHandler } from "./requestHandlers/foldersRequestHandler.ts";
import { filesRequestHandler } from "./requestHandlers/filesRequestHandler.ts";

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
    if (req.url === "/api/health" && req.method === "GET") {
      healthRequestHandler(req, res);
      return;
    }

    // Get folders endpoint - list subfolders at a given path
    if (req.url?.startsWith("/api/folders") && req.method === "GET") {
      foldersRequestHandler(req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>, res, { database });
      return;
    }

    // Files endpoint - serves individual files or queries for multiple files
    // Query mode REQUIRES trailing slash: /api/files/ or /api/files/subfolder/
    // File serving has NO trailing slash: /api/files/image.jpg
    if (req.url?.startsWith("/api/files/") && req.method === "GET") {
      filesRequestHandler(req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>, res, {
        database,
        storageRoot: storagePath,
      });
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
