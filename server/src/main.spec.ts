import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import http from "node:http";
import path from "node:path";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { FileScanner } from "./indexDatabase/fileScanner.ts";
import { createServer } from "./main.ts";
import { walkFiles, toRelative } from "./fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "./fileHandling/mimeTypes.ts";

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
  let storagePath: string;
  const TEST_PORT = 3001;

  beforeEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    
    storagePath = path.resolve("./exampleFolder");
    database = new IndexDatabase(storagePath);
    
    // Scan existing files to populate the database
    for (const filePath of walkFiles(storagePath)) {
      const relativePath = toRelative(storagePath, filePath);
      await database.addFile({
        relativePath,
        mimeType: mimeTypeForFilename(relativePath),
      });
    }

    const fileScanner = new FileScanner(storagePath, database);
    server = createServer(database, storagePath, fileScanner);

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  describe("CORS headers", () => {
    it("should set Access-Control-Allow-Origin to *", async () => {
      const response = await makeRequest(TEST_PORT, "/api/health");
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    });

    it("should set Access-Control-Allow-Methods", async () => {
      const response = await makeRequest(TEST_PORT, "/api/health");
      expect(response.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    });

    it("should set Access-Control-Allow-Headers", async () => {
      const response = await makeRequest(TEST_PORT, "/api/health");
      expect(response.headers["access-control-allow-headers"]).toBe("Content-Type");
    });

    it("should respond to OPTIONS preflight requests with 200", async () => {
      const response = await makeRequest(TEST_PORT, "/api/health", "OPTIONS");
      expect(response.status).toBe(200);
    });
  });

  describe("GET /health", () => {
    it("should return 200 with status ok", async () => {
      const response = await makeRequest(TEST_PORT, "/api/health");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.status).toBe("ok");
    });

    it("should return JSON with status and message", async () => {
      const response = await makeRequest(TEST_PORT, "/api/health");
      const data = JSON.parse(response.body);
      expect(data).toEqual({ status: "ok", message: "Server is running" });
    });
  });

  describe("GET /folders", () => {
    it("should return folders for root path", async () => {
      const response = await makeRequest(TEST_PORT, "/api/folders");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      // exampleFolder has one subfolder at root: "subFolder"
      expect(data.folders).toEqual(["subFolder"]);
    });

    it("should return folders for specific subpath", async () => {
      const response = await makeRequest(TEST_PORT, "/api/folders/subFolder");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      // subFolder has one subfolder: "grandchildFolder"
      expect(data.folders).toEqual(["grandchildFolder"]);
    });

    it("should decode URL-encoded paths", async () => {
      // Create a folder with space for this test
      const response = await makeRequest(TEST_PORT, "/api/folders/sub%20Folder");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.folders).toEqual([]);
    });

    it("should remove trailing slash", async () => {
      const response = await makeRequest(TEST_PORT, "/api/folders/subFolder/");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.folders).toEqual(["grandchildFolder"]);
    });
  });

  describe("GET /files/ - query mode (with trailing slash or query params)", () => {
    it("should return files at root path", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.items).toHaveLength(1);
      expect(data.items[0].relativePath).toBe("sewing-threads.heic");
      expect(data.total).toBe(1);
    });

    it("should return files in subfolder with trailing slash", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/subFolder/");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      // subFolder has 2 files: soundboard.heic and grandchildFolder/.gitkeep
      expect(data.items.length).toBeGreaterThanOrEqual(1);
      const soundboardFile = data.items.find((item: { relativePath: string }) => item.relativePath === "subFolder/soundboard.heic");
      expect(soundboardFile).toBeDefined();
    });

    it("should decode URL-encoded paths", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/sub%20Folder/");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.items).toHaveLength(0);
    });

    it("should handle explicit filter parameter", async () => {
      const filter = JSON.stringify({ relativePath: { regex: ".*\\.heic$" } });
      const response = await makeRequest(TEST_PORT, `/api/files/?filter=${encodeURIComponent(filter)}`);
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      // Should match both .heic files
      expect(data.total).toBe(2);
    });

    it("should parse metadata as JSON array", async () => {
      const metadata = JSON.stringify(["mimeType"]);
      const response = await makeRequest(TEST_PORT, `/api/files/?metadata=${encodeURIComponent(metadata)}`);
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.items[0]).toHaveProperty("mimeType");
    });

    it("should parse metadata as comma-separated string", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/?metadata=mimeType,relativePath");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.items[0]).toHaveProperty("mimeType");
      expect(data.items[0]).toHaveProperty("relativePath");
    });

    it("should parse pageSize parameter", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/?pageSize=1");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.pageSize).toBe(1);
      expect(data.items).toHaveLength(1);
    });

    it("should parse page parameter", async () => {
      // Get all files first to see total
      const allResponse = await makeRequest(TEST_PORT, "/api/files/");
      const allData = JSON.parse(allResponse.body);
      const totalFiles = allData.total;
      
      const response = await makeRequest(TEST_PORT, "/api/files/?page=2&pageSize=1");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.page).toBe(2);
      expect(data.pageSize).toBe(1);
      // Page 2 with pageSize 1 should have 1 item if there are at least 2 files total
      if (totalFiles >= 2) {
        expect(data.items).toHaveLength(1);
      }
    });

    it("should return count only when count=true", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/?count=true");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data).toHaveProperty("count");
      expect(typeof data.count).toBe("number");
      expect(data).not.toHaveProperty("items");
      expect(data).not.toHaveProperty("page");
      expect(data.count).toBe(1); // Only 1 file at root
    });

    it("should return count for subfolder when count=true", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/subFolder/?count=true");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data).toHaveProperty("count");
      expect(data.count).toBeGreaterThanOrEqual(1);
    });

    it("should return count with custom filter when count=true", async () => {
      const filter = JSON.stringify({ relativePath: { regex: ".*\\.heic$" } });
      const response = await makeRequest(TEST_PORT, `/api/files/?filter=${encodeURIComponent(filter)}&count=true`);
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data).toHaveProperty("count");
      expect(data.count).toBe(2); // Should match 2 .heic files
    });

    it("should match files only in specified folder when includeSubfolders=false", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/subFolder/");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      // Should only match files directly in subFolder, not in nested folders
      const paths = data.items.map((item: { relativePath: string }) => item.relativePath);
      expect(paths.every((p: string) => p.split("/").length === 2)).toBe(true);
    });

    it("should match files in folder and all subfolders when includeSubfolders=true", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/subFolder/?includeSubfolders=true");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      // Should match files in subFolder and any nested folders
      const paths = data.items.map((item: { relativePath: string }) => item.relativePath);
      expect(paths.some((p: string) => p.split("/").length === 2)).toBe(true); // Has files directly in subFolder
      // If there are nested folders with files, they should be included
      expect(paths.every((p: string) => p.startsWith("subFolder/"))).toBe(true);
    });

    it("should return correct count with includeSubfolders=true", async () => {
      const withoutSubfolders = await makeRequest(TEST_PORT, "/api/files/subFolder/?count=true");
      const withSubfolders = await makeRequest(TEST_PORT, "/api/files/subFolder/?count=true&includeSubfolders=true");
      expect(withoutSubfolders.status).toBe(200);
      expect(withSubfolders.status).toBe(200);
      const dataWithout = JSON.parse(withoutSubfolders.body);
      const dataWith = JSON.parse(withSubfolders.body);
      // Count with subfolders should be >= count without subfolders
      expect(dataWith.count).toBeGreaterThanOrEqual(dataWithout.count);
    });
  });

  describe("GET /files/{path} - individual file serving", () => {
    it("should serve existing file (no trailing slash)", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/sewing-threads.heic");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("image/");
      expect(response.body.length).toBeGreaterThan(0);
    });

    it("should return 404 for non-existent file", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/nonexistent.jpg");
      expect(response.status).toBe(404);
      const data = JSON.parse(response.body);
      expect(data.error).toBe("File not found");
    });

    it("should return 403 for path traversal attempts", async () => {
      // Try to access a file outside the storage directory using ../ in the filename
      const response = await makeRequest(TEST_PORT, "/api/files/..%2F..%2F..%2Fetc%2Fpasswd");
      expect(response.status).toBe(403);
      const data = JSON.parse(response.body);
      expect(data.error).toBe("Access denied");
    });

    it("should serve file from subfolder", async () => {
      const response = await makeRequest(TEST_PORT, "/api/files/subFolder/soundboard.heic");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("image/");
    });
  });

  describe("GET /status", () => {
    it("should return 200 with status info", async () => {
      const response = await makeRequest(TEST_PORT, "/api/status");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data).toHaveProperty("databaseSize");
      expect(data).toHaveProperty("queues");
      expect(data).toHaveProperty("scannedFilesCount");
    });
  });

  describe("404 handler", () => {
    it("should return 404 for unknown routes", async () => {
      const response = await makeRequest(TEST_PORT, "/unknown");
      expect(response.status).toBe(404);
      const data = JSON.parse(response.body);
      expect(data).toEqual({ error: "Not found" });
    });
  });
});
