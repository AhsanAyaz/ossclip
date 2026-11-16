#!/usr/bin/env tsx
/**
 * `pnpm stills [Component]` — renders the scene fixtures in
 * packages/scenes/test/stills.fixtures.ts to PNGs in
 * packages/scenes/test/__stills__/, in the explainer look (plan Task 3).
 *
 * The stills are how the pattern scenes get LOOKED at before they ship:
 * every component task renders a sparse and a dense fixture and someone
 * opens the files. They are not compared to anything (plan decision 6).
 *
 * ONE bundle and one public dir for the whole run: bundling costs tens of
 * seconds and every still renders from the same entry. The bundled fonts are
 * staged into that public dir first (`stageBundledFonts`), the same staging
 * produce does, or `<BundledFonts>` would 404 its way to the fallback stack
 * and every still would show Arial while claiming to show the look.
 *
 * The browser is the render path's own: `browserExecutable` from the ossclip
 * config (`OSSCLIP_BROWSER` or config.json), else Remotion's downloaded
 * headless shell — what `ossclip produce` and the cover render use.
 *
 * Run: pnpm stills            (every fixture)
 *      pnpm stills StatCard   (that component's fixtures only)
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ThemeSchema, loadConfig, lookTheme, stageBundledFonts } from "../packages/core/src/index";
import {
  bundleRenderEntry,
  renderSceneStill,
  selectStillFixtures,
  stillJobs,
} from "../packages/renderer/src/index";
import { STILL_FIXTURES } from "../packages/scenes/test/stills.fixtures";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "packages", "scenes", "test", "__stills__");
/** The explainer look's own `bg`: the slate the playbook's shots sit on. */
const THEME = ThemeSchema.parse({ ...lookTheme("explainer") });
const BACKGROUND = THEME.bg;

async function main(): Promise<void> {
  const fixtures = selectStillFixtures(STILL_FIXTURES, process.argv[2]);
  // Before the bundle, so a fixture over a copy cap fails in a second.
  const jobs = stillJobs(fixtures, THEME, BACKGROUND);
  const publicDir = mkdtempSync(join(tmpdir(), "ossclip-stills-"));
  try {
    stageBundledFonts(THEME, [publicDir]);
    mkdirSync(OUT_DIR, { recursive: true });
    const { browserExecutable } = loadConfig();

    let t0 = Date.now();
    console.log("▸ Bundling…");
    const serveUrl = await bundleRenderEntry(publicDir);
    console.log(`  bundled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    for (const job of jobs) {
      t0 = Date.now();
      const outPath = join(OUT_DIR, job.fileName);
      await renderSceneStill(job.props, {
        publicDir,
        serveUrl,
        outPath,
        atSec: job.atSec,
        browserExecutable,
      });
      console.log(`✓ ${job.fileName} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
    console.log(`${jobs.length} still(s) → ${OUT_DIR}`);
  } finally {
    rmSync(publicDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
