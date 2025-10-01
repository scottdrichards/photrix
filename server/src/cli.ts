import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { PhotrixHttpServer } from "./httpServer.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";

async function main(): Promise<void> {
  const mediaRoot = await resolveMediaRoot();
  const indexDatabaseFile = resolveOptionalPath(process.env.PHOTRIX_INDEX_DB ?? process.env.PHOTRIX_INDEX_PATH);

  const watch = parseBooleanEnv(process.env.PHOTRIX_WATCH, true);
  const awaitWriteFinish = parseBooleanEnv(process.env.PHOTRIX_AWAIT_WRITE_FINISH, true);

  const corsOrigin = process.env.PHOTRIX_CORS_ORIGIN;
  const corsAllowCredentials = parseBooleanEnv(process.env.PHOTRIX_CORS_CREDENTIALS, false);

  const host = process.env.PHOTRIX_HTTP_HOST ?? DEFAULT_HOST;
  const port = parsePort(process.env.PHOTRIX_HTTP_PORT, DEFAULT_PORT);

  const server = new PhotrixHttpServer({
    mediaRoot,
    indexDatabaseFile,
    indexer: {
      watch,
      awaitWriteFinish,
    },
    cors: {
      origin: corsOrigin,
      allowCredentials: corsAllowCredentials,
    },
  });

  const { port: listeningPort, host: listeningHost } = await server.start(port, host);

  const displayHost = listeningHost === "0.0.0.0" ? "localhost" : listeningHost;
  console.log(`[photrix] Serving media from ${mediaRoot}`);
  console.log(`[photrix] Listening on http://${displayHost}:${listeningPort}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log("[photrix] Shutting down...");
    try {
      await server.stop();
    } catch (error) {
      console.error("[photrix] Error during shutdown", error);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    console.warn(`[photrix] Invalid port "${raw}"; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

async function resolveMediaRoot(): Promise<string> {
  const envRoot = process.env.PHOTRIX_MEDIA_ROOT;
  if (envRoot && envRoot.trim().length > 0) {
    const absolute = path.resolve(envRoot);
    await ensureDirectory(absolute);
    return absolute;
  }

  const candidates = [
    path.resolve(process.cwd(), "exampleFolder"),
    path.resolve(process.cwd(), "../uploads"),
  ];

  for (const candidate of candidates) {
    try {
      await ensureDirectory(candidate);
      return candidate;
    } catch {
      // continue to next candidate
    }
  }

  const fallback = path.resolve(process.cwd(), "media");
  await ensureDirectory(fallback);
  return fallback;
}

async function ensureDirectory(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

function resolveOptionalPath(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  return path.resolve(raw);
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

main().catch((error) => {
  console.error("[photrix] Failed to start HTTP server", error);
  process.exit(1);
});