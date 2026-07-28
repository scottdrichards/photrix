import { defineConfig, devices } from "@playwright/test";

// Dedicated ports for the isolated test instance so an agent can run the suite
// while a normal dev server (3000/5173) is also up, without either clobbering
// the other. The client's proxy target is pointed at the test API via env.
const API_PORT = 3399;
const CLIENT_PORT = 5273;
const CLIENT_URL = `http://localhost:${CLIENT_PORT}`;

// Env injected into the server process. `dotenv/config` in server/src/main.ts
// does NOT override already-set process.env, so these win over server/.env —
// keeping the test run off the real library, DB, cache, and auth.
const serverEnv = {
  PORT: String(API_PORT),
  MEDIA_ROOT: "./exampleFolder",
  CACHE_DIR: "./.cache-e2e",
  INDEX_DB_LOCATION: "./.cache-e2e",
  // Empty string is falsy in the auth check, so the server stays open (no login).
  AUTH_PASSWORD: "",
  PHOTRIX_ACCOUNTS: "",
  PHOTRIX_OTEL_ENABLED: "false",
  // Keep the piped server output readable; bump to "debug" when diagnosing a boot failure.
  LOG_LEVEL: "warn",
};

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./globalSetup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: CLIENT_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "npm run start",
      cwd: "../server",
      url: `http://localhost:${API_PORT}/api/health`,
      env: serverEnv,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `npm run dev -- --port ${CLIENT_PORT} --strictPort`,
      cwd: "../client",
      url: CLIENT_URL,
      env: { PHOTRIX_API_TARGET: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
