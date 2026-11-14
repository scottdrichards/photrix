import { afterEach, describe, expect, it, jest } from "@jest/globals";
import http from "node:http";

// Fresh module state per test — MCP_PORT/MCP_AUTH_TOKEN are read into
// module-level consts at import time (see mcpServer.ts), so each test that
// wants different env-driven behavior needs its own import.
const loadServer = async (env: Record<string, string | undefined> = {}) => {
  jest.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("./mcpServer.ts");
};

describe("startMcpServer", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    delete process.env.MCP_PORT;
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.PHOTRIX_TOKEN;
    delete process.env.PHOTRIX_BASE_URL;
    forwardedFor = [];
    if (photrix) {
      await new Promise<void>((resolve) => photrix?.close(() => resolve()));
      photrix = undefined;
    }
  });

  let photrix: http.Server | undefined;
  let forwardedFor: (string | undefined)[] = [];
  // A stand-in Photrix whose auth gate accepts exactly one key, and rate-limits
  // the key "busy-key".
  const startFakePhotrix = async (goodKey: string): Promise<string> => {
    photrix = http.createServer((req, res) => {
      forwardedFor.push(req.headers["x-forwarded-for"] as string | undefined);
      if (req.headers["authorization"] === "Bearer busy-key") {
        res.writeHead(429, { "retry-after": "7" });
        res.end();
        return;
      }
      const ok = req.headers["authorization"] === `Bearer ${goodKey}`;
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(ok ? "{}" : JSON.stringify({ error: "Unauthorized" }));
    });
    await new Promise<void>((resolve) => photrix?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${listeningPort(photrix)}`;
  };

  const listTools = (port: number, bearer?: string) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  const listeningPort = (srv: http.Server): number => {
    const address = srv.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected startMcpServer to bind a TCP port");
    }
    return address.port;
  };

  it("binds a port and answers a health check without any Photrix auth", async () => {
    // Port 0 -> the OS picks a free ephemeral port, so this never collides
    // with a real dev instance's MCP_PORT (default 3100).
    const { startMcpServer } = await loadServer({ MCP_PORT: "0" });
    server = await startMcpServer();

    const response = await fetch(`http://127.0.0.1:${listeningPort(server)}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("404s on unknown paths and only accepts POST on /mcp", async () => {
    const { startMcpServer } = await loadServer({ MCP_PORT: "0" });
    server = await startMcpServer();
    const port = listeningPort(server);

    const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(notFound.status).toBe(404);

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/mcp`);
    expect(wrongMethod.status).toBe(405);
  });

  it("refuses /mcp without a bearer, before contacting Photrix", async () => {
    const { startMcpServer } = await loadServer({ MCP_PORT: "0" });
    server = await startMcpServer();
    const response = await listTools(listeningPort(server));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("has no built-in key: the retired env credentials grant nothing", async () => {
    const photrixUrl = await startFakePhotrix("good-key");
    const { startMcpServer } = await loadServer({
      MCP_PORT: "0",
      PHOTRIX_BASE_URL: photrixUrl,
      MCP_AUTH_TOKEN: "old-gate",
      PHOTRIX_TOKEN: "good-key",
    });
    server = await startMcpServer();
    const port = listeningPort(server);

    // Neither the old gate value nor no key at all reaches Photrix's key.
    expect((await listTools(port, "old-gate")).status).toBe(401);
    expect((await listTools(port)).status).toBe(401);
  });

  it("passes Photrix's rate limit through as a 429 and tells Photrix who is calling", async () => {
    const photrixUrl = await startFakePhotrix("good-key");
    const { startMcpServer } = await loadServer({
      MCP_PORT: "0",
      PHOTRIX_BASE_URL: photrixUrl,
    });
    server = await startMcpServer();
    const port = listeningPort(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer busy-key",
        "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(forwardedFor).toEqual(["203.0.113.7"]);
  });

  it("rejects a second bind on the same port instead of crashing the process", async () => {
    const first = await loadServer({ MCP_PORT: "0" });
    server = await first.startMcpServer();
    const port = listeningPort(server);

    const second = await loadServer({ MCP_PORT: String(port) });
    await expect(second.startMcpServer()).rejects.toThrow();
  });

  it("401s at connect when Photrix rejects the caller's key, so the client sees an auth failure", async () => {
    const photrixUrl = await startFakePhotrix("good-key");
    const { startMcpServer } = await loadServer({
      MCP_PORT: "0",
      PHOTRIX_BASE_URL: photrixUrl,
    });
    server = await startMcpServer();
    const port = listeningPort(server);

    const rejected = await listTools(port, "wrong-key");
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("www-authenticate")).toMatch(/^Bearer/);

    const missing = await listTools(port);
    expect(missing.status).toBe(401);

    const accepted = await listTools(port, "good-key");
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toContain("get_person_photos");
  });

  it("still serves when Photrix is unreachable, leaving the error to the tools", async () => {
    const { startMcpServer } = await loadServer({
      MCP_PORT: "0",
      // Nothing listens on port 9 (discard) here; the auth probe fails to connect.
      PHOTRIX_BASE_URL: "http://127.0.0.1:9",
    });
    server = await startMcpServer();
    const response = await listTools(listeningPort(server), "any-key");
    expect(response.status).toBe(200);
  });
});
