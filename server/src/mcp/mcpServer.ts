import { createHash } from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildPhotrixMcpServer } from "./buildServer.ts";
import { createPhotrixApi, photrixBaseUrl } from "./photrixApi.ts";
import { readJsonBody } from "../common/readBody.ts";
import { clientIpFromRequest } from "../common/clientIp.ts";

// Streamable-HTTP MCP server that lets remote AI agents query the Photrix photo
// library. It proxies every request to the Photrix REST API, so it can live on
// a different host and requires no access to the SQLite index. It can run
// standalone (`npm run mcp`, see main.ts) or in-process alongside the main
// Photrix server (see ../main.ts's call to startMcpServer), which is how it
// starts by default so agents don't depend on a second process being started
// and kept alive separately.
//
// Stateless mode: a fresh McpServer + transport is built per POST and torn down
// when the response closes. There are no server->client notifications here (only
// request/response tool calls), so no session state is needed and horizontal
// scaling is trivial.

// `Number(x) || 3100` would treat an explicit MCP_PORT=0 (used by tests to ask
// the OS for a free ephemeral port) as falsy and silently fall back to 3100, so
// check for a genuinely unset/invalid value instead.
const parsedPort = Number(process.env.MCP_PORT);
const PORT =
  process.env.MCP_PORT !== undefined && Number.isFinite(parsedPort) ? parsedPort : 3100;
// There is deliberately no server-side credential. Every caller sends its own
// personal MCP key, which is forwarded to Photrix, so this server can be put
// on a public URL without becoming a way into the library. These two variables
// once configured a shared fallback key and a shared gate; say so if they are
// still set, since they no longer do anything.
const RETIRED_ENV = ["PHOTRIX_TOKEN", "MCP_AUTH_TOKEN"] as const;

// The caller's key is checked with Photrix before anything is served, so a
// wrong or revoked key fails the client's connect with a 401 instead of
// connecting fine and failing on every tool call. A key that passed is
// remembered briefly so each request doesn't pay a round trip; a revocation
// still takes effect at once on the tool calls, which Photrix itself checks.
const VERIFIED_KEY_TTL_MS = 5 * 60_000;
const verifiedKeys = new Map<string, number>();
const keyId = (bearer: string) => createHash("sha256").update(bearer).digest("hex");


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

const unauthorized = (res: http.ServerResponse, message: string) =>
  jsonRpcError(res, 401, message, { "www-authenticate": 'Bearer realm="photrix"' });

const handleRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
  try {
    const pathname = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. POST JSON-RPC to /mcp." }));
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode has no SSE stream to open, so only POST is meaningful.
      jsonRpcError(res, 405, "Method not allowed. Use POST for stateless MCP.", {
        allow: "POST",
      });
      return;
    }

    const authHeader = req.headers["authorization"];
    const callerBearer =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : "";
    if (!callerBearer) {
      unauthorized(res, "Unauthorized: send your MCP key as `Authorization: Bearer <key>`.");
      return;
    }
    // Photrix rate-limits per key and logs the client, so it is told who is
    // really calling rather than seeing every agent as this process.
    const api = createPhotrixApi(callerBearer, clientIpFromRequest(req));

    const id = keyId(callerBearer);
    const verifiedAt = verifiedKeys.get(id);
    if (verifiedAt === undefined || Date.now() - verifiedAt > VERIFIED_KEY_TTL_MS) {
      // Photrix being unreachable is not the caller's fault: let the request
      // through and the tools report it, rather than failing the connect.
      const verdict = await api.checkAuth().catch(() => "unreachable" as const);
      if (verdict === "unauthorized") {
        verifiedKeys.delete(id);
        unauthorized(res, "Unauthorized: Photrix rejected this MCP key.");
        return;
      }
      if (typeof verdict === "object") {
        jsonRpcError(res, 429, "Too many requests for this MCP key.", {
          "retry-after": String(verdict.retryAfterSeconds),
        });
        return;
      }
      if (verdict === "ok") verifiedKeys.set(id, Date.now());
    }

    const body = await readJsonBody(req, { ifEmpty: null }).then((b) => b ?? undefined);
    const mcp = buildPhotrixMcpServer(api);
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
    // The detail can name internal addresses, and this endpoint may be public.
    console.error("MCP request failed:", err);
    if (!res.headersSent) jsonRpcError(res, 500, "Internal error");
  }
};

/**
 * Starts the Photrix MCP (Streamable HTTP) server and resolves once it's
 * listening, or rejects if the port can't be bound (e.g. already in use).
 * Used by both the standalone `npm run mcp` entrypoint (main.ts) and by the
 * main Photrix server (see server/src/main.ts), which starts this in-process
 * by default.
 */
export const startMcpServer = (): Promise<http.Server> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleRequest(req, res);
    });
    server.once("error", reject);
    server.listen(PORT, () => {
      server.removeListener("error", reject);
      for (const name of RETIRED_ENV) {
        if (process.env[name]) {
          console.warn(`${name} is set but ignored: every MCP caller must send its own key`);
        }
      }
      console.log(
        `Photrix MCP server listening on http://localhost:${PORT}/mcp (proxying ${photrixBaseUrl})`,
      );
      resolve(server);
    });
  });
