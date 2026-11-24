import { test, expect, type Page } from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;
const PROPS = join(WORKDIR, "render-props.json");
const OVERRIDES = join(WORKDIR, "overrides.json");

/**
 * A clip's speed resizes its block, pinned or not (decided after 493597a),
 * and no block is ever longer than its clip (decided after 9478bcb, when an
 * end drag past a sped-up clip snapped back on release and moved the take
 * after it) — driven through the real Inspector, Timeline and reducer.
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

// Each test reads the doc from disk at load; none clicks Save, so a test's
// edits stay in its own page. The live-cut tests write one, so every test
// starts from none.
test.beforeEach(async () => {
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

/**
 * A saved cut in the gap AFTER the clip (10.5..11.5, between its end at 10
 * and scene-2 at 12.1) that the fixture's identity spans have not applied:
 * the editor previews it live, so every cue goes through `retimeForPreview`
 * — the author's path (a project with cleanup cuts) — while the clip itself
 * stays where it is.
 */
const LIVE_CUT = { startSec: 10.5, endSec: 11.5, src: { startSec: 10.5, endSec: 11.5 } };
const withLiveCut = () => writeFile(OVERRIDES, JSON.stringify({ cuts: [LIVE_CUT] }));

/** Every timeline block but the clip, by test id: the neighbours a refused
 * drag must leave exactly where they were. */
const otherBlocks = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-testid^="timeline-block-"]')]
        .filter((el) => el.dataset.testid !== "timeline-block-clip-1")
        .map((el) => {
          const r = el.getBoundingClientRect();
          return [el.dataset.testid!, { x: Math.round(r.x * 10) / 10, width: Math.round(r.width * 10) / 10 }];
        }),
    ),
  );

const open = async (page: Page, liveCut: boolean) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="timeline-block-clip-1"]');
  // The seam is drawn only once the live clock is the one on screen.
  if (liveCut) await expect(page.getByTestId("timeline-cut-seam-10.5-11.5")).toBeVisible();
  const block = page.getByTestId("timeline-block-clip-1");
  await block.click();
  return block;
};

/** Press the selected block's END handle and move it `dx` px; returns the
 * width the block had at the drag's last move, before the release. Inside
 * the 10 px end handle, clear of the selected block's 2 px border:
 * `width - 2` lands on the handle's own edge and starts a MOVE instead. */
const dragEnd = async (page: Page, block: ReturnType<Page["getByTestId"]>, dx: number) => {
  const box = (await block.boundingBox())!;
  const y = box.y + box.height / 2;
  const endX = box.x + box.width - 6;
  await page.mouse.move(endX, y);
  await page.mouse.down();
  await page.mouse.move(endX + dx, y, { steps: 6 });
  const during = (await block.boundingBox())!.width;
  await page.mouse.up();
  return during;
};

test("a trimmed clip block takes the clip's length at its new speed; one undo restores both", async ({
  page,
}) => {
  const block = await open(page, false);
  const atClipLength = (await block.boundingBox())!;

  // Drag the END edge shorter: the block is trimmed to 3 s, and the window
  // is pinned — the case the speed slider used to leave alone.
  await dragEnd(page, block, -atClipLength.width / 4);
  await expect.poll(async () => off((await block.boundingBox())!.width, (atClipLength.width * 3) / 4)).toBeLessThan(2);
  const trimmed = (await block.boundingBox())!;

  // Speed 2: a 4 s clip plays 2 s, so the block is half its clip length,
  // from the same start — however it was trimmed.
  await expect(page.getByTestId("prop-speed-hint")).toHaveText(
    "Changing speed resizes the block to the clip's new length. A block can be trimmed, not made longer than its clip.",
  );
  await setRange(page, "prop-speed", "2");
  await expect.poll(async () => off((await block.boundingBox())!.width, atClipLength.width / 2)).toBeLessThan(2);
  expect(off((await block.boundingBox())!.x, atClipLength.x)).toBeLessThan(2);

  // One undo: the trimmed window AND the old speed, together. Blur first so
  // the key's keyup on a focused slider cannot re-commit its value.
  await page.getByTestId("prop-speed").evaluate((el) => (el as HTMLElement).blur());
  await page.keyboard.press("Meta+z");
  await expect.poll(async () => off((await block.boundingBox())!.width, trimmed.width)).toBeLessThan(2);
  await expect(page.getByTestId("prop-speed")).toHaveValue("1");
});

for (const liveCut of [false, true]) {
  test(`an end drag past the clip stops at its length and nothing moves on release${liveCut ? " (live cut)" : ""}`, async ({
    page,
  }) => {
    if (liveCut) await withLiveCut();
    const block = await open(page, liveCut);
    const atClipLength = (await block.boundingBox())!;

    // At its own length, the end will not go further right at all.
    const before = await otherBlocks(page);
    expect(off(await dragEnd(page, block, atClipLength.width * 0.75), atClipLength.width)).toBeLessThan(1);
    await page.waitForTimeout(200);
    expect(off((await block.boundingBox())!.width, atClipLength.width)).toBeLessThan(1);
    expect(await otherBlocks(page)).toEqual(before);

    // At speed 2 (2 s played) the same: the drag stops at the played
    // length, the release changes nothing — no snap — and no neighbour
    // moves. The field report: the block followed the mouse, snapped back
    // to 2 s on release, and the take after it moved to the long pin's end.
    await setRange(page, "prop-speed", "2");
    await expect.poll(async () => off((await block.boundingBox())!.width, atClipLength.width / 2)).toBeLessThan(2);
    await page.getByTestId("prop-speed").evaluate((el) => (el as HTMLElement).blur());
    const played = (await block.boundingBox())!;
    const neighbours = await otherBlocks(page);
    const during = await dragEnd(page, block, atClipLength.width * 0.75);
    expect(off(during, played.width)).toBeLessThan(1);
    await page.waitForTimeout(200);
    const after = (await block.boundingBox())!;
    expect(off(after.width, during)).toBeLessThan(1);
    expect(off(after.x, played.x)).toBeLessThan(1);
    expect(await otherBlocks(page)).toEqual(neighbours);
  });
}

test("under a live cut, a trimmed clip stays trimmed after release", async ({ page }) => {
  // The other half of the retime bug: the preview re-derived every clip's
  // end from its length, so a trim drew short while dragging and grew back
  // to the whole clip on release.
  await withLiveCut();
  const block = await open(page, true);
  const atClipLength = (await block.boundingBox())!;
  const during = await dragEnd(page, block, -atClipLength.width / 4);
  expect(off(during, (atClipLength.width * 3) / 4)).toBeLessThan(2);
  await page.waitForTimeout(200);
  expect(off((await block.boundingBox())!.width, during)).toBeLessThan(1);
});
