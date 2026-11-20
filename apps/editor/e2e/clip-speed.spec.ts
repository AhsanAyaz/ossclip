import { test, expect, type Page } from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;
const PROPS = join(WORKDIR, "render-props.json");
const OVERRIDES = join(WORKDIR, "overrides.json");

/**
 * A clip's speed resizes its block, pinned or not (decided after 493597a),
 * driven through the real Inspector, Timeline and reducer.
 *
 * The committed fixture has no ClipScene, so this file gives the workdir
 * one: a 4 s clip at 6..10, in the gap between scene-0 (ends 5.09) and
 * scene-2 (starts 12.1), playing the fixture's own mezzanine (the Player
 * resolves it through `/media/`, `withMediaClipSrc`) so no media is added.
 * Written into `baseSceneCues` — the pristine base the editor merges onto —
 * and `sceneCues` alike. Starts from no overrides.json so nothing another
 * spec saved can pin or move it. Everything is restored after; its own
 * serialized project, last, because it rewrites render-props.json.
 */
const CLIP = {
  id: "clip-1",
  kind: "graphic",
  layout: "full-bleed",
  component: "ClipScene",
  props: { src: "mezzanine.mp4", durationSec: 4, gainDb: -13, muted: true },
  startSec: 6,
  endSec: 10,
};

let originalProps = "";
let originalOverrides: string | null = null;

test.beforeAll(async () => {
  originalProps = await readFile(PROPS, "utf8");
  originalOverrides = await readFile(OVERRIDES, "utf8").catch(() => null);
  const props = JSON.parse(originalProps) as Record<string, { startSec: number }[]>;
  for (const key of ["sceneCues", "baseSceneCues"]) {
    props[key] = [...props[key]!, CLIP].sort((a, b) => a.startSec - b.startSec);
  }
  await writeFile(PROPS, JSON.stringify(props));
  await rm(OVERRIDES, { force: true });
});

test.afterAll(async () => {
  await writeFile(PROPS, originalProps);
  if (originalOverrides !== null) await writeFile(OVERRIDES, originalOverrides);
  else await rm(OVERRIDES, { force: true });
});

/** Set the slider the way a user tick does: the native setter, then `input`. */
const setRange = (page: Page, testId: string, value: string) =>
  page.getByTestId(testId).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);

/** Pixel distance: block geometry is percentage-based, so sub-pixel noise. */
const off = (a: number, b: number) => Math.abs(a - b);

test("a dragged clip block takes the clip's length at its new speed; one undo restores both", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="timeline-block-clip-1"]');
  const block = page.getByTestId("timeline-block-clip-1");
  const atClipLength = (await block.boundingBox())!;

  // Drag the END edge later: the block now runs past the clip (a hold), and
  // the window is pinned — the case the speed slider used to leave alone.
  await block.click();
  const y = atClipLength.y + atClipLength.height / 2;
  // Inside the 10 px end handle, clear of the selected block's 2 px border:
  // `width - 2` lands on the handle's own edge and starts a MOVE instead.
  const endX = atClipLength.x + atClipLength.width - 6;
  await page.mouse.move(endX, y);
  await page.mouse.down();
  await page.mouse.move(endX + atClipLength.width / 4, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await block.boundingBox())!.width).toBeGreaterThan(atClipLength.width + 10);
  const dragged = (await block.boundingBox())!;

  // Speed 2: a 4 s clip plays 2 s, so the block is half its clip length,
  // from the same start — however long it was dragged.
  await expect(page.getByTestId("prop-speed-hint")).toBeVisible();
  await setRange(page, "prop-speed", "2");
  await expect.poll(async () => off((await block.boundingBox())!.width, atClipLength.width / 2)).toBeLessThan(2);
  expect(off((await block.boundingBox())!.x, atClipLength.x)).toBeLessThan(2);

  // One undo: the dragged window AND the old speed, together. Blur first so
  // the key's keyup on a focused slider cannot re-commit its value.
  await page.getByTestId("prop-speed").evaluate((el) => (el as HTMLElement).blur());
  await page.keyboard.press("Meta+z");
  await expect.poll(async () => off((await block.boundingBox())!.width, dragged.width)).toBeLessThan(2);
  await expect(page.getByTestId("prop-speed")).toHaveValue("1");
});
