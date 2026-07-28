import { defineConfig } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Isolation, done automatically rather than left to whoever runs this: copy
 * the committed fixture workdir into a fresh OS temp directory before the
 * webServer below even starts, and point the edit server at that copy — so
 * there is no env var for a caller to remember to export, and no way for a
 * previous run's `overrides.json` to leak into this one.
 *
 * This has to happen at config-load time (module top level), not in a real
 * Playwright `globalSetup` file: the `command` string below is built by
 * interpolating a JS value into a template literal right now, when this
 * module executes, and Playwright starts webServer processes as part of
 * loading its config's plugins — BEFORE it runs the user's `globalSetup`.
 * A `globalSetup` would be too late to affect the path the server is told
 * to serve (and, worse, it would still be empty at the moment the edit
 * server tries to read `render-props.json` out of it and exits early).
 *
 * The catch: Playwright loads this config module more than once per run —
 * once in the process that starts the webServer, and again in each worker
 * process that runs a spec file — and `mkdtemp`'s random suffix would give
 * each of those loads a DIFFERENT directory, leaving the spec reading
 * `overrides.json` from a path the running server never touches. The
 * directory name is made deterministic instead (scoped to the root
 * process's pid, which is the same across a main-process load and a
 * worker's load of the same invocation, and different across separate
 * `playwright test` invocations), and population is guarded by a marker
 * file so only the first of those redundant loads actually copies.
 */
const FIXTURE_DIR = fileURLToPath(new URL("./e2e/fixtures/workdir", import.meta.url));
// In a worker process (TEST_WORKER_INDEX is set), the runner that started
// the webServer is this process's parent; in the main process, it's this
// process itself.
const rootPid = process.env.TEST_WORKER_INDEX !== undefined ? process.ppid : process.pid;
const WORKDIR = join(tmpdir(), `ossclip-e2e-${rootPid}`);
const readyMarker = join(WORKDIR, ".fixture-ready");
if (!existsSync(readyMarker)) {
  rmSync(WORKDIR, { recursive: true, force: true });
  mkdirSync(WORKDIR, { recursive: true });
  cpSync(FIXTURE_DIR, WORKDIR, { recursive: true });
  writeFileSync(readyMarker, "");
}
// The spec itself reads `overrides.json` back out of this same directory —
// exposing it via the env var it already looked for keeps that code
// unchanged and keeps the two ends (webServer + spec) unambiguously in sync.
process.env.OSSCLIP_E2E_WORKDIR = WORKDIR;

export default defineConfig({
  testDir: "./e2e",
  // The landscape spec REWRITES the shared workdir's render-props.json to a
  // 16:9 frame for its own tests (the server reads the file per request, so
  // no second server is needed) — but that swap must never race the portrait
  // specs running in a parallel worker. A dependent project serializes it:
  // `landscape` starts only after `main` has fully finished.
  projects: [
    { name: "main", testIgnore: /(landscape|renderflow)\.spec\.ts/ },
    { name: "landscape", testMatch: /landscape\.spec\.ts/, dependencies: ["main"] },
    // Writes a command.json into the shared workdir (the main project's
    // R11 test asserts its ABSENCE), so it runs last, serialized.
    { name: "renderflow", testMatch: /renderflow\.spec\.ts/, dependencies: ["landscape"] },
  ],
  use: {
    baseURL: "http://127.0.0.1:5173",
    // Tall enough that the stage (≈676px) AND the timeline below it are both
    // inside the viewport: several specs drive raw `page.mouse` events at
    // measured coordinates, and raw mouse — unlike locator.click() — never
    // auto-scrolls its target into view. At the default 720p the timeline
    // sits below the fold and every aimed click lands on <html>.
    viewport: { width: 1280, height: 1000 },
    // Containers/CI images often pre-install one Chromium rather than the
    // exact revision this @playwright/test version pins — point at it instead
    // of downloading. Unset locally, only the autoplay arg applies.
    launchOptions: {
      ...(process.env.OSSCLIP_E2E_CHROMIUM
        ? { executablePath: process.env.OSSCLIP_E2E_CHROMIUM }
        : {}),
      // The Task-5 SPACE test starts playback with no prior pointer input;
      // headless Chromium's autoplay policy would otherwise reject the
      // keyboard-initiated play() and the test would fail for a reason that
      // has nothing to do with the shortcut.
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  webServer: [
    {
      // `pnpm ossclip` is a root-level script (apps/editor has no such
      // script of its own), so this must run from the monorepo root rather
      // than the default cwd (this config file's directory).
      command: `pnpm ossclip edit ${WORKDIR} --no-open`,
      cwd: "../..",
      port: 5174,
      // Deliberately NOT reused: this server's whole identity is the fresh
      // per-run WORKDIR above. Reusing a server left running from a prior
      // invocation would silently point every request at that OLD run's
      // (possibly already-mutated) directory instead of this one's.
      reuseExistingServer: false,
    },
    { command: "pnpm --filter @ossclip/editor dev", port: 5173, reuseExistingServer: true },
  ],
});
