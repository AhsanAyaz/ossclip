import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Explicit, not just "localhost": on some setups Node resolves the
    // bare hostname to the IPv6 loopback only, and Playwright's baseURL
    // (and its webServer readiness probe) hit 127.0.0.1 specifically.
    host: "127.0.0.1",
    // e2e port overrides (overlay-library ruling R15, playwright.config.ts):
    // a run beside the developer's own `ossclip edit` on 5174 points both
    // ends elsewhere. Defaults unchanged; an overridden port is strict, so a
    // busy one fails the run instead of vite drifting to a port nobody probes.
    port: Number(process.env.E2E_VITE_PORT ?? 5173),
    strictPort: process.env.E2E_VITE_PORT !== undefined,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.E2E_EDIT_PORT ?? 5174}`,
      "/media": `http://127.0.0.1:${process.env.E2E_EDIT_PORT ?? 5174}`,
    },
  },
  build: { outDir: "dist" },
});
