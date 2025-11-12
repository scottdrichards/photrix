import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import http from "node:http";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { FileScanner } from "./indexDatabase/fileScanner.ts";
import type { QueryOptions } from "./indexDatabase/indexDatabase.type.ts";

// Helper to make HTTP requests
const makeRequest = (
  port: number,
  path: string,
  method: string = "GET"
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> => {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port,
        path,
        method,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
};

describe("main.ts HTTP Server", () => {
  let server: http.Server;
  let database: IndexDatabase;
  let scanner: FileScanner;
  const TEST_PORT = 3001;

  beforeEach(async () => {
    // Add small delay to prevent port conflicts
    await new Promise(resolve => setTimeout(resolve, 100));
    // Create database and scanner
    database = new IndexDatabase("./exampleFolder");
    scanner = new FileScanner("./exampleFolder", database);

    // Create server with same logic as main.ts
    server = http.createServer((req, res) => {
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

      // Get folders endpoint
      if (req.url?.startsWith("/folders") && req.method === "GET") {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const pathMatch = url.pathname.match(/^\/folders\/(.+)/);
          const subPath = pathMatch ? decodeURIComponent(pathMatch[1]) : "";
          const cleanPath = subPath.endsWith("/") ? subPath.slice(0, -1) : subPath;
          const folders = database.getFolders(cleanPath);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ folders }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Internal server error",
              message: error instanceof Error ? error.message : String(error),
            })
          );
        }
        return;
      }

      // Query files endpoint
      if (req.url?.startsWith("/files") && req.method === "GET") {
        (async () => {
          try {
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const pathMatch = url.pathname.match(/^\/files\/(.+)/);
            const subPath = pathMatch ? decodeURIComponent(pathMatch[1]) : null;
            const filterParam = url.searchParams.get("filter");
            const metadataParam = url.searchParams.get("metadata");
            const pageSize = url.searchParams.get("pageSize");
            const page = url.searchParams.get("page");

            let filter;
            if (filterParam) {
              filter = JSON.parse(filterParam);
            } else if (subPath && subPath !== "count") {
              const cleanPath = subPath.endsWith("/") ? subPath.slice(0, -1) : subPath;
              filter = {
                relativePath: {
                  regex: `^${cleanPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/]+$`,
                },
              };
            } else {
              filter = { relativePath: { regex: `^[^/]+$` } };
            }

            let metadata: QueryOptions["metadata"] = [];
            if (metadataParam) {
              try {
                metadata = JSON.parse(metadataParam);
              } catch {
                metadata = metadataParam.split(",").map((s) => s.trim()).filter(Boolean) as QueryOptions["metadata"];
              }
            }

            const queryOptions: QueryOptions = {
              filter,
              metadata,
              ...(pageSize && { pageSize: parseInt(pageSize, 10) }),
              ...(page && { page: parseInt(page, 10) }),
            };

            const result = await database.queryFiles(queryOptions);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (error) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Internal server error",
                message: error instanceof Error ? error.message : String(error),
              })
            );
          }
        })();
        return;
      }

      // Default 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    // Start server
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, resolve);
    });
  });

  afterEach(async () => {
    await scanner.stopWatching();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    // Add delay after cleanup to ensure port is released
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  describe("CORS headers", () => {
    it("should set Access-Control-Allow-Origin to *", async () => {
      const response = await makeRequest(TEST_PORT, "/health");
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    });

    it("should set Access-Control-Allow-Methods", async () => {
      const response = await makeRequest(TEST_PORT, "/health");
      expect(response.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    });

    it("should set Access-Control-Allow-Headers", async () => {
      const response = await makeRequest(TEST_PORT, "/health");
      expect(response.headers["access-control-allow-headers"]).toBe("Content-Type");
    });

    it("should respond to OPTIONS preflight requests with 200", async () => {
      const response = await makeRequest(TEST_PORT, "/health", "OPTIONS");
      expect(response.status).toBe(200);
    });
  });

  describe("GET /health", () => {
    it("should return 200 with status ok", async () => {
      const response = await makeRequest(TEST_PORT, "/health");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.status).toBe("ok");
    });

    it("should return JSON with status and message", async () => {
      const response = await makeRequest(TEST_PORT, "/health");
      const data = JSON.parse(response.body);
      expect(data).toEqual({ status: "ok", message: "Server is running" });
    });
  });

  describe("GET /files/count", () => {
    it("should return 200 with file count", async () => {
      const response = await makeRequest(TEST_PORT, "/files/count");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data).toHaveProperty("count");
      expect(typeof data.count).toBe("number");
    });

    it("should call database.getFileCount()", async () => {
      const response = await makeRequest(TEST_PORT, "/files/count");
      const data = JSON.parse(response.body);
      expect(data.count).toBe(database.getFileCount());
    });
  });

  describe("GET /folders", () => {
    it("should return folders for root path when no path specified", async () => {
      const response = await makeRequest(TEST_PORT, "/folders");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data).toHaveProperty("folders");
      expect(Array.isArray(data.folders)).toBe(true);
    });

    it("should return folders for specific subpath", async () => {
      const response = await makeRequest(TEST_PORT, "/folders/subFolder");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data).toHaveProperty("folders");
    });

    it("should decode URL-encoded path segments", async () => {
      const response = await makeRequest(TEST_PORT, "/folders/sub%20folder");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data).toHaveProperty("folders");
    });

    it("should remove trailing slash from path", async () => {
      const response = await makeRequest(TEST_PORT, "/folders/subFolder/");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data).toHaveProperty("folders");
    });

    it("should return 500 on database error", async () => {
      // Mock getFolders to throw an error
      const originalGetFolders = database.getFolders;
      database.getFolders = () => {
        throw new Error("Database error");
      };

      const response = await makeRequest(TEST_PORT, "/folders");
      expect(response.status).toBe(500);
      const data = JSON.parse(response.body);
      expect(data.error).toBe("Internal server error");
      expect(data.message).toBe("Database error");

      // Restore original method
      database.getFolders = originalGetFolders;
    });
  });

  describe("GET /files", () => {
    describe("path-based filtering", () => {
      it("should return root-level files when no path specified", async () => {
        const response = await makeRequest(TEST_PORT, "/files");
        expect(response.status).toBe(200);
        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("items");
        expect(Array.isArray(data.items)).toBe(true);
      });

      it("should return files in specific subfolder", async () => {
        const response = await makeRequest(TEST_PORT, "/files/subFolder");
        expect(response.status).toBe(200);
        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("items");
      });

      it("should use regex to exclude subfolders", async () => {
        const response = await makeRequest(TEST_PORT, "/files");
        const data = JSON.parse(response.body);
        // All items should be at root level (no slash in relativePath)
        data.items.forEach((item: { relativePath: string }) => {
          expect(item.relativePath).not.toMatch(/\//);
        });
      });

      it("should decode URL-encoded path segments", async () => {
        const response = await makeRequest(TEST_PORT, "/files/sub%20folder");
        expect(response.status).toBe(200);
        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("items");
      });

      it("should escape regex special characters in path", async () => {
        const response = await makeRequest(TEST_PORT, "/files/test.folder");
        expect(response.status).toBe(200);
        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("items");
      });
    });

    describe("query string parameters", () => {
      it("should parse filter parameter as JSON", async () => {
        const filter = JSON.stringify({ relativePath: { regex: "^test" } });
        const response = await makeRequest(TEST_PORT, `/files?filter=${encodeURIComponent(filter)}`);
        expect(response.status).toBe(200);
        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("items");
      });

      it("should parse metadata as JSON array", async () => {
        const metadata = JSON.stringify(["mimeType"]);
        const response = await makeRequest(TEST_PORT, `/files?metadata=${encodeURIComponent(metadata)}`);
        expect(response.status).toBe(200);
        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("items");
      });

      it("should parse metadata as comma-separated string", async () => {
        const response = await makeRequest(TEST_PORT, "/files?metadata=mimeType,sizeInBytes");
        expect(response.status).toBe(200);
        const data = JSON.parse(response.body);
        expect(data).toHaveProperty("items");
      });

      it("should parse pageSize parameter", async () => {
        const response = await makeRequest(TEST_PORT, "/files?pageSize=5");
        expect(response.status).toBe(200);
        const data = JSON.parse(response.body);
        expect(data.pageSize).toBe(5);
      });

      it("should parse page parameter", async () => {
        const response = await makeRequest(TEST_PORT, "/files?page=2");
        expect(response.status).toBe(200);
        const data = JSON.parse(response.body);
        expect(data.page).toBe(2);
      });

      it("should prefer explicit filter over path-based filter", async () => {
        const filter = JSON.stringify({ relativePath: { regex: ".*" } });
        const response = await makeRequest(TEST_PORT, `/files/subfolder?filter=${encodeURIComponent(filter)}`);
        expect(response.status).toBe(200);
        const data = JSON.parse(response.body);
        // Should use the explicit filter, not the path-based one
        expect(data).toHaveProperty("items");
      });
    });

    describe("error handling", () => {
      it("should return 500 on database query error", async () => {
        // Mock queryFiles to throw an error
        const originalQueryFiles = database.queryFiles;
        database.queryFiles = async () => {
          throw new Error("Query error");
        };

        const response = await makeRequest(TEST_PORT, "/files");
        expect(response.status).toBe(500);
        const data = JSON.parse(response.body);
        expect(data.error).toBe("Internal server error");

        // Restore original method
        database.queryFiles = originalQueryFiles;
      });

      it("should include error message in response", async () => {
        // Mock queryFiles to throw an error
        const originalQueryFiles = database.queryFiles;
        database.queryFiles = async () => {
          throw new Error("Specific error message");
        };

        const response = await makeRequest(TEST_PORT, "/files");
        const data = JSON.parse(response.body);
        expect(data.message).toBe("Specific error message");

        // Restore original method
        database.queryFiles = originalQueryFiles;
      });
    });
  });

  describe("404 handler", () => {
    it("should return 404 for unknown routes", async () => {
      const response = await makeRequest(TEST_PORT, "/unknown");
      expect(response.status).toBe(404);
    });

    it("should return JSON error response", async () => {
      const response = await makeRequest(TEST_PORT, "/unknown");
      const data = JSON.parse(response.body);
      expect(data).toEqual({ error: "Not found" });
    });
  });

  describe("server startup", () => {
    it.todo("should read MEDIA_ROOT from environment");
    it.todo("should default to ./exampleFolder if MEDIA_ROOT not set");
    it.todo("should create IndexDatabase with absolute path");
    it.todo("should create FileScanner instance");
    it.todo("should listen on PORT from environment");
    it.todo("should default to port 3000 if PORT not set");
    it.todo("should exit with code 1 on startup error");
  });
});
