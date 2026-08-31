import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;
const OVERRIDES = join(WORKDIR, "overrides.json");

/**
 * The player must survive a saved cut whose rounded `src` misaligns with the
 * span floats (the 2026-08-31 ADK crash, driven end to end).
 *
 * "Delete this chunk" rounds `src` to 3 decimals at the write boundary while
 * spans keep full float precision; the honest set difference then left a
 * sub-millisecond keep sliver, EdlVideo rounded both of its ends to the SAME
 * frame, and Remotion's "trimAfter must be greater than trimBefore" throw
 * blanked the entire Player and stopped playback. The unit layers each held
 * green while the composed pipeline shipped the crash — this spec is the
 * flow-level net: load a doc carrying exactly such a cut, cross the seam,
 * and demand a silent console.
 *
 * Two adjacent cuts leave a 0.4ms keep sliver between them at source 15s —
 * the same shape as the real bug's 0.125ms one, and MID-timeline on purpose:
 * a first draft parked the sliver at the very end of the video, where its
 * `<Sequence>` starts past the composition's last frame and never mounts —
 * that spec stayed green with the fix reverted, catching nothing. Mid-video
 * the sliver premounts as the playhead approaches, which is where the real
 * crash fired. Seeded as a SAVED doc (not a gesture) because that is also
 * the regression that hurts most: a project that crashes every time it opens.
 *
 * Own serialized project (playwright.config.ts), after `recut`: this file
 * rewrites the shared overrides.json, and restores it after.
 */
const SLIVER_CUTS = [
  { startSec: 10, endSec: 14.9996, src: { startSec: 10, endSec: 14.9996 } },
  { startSec: 15, endSec: 20, src: { startSec: 15, endSec: 20 } },
];

let originalOverrides: string | null = null;

test.beforeAll(async () => {
  originalOverrides = await readFile(OVERRIDES, "utf8").catch(() => null);
  const doc = originalOverrides ? JSON.parse(originalOverrides) : {};
  doc.cuts = SLIVER_CUTS;
  await writeFile(OVERRIDES, JSON.stringify(doc));
});

test.afterAll(async () => {
  if (originalOverrides !== null) await writeFile(OVERRIDES, originalOverrides);
});

const settle = async (page: Page) => {
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  let prev = "";
  await expect
    .poll(async () => {
      const track = await page.getByTestId("playhead").locator("..").boundingBox();
      const key = JSON.stringify(track);
      const stable = key === prev;
      prev = key;
      return stable;
    })
    .toBe(true);
};

test("a saved rounded cut plays through its seam without blanking the player", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await page.goto("/");
  await settle(page);

  // Park the playhead just before the seam (the cuts shorten output to
  // ~21.9s; frac 0.4 lands ~8.8s), inside EdlVideo's 1s premount window of
  // where the sliver span USED to mount (output 10s) — the crash fired on
  // mount, before any frame of it was reached.
  const ruler = (await page.getByTestId("ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * 0.4, ruler.y + ruler.height / 2);
  await page.keyboard.press("Space");
  await expect
    .poll(async () => page.getByTestId("stage").getAttribute("data-playing"))
    .toBe("true");

  // Cross the seam. Playback reaching the natural END and stopping is fine;
  // a Remotion throw is not — the discriminator is the silent console, which
  // is exactly what the shipped bug was not (one TypeError, then a blank
  // stage). The favicon 404 is the one line this server always logs.
  await page.waitForTimeout(3000);
  const realErrors = consoleErrors.filter((t) => !t.includes("favicon"));
  expect(pageErrors).toEqual([]);
  expect(realErrors).toEqual([]);
});
