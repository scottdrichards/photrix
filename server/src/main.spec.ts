import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import http from "node:http";
import path from "node:path";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
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
  const TEST_PORT = 3001;

  beforeEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const absolutePath = path.resolve("./exampleFolder");
    database = new IndexDatabase(absolutePath);
    
    // Scan existing files to populate the database
    for (const filePath of walkFiles(absolutePath)) {
      const relativePath = toRelative(absolutePath, filePath);
      await database.addFile({
        relativePath,
        mimeType: mimeTypeForFilename(relativePath),
      });
    }

    server = createServer(database);

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
      // exampleFolder has 3 files: sewing-threads.heic, subFolder/soundboard.heic, and subFolder/grandchildFolder/.gitkeep
      expect(data.count).toBe(3);
    });

    it("should return actual file count from database", async () => {
      const response = await makeRequest(TEST_PORT, "/files/count");
      const data = JSON.parse(response.body);
      expect(data.count).toBe(database.getFileCount());
    });
  });

  describe("GET /folders", () => {
    it("should return folders for root path", async () => {
      const response = await makeRequest(TEST_PORT, "/folders");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      // exampleFolder has one subfolder at root: "subFolder"
      expect(data.folders).toEqual(["subFolder"]);
    });

    it("should return folders for specific subpath", async () => {
      const response = await makeRequest(TEST_PORT, "/folders/subFolder");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      // subFolder has one subfolder: "grandchildFolder"
      expect(data.folders).toEqual(["grandchildFolder"]);
    });

    it("should decode URL-encoded paths", async () => {
      // Create a folder with space for this test
      const response = await makeRequest(TEST_PORT, "/folders/sub%20Folder");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.folders).toEqual([]);
    });

    it("should remove trailing slash", async () => {
      const response = await makeRequest(TEST_PORT, "/folders/subFolder/");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.folders).toEqual(["grandchildFolder"]);
    });
  });

  describe("GET /files", () => {
    it("should return files at root path", async () => {
      const response = await makeRequest(TEST_PORT, "/files");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.items).toHaveLength(1);
      expect(data.items[0].relativePath).toBe("sewing-threads.heic");
      expect(data.total).toBe(1);
    });

    it("should return files in subfolder", async () => {
      const response = await makeRequest(TEST_PORT, "/files/subFolder");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      // subFolder has 2 files: soundboard.heic and grandchildFolder/.gitkeep
      expect(data.items.length).toBeGreaterThanOrEqual(1);
      const soundboardFile = data.items.find((item: { relativePath: string }) => item.relativePath === "subFolder/soundboard.heic");
      expect(soundboardFile).toBeDefined();
    });

    it("should decode URL-encoded paths", async () => {
      const response = await makeRequest(TEST_PORT, "/files/sub%20Folder");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.items).toHaveLength(0);
    });

    it("should handle explicit filter parameter", async () => {
      const filter = JSON.stringify({ relativePath: { regex: ".*\\.heic$" } });
      const response = await makeRequest(TEST_PORT, `/files?filter=${encodeURIComponent(filter)}`);
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      // Should match both .heic files
      expect(data.total).toBe(2);
    });

    it("should parse metadata as JSON array", async () => {
      const metadata = JSON.stringify(["mimeType"]);
      const response = await makeRequest(TEST_PORT, `/files?metadata=${encodeURIComponent(metadata)}`);
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.items[0]).toHaveProperty("mimeType");
    });

    it("should parse metadata as comma-separated string", async () => {
      const response = await makeRequest(TEST_PORT, "/files?metadata=mimeType,relativePath");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.items[0]).toHaveProperty("mimeType");
      expect(data.items[0]).toHaveProperty("relativePath");
    });

    it("should parse pageSize parameter", async () => {
      const response = await makeRequest(TEST_PORT, "/files?pageSize=1");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.pageSize).toBe(1);
      expect(data.items).toHaveLength(1);
    });

    it("should parse page parameter", async () => {
      // Get all files first to see total
      const allResponse = await makeRequest(TEST_PORT, "/files");
      const allData = JSON.parse(allResponse.body);
      const totalFiles = allData.total;
      
      const response = await makeRequest(TEST_PORT, "/files?page=2&pageSize=1");
      expect(response.status).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.page).toBe(2);
      expect(data.pageSize).toBe(1);
      // Page 2 with pageSize 1 should have 1 item if there are at least 2 files total
      if (totalFiles >= 2) {
        expect(data.items).toHaveLength(1);
      }
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
