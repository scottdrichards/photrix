import "dotenv/config";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildPhotrixMcpServer } from "./buildServer.ts";
import { createPhotrixApi, photrixBaseUrl } from "./photrixApi.ts";

// Streamable-HTTP MCP server that lets remote AI agents query the Photrix photo
// library. It runs as its own process (separate port) and proxies every request
// to the Photrix REST API, so it can live on a different host and requires no
// access to the SQLite index.
//
// Stateless mode: a fresh McpServer + transport is built per POST and torn down
// when the response closes. There are no server->client notifications here (only
// request/response tool calls), so no session state is needed and horizontal
// scaling is trivial.

const PORT = Number(process.env.MCP_PORT) || 3100;
// Optional shared-secret gate for the MCP endpoint itself (distinct from the
// PHOTRIX_TOKEN used to authenticate to Photrix). Set to require callers to send
// `Authorization: Bearer <MCP_AUTH_TOKEN>`.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

const readBody = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });

const jsonRpcError = (
  res: http.ServerResponse,
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
) => {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: status === 405 ? -32000 : -32603, message },
      id: null,
    }),
  );
};

const handleRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
  try {
    const pathname = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", photrix: photrixBaseUrl }));
      return;
    }

    if (pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. POST JSON-RPC to /mcp." }));
      return;
    }

    if (MCP_AUTH_TOKEN && req.headers["authorization"] !== `Bearer ${MCP_AUTH_TOKEN}`) {
      jsonRpcError(res, 401, "Unauthorized");
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode has no SSE stream to open, so only POST is meaningful.
      jsonRpcError(res, 405, "Method not allowed. Use POST for stateless MCP.", {
        allow: "POST",
      });
      return;
    }

    // Per-user mode (no MCP_AUTH_TOKEN gate): forward the caller's bearer to
    // Photrix so each agent authenticates with its own personal MCP key. In
    // legacy shared-secret mode the bearer *is* the gate token, so we fall back
    // to the env PHOTRIX_TOKEN for the Photrix connection instead.
    const authHeader = req.headers["authorization"];
    const callerBearer =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : undefined;
    const photrixToken = MCP_AUTH_TOKEN ? undefined : callerBearer;

    const body = await readBody(req);
    const mcp = buildPhotrixMcpServer(createPhotrixApi(photrixToken));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      jsonRpcError(res, 500, err instanceof Error ? err.message : String(err));
    }
  }
};

const server = http.createServer((req, res) => {
  void handleRequest(req, res);
});

server.listen(PORT, () => {
  console.log(
    `Photrix MCP server listening on http://localhost:${PORT}/mcp (proxying ${photrixBaseUrl})`,
  );
});
