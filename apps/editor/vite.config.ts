import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Explicit, not just "localhost": on some setups Node resolves the
    // bare hostname to the IPv6 loopback only, and Playwright's baseURL
    // (and its webServer readiness probe) hit 127.0.0.1 specifically.
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:5174",
      "/media": "http://127.0.0.1:5174",
    },
  },
  build: { outDir: "dist" },
});
