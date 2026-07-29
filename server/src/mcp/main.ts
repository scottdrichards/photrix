import "dotenv/config";
import { startMcpServer } from "./mcpServer.ts";

// Standalone entrypoint for `npm run mcp` — useful when running the MCP
// server as its own process (e.g. on a different host from Photrix itself).
// By default the main Photrix server also starts this in-process on boot
// (see server/src/main.ts's call to startMcpServer, gated by MCP_AUTOSTART),
// so this script is only needed for that standalone/remote-host setup.
startMcpServer().catch((err) => {
  console.error("Failed to start Photrix MCP server:", err);
  process.exit(1);
});
