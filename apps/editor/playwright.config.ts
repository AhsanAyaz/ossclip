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

/**
 * A temp HOME for the edit server (overlay-library ruling R7), built the same
 * way and for the same reasons as WORKDIR above: deterministic per root pid,
 * populated once behind a marker. Everything the server reads or writes under
 * `~/.ossclip` — the overlay library the tray adds into, `recent-projects.json`,
 * config.json — lands here, so no spec can ever touch the real one, and the
 * suite stops depending on whatever the developer's own config says.
 *
 * The library is seeded with `e2e/fixtures/library/` (a "max plan" entry the
 * find-matches spec places). `assets/` holds a PNG OUTSIDE the library for
 * the tray's paste-a-path add to copy in: a path already inside the library
 * would prove nothing about the copy.
 */
const HOME_DIR = `${WORKDIR}-home`;
const homeMarker = join(HOME_DIR, ".fixture-ready");
if (!existsSync(homeMarker)) {
  rmSync(HOME_DIR, { recursive: true, force: true });
  mkdirSync(join(HOME_DIR, ".ossclip"), { recursive: true });
  cpSync(fileURLToPath(new URL("./e2e/fixtures/library", import.meta.url)), join(HOME_DIR, ".ossclip", "library"), {
    recursive: true,
  });
  mkdirSync(join(HOME_DIR, "assets"), { recursive: true });
  cpSync(fileURLToPath(new URL("./e2e/fixtures/clean-edit.png", import.meta.url)), join(HOME_DIR, "assets", "clean-edit.png"));
  writeFileSync(homeMarker, "");
}
process.env.OSSCLIP_E2E_HOME = HOME_DIR;

/**
 * Ports, overridable (ruling R15) with the defaults unchanged. The developer's
 * OWN `ossclip edit` lives on 5174, so a run beside it needs other ports —
 * `E2E_EDIT_PORT=5274 E2E_VITE_PORT=5273 pnpm e2e`. vite.config.ts reads the
 * same two variables (its proxy target and its own port), and the specs follow
 * through `baseURL`. An overridden port is never REUSED: a server already on a
 * port someone chose on purpose is not one this run started, and reusing it
 * would proxy every request into somebody else's project.
 */
const EDIT_PORT = Number(process.env.E2E_EDIT_PORT ?? 5174);
const VITE_PORT = Number(process.env.E2E_VITE_PORT ?? 5173);
const vitePortOverridden = process.env.E2E_VITE_PORT !== undefined || process.env.E2E_EDIT_PORT !== undefined;

export default defineConfig({
  testDir: "./e2e",
  // Retry ON CI ONLY. This suite drives real timing — a video element
  // mounting, a render child spawning — against a shared machine of unknown
  // load, and a one-in-forty timing miss reported as a red build teaches
  // contributors to ignore the build. A test that fails all three attempts
  // still fails; a retried one is reported as flaky, which is the honest
  // signal. Locally retries stay OFF, so a flake surfaces while you are the
  // one who can debug it.
  retries: process.env.CI ? 2 : 0,
  // A stray `test.only` would otherwise green-light a PR having run one test.
  forbidOnly: Boolean(process.env.CI),
  // The landscape spec REWRITES the shared workdir's render-props.json to a
  // 16:9 frame for its own tests (the server reads the file per request, so
  // no second server is needed) — but that swap must never race the portrait
  // specs running in a parallel worker. A dependent project serializes it:
  // `landscape` starts only after `main` has fully finished.
  projects: [
    { name: "main", testIgnore: /(landscape|renderflow|recut|sliver-cut|overlays|logo-finder)\.spec\.ts/ },
    { name: "landscape", testMatch: /landscape\.spec\.ts/, dependencies: ["main"] },
    // Writes a command.json into the shared workdir (the main project's
    // R11 test asserts its ABSENCE), so it runs last, serialized.
    { name: "renderflow", testMatch: /renderflow\.spec\.ts/, dependencies: ["landscape"] },
    // Rewrites the shared render-props.json's `spans` to a real cut (§137), so
    // source time and output time disagree — the identity-span fixture cannot
    // tell a source-keyed edit from an output-keyed one. Serialized behind
    // everything else for the same reason `landscape` is, and last because its
    // rewrite is the one that changes what other specs would MEASURE.
    { name: "recut", testMatch: /recut\.spec\.ts/, dependencies: ["renderflow"] },
    // Rewrites the shared overrides.json with a sliver-producing saved cut
    // (the 2026-08-31 ADK crash) and restores it after — serialized behind
    // everything for the same reason the other rewriters are.
    { name: "sliver-cut", testMatch: /sliver-cut\.spec\.ts/, dependencies: ["recut"] },
    // Gives the shared production.json a transcript (the overlay lane's word
    // space, which no other spec draws) and starts from no overrides.json,
    // restoring both after — a rewriter, so serialized last like the others.
    { name: "overlays", testMatch: /overlays\.spec\.ts/, dependencies: ["sliver-cut"] },
    // Gives production.json a transcript AND logo suggestions, writes
    // candidate files into the workdir and adds to the temp-HOME library —
    // a rewriter like `overlays`, so serialized behind it.
    { name: "logo-finder", testMatch: /logo-finder\.spec\.ts/, dependencies: ["overlays"] },
  ],
  use: {
    baseURL: `http://127.0.0.1:${VITE_PORT}`,
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
      //
      // tsx directly rather than `pnpm ossclip`: pnpm here is corepack's shim,
      // and under the temp HOME corepack finds no cached pnpm and goes to the
      // network for one. `--port` is always passed so it is PINNED — an
      // unpinned edit server steps around a busy port (edit-port.ts), which
      // would leave Playwright probing a port this run never bound.
      command: `node_modules/.bin/tsx apps/cli/src/index.ts edit ${WORKDIR} --no-open --port ${EDIT_PORT}`,
      cwd: "../..",
      port: EDIT_PORT,
      env: { HOME: HOME_DIR, USERPROFILE: HOME_DIR },
      // Deliberately NOT reused: this server's whole identity is the fresh
      // per-run WORKDIR above. Reusing a server left running from a prior
      // invocation would silently point every request at that OLD run's
      // (possibly already-mutated) directory instead of this one's.
      reuseExistingServer: false,
    },
    // `E2E_EDIT_PORT` reaches vite.config.ts's proxy through the inherited
    // environment; a run that overrides either port must not reuse a vite
    // that may be proxying into a DIFFERENT edit server.
    {
      command: "pnpm --filter @ossclip/editor dev",
      port: VITE_PORT,
      reuseExistingServer: !vitePortOverridden,
    },
  ],
});
