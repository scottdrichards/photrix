import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "build",
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    allowedHosts: [
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
