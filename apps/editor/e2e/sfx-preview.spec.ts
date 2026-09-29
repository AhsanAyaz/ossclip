import { test, expect } from "@playwright/test";

/**
 * The preview survives a production with more sfx cues than the Player has
 * shared audio tags (field report 2026-09-18, ".ossclip/CAA ship karachi
 * After").
 *
 * What happened: the composition's `SfxTrack` mounted one UNBOUNDED
 * `<Sequence>` per cue, so every cue the playhead had passed kept its
 * `<Audio>` mounted, and `<Player>` mounts audio through a fixed pool of five
 * shared tags. The sixth cue threw "Tried to simultaneously mount 6
 * <Html5Audio /> tags", Remotion's error boundary replaced the stage with a
 * warning triangle, and nothing played again — not even takes BEFORE the cue
 * — until the page was reloaded. The render never saw it (no shared tags
 * there), which is why this is an editor test.
 *
 * The fixture carries SEVEN cues on purpose: five is the pool, so a fixture at
 * the limit would have gone green against the bug.
 *
 * Seeking, not playing: headless Chromium ships no H.264, so the fixture's
 * video never decodes here and the playhead would not advance on its own. The
 * crash was in MOUNTING the cues, and a seek past them mounts every one.
 */
test("a production with more sfx cues than shared audio tags still previews", async ({ page }) => {
  const crashes: string[] = [];
  page.on("pageerror", (e) => crashes.push(e.message));
  await page.goto("/");
  await page.waitForSelector("[data-testid='stage'] video");

  // Park the playhead past the LAST cue: the ruler is the editor's seek
  // surface (a block click only selects — field report 2026-08-07).
  const ruler = (await page.getByTestId("ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * 0.95, ruler.y + ruler.height / 2);

  // The stage still has the composition, not the error boundary's triangle.
  await expect(page.locator("[data-testid='stage'] video")).toHaveCount(1);
  await expect(page.getByTestId("stage")).not.toContainText("⚠️");
  expect(crashes.filter((m) => /Html5Audio/.test(m))).toEqual([]);
});
