import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { PhotrixHttpServer } from "./httpServer.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";

async function main(): Promise<void> {
  if (!process.env.PHOTRIX_MEDIA_ROOT) {
    throw new Error("No PHOTRIX_MEDIA_ROOT specified in environmental variables");
  }
  
  if (!process.env.PHOTRIX_INDEX_DB){
    throw new Error("No PHOTRIX_INDEX_DB specified in environmental variables");
  }

  const envToBoolean = (envKey:string):boolean|null=>{
    const envString = process.env[envKey];
    if (!envString){
      return null
    }
    const envStringLower = envString.toLocaleLowerCase();
    if (['1','true','yes','on'].includes(envStringLower)){
      return true;
    }
    if (['0','false','no','off'].includes(envStringLower)){
      return false;
    }
    throw new Error(`Env key ${envKey} contains value that can't be cast to boolean: ${envString}`)
  }

  const watch = envToBoolean('PHOTRIX_WATCH') ?? true;
  const awaitWriteFinish = envToBoolean('PHOTRIX_AWAIT_WRITE_FINISH') ?? true;

  const corsOrigin = process.env.PHOTRIX_CORS_ORIGIN;
  const corsAllowCredentials = envToBoolean('PHOTRIX_CORS_CREDENTIALS') ?? false;

  const host = process.env.PHOTRIX_HTTP_HOST ?? DEFAULT_HOST;

  const port = process.env.PHOTRIX_HTTP_PORT ? +process.env.PHOTRIX_HTTP_PORT : DEFAULT_PORT;

  if (isNaN(port)){
    throw new Error(`Invalid port: ${process.env.PHOTRIX_HTTP_PORT}`)
  }

  const serverConfig: ConstructorParameters<typeof PhotrixHttpServer>[0] = {
    mediaRoot: path.resolve(process.env.PHOTRIX_MEDIA_ROOT),
    indexDatabaseFile: path.resolve(process.env.PHOTRIX_INDEX_DB),
    indexer: {
      watch,
      awaitWriteFinish,
    },
    cors: {
      origin: corsOrigin,
      allowCredentials: corsAllowCredentials,
    },
  };

  const server = new PhotrixHttpServer(serverConfig);

  const { port: listeningPort, host: listeningHost } = await server.start(port, host);

  const displayHost = listeningHost === "0.0.0.0" ? "localhost" : listeningHost;
  console.log(`[photrix] Serving media from ${serverConfig.mediaRoot}`);
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

main().catch((error) => {
  console.error("[photrix] Failed to start HTTP server", error);
  process.exit(1);
});
