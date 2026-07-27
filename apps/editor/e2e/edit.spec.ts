import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;

test("drag an element, save, and the patch lands on disk", async ({ page }) => {
  await page.goto("/");
  // Frame 0 can land a beat before the first cue actually starts (real
  // productions rarely open on an exact-zero timestamp) and the Player
  // never advances on its own without pressing play — seek to the first
  // scene explicitly so its `data-edit-id` leaves are guaranteed to exist.
  await page.locator('[data-testid^="timeline-block-"]').first().click();
  await page.waitForSelector("[data-edit-id]");
  // That click also leaves the whole SCENE selected (no element), and the
  // selection box it draws covers the full slot — a subsequent mousedown
  // inside it would be read as "keep dragging the current selection"
  // instead of a fresh hit-test, silently patching nothing on mouseup.
  // Escape clears the selection without losing the seek.
  await page.keyboard.press("Escape");
  const el = page.locator("[data-edit-id]").first();
  const box = (await el.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 10);
  await page.mouse.up();
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);

  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  const scene = Object.values(doc.scenes)[0] as any;
  expect(Object.values(scene.elements)[0]).toMatchObject({ dx: expect.any(Number) });
});
