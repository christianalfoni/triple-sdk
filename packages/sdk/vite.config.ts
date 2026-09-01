import { defineConfig } from "vite";

/**
 * The client is served by Vite on :5173.
 * The demo server runs separately on :3000 (see src/demo/server/main.ts).
 * Everything under /api is proxied there so the browser sees a single origin.
 */
export default defineConfig({
  root: "src/demo/client",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
