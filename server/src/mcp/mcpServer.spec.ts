import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type http from "node:http";

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

  it("rejects /mcp requests missing the bearer when MCP_AUTH_TOKEN is set", async () => {
    const { startMcpServer } = await loadServer({
      MCP_PORT: "0",
      MCP_AUTH_TOKEN: "secret-gate-token",
    });
    server = await startMcpServer();
    const port = listeningPort(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a second bind on the same port instead of crashing the process", async () => {
    const first = await loadServer({ MCP_PORT: "0" });
    server = await first.startMcpServer();
    const port = listeningPort(server);

    const second = await loadServer({ MCP_PORT: String(port) });
    await expect(second.startMcpServer()).rejects.toThrow();
  });
});
