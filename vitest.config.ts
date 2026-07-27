import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The editor's Playwright smoke test (apps/editor/e2e/edit.spec.ts) uses
    // its own runner (`playwright test`, see apps/editor/playwright.config.ts)
    // and imports `@playwright/test`, not vitest — left in vitest's default
    // include glob (`**/*.spec.ts`), it would be picked up here too and fail
    // outright since `test`/`expect` come from a different framework.
    exclude: [...configDefaults.exclude, "apps/editor/e2e/**"],
  },
});
