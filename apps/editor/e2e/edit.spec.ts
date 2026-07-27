import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Set by `playwright.config.ts`, which copies the committed fixture workdir
// into a fresh OS temp directory before either webServer starts and points
// both this env var and the edit server at that same copy — so this test
// can never pass on a leftover `overrides.json` from a previous run.
const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;

test("drag an element, save, and the patch lands on disk", async ({ page }) => {
  await page.goto("/");
  // Frame 0 can land a beat before the first cue actually starts (real
  // productions rarely open on an exact-zero timestamp) and the Player
  // never advances on its own without pressing play — seek to the first
  // scene explicitly so its `data-edit-id` leaves are guaranteed to exist.
  // This also leaves the whole SCENE selected (no element) — the natural
  // state a user is in right after picking a scene off the timeline — which
  // is deliberate: it's the exact situation the click-through-a-scene-box
  // fix below needs to prove out, with no `Escape` workaround in between.
  await page.locator('[data-testid^="timeline-block-"]').first().click();
  await page.waitForSelector("[data-edit-id]");

  const el = page.locator("[data-edit-id]").first();
  const box = (await el.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const dx = 40;
  const dy = 10;
  // One natural mousedown-drag-mouseup on the element, straight after the
  // scene-level selection above — no `Escape`, no extra click. Before the
  // Overlay fix, the scene's selection box covers this entire slot, so this
  // mousedown would have been read as "keep dragging the scene selection"
  // (which isn't draggable at all) instead of re-hit-testing and picking up
  // this specific element; the drag would have silently patched nothing.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy);
  await page.mouse.up();

  // THE Task-1 assertion: the element's on-screen rect moved by the dragged
  // amount (±5%), not merely "a patch was written". The previous version of
  // this test only checked the stored delta — which was correct — while the
  // RENDER multiplied it by the scene's fill scale, so every drag overshot
  // proportionally to distance and the suite stayed green. Storage and render
  // must both hold, and only the on-screen position proves the second half.
  await expect
    .poll(
      async () => {
        const after = (await el.boundingBox())!;
        // Within 5% of the drag distance on each axis (a floor of 1px keeps
        // the short axis from demanding sub-pixel layout).
        const ok = (moved: number, intended: number) =>
          Math.abs(moved - intended) <= Math.max(1, Math.abs(intended) * 0.05);
        const movedX = after.x - box.x;
        const movedY = after.y - box.y;
        return ok(movedX, dx) && ok(movedY, dy)
          ? "landed"
          : `moved ${movedX.toFixed(1)},${movedY.toFixed(1)} wanted ${dx},${dy}`;
      },
      { message: "element should land where it was dropped (±5%)" },
    )
    .toBe("landed");

  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);

  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  const scene = Object.values(doc.scenes)[0] as { elements: Record<string, { dx: number; dy: number }> };
  const patch = Object.values(scene.elements)[0];

  // Guard against the smoke test passing while the drag path is broken: a
  // stale `overrides.json` satisfies `expect.any(Number)` even when this
  // run's drag did nothing (the isolation above already rules out a stale
  // FILE, but not a stale-shaped ASSERTION). Check the recorded delta
  // actually corresponds to the mouse movement just performed — sign and
  // rough magnitude — rather than exact page-pixel equality: the Player
  // renders its composition at a fixed native resolution (from
  // `render-props.json`'s `settings.width/height`) and scales it down to
  // fit the on-screen stage, so a page-pixel mouse delta and the
  // composition-space delta this drag records need not be numerically
  // identical.
  const renderProps = JSON.parse(await readFile(join(WORKDIR, "render-props.json"), "utf8"));
  const stageBox = (await page.getByTestId("stage").boundingBox())!;
  const scaleX = renderProps.settings.width / stageBox.width;
  const scaleY = renderProps.settings.height / stageBox.height;
  const expectedDx = dx * scaleX;
  const expectedDy = dy * scaleY;

  expect(Math.sign(patch.dx)).toBe(Math.sign(expectedDx));
  expect(Math.sign(patch.dy)).toBe(Math.sign(expectedDy));
  // A tight band (±20%) around the composition-space delta, not an exact
  // formula: `stageBox` is measured with sub-pixel rounding, so an exact
  // equality would be flaky. But it must be tight enough to actually catch
  // the scaling regression this guards against — the Overlay dispatching
  // the RAW page-pixel delta instead of rescaling it by
  // `settings.width / stageRect.width` (Overlay.tsx). At this fixture's
  // ~2.8x page-to-composition ratio, an unscaled page-pixel delta would
  // land nowhere near this band, which a loose 0.2x–5x band could not
  // reliably tell apart from a correctly-scaled one.
  expect(Math.abs(patch.dx)).toBeGreaterThan(Math.abs(expectedDx) * 0.8);
  expect(Math.abs(patch.dx)).toBeLessThan(Math.abs(expectedDx) * 1.2);
  expect(Math.abs(patch.dy)).toBeGreaterThan(Math.abs(expectedDy) * 0.8);
  expect(Math.abs(patch.dy)).toBeLessThan(Math.abs(expectedDy) * 1.2);
});
