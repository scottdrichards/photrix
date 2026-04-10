import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";

type ResponseData = {
  status: number;
  body: string;
};

const makeRequest = (
  port: number,
  requestPath: string,
  method = "GET",
  headers: Record<string, string> = {},
): Promise<ResponseData> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port,
        path: requestPath,
        method,
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, body });
        });
      },
    );

    req.on("error", reject);
    req.end();
  });

describe("createServer auth gate", () => {
  let server: http.Server;
  let storagePath: string;
  let authPath: string;
  let indexPath: string;
  const testPort = 3115;

  beforeEach(async () => {
    storagePath = mkdtempSync(path.join(os.tmpdir(), "photrix-auth-storage-"));
    authPath = mkdtempSync(path.join(os.tmpdir(), "photrix-auth-db-"));
    indexPath = mkdtempSync(path.join(os.tmpdir(), "photrix-index-db-"));

    process.env.PORT = String(testPort);
    process.env.AUTH_REQUIRED = "true";
    process.env.AUTH_DB_LOCATION = authPath;
    process.env.INDEX_DB_LOCATION = indexPath;
    process.env.AUTH_BOOTSTRAP_TOKEN = "test-bootstrap-token";
    process.env.AUTH_ORIGIN = "http://localhost:5173";
    process.env.AUTH_ALLOWED_ORIGINS = "http://localhost:5173,http://localhost:3000";
    process.env.AUTH_ALLOWED_HOSTS = "localhost,192.168.1.97";
    process.env.AUTH_TRUSTED_PROXY_IPS = "192.168.1.97";
    process.env.AUTH_REQUIRE_HTTPS = "false";

    writeFileSync(path.join(storagePath, "root.jpg"), "root");

    const db = await IndexDatabase.create(storagePath);
    await db.addPaths(["root.jpg"]);

    const { createServer } = await import("./createServer.ts");
    server = await createServer(db, storagePath);

    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    rmSync(storagePath, { recursive: true, force: true });

    delete process.env.AUTH_REQUIRED;
    delete process.env.AUTH_DB_LOCATION;
    delete process.env.INDEX_DB_LOCATION;
    delete process.env.AUTH_BOOTSTRAP_TOKEN;
    delete process.env.AUTH_ORIGIN;
    delete process.env.AUTH_ALLOWED_ORIGINS;
    delete process.env.AUTH_ALLOWED_HOSTS;
    delete process.env.AUTH_TRUSTED_PROXY_IPS;
    delete process.env.AUTH_REQUIRE_HTTPS;
  });

  it("blocks unauthenticated access to protected APIs", async () => {
    const response = await makeRequest(testPort, "/api/files/");

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "Authentication required" });
  });

  it("exposes auth session endpoint for login bootstrap", async () => {
    const response = await makeRequest(testPort, "/api/auth/session");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      authEnabled: true,
      setupRequired: true,
      authenticated: false,
      username: null,
    });
  });

  it("rejects disallowed host headers", async () => {
    const response = await makeRequest(testPort, "/api/auth/session", "GET", {
      host: "evil.example.com",
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Host not allowed" });
  });

  it("rejects forwarded headers from untrusted clients", async () => {
    const response = await makeRequest(testPort, "/api/auth/session", "GET", {
      "x-forwarded-for": "203.0.113.8",
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error:
        "Forwarded headers are only accepted from trusted proxies. Add your reverse proxy IP to AUTH_TRUSTED_PROXY_IPS.",
    });
  });
});
