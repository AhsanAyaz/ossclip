import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:5174",
      "/media": "http://127.0.0.1:5174",
    },
  },
  build: { outDir: "dist" },
});
