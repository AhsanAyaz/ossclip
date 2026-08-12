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
    // 15s, not vitest's 5s default. The apps/cli suites that build a real
    // `buildProgram()` (bare-path, replay-argv, llm-help,
    // produce-argv-roundtrip, telemetry) take 2–4.3s EACH when the machine is
    // idle — comfortably under 5s alone, and over it whenever the box is
    // loaded. That produced intermittent "Test timed out in 5000ms" failures
    // in a rotating set of files, reproducible on a clean tree, which cost
    // two false investigations in one session (2026-08-12) before anyone
    // recognised the shape. The cost of a generous ceiling is a slow test
    // hanging longer before it fails; the cost of a tight one is a green
    // suite that lies at random.
    testTimeout: 15_000,
  },
});
