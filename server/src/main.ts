import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { FileWatcher } from "./indexDatabase/fileWatcher.ts";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  console.log("Starting photrix server...");

  // Start indexing in the background
  const watchPath = process.env.WATCH_PATH || "./exampleFolder";
  console.log(`Starting indexing for: ${watchPath}`);
  
  const absolutePath = path.resolve(watchPath);
  console.log(`Indexing directory: ${absolutePath}`);

  const database = new IndexDatabase(absolutePath);

  // Start watching the directory
  new FileWatcher(absolutePath, database);

  console.log("Indexing started");

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
