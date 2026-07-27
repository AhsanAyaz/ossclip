import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;

/**
 * The Player's transport state, mirrored onto the stage by App.tsx. Asserted
 * instead of `<video>.paused` because the e2e's headless Chromium has no
 * H.264 decoder — the media never runs here, but the transport state (which
 * is what Tasks 2 and 5 are about) flips regardless.
 */
const isPlaying = async (page: Page) =>
  (await page.getByTestId("stage").getAttribute("data-playing")) === "true";

/** The playhead's position as a fraction of the track. */
const playheadFrac = async (page: Page) => {
  const track = (await page.locator("[data-testid='playhead']").locator("..").boundingBox())!;
  const head = (await page.getByTestId("playhead").boundingBox())!;
  return (head.x - track.x) / track.width;
};

/**
 * Wait for the layout to stop moving before measuring coordinates. The video
 * mounts asynchronously and can resize the stage, shifting the timeline —
 * raw `page.mouse` events aimed with stale boxes land on whatever moved in.
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

test("clicking an element selects it without toggling playback; the background still toggles (Task 2)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await page.locator('[data-testid^="timeline-block-"]').first().click();
  await page.waitForSelector("[data-edit-id]");
  expect(await isPlaying(page)).toBe(false);

  // Half one: a press on an editable element is the editor's — selection
  // appears, playback stays paused. Raw mouse, because Playwright's
  // actionability check refuses to click through Remotion's stacked
  // pointer-events wrappers that the app's own hit-testing sees through.
  const elBox = (await page.locator("[data-edit-id]").first().boundingBox())!;
  await page.mouse.click(elBox.x + elBox.width / 2, elBox.y + elBox.height / 2);
  await expect(page.getByTestId("overlay-box")).toBeVisible();
  expect(await isPlaying(page)).toBe(false);

  // Half two: a press on the bare video (top of the frame, no editable
  // element there in this fixture's layouts) is the Player's — playback
  // toggles like any reel player.
  const stage = (await page.getByTestId("stage").boundingBox())!;
  await page.mouse.click(stage.x + stage.width * 0.5, stage.y + stage.height * 0.06);
  await expect.poll(() => isPlaying(page)).toBe(true);
  await page.mouse.click(stage.x + stage.width * 0.5, stage.y + stage.height * 0.06);
  await expect.poll(() => isPlaying(page)).toBe(false);
});

test("the timeline scrubs on press-and-drag, and a click inside a block seeks to that point (Tasks 3+4)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  const track = (await page.locator("[data-testid='playhead']").locator("..").boundingBox())!;

  // Task 4: click INSIDE the second block, off-centre — the playhead must
  // land at the CLICKED fraction, not snap to the block's start.
  const block = (await page.locator('[data-testid^="timeline-block-"]').nth(1).boundingBox())!;
  const clickX = block.x + block.width * 0.7;
  await page.mouse.click(clickX, block.y + block.height / 2);
  const clickedFrac = (clickX - track.x) / track.width;
  await expect
    .poll(() => playheadFrac(page))
    .toBeGreaterThan(clickedFrac - 0.02);
  expect(await playheadFrac(page)).toBeLessThan(clickedFrac + 0.02);

  // Task 3: press on the BARE track (the 16%-38% stretch is a real gap in
  // this fixture — pressing inside a block would start a block move, Task 6)
  // and drag: the playhead follows the pointer continuously, both ways.
  const y = track.y + track.height / 2;
  await page.mouse.move(track.x + track.width * 0.25, y);
  await page.mouse.down();
  await expect.poll(() => playheadFrac(page)).toBeGreaterThan(0.23);
  expect(await playheadFrac(page)).toBeLessThan(0.27);
  await page.mouse.move(track.x + track.width * 0.33, y, { steps: 4 });
  await expect.poll(() => playheadFrac(page)).toBeGreaterThan(0.31);
  await page.mouse.move(track.x + track.width * 0.19, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => playheadFrac(page)).toBeLessThan(0.21);
});

test("SPACE toggles playback globally, but types a space inside a field (Task 5)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  expect(await isPlaying(page)).toBe(false);

  await page.keyboard.press("Space");
  await expect.poll(() => isPlaying(page)).toBe(true);
  await page.keyboard.press("Space");
  await expect.poll(() => isPlaying(page)).toBe(false);

  // Guard: with focus in an inspector field, SPACE is typing, not transport.
  const field = page.locator(".sidebar input, input").last();
  await field.click();
  const before = await field.inputValue();
  await page.keyboard.press("Space");
  expect(await isPlaying(page)).toBe(false);
  expect((await field.inputValue()).length).toBeGreaterThanOrEqual(before.length);
});

test("dragging a block body moves the scene in time, keeping its duration; a click never pins (Task 6)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);

  // The fixture's second scene (12.10–16.71s) has ~7s of clear room to its
  // left and almost none to its right — drag LEFT so the clamp cannot mask a
  // broken move.
  const blockSel = page.locator('[data-testid^="timeline-block-"]').nth(1);
  const before = (await blockSel.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 - 40, before.y + before.height / 2, {
    steps: 5,
  });
  await page.mouse.up();

  // On screen: moved left, same width — a move, not a resize.
  await expect
    .poll(async () => (await blockSel.boundingBox())!.x)
    .toBeLessThan(before.x - 20);
  const after = (await blockSel.boundingBox())!;
  expect(Math.abs(after.width - before.width)).toBeLessThan(2);
  // …and it pinned, exactly like an edge drag would.
  await expect(blockSel.getByText("PIN")).toBeVisible();

  // On disk: duration preserved to the millisecond.
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  const renderProps = JSON.parse(await readFile(join(WORKDIR, "render-props.json"), "utf8"));
  const cue = renderProps.sceneCues[1];
  const timing = doc.scenes[cue.id].timing;
  expect(timing.startSec).toBeLessThan(cue.startSec);
  expect(timing.endSec - timing.startSec).toBeCloseTo(cue.endSec - cue.startSec, 3);

  // And a plain click on a block does NOT write a timing override: click the
  // FIRST block (untouched) and save — its scene must carry no timing.
  await page.locator('[data-testid^="timeline-block-"]').first().click();
  await page.keyboard.press("Meta+s");
  const doc2 = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc2.scenes[renderProps.sceneCues[0].id]?.timing).toBeUndefined();
});
