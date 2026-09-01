import { defineConfig } from "vite";

/**
 * Dev: Vite serves the app on :5173 and proxies everything stateful to the
 * worker on :8787 (wrangler dev). Prod: `vite build` → dist/, served by the
 * SAME worker as static assets — one deployment.
 */
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/w": "http://localhost:8787",
    },
  },
});
