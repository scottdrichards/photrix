import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(clientDir, "..");

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "build",
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    // The dev server listens on every interface with no auth, and Vite serves
    // anything under fs.allow through /@fs/. Keep that to what the client
    // actually needs; never the whole monorepo (the server dir holds the
    // index database and its cache).
    fs: {
      strict: true,
      allow: [
        clientDir,
        path.join(repoRoot, "shared"),
        path.join(repoRoot, "node_modules"),
        path.join(clientDir, "node_modules"),
      ],
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.env*",
        "**/.cache/**",
        "**/*.db",
        "**/*.db-*",
        "**/*.sqlite*",
        "**/*.pem",
        "**/*.key",
      ],
    },
    allowedHosts: [
      "dev.photos.scottdrichards.com",
      "localhost",
      "photrix.scottdrichards.com",
      "local.photrix.scottdrichards.com",
      "local.photrix.scottderichards.com",
    ],
    proxy: {
      "/api": {
        // Override for isolated e2e runs (points at the test API port); defaults
        // to the standard dev server otherwise.
        target: process.env.PHOTRIX_API_TARGET || "http://localhost:3000",
        changeOrigin: true,
      },
      "/share": {
        target: process.env.PHOTRIX_API_TARGET || "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
