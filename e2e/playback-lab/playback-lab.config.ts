import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The playback lab: real hls.js in headless Chromium against a real, isolated
// Photrix server doing real on-the-fly encodes, under emulated network
// conditions. It is expensive (minutes, a GPU encoder, gigabytes of synthetic
// media), so it is NOT part of `bun run test:e2e`; run it on purpose with
// `bun run --filter photrix-e2e test:playback-lab`. See README.md here.

const here = dirname(fileURLToPath(import.meta.url));

const LAB_API_PORT = Number(process.env.PHOTRIX_LAB_PORT) || 3398;
const LAB_MEDIA_ROOT = resolve(
  process.env.PHOTRIX_LAB_MEDIA ?? resolve(here, ".media"),
);
const LAB_CACHE = resolve(here, ".cache");
const SERVER_LOG = resolve(here, "..", "test-results", "playback-lab", "server.log");

const serverEnv = {
  PORT: String(LAB_API_PORT),
  MEDIA_ROOT: LAB_MEDIA_ROOT,
  CACHE_DIR: LAB_CACHE,
  INDEX_DB_LOCATION: LAB_CACHE,
  AUTH_PASSWORD: "",
  PHOTRIX_ACCOUNTS: "",
  PHOTRIX_OTEL_ENABLED: "false",
  LOG_LEVEL: process.env.PHOTRIX_LAB_LOG_LEVEL ?? "info",
  MCP_PORT: "0",
  MCP_AUTOSTART: "false",
  // The lab measures video. Keep its ML workers off any CUDA card, so a lab
  // run can't take VRAM from another Photrix on the same machine, and skip the
  // audio models entirely.
  CUDA_VISIBLE_DEVICES: "",
  PHOTRIX_DISABLE_AUDIO: "1",
  // Let a run shorten the server's HLS idle windows (see hlsSession.ts).
  ...(process.env.PHOTRIX_HLS_VARIANT_IDLE_MS
    ? { PHOTRIX_HLS_VARIANT_IDLE_MS: process.env.PHOTRIX_HLS_VARIANT_IDLE_MS }
    : {}),
};

export default defineConfig({
  testDir: ".",
  testMatch: "*.lab.ts",
  globalSetup: "./globalSetup.ts",
  // Scenarios share one server and one encoder; running them side by side
  // would measure contention, not the scenario. The concurrency scenarios
  // open their own parallel players.
  workers: 1,
  fullyParallel: false,
  timeout: 10 * 60_000,
  reporter: [["list"]],
  outputDir: "../test-results/playback-lab/artifacts",
  use: {
    baseURL: `http://localhost:${LAB_API_PORT}`,
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `mkdir -p "${dirname(SERVER_LOG)}" && npm run start > "${SERVER_LOG}" 2>&1`,
    cwd: resolve(here, "..", "..", "server"),
    url: `http://localhost:${LAB_API_PORT}/api/health`,
    env: serverEnv,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
