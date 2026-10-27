import { defineConfig, devices } from "@playwright/test";
import { API_PORT, API_URL, CLIENT_PORT, CLIENT_URL } from "./ports";

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
  // One at a time. Tests often share a machine with a running library's background
  // analysis, and parallel browsers on top of that starved each other past
  // the 30s test timeout (even in context teardown); serially every test
  // passes. The suite is small, so this costs little.
  workers: 1,
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
    // Indexes the example library before any page opens; see index.setup.ts.
    { name: "index", testMatch: /index\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["index"],
    },
  ],
  webServer: [
    {
      command: "npm run start",
      cwd: "../server",
      url: `${API_URL}/api/health`,
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
      env: { PHOTRIX_API_TARGET: API_URL },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
