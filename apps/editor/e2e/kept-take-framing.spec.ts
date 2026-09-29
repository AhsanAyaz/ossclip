import { test, expect } from "@playwright/test";

/**
 * The zoom SLIDER works on a carved `take-kept-*` block (field report
 * 2026-09-18, ".ossclip/CAA ship karachi After").
 *
 * What happened: the stage preview (`videoPreview`) was applied to the cue
 * list BEFORE `carveKeptTakes` minted the kept block, so for that block the
 * patch matched no cue at all. The slider is a CONTROLLED input reading
 * `cue.video.scale` back out of those cues — with the preview dropped it
 * snapped back to 1× on every change event, the drag went nowhere, and its
 * pointerup committed that 1 OVER the user's framing (their overrides.json
 * ended up holding a literal `"video": {"scale": 1}` for the block). The
 * number fields wrote straight through `patchVideo` and kept working, which
 * is what made it read as "framing is broken on a retake I kept".
 *
 * The fixture's `production.json` carries one vetoable `retake` removal
 * inside the plain stretch at 22.5–25.5s; keeping it is what carves the
 * block. Nothing is saved here — a veto lives in the in-memory doc until
 * ⌘S, so this spec leaves the shared workdir alone.
 */
test("the zoom slider moves a kept retake's framing, not just the number field", async ({
  page,
}) => {
  await page.goto("/");

  // Keep the removal. `mousedown` on the chip itself, dispatched rather than
  // aimed: chips fan out by `stackIndex` and overlap each other's boxes, and
  // the handler is an onMouseDown (Timeline's restore-seam idiom).
  await page.locator('[data-testid^="timeline-removal-22.5-"]').first().dispatchEvent("mousedown");

  const block = page.locator('[data-testid="timeline-block-take-kept-22500"]');
  await expect(block).toHaveCount(1);
  await block.click({ position: { x: 20, y: 10 } });

  const scale = page.getByTestId("field-scale");
  await expect(scale).toHaveValue("1");

  // Drag the slider the way a user does: press, move, release. The commit is
  // on pointerup, so a synthetic `fill()` would prove nothing about the bug.
  const bar = (await page.getByTestId("zoom-slider").boundingBox())!;
  await page.mouse.move(bar.x + bar.width * 0.2, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width * 0.55, bar.y + bar.height / 2, { steps: 8 });
  await page.mouse.up();

  // The committed value, read off the number field that mirrors the same cue.
  await expect(scale).not.toHaveValue("1");
  await expect(page.getByTestId("sidebar")).not.toContainText("ZOOM 1.00×");
});
