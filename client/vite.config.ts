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
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
