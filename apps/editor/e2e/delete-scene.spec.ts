import { test, expect, type Page } from "@playwright/test";

/**
 * The Delete/Backspace confirmation (§139), driven end to end.
 *
 * Nothing here presses ⌘S. Every assertion is on browser state, so this file
 * writes nothing into the workdir it shares with the other specs running in
 * parallel workers — the deletes it makes exist only in this page's reducer,
 * and each test starts from a fresh `goto`.
 *
 * `scene-5` throughout: the last graphic cue in the fixture, and the only one
 * no other spec ever hides or cuts (interactions.spec.ts saves a `pip` on it,
 * which does not change what is deletable).
 */
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

const openOn = async (page: Page, id: string) => {
  await page.goto("/");
  await settle(page);
  await page.getByTestId(`timeline-block-${id}`).click();
  await page.keyboard.press("Delete");
  return page.getByTestId("delete-scene-modal");
};

test("Delete asks before it deletes, naming the scene and preselecting the graphic", async ({
  page,
}) => {
  const modal = await openOn(page, "scene-5");
  await expect(modal).toBeVisible();
  // Named, so the user knows what is about to go.
  await expect(modal).toContainText("scene-5");
  await expect(page.getByTestId("delete-option-graphic")).toBeVisible();
  await expect(page.getByTestId("delete-option-take")).toBeVisible();
  // The recoverable one is the default, and it is the DEFAULT ACTION that
  // holds focus — that pairing is what makes Enter both fast and safe.
  await expect(page.getByTestId("delete-option-graphic").locator("input")).toBeChecked();
  await expect(page.getByTestId("delete-option-take").locator("input")).not.toBeChecked();
  await expect(page.getByTestId("delete-confirm")).toBeFocused();
  await expect(page.getByTestId("timeline-block-scene-5")).toHaveCSS("border-style", "solid");
});

test("Enter takes the default: the graphic goes ghost, and ⌘Z brings it back", async ({ page }) => {
  const modal = await openOn(page, "scene-5");
  await expect(modal).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(modal).toHaveCount(0);

  const block = page.getByTestId("timeline-block-scene-5");
  await expect(block).toHaveCSS("border-style", "dashed");
  await expect(page.getByTestId("restore-scene")).toBeVisible();

  // Undoable like every other edit — the modal adds friction, not a second
  // edit mechanism that escapes the history.
  await page.keyboard.press("Meta+z");
  await expect(block).toHaveCSS("border-style", "solid");
  await expect(page.getByTestId("restore-scene")).toHaveCount(0);
});

test("Escape cancels, deleting nothing and leaving the selection alone", async ({ page }) => {
  const modal = await openOn(page, "scene-5");
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId("timeline-block-scene-5")).toHaveCSS("border-style", "solid");
  // The CAPTURE-phase Escape must not also reach the Overlay's own Escape:
  // the scene is still selected, so the Inspector still shows its panel.
  await expect(page.getByTestId("delete-scene")).toBeVisible();
});

test("the whole take leaves a restore seam where it was, and that undoes too", async ({ page }) => {
  const modal = await openOn(page, "scene-5");
  await page.getByTestId("delete-option-take").locator("input").check();
  await page.getByTestId("delete-confirm").click();
  await expect(modal).toHaveCount(0);

  // `cutChunk` writes the cue's own window — both testids are keyed by it.
  //
  // Since the cut-review rework the editor's own cut writers resolve `src` AT
  // THE GESTURE and `livePreviewMap` subtracts it, so this cut arrives at the
  // Timeline already APPLIED: the window is gone from the live clock, the
  // block with it, and Timeline draws the seam arm (the `cut.src` branch,
  // Timeline.tsx) rather than a band struck through material that is no
  // longer on screen. Asserting the old `timeline-cut-…` band here is what
  // went red on CI — this suite is the only place that renders the applied
  // arm end to end, and `pnpm test` never runs it.
  const seam = page.locator('[data-testid^="timeline-cut-seam-27.61-"]');
  const block = page.getByTestId("timeline-block-scene-5");
  await expect(seam).toHaveCount(1);
  await expect(block).toHaveCount(0);

  await page.keyboard.press("Meta+z");
  await expect(seam).toHaveCount(0);
  await expect(block).toHaveCount(1);
});

test("a plain take still confirms, with only the option that applies", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  // The first take block: a derived filler window with no graphic on it. The
  // old binding refused this keypress outright (§139).
  await page.locator('[data-testid^="timeline-block-take-"]').first().click();
  await page.keyboard.press("Delete");
  const modal = page.getByTestId("delete-scene-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("delete-option-take")).toBeVisible();
  await expect(page.getByTestId("delete-option-graphic")).toHaveCount(0);
  await expect(page.getByTestId("delete-option-take").locator("input")).toBeChecked();
});

test("Tab is trapped inside the dialog", async ({ page }) => {
  await openOn(page, "scene-5");
  // From the default action, Tab wraps to the first control rather than
  // walking out onto the timeline blocks behind the backdrop.
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("delete-option-graphic").locator("input")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("delete-confirm")).toBeFocused();
});

test("the shortcuts reference documents the key", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.getByTestId("shortcuts-button").click();
  await expect(page.getByTestId("shortcuts-modal")).toContainText("delete / backspace");
  await expect(page.getByTestId("shortcuts-modal")).toContainText("graphic or whole take");
});
