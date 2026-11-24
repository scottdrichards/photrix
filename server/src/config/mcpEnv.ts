// The standalone MCP entry point's counterpart of serverEnv.ts. It doesn't
// need MEDIA_ROOT: it reaches the library through the HTTP API.
import "dotenv/config";
import { initConfig } from "./config.ts";

initConfig("mcp");
