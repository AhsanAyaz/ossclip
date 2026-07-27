import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: [
    {
      // `pnpm ossclip` is a root-level script (apps/editor has no such
      // script of its own), so this must run from the monorepo root rather
      // than the default cwd (this config file's directory).
      command: `pnpm ossclip edit ${process.env.OSSCLIP_E2E_WORKDIR} --no-open`,
      cwd: "../..",
      port: 5174,
      reuseExistingServer: true,
    },
    { command: "pnpm --filter @ossclip/editor dev", port: 5173, reuseExistingServer: true },
  ],
});
