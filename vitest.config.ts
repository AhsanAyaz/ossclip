import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The editor's Playwright smoke test (apps/editor/e2e/edit.spec.ts) uses
    // its own runner (`playwright test`, see apps/editor/playwright.config.ts)
    // and imports `@playwright/test`, not vitest — left in vitest's default
    // include glob (`**/*.spec.ts`), it would be picked up here too and fail
    // outright since `test`/`expect` come from a different framework.
    // docs/local/** is gitignored scratch — the Remotion project that renders
    // the blog art lives there, is not a workspace package, and tests its frame
    // math with node's built-in runner (`node --test`, no vitest dependency).
    // Same problem as the e2e specs above: vitest collects the file and fails
    // with "No test suite found" because the registrations are node:test's.
    exclude: [
      ...configDefaults.exclude,
      "apps/editor/e2e/**",
      "docs/local/**",
    ],
    // The telemetry key is baked into the build (telemetry.ts §134), so the
    // suite's hermeticity — no network, no ~/.ossclip writes — is enforced
    // here instead: every test process runs with telemetry forced off. The
    // hermetic-suite tests in apps/cli/test/telemetry.test.ts pin this.
    env: { OSSCLIP_TELEMETRY: "0" },
  },
});
