import { test, expect, type Locator, type Page } from "@playwright/test";
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

/**
 * Seek INTO a block, then select it — two separate gestures since the field
 * report 2026-08-07 fix: clicking a block only selects, it never moves the
 * playhead. Tests that need a scene's content ON STAGE therefore park the
 * playhead first via the ruler (the intentional seek surface), then click
 * the block — the same two steps a user now takes.
 */
const selectBlockAt = async (page: Page, block: Locator, frac = 0.65) => {
  const b = (await block.boundingBox())!;
  const ruler = (await page.getByTestId("ruler").boundingBox())!;
  await page.mouse.click(b.x + b.width * frac, ruler.y + ruler.height / 2);
  // Click OFF the just-parked playhead: its grab zone sits exactly where the
  // seek landed and intercepts a center click on the block.
  await block.click({ position: { x: b.width * 0.3, y: b.height / 2 } });
};

test("clicks never toggle playback: elements select, the background does nothing (Tasks 2 + R9-1)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await selectBlockAt(page, page.locator('[data-testid^="timeline-block-"]').first());
  await page.waitForSelector("[data-edit-id]");
  expect(await isPlaying(page)).toBe(false);

  // A press on an editable element is the editor's — selection appears,
  // playback stays paused. Raw mouse, because Playwright's actionability
  // check refuses to click through Remotion's stacked pointer-events
  // wrappers that the app's own hit-testing sees through.
  const elBox = (await page.locator("[data-edit-id]").first().boundingBox())!;
  await page.mouse.click(elBox.x + elBox.width / 2, elBox.y + elBox.height / 2);
  await expect(page.getByTestId("overlay-box")).toBeVisible();
  expect(await isPlaying(page)).toBe(false);

  // DELIBERATE INVERSION (round 9, Task 1): this half used to assert a
  // background click toggles playback — the right behaviour for a viewer and
  // the wrong one for an editor, where the frame is a canvas, not a play
  // button. clickToPlay is now off; playback is explicit (transport bar,
  // SPACE, J/K/L). A background click must do NOTHING to the transport.
  const stage = (await page.getByTestId("stage").boundingBox())!;
  await page.mouse.click(stage.x + stage.width * 0.5, stage.y + stage.height * 0.06);
  await page.waitForTimeout(200);
  expect(await isPlaying(page)).toBe(false);
  // …and SPACE still starts playback, so the explicit path works.
  await page.keyboard.press("Space");
  await expect.poll(() => isPlaying(page)).toBe(true);
  await page.keyboard.press("Space");
  await expect.poll(() => isPlaying(page)).toBe(false);
});

test("J/K/L transport: ladder up, reverse, settle at 1x (R9-2)", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const rate = () => page.getByTestId("stage").getAttribute("data-rate");

  await page.keyboard.press("l");
  await expect.poll(() => isPlaying(page)).toBe(true);
  expect(await rate()).toBe("1");
  await page.keyboard.press("l");
  await expect.poll(rate).toBe("1.5");
  await page.keyboard.press("l");
  await expect.poll(rate).toBe("2");

  // J reverses from a forward sprint: straight to -1, then down the ladder.
  await page.keyboard.press("j");
  await expect.poll(rate).toBe("-1");
  await page.keyboard.press("j");
  await expect.poll(rate).toBe("-1.5");

  // K stops and resets to 1x; K again plays at 1x.
  await page.keyboard.press("k");
  await expect.poll(() => isPlaying(page)).toBe(false);
  expect(await rate()).toBe("1");
  await page.keyboard.press("k");
  await expect.poll(() => isPlaying(page)).toBe(true);
  expect(await rate()).toBe("1");
  await page.keyboard.press("Space");
  await expect.poll(() => isPlaying(page)).toBe(false);

  // The rate is visible and mouse-reachable, not keyboard-only.
  await expect(page.getByTestId("rate-chip")).toHaveText("1×");
  await page.getByTestId("rate-chip").click();
  await expect.poll(rate).toBe("1");
  await expect.poll(() => isPlaying(page)).toBe(true);
  await page.keyboard.press("k");
});

test("the ruler seeks without touching the selection (R9-3)", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  // Select a scene first — the point of the ruler is navigating WITHOUT
  // losing (or changing) this selection. Seek into it first: the box below
  // needs the scene's DOM mounted, and selecting no longer seeks.
  await selectBlockAt(page, page.locator('[data-testid^="timeline-block-"]').first());
  await expect(page.getByTestId("overlay-box")).toBeVisible();

  const ruler = (await page.getByTestId("ruler").boundingBox())!;
  const y = ruler.y + ruler.height / 2;
  await page.mouse.move(ruler.x + ruler.width * 0.6, y);
  await page.mouse.down();
  await expect.poll(() => playheadFrac(page)).toBeGreaterThan(0.55);
  await page.mouse.move(ruler.x + ruler.width * 0.35, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => playheadFrac(page)).toBeLessThan(0.45);

  // The SELECTION survived the whole scrub — asserted via the Inspector's
  // timing section, which renders only for a selected scene. (The overlay
  // box is the wrong oracle here: it needs the selected scene's DOM, and the
  // scrub deliberately parked the playhead OUTSIDE that scene's window, so
  // its <Sequence> is unmounted and the box has nothing to measure.)
  await expect(page.getByTestId("timing-range")).toBeVisible();
});

test("decimal scale commits, and the timing section states the window (R9-5+6)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await page.locator('[data-testid^="timeline-block-"]').first().click();

  // Task 6: the resolved window shows for an UNPINNED cue — "tracking
  // transcript" is a label on the times now, not a replacement for them.
  await expect(page.getByTestId("timing-range")).toContainText("s –");

  // Task 5: 0.62 into the video-framing scale — HTML's default step=1 used
  // to mark this INVALID and silently never commit it.
  await page.getByTestId("field-scale").fill("0.62");
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  const renderProps = JSON.parse(await readFile(join(WORKDIR, "render-props.json"), "utf8"));
  // `baseSceneCues`, not `sceneCues`: the rendered list now interleaves
  // derived `take-*` cues between the graphics (Task A), so positional
  // indexing into it names a different cue than the block that was clicked.
  expect(doc.scenes[renderProps.baseSceneCues[0].id].video.scale).toBe(0.62);

  // R12 §48: a comma-decimal locale types "0,7" — it must COMMIT as 0.7,
  // not sit in the field as a string the old number input reported empty.
  await page.getByTestId("field-scale").fill("0,7");
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc2 = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc2.scenes[renderProps.baseSceneCues[0].id].video.scale).toBe(0.7);
});

test("the timeline scrubs on press-and-drag; a click inside a block selects WITHOUT seeking (Task 3 + field report 2026-08-07)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  const track = (await page.locator("[data-testid='playhead']").locator("..").boundingBox())!;

  // Field report 2026-08-07 inverted Task 4: a click inside a graphic block
  // used to ALSO seek to the clicked fraction, which moved the playhead on
  // every scene selection. Now the click selects (the Inspector's timing
  // section is the oracle — it renders only for a selected scene) and the
  // playhead stays parked. By id, not nth(): derived `take-*` blocks fill
  // the gaps (Task A), so ordinal positions name different blocks.
  const before = await playheadFrac(page);
  const block = (await page.getByTestId("timeline-block-scene-2").boundingBox())!;
  await page.mouse.click(block.x + block.width * 0.7, block.y + block.height / 2);
  await expect(page.getByTestId("timing-range")).toBeVisible();
  await page.waitForTimeout(150);
  expect(Math.abs((await playheadFrac(page)) - before)).toBeLessThan(0.02);

  // Task 3: press-and-drag seeking. The 16%-38% stretch used to be a bare
  // gap; it is now the `take-0` PLAIN block (Task A) — which still scrubs,
  // deliberately: a plain block's window is derived, so it has no move-drag
  // to start, and the takes cover most of the track now — losing press-and-
  // drag seeking over them would regress this very gesture. The one change
  // (field report 2026-08-07): the seek starts once the press TRAVELS past
  // the click threshold — a bare press-and-release is a selection, so the
  // playhead must not jump until the pointer actually moves.
  const y = track.y + track.height / 2;
  await page.mouse.move(track.x + track.width * 0.25, y);
  await page.mouse.down();
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
  // A NAMED free-text field, not a positional `.last()`: the old locator
  // grabbed whatever input happened to render last — the captions feature
  // added a checkbox there (which blurs after toggle per Task 2, making
  // Space transport again by design), and the nearest text input was a
  // select-on-focus NumberField that Space wipes. The guard this test pins
  // is about typing words; fontDisplay is the panel's one true free-text
  // field.
  const field = page.getByTestId("theme-fontDisplay");
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

  // The fixture's second graphic scene (12.10–16.71s) has ~7s of clear room
  // to its left and almost none to its right — drag LEFT so the clamp cannot
  // mask a broken move. By id: derived `take-*` blocks fill the ordinal
  // positions now (Task A), and they deliberately do not move.
  const blockSel = page.getByTestId("timeline-block-scene-2");
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
  const cue = renderProps.baseSceneCues.find((c: { id: string }) => c.id === "scene-2");
  // The SRC-ANCHORED arm of `SceneTimingSchema`: since timing went audio-first
  // the editor converts the drag at the gesture and pins SOURCE seconds, so a
  // dropped block cannot snap back when the next derive changes the output
  // clock under it. There is no dual-write — asserting `startSec` here is what
  // went red on CI, and asserting either shape would let a regression back to
  // the output-clock arm pass.
  const timing = doc.scenes[cue.id].timing;
  expect(Object.keys(timing).sort()).toEqual(["srcEnd", "srcStart"]);
  // Comparable against the cue's OUTPUT-clock window only because this
  // project's fixture spans are the identity (the `recut` project rewrites
  // them, and playwright.config.ts serializes it behind everything else).
  expect(timing.srcStart).toBeLessThan(cue.startSec);
  expect(timing.srcEnd - timing.srcStart).toBeCloseTo(cue.endSec - cue.startSec, 3);

  // And a plain click on a block does NOT write a timing override: click the
  // FIRST block (untouched) and save — its scene must carry no timing.
  await page.locator('[data-testid^="timeline-block-"]').first().click();
  await page.keyboard.press("Meta+s");
  const doc2 = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc2.scenes[renderProps.baseSceneCues[0].id]?.timing).toBeUndefined();
});

test("double-click retypes a caption word in place; the edit lands in overrides.json (Task 7a)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  // Park the playhead where a caption line is definitely on screen: seek
  // into the first scene block via the ruler (block clicks select, they no
  // longer seek — field report 2026-08-07).
  await selectBlockAt(page, page.locator('[data-testid^="timeline-block-"]').first());
  await page.waitForSelector("[data-caption-word]");

  const word = page.locator("[data-caption-word]").first();
  const wordIndex = await word.getAttribute("data-caption-word");
  const was = await word.getAttribute("data-caption-text");
  // The SOURCE anchor the edit is keyed on (§137). The fixture's
  // render-props.json predates the field entirely, so this attribute exists
  // only because the editor's load path backfilled it from the file's spans —
  // asserting on it therefore covers the repair as well as the key.
  const srcStart = await word.getAttribute("data-caption-src");
  expect(srcStart).not.toBeNull();
  const box = (await word.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);

  const input = page.getByTestId("caption-edit");
  await expect(input).toBeVisible();
  // The input seeds with the RAW word, not a decorated rendering.
  await expect(input).toHaveValue(was!);
  await input.fill("RETYPED");
  await page.keyboard.press("Enter");

  // The stage caption updates live…
  await expect(page.locator(`[data-caption-word="${wordIndex}"]`)).toHaveText(/RETYPED/);
  // …and the override survives a save, keyed and guarded.
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  // Keyed by source milliseconds, NOT by the word's position — the whole
  // point of §137. Derived here rather than hardcoded, so a wrong derivation
  // fails this rather than a changed fixture silently agreeing with it.
  const key = `w${Math.round(Number(srcStart) * 1000)}`;
  expect(doc.captions[key]).toEqual({ text: "RETYPED", was });
  expect(doc.captions[wordIndex!]).toBeUndefined();
});

test("plain take blocks fill the timeline, select, and hold a framing override (Task A)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  // The fixture's 5.09–12.10s gap is now the `take-0` block, derived live by
  // the same fillPlainCues the pipeline runs.
  const take = page.getByTestId("timeline-block-take-0");
  await expect(take).toBeVisible();
  await take.click();

  // Selecting it opens the Take inspector: a timing readout (derived, not
  // movable) and the framing fields — the whole point of the fill is that
  // framing works HERE, where no graphic scene exists.
  await expect(page.getByTestId("timing-range")).toContainText("5.09s");
  await expect(page.getByTestId("field-scale")).toBeVisible();
  await page.getByTestId("field-scale").fill("1.3");
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc.scenes["take-0"].video.scale).toBe(1.3);
});

test("drag the picture to pan its framing; the zoom slider commits one undo step (Task B)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  // Park inside take-0 (ruler seek — the click only selects now, field
  // report 2026-08-07) and select it, so the video slot on stage is tagged
  // with its id.
  await selectBlockAt(page, page.getByTestId("timeline-block-take-0"));
  await expect(page.getByTestId("zoom-slider")).toBeVisible();

  // Drag the PICTURE, well above the strip reserved for the Player's own
  // transport and clear of captions/graphics.
  const stage = (await page.getByTestId("stage").boundingBox())!;
  const cx = stage.x + stage.width * 0.5;
  const cy = stage.y + stage.height * 0.3;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 25, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  const video = doc.scenes["take-0"].video;
  const renderProps = JSON.parse(await readFile(join(WORKDIR, "render-props.json"), "utf8"));
  // Same ±20% band edit.spec.ts uses to catch an un-rescaled delta — the
  // stage box and the Player's letterboxed canvas differ by ~10%.
  const expected = 60 * (renderProps.settings.width / stage.width);
  expect(video.dx).toBeGreaterThan(expected * 0.8);
  expect(video.dx).toBeLessThan(expected * 1.2);
  expect(video.dy).toBeGreaterThan(0);

  // Slider: a three-arrow burst commits with one coalesce key, so ONE undo
  // erases the whole burst — and leaves the drag above intact. Relative
  // assertions: earlier tests may already have left a scale on this take.
  const slider = page.getByTestId("zoom-slider");
  const before = Number(await slider.inputValue());
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc2 = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc2.scenes["take-0"].video.scale).toBeCloseTo(before + 0.03, 6);
  // Blur first: Meta+z's keyup on a focused slider would re-commit its value.
  await slider.evaluate((el) => (el as HTMLElement).blur());
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc3 = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc3.scenes["take-0"].video.scale ?? before).toBeCloseTo(before, 6);
  expect(doc3.scenes["take-0"].video.dx).toBeCloseTo(video.dx, 6);
});

test("Delete turns a scene into a restorable ghost and its window into a take (Task C)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  const block = page.getByTestId("timeline-block-scene-3");
  await block.click();
  await page.keyboard.press("Delete");
  // Delete now ASKS (§139) — Enter takes the preselected default, which is
  // the graphic, so everything below this line is unchanged from Task C.
  await expect(page.getByTestId("delete-scene-modal")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("delete-scene-modal")).toHaveCount(0);

  // The scene block is GONE from the timeline — not a selectable ghost
  // (field report 2026-08-31: edits on the deleted id landed nowhere the
  // player reads). The selection remaps to the take that took over the
  // window, whose panel carries the way back.
  await expect(block).toHaveCount(0);
  await expect(page.getByTestId("restore-scene-scene-3")).toBeVisible();
  // …and on disk the delete is soft: hidden: true under the scene's id.
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc.scenes["scene-3"].hidden).toBe(true);

  // Restore DELETES the key — not hidden: false — and the block comes back.
  await page.getByTestId("restore-scene-scene-3").click();
  await expect(block).toHaveCount(1);
  await expect(block).toHaveCSS("border-style", "solid");
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc2 = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect("hidden" in doc2.scenes["scene-3"]).toBe(false);
});

test("the selected block paints above its take neighbours, including mid-resize (R11 Task 1)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  const scene = page.getByTestId("timeline-block-scene-2");
  await scene.click();
  const z = (testId: string) =>
    page
      .getByTestId(testId)
      .evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
  expect(await z("timeline-block-scene-2")).toBeGreaterThan(await z("timeline-block-take-0"));

  // Drag the START edge left into take-0's territory (the takes stay stale
  // until the commit, deliberately) — while the preview is live, the block
  // must be the topmost thing at a point inside the overlap, or the drag
  // grows invisibly underneath its neighbour.
  const box = (await scene.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, y, { steps: 4 });
  const topId = await page.evaluate(
    ([x, py]) =>
      document
        .elementFromPoint(x!, py!)
        ?.closest('[data-testid^="timeline-block-"]')
        ?.getAttribute("data-testid") ?? null,
    [box.x - 30, y],
  );
  expect(topId).toBe("timeline-block-scene-2");
  await page.mouse.up();
  // The edge drag pinned scene-2 — undo so this test leaves no residue.
  await page.keyboard.press("Meta+z");
});

test("drag a corner handle to reshape the graphic box; body clicks still reach elements (R11 Task 2)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-3"));
  await expect(page.getByTestId("overlay-box")).toBeVisible();
  const handle = page.getByTestId("box-handle-se");
  await expect(handle).toBeVisible();

  // Drag the SE corner inward — the box on screen follows the preview.
  const before = (await page.getByTestId("overlay-box").boundingBox())!;
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - 50, hb.y + hb.height / 2 - 30, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await page.getByTestId("overlay-box").boundingBox())!.width)
    .toBeLessThan(before.width - 30);

  // On disk: the committed fractions match what is on screen, inside the
  // same ±20% band edit.spec.ts uses for rescaled deltas.
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  const rect = doc.scenes["scene-3"].graphicRect;
  const stage = (await page.getByTestId("stage").boundingBox())!;
  const after = (await page.getByTestId("overlay-box").boundingBox())!;
  const seenW = (after.width - 9) / stage.width; // minus the box's HANDLE pad
  expect(rect.w).toBeGreaterThan(seenW * 0.8);
  expect(rect.w).toBeLessThan(seenW * 1.2);

  // The regression this feature most threatens: a click INSIDE the box must
  // still fall through to the element underneath it.
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-0"));
  await page.waitForSelector("[data-edit-id]");
  const el = (await page.locator("[data-edit-id]").first().boundingBox())!;
  await page.mouse.click(el.x + el.width / 2, el.y + el.height / 2);
  await expect(page.getByText("Reset element")).toBeVisible();

  // Leave no residue for later tests: reset the box and save.
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-3"));
  await page.getByTestId("reset-box").click();
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
});

test("Render is present but honestly disabled without a recorded command (R11 Task 4)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  // The fixture workdir has no command.json — the button must exist, be
  // disabled, and SAY WHY, rather than firing a replay that cannot work.
  const btn = page.getByTestId("render-button");
  await expect(btn).toBeVisible();
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveAttribute("title", /command\.json/);
});

test("element corner handles resize by drag; the slider drives scale too (R12 §47)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await selectBlockAt(page, page.locator('[data-testid^="timeline-block-"]').first());
  await page.waitForSelector("[data-edit-id]");
  const el = (await page.locator("[data-edit-id]").first().boundingBox())!;
  await page.mouse.click(el.x + el.width / 2, el.y + el.height / 2);
  await expect(page.getByTestId("overlay-box")).toBeVisible();

  // Position was already direct manipulation; size now is too: drag the SE
  // corner OUTWARD (away from the element's centre) to grow it.
  const handle = (await page.getByTestId("el-handle-se").boundingBox())!;
  const hx = handle.x + handle.width / 2;
  const hy = handle.y + handle.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + 40, hy + 25, { steps: 5 });
  await page.mouse.up();

  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  const renderProps = JSON.parse(await readFile(join(WORKDIR, "render-props.json"), "utf8"));
  const elements = doc.scenes[renderProps.baseSceneCues[0].id].elements as Record<
    string,
    { scale?: number }
  >;
  const scaled = Object.values(elements).find((t) => t.scale !== undefined);
  expect(scaled).toBeTruthy();
  expect(scaled!.scale!).toBeGreaterThan(1);
  // §48: the committed value is rounded, not float dust.
  expect(String(scaled!.scale).replace(/^-?\d+\.?/, "").length).toBeLessThanOrEqual(3);

  // And the scale slider exists as the coarse control for the same value.
  await expect(page.getByTestId("el-scale-slider")).toBeVisible();
});

test("element text edits live in the panel; the inline double-click input is gone (R12 §49)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await selectBlockAt(page, page.locator('[data-testid^="timeline-block-"]').first());
  await page.waitForSelector("[data-edit-id]");
  const el = page.locator("[data-edit-id]").first();
  const elBox = (await el.boundingBox())!;
  await page.mouse.click(elBox.x + elBox.width / 2, elBox.y + elBox.height / 2);
  await expect(page.getByTestId("element-text")).toBeVisible();

  // The floating input used to open here, painting over the element while
  // the un-edited render showed behind it. Gone: a double-click adds no
  // input anywhere.
  const inputsBefore = await page.locator("input").count();
  await page.mouse.dblclick(elBox.x + elBox.width / 2, elBox.y + elBox.height / 2);
  await page.waitForTimeout(150);
  expect(await page.locator("input").count()).toBe(inputsBefore);

  // The panel edits the element and the stage follows live.
  await page.getByTestId("element-text").fill("REPLACED BY PANEL");
  await expect(el).toHaveText(/REPLACED BY PANEL/);
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  const renderProps = JSON.parse(await readFile(join(WORKDIR, "render-props.json"), "utf8"));
  const props = doc.scenes[renderProps.baseSceneCues[0].id].props;
  expect(JSON.stringify(props)).toContain("REPLACED BY PANEL");
});

test("switching layout never hides the graphic — every option keeps the scene on stage (R13)", async ({
  page,
}) => {
  // The author's repro: a ChatMock on blurred-behind, switched to any other
  // layout — the bubble, its text, and the selection box all vanished.
  // full-bleed was the deleting layout (its slot table has no graphic slot);
  // the sweep pins EVERY option so a future layout can't regress the same way.
  await page.goto("/");
  await settle(page);
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-5"));
  await expect(page.getByTestId("overlay-box")).toBeVisible();
  const layoutSelect = page.getByTestId("layout-select");
  await expect(layoutSelect).toHaveValue("blurred-behind");

  const graphic = page.locator('[data-edit-scene="scene-5"]');
  for (const layout of ["video-top", "pip-bubble", "graphic-only", "full-bleed", "blurred-behind"]) {
    await layoutSelect.selectOption(layout);
    await expect(graphic, layout).toBeVisible();
    await expect
      .poll(async () => {
        const b = await graphic.boundingBox();
        return b ? Math.min(b.width, b.height) : 0;
      }, { message: `graphic has no footprint under ${layout}` })
      .toBeGreaterThan(20);
    // The selection box tracks the graphic to its new slot…
    await expect(page.getByTestId("overlay-box"), layout).toBeVisible();
    // …and the Inspector's Graphic box stays editable (it used to disappear
    // with the slot on full-bleed).
    await expect(page.getByTestId("field-box-x"), layout).toBeVisible();
  }
  // Nothing was saved — reloading discards the sweep's in-memory overrides.
});

test("a layout swap re-slots a graphic the pipeline had routed elsewhere (R13)", async ({
  page,
}) => {
  // scene-3 carries a graphicRect BAKED into the base cue by
  // routeAroundSourceText — computed for its original video-top layout
  // (y=0.5). A layout override must drop it, or the graphic renders at the
  // old layout's routed position inside the new layout's staging.
  await page.goto("/");
  await settle(page);
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-3"));
  await expect(page.getByTestId("overlay-box")).toBeVisible();
  await page.getByTestId("layout-select").selectOption("blurred-behind");

  const stage = (await page.getByTestId("stage").boundingBox())!;
  // blurred-behind's own slot starts at y=0.24; the stale routed rect sat at
  // y=0.5. Poll until the graphic sits in the NEW slot's band (±0.05 for
  // frame-pixel quantization) — a graphic still parked at 0.5 never passes.
  await expect
    .poll(async () => {
      const b = await page.locator('[data-edit-scene="scene-3"]').boundingBox();
      return b ? Math.abs((b.y - stage.y) / stage.height - 0.24) < 0.05 : false;
    })
    .toBe(true);
});

test("timeline zoom: the track widens, scrolls, and gestures stay calibrated (R14 §53)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  const scroller = page.getByTestId("timeline-scroller");
  const viewport = (await scroller.boundingBox())!;
  const track = page.getByTestId("playhead").locator("..");
  // Fit (the default): the track spans the viewport, no scroll, zoom-out
  // honestly disabled.
  expect((await track.boundingBox())!.width).toBeLessThanOrEqual(viewport.width + 2);
  await expect(page.getByTestId("zoom-out")).toBeDisabled();

  await page.getByTestId("zoom-in").click();
  await page.getByTestId("zoom-in").click();
  await expect(page.getByTestId("zoom-level")).toHaveText("4×");
  expect((await track.boundingBox())!.width).toBeGreaterThan(viewport.width * 3.5);

  // The widened track scrolls horizontally.
  const scrolled = await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    return el.scrollLeft;
  });
  expect(scrolled).toBeGreaterThan(viewport.width * 2);

  // Gestures stay calibrated on the wide, scrolled track: a click inside a
  // late block still selects it (clicks no longer seek — field report
  // 2026-08-07 — so the ruler carries the seek half of the calibration
  // check, at the same scrolled-content x the block sits at).
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-5"));
  await expect(page.getByTestId("timing-range")).toContainText("27.61s");
  const frac = await playheadFrac(page);
  expect(frac).toBeGreaterThan(27.61 / 31.92458 - 0.01);
  expect(frac).toBeLessThan(31.65 / 31.92458 + 0.01);

  // Fit returns to the whole clip in view.
  await page.getByTestId("zoom-fit").click();
  await expect(page.getByTestId("zoom-level")).toHaveText("1×");
  expect((await track.boundingBox())!.width).toBeLessThanOrEqual(viewport.width + 2);
});

test("view zoom magnifies the preview and NEVER writes an override (R15 §55b)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  const before = (await page.getByTestId("stage").boundingBox())!;
  // The preview is container-sized now (§55a) — sanity: bigger than the old
  // fixed 380px sliver would ever allow the 9:16 frame to be.
  expect(before.height).toBeGreaterThan(500);

  await page.getByTestId("view-zoom-in").click();
  await expect(page.getByTestId("view-zoom-level")).toHaveText("200%");
  await expect
    .poll(async () => (await page.getByTestId("stage").boundingBox())!.width)
    .toBeGreaterThan(before.width * 1.8);

  // Alt-drag pans the magnified view — the camera moves, the document does
  // not: no dirty flag, no selection, nothing in the override layer.
  const area = page.getByTestId("stage").locator("..");
  const stageBox = (await page.getByTestId("stage").boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.move(stageBox.x + 100, stageBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + 40, stageBox.y + 60, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  void area;

  await page.getByTestId("view-zoom-fit").click();
  await expect(page.getByTestId("view-zoom-level")).toHaveText("100%");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
});

test("caption position: per-scene slider, and Apply to all scenes (R15 §56)", async ({
  page,
}) => {
  const cleanDoc = await readFile(join(WORKDIR, "overrides.json"), "utf8").catch(() => "");
  await page.goto("/");
  await settle(page);
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-0"));
  const word = page.locator("[data-caption-word]").first();
  await expect(word).toBeVisible();
  const before = (await word.boundingBox())!.y;

  const slider = page.getByTestId("caption-y-slider");
  await slider.focus();
  await page.keyboard.press("Home"); // 0.05 — far above any layout's anchor
  await expect.poll(async () => (await word.boundingBox())!.y).toBeLessThan(before - 60);

  // The bulk fan-out (§56b): one click, every scene, one undo step.
  await page.getByTestId("caption-y-all").click();
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  const renderProps = JSON.parse(await readFile(join(WORKDIR, "render-props.json"), "utf8"));
  for (const cue of renderProps.baseSceneCues) {
    expect(doc.scenes[cue.id]?.captionY, cue.id).toBeCloseTo(0.05, 5);
  }

  // Leave no residue: restore the pre-test doc on disk.
  await page.request.put("/api/overrides", {
    data: cleanDoc || JSON.stringify({ theme: {}, scenes: {}, captions: {} }),
    headers: { "content-type": "application/json" },
  });
});

test("a drag at the timeline's edge pages the view and keeps going (R15 §58)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  // Zoom to 4× so the track genuinely overflows the scroller.
  await page.getByTestId("zoom-in").click();
  await page.getByTestId("zoom-in").click();
  await expect(page.getByTestId("zoom-level")).toHaveText("4×");
  const scroller = page.getByTestId("timeline-scroller");
  const sb = (await scroller.boundingBox())!;
  // Zoom buttons anchor about the viewport centre, so scrollLeft is already
  // nonzero — start the paging assertions from the left bound.
  await scroller.evaluate((el) => {
    el.scrollLeft = 0;
  });

  // A scrub that runs off the right edge pages forward by a viewport width…
  const ruler = (await page.getByTestId("ruler").boundingBox())!;
  await page.mouse.move(sb.x + sb.width * 0.5, ruler.y + ruler.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width - 2, ruler.y + ruler.height / 2, { steps: 6 });
  await page.mouse.move(sb.x + sb.width - 1, ruler.y + ruler.height / 2);
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(sb.width * 0.8);
  await page.mouse.up();

  // …and a block-body drag does the same, with the DRAG continuing across
  // the page: the committed window ends past what the first viewport could
  // even display (0..~8s at 4×).
  await scroller.evaluate((el) => {
    el.scrollLeft = 0;
  });
  const block = (await page.getByTestId("timeline-block-scene-0").boundingBox())!;
  await page.mouse.move(block.x + block.width / 2, block.y + block.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width - 2, block.y + block.height / 2, { steps: 8 });
  // Two wiggles past the cooldown so a second page can fire — the drag must
  // survive the content shifting underneath it.
  await page.waitForTimeout(350);
  await page.mouse.move(sb.x + sb.width - 1, block.y + block.height / 2);
  await page.waitForTimeout(100);
  await page.mouse.up();
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8").catch(() => "{}"));
  const timing = doc.scenes?.["scene-0"]?.timing;
  // Committed on release like any move drag (unsaved doc — read the app's
  // state instead: the block's own label survives, so assert via the
  // Inspector's timing range).
  void timing;
  await expect(page.getByTestId("timing-range")).not.toContainText("0.09s –");
  // Cleanup: reload discards the unsaved move.
});

test("transcript view: search, retype 1:1 through the caption layer, jump (R15 §59)", async ({
  page,
}) => {
  const cleanDoc = await readFile(join(WORKDIR, "overrides.json"), "utf8").catch(() => "");
  await page.goto("/");
  await settle(page);
  await page.getByTestId("transcript-toggle").click();
  await expect(page.getByTestId("transcript-panel")).toBeVisible();
  // The ONE-LINE hint (2026-08-18) — the full scope contract collapsed
  // behind the panel's ? toggle, so the always-visible text is just the
  // three gestures.
  await expect(page.getByTestId("transcript-panel")).toContainText(
    "Click to jump · double-click to retype · drag to select",
  );

  // Search narrows by highlight; the first fixture word is "Claude".
  await page.getByTestId("transcript-search").fill("claude");
  await expect(page.getByTestId("transcript-panel")).toContainText("match");

  // Retype word 0 through the panel — it lands in the SAME caption override
  // layer the stage double-click writes (base-guarded, produce-applied).
  await page.getByTestId("transcript-word-0").dblclick();
  const edit = page.getByTestId("transcript-edit");
  await expect(edit).toBeVisible();
  await edit.fill("CLAWD");
  await edit.press("Enter");
  await expect(page.getByTestId("transcript-word-0")).toHaveText("CLAWD");
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  // Source-anchored, not positional (§137). The panel exposes no source time
  // of its own, so derive it from the same file the editor loaded: this
  // fixture predates `srcStart` and has ONE identity span
  // (srcIn 0 → outIn 0), so the backfilled anchor is the word's `start`.
  // Derived rather than hardcoded, so a wrong derivation fails here instead
  // of a changed fixture silently agreeing with it.
  const renderProps = JSON.parse(await readFile(join(WORKDIR, "render-props.json"), "utf8"));
  const w0 = (renderProps.baseCaptionLines ?? renderProps.captionLines)[0].words[0];
  const key = `w${Math.round((w0.srcStart ?? w0.start) * 1000)}`;
  expect(doc.captions[key]).toEqual({ text: "CLAWD", was: "Claude" });
  // The old positional key must not be written alongside it. NOT an
  // assertion on the whole map: the workdir is shared across this file's
  // tests, and the stage-retype test above deliberately leaves its own
  // source-keyed edit behind.
  expect(doc.captions["0"]).toBeUndefined();

  // Clicking a word jumps the preview to its start.
  await page.getByTestId("transcript-word-5").click();
  await expect.poll(() => playheadFrac(page)).toBeGreaterThan(0.01);

  await page.request.put("/api/overrides", {
    data: cleanDoc || JSON.stringify({ theme: {}, scenes: {}, captions: {} }),
    headers: { "content-type": "application/json" },
  });
});

test("the keybinds reference opens with ? and the top-bar button, closes with esc (R16 §63)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  // Select FIRST — the modal's backdrop owns clicks while it is open. Seek
  // into the scene too: the overlay box needs its DOM mounted, and block
  // clicks no longer seek (field report 2026-08-07).
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-0"));
  await expect(page.getByTestId("overlay-box")).toBeVisible();
  await page.keyboard.press("?");
  const modal = page.getByTestId("shortcuts-modal");
  await expect(modal).toBeVisible();
  // It documents the bindings this suite exercises — a stale list fails here.
  await expect(modal).toContainText("split the scene at the playhead");
  await expect(modal).toContainText("select previous / next scene");
  await expect(modal).toContainText("play / pause");
  // Esc closes the MODAL without also clearing the selection through the
  // Overlay's own Esc handler.
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId("overlay-box")).toBeVisible();
  // The top-bar button is the discoverable path to the same reference.
  await page.getByTestId("shortcuts-button").click();
  await expect(page.getByTestId("shortcuts-modal")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("⌘B splits the scene at the playhead; undo heals it (R16 §61)", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const blocks = page.locator('[data-testid^="timeline-block-"]');
  const before = await blocks.count();
  // Park the playhead mid-scene (~2.6s, comfortably clear of both edges)
  // and select — two gestures now, the click no longer seeks (field report
  // 2026-08-07); ⌘B still cuts at the PLAYHEAD, wherever it was parked.
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-0"));
  await page.keyboard.press("Meta+b");
  await expect(blocks).toHaveCount(before + 1);
  // The second half is a real, selectable scene named by its start time.
  const half = page.locator('[data-testid^="timeline-block-scene-0\\@"]');
  await expect(half).toHaveCount(1);
  await half.click();
  await expect(page.getByTestId("timing-range")).toBeVisible();
  // One undo takes the cut back — it is an edit like any other.
  await page.keyboard.press("Meta+z");
  await expect(blocks).toHaveCount(before);
});

test("⌥+arrows select the neighbour scene; ⌘+arrows jump to scene starts (R16 §62)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  // Ruler-seek mid-scene, then select — the click alone no longer moves the
  // playhead (field report 2026-08-07), and this test's "select ≠ seek"
  // assertion below needs it parked measurably off zero.
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-0"));
  // ⌥→ moves the SELECTION to the next block (the take after scene-0) —
  // the Inspector heading flips from Scene to Take.
  await expect(page.locator("text=Scene").first()).toBeVisible();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator("text=Take").first()).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.locator("text=Scene").first()).toBeVisible();
  // …and the playhead has not moved off the click position (select ≠ seek).
  const fracBefore = await playheadFrac(page);
  expect(fracBefore).toBeGreaterThan(0.02);

  // ⌘→ jumps the PLAYHEAD to the next scene's beginning AND selects it
  // (§72) — cursor there, scene selected, play starts from that point.
  await page.keyboard.press("Meta+ArrowRight");
  await expect.poll(() => playheadFrac(page)).toBeGreaterThan(5.0 / 31.92458 - 0.01);
  await expect(page.locator("text=Take").first()).toBeVisible();
  await page.keyboard.press("Meta+ArrowLeft");
  await expect.poll(() => playheadFrac(page)).toBeLessThan(0.02);
  await expect(page.locator("text=Scene").first()).toBeVisible();
});

test("ctrl/cmd+scroll on the preview zooms the view (R16 §73)", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  // The listener attached during the LOADING screen — to a node that did not
  // exist yet — so the documented shortcut was dead in every session. A real
  // ctrl-wheel dispatched at the stage is the regression test the buttons
  // could never be.
  await expect(page.getByTestId("view-zoom-level")).toHaveText("100%");
  await page.getByTestId("stage").evaluate((el) => {
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -240, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
  await expect
    .poll(async () => page.getByTestId("view-zoom-level").textContent())
    .not.toBe("100%");
  await page.getByTestId("view-zoom-fit").click();
  await expect(page.getByTestId("view-zoom-level")).toHaveText("100%");
});

test("the view follows the cursor out of the viewport (R16 §72)", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  // Zoom to 4× and park at the far left, then drive the cursor rightward by
  // keyboard alone — the timeline must scroll to keep it in view.
  await page.getByTestId("zoom-in").click();
  await page.getByTestId("zoom-in").click();
  const scroller = page.getByTestId("timeline-scroller");
  await scroller.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await page.getByTestId("timeline-block-scene-0").click();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Meta+ArrowRight");
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  const sb = (await scroller.boundingBox())!;
  const head = (await page.getByTestId("playhead").boundingBox())!;
  expect(head.x).toBeGreaterThanOrEqual(sb.x - 2);
  expect(head.x).toBeLessThanOrEqual(sb.x + sb.width + 2);
});

test("caption scale is a per-scene control like every other scale (R16 §64)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-0"));
  const word = page.locator("[data-caption-word]").first();
  await expect(word).toBeVisible();
  const sizeBefore = await word.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));

  const slider = page.getByTestId("caption-scale-slider");
  await slider.focus();
  await page.keyboard.press("End"); // 3× — the top of the range
  await expect
    .poll(() => word.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)))
    .toBeGreaterThan(sizeBefore * 2.5);
  // In-memory only — reloading elsewhere discards it; nothing was saved.
});

test("a strikethrough line's style is editable: struck, ✗ wrong, ✓ right (R16 §66)", async ({
  page,
}) => {
  const cleanDoc = await readFile(join(WORKDIR, "overrides.json"), "utf8").catch(() => "");
  await page.goto("/");
  await settle(page);
  // scene-2 is the fixture's StrikethroughReveal: "PROMPT" struck, "RUN
  // AGENTIC LOOPS" plain. Select the PLAIN line.
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-2"));
  await page.waitForSelector('[data-edit-id="line-1"]');
  const el = (await page.locator('[data-edit-id="line-1"]').boundingBox())!;
  await page.mouse.click(el.x + el.width / 2, el.y + el.height / 2);
  const style = page.getByTestId("line-style");
  await expect(style).toBeVisible();
  await expect(style).toHaveValue("plain");

  // ✓ right: the verdict glyph appears in the rendered scene.
  await style.selectOption("check");
  await expect(page.locator('[data-edit-scene="scene-2"]')).toContainText("✓");
  // struck: the whole-phrase fix the §66 report asked for — ANY line can be
  // struck from the editor now, not just the ones the producer chose.
  await style.selectOption("struck");
  await expect(page.locator('[data-edit-scene="scene-2"]')).not.toContainText("✓");
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  const lines = doc.scenes["scene-2"].props.lines;
  expect(lines[1].struck).toBe(true);
  expect(lines[0].struck).toBe(true); // untouched neighbour keeps its strike

  await page.request.put("/api/overrides", {
    data: cleanDoc || JSON.stringify({ theme: {}, scenes: {}, captions: {} }),
    headers: { "content-type": "application/json" },
  });
});

test("BulletList: an enumeration component, items editable from the panel (R16 §67)", async ({
  page,
}) => {
  const cleanDoc = await readFile(join(WORKDIR, "overrides.json"), "utf8").catch(() => "");
  await page.goto("/");
  await settle(page);
  // Swap scene-2 to the new component via the R13 component select — the
  // registry defaults render immediately.
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-2"));
  await page.locator("select").first().selectOption("BulletList");
  await page.waitForSelector('[data-edit-id="item-0"]');
  await expect(page.locator('[data-edit-scene="scene-2"]')).toContainText("▸");

  // Items are first-class editable elements: select one, retype in the panel.
  const el = (await page.locator('[data-edit-id="item-0"]').boundingBox())!;
  await page.mouse.click(el.x + el.width / 2, el.y + el.height / 2);
  await expect(page.getByTestId("element-text")).toBeVisible();
  await page.getByTestId("element-text").fill("AI HARNESS");
  await expect(page.locator('[data-edit-id="item-0"]')).toContainText("AI HARNESS");
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc.scenes["scene-2"].component).toBe("BulletList");
  expect(doc.scenes["scene-2"].props.items[0]).toBe("AI HARNESS");

  await page.request.put("/api/overrides", {
    data: cleanDoc || JSON.stringify({ theme: {}, scenes: {}, captions: {} }),
    headers: { "content-type": "application/json" },
  });
});

test("a split half inherits the original scene's edits (R16 §68)", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  // The reported flow: style a take's captions, split it, and the RIGHT half
  // used to fall back to default caption placement and scale. nth(1): the
  // FIRST take is the 0.09s sliver before scene-0 — too thin to split and
  // sitting under the parked playhead's grab zone. Ruler-seek mid-take
  // first: the click only selects now (field report 2026-08-07), and ⌘B
  // below cuts at the playhead.
  await selectBlockAt(page, page.locator('[data-testid^="timeline-block-take-"]').nth(1));
  const scaleSlider = page.getByTestId("caption-scale-slider");
  await scaleSlider.focus();
  await page.keyboard.press("End"); // 3×
  const ySlider = page.getByTestId("caption-y-slider");
  await ySlider.focus();
  await page.keyboard.press("Home"); // 0.05

  // ⌘B works with the slider still focused (§70's yield rule) — the
  // playhead is already parked mid-take by the ruler seek above.
  const blocks = page.locator('[data-testid^="timeline-block-"]');
  const before = await blocks.count();
  await page.keyboard.press("Meta+b");
  await expect(blocks).toHaveCount(before + 1);

  // Select the RIGHT half (the one whose id carries the `@<split id>` suffix;
  // the suffix is the split's minted id since §137, not its time — which is
  // why the locator matches on the `@` and nothing more) — its panel shows the
  // inherited style, not the defaults.
  await page.locator('[data-testid^="timeline-block-take-"][data-testid*="\\@"]').first().click();
  await expect(page.getByTestId("caption-scale-slider")).toHaveValue("3");
  await expect(page.getByTestId("caption-y-slider")).toHaveValue("0.05");
  // Unsaved throughout — reloading elsewhere discards the experiment.
});

test("playback keys yield from controls, arrows step frames, graphics exit softly (R16 §69-71)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await page.getByTestId("timeline-block-scene-0").click();

  // §71: plain arrows nudge the playhead one frame — even with a scene
  // selected (⌥/⌘+arrows own the bigger jumps).
  const frac0 = await playheadFrac(page);
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(() => playheadFrac(page)).toBeGreaterThan(frac0 + 0.003);
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Math.abs((await playheadFrac(page)) - frac0)).toBeLessThan(0.002);

  // §70: a freshly-scrubbed slider used to swallow SPACE. Now the key blurs
  // the control and drives the transport.
  await page.getByTestId("zoom-slider").focus();
  await page.keyboard.press("Space");
  await expect.poll(() => isPlaying(page)).toBe(true);
  await page.keyboard.press("Space");
  await expect.poll(() => isPlaying(page)).toBe(false);

  // §69: near its end the graphic is mid-exit — faded, not blinking out
  // after the layout has already moved on. Seek via the RULER: the scene's
  // final 0.3s sits under the block's own resize handle, which swallows a
  // block click there.
  const ruler = (await page.getByTestId("ruler").boundingBox())!;
  const seekTo = (t: number) =>
    page.mouse.click(ruler.x + (t / 31.92458) * ruler.width, ruler.y + ruler.height / 2);
  await seekTo(4.95); // scene-0 ends at 5.09 — inside the exit window
  const fade = page.locator('[data-edit-scene="scene-0"] > div').first();
  await expect
    .poll(() => fade.evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity)))
    .toBeLessThan(0.85);
  // …and mid-scene it is fully present.
  await seekTo(2.5);
  await expect
    .poll(() => fade.evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity)))
    .toBeGreaterThan(0.99);
});

test("transcript wraps in place, and the pane is drag-resizable (R16 §65)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await page.getByTestId("transcript-toggle").click();
  const body = page.getByTestId("transcript-body");
  await expect(body).toBeVisible();
  // The §65 report: caption lines rendered as unbreakable inline runs (no
  // whitespace between the word spans) and ran off the pane's right edge
  // behind a horizontal scrollbar. With real spaces they wrap in place —
  // and they stay real after 2026-08-18 round 3 moved each space INSIDE
  // the preceding span (to paint the selection band continuously): break
  // opportunities are the space characters, not the node boundaries, so
  // this assertion is the guard that the move kept the wrapping.
  expect(
    await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    "transcript must wrap, not scroll sideways",
  ).toBe(true);

  // Drag the divider right: the pane widens, the preview refits.
  const panel = page.getByTestId("transcript-panel");
  const before = (await panel.boundingBox())!;
  const stageBefore = (await page.getByTestId("stage").boundingBox())!;
  const divider = (await page.getByTestId("transcript-divider").boundingBox())!;
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await page.mouse.down();
  await page.mouse.move(divider.x + divider.width / 2 + 150, divider.y + 200, { steps: 5 });
  await page.mouse.up();
  const after = (await panel.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 120);
  // The stage yields the room: at this viewport the 9:16 preview is
  // height-bound, so its WIDTH holds while it shifts right; had it been
  // width-bound it would shrink. Either way it never overlaps the pane.
  await expect
    .poll(async () => (await page.getByTestId("stage").boundingBox())!.x)
    .toBeGreaterThan(stageBefore.x + 30);
  expect((await page.getByTestId("stage").boundingBox())!.width).toBeLessThanOrEqual(
    stageBefore.width + 1,
  );
  // …and still wrapping at the new width.
  expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

  // The width is remembered across a reload.
  await page.reload();
  await settle(page);
  await page.getByTestId("transcript-toggle").click();
  const reloaded = (await panel.boundingBox())!;
  expect(Math.abs(reloaded.width - after.width)).toBeLessThan(4);

  // Leave no residue for other tests' geometry.
  await page.evaluate(() => window.localStorage.removeItem("ossclip.transcriptWidth"));
});

test("pip bubble: roundness and placement are per-scene edits (R14 §52)", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-5"));
  await page.getByTestId("layout-select").selectOption("pip-bubble");

  // The PiP section appears with the layout switch, and the slot on stage is
  // the default circle.
  const slider = page.getByTestId("pip-roundness");
  await expect(slider).toBeVisible();
  const video = page.locator("[data-edit-video]");
  const radius = () =>
    video.evaluate((el) => Number.parseFloat(getComputedStyle(el).borderRadius));
  await expect.poll(radius).toBeGreaterThan(40);

  // Roundness to the minimum squares the mask off.
  await slider.focus();
  await page.keyboard.press("Home");
  await expect.poll(radius).toBeLessThan(1);

  // Placement: a smaller pip-y lifts the bubble.
  const topBefore = (await video.boundingBox())!.y;
  await page.getByTestId("field-pip-y").fill("0.2");
  await expect.poll(async () => (await video.boundingBox())!.y).toBeLessThan(topBefore - 20);

  // On disk: one pip object under the scene, exactly what the panel showed.
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc.scenes["scene-5"].pip).toEqual({ cornerRadius: 0, y: 0.2 });

  // Leave no residue for later tests: reset the bubble, restore the layout,
  // save the clean doc back.
  await page.getByTestId("reset-pip").click();
  await page.getByTestId("layout-select").selectOption("blurred-behind");
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
});

test("undo/redo: toolbar buttons and ⌘⇧Z walk the history both ways (R17 §80)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  const undoBtn = page.getByTestId("undo-button");
  const redoBtn = page.getByTestId("redo-button");
  // A fresh session has no history in either direction.
  await expect(undoBtn).toBeDisabled();
  await expect(redoBtn).toBeDisabled();

  // One observable edit: split scene-0 at the playhead — parked mid-scene by
  // the ruler half of selectBlockAt (the block click alone no longer seeks,
  // field report 2026-08-07, and a split at 0 would produce no new block).
  const blocks = page.locator('[data-testid^="timeline-block-"]');
  const before = await blocks.count();
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-0"));
  await page.keyboard.press("Meta+b");
  await expect(blocks).toHaveCount(before + 1);
  await expect(undoBtn).toBeEnabled();

  // The button pair walks it back and forth.
  await undoBtn.click();
  await expect(blocks).toHaveCount(before);
  await expect(redoBtn).toBeEnabled();
  await redoBtn.click();
  await expect(blocks).toHaveCount(before + 1);

  // The keyboard pair does the same.
  await page.keyboard.press("Meta+z");
  await expect(blocks).toHaveCount(before);
  await page.keyboard.press("Meta+Shift+z");
  await expect(blocks).toHaveCount(before + 1);

  // A NEW edit after an undo abandons the redo branch — the universal
  // contract, and the reason redo needs no confirmation dialog.
  await page.keyboard.press("Meta+z");
  await expect(blocks).toHaveCount(before);
  await page.keyboard.press("Meta+b");
  await expect(blocks).toHaveCount(before + 1);
  await expect(redoBtn).toBeDisabled();
  await page.keyboard.press("Meta+z");
  await expect(blocks).toHaveCount(before);
});

test("transcript find: chevrons and Enter walk the matches with a counter (R17 §81)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await page.getByTestId("transcript-toggle").click();
  // "free" appears exactly twice in the fixture — indices 10 and 90, far
  // enough apart that walking between them must scroll the pane.
  await page.getByTestId("transcript-search").fill("free");
  const count = page.getByTestId("transcript-match-count");
  await expect(count).toHaveText("1/2 matches");
  await expect(page.getByTestId("transcript-word-10")).toBeInViewport();

  await page.getByTestId("transcript-next").click();
  await expect(count).toHaveText("2/2 matches");
  await expect(page.getByTestId("transcript-word-90")).toBeInViewport();

  // Walking past the end wraps — the usual finder behaviour.
  await page.getByTestId("transcript-next").click();
  await expect(count).toHaveText("1/2 matches");
  await page.getByTestId("transcript-prev").click();
  await expect(count).toHaveText("2/2 matches");

  // Enter / ⇧Enter in the box are the keyboard chevrons.
  await page.getByTestId("transcript-search").press("Enter");
  await expect(count).toHaveText("1/2 matches");
  await page.getByTestId("transcript-search").press("Shift+Enter");
  await expect(count).toHaveText("2/2 matches");

  // No matches is said outright, and the chevrons disable.
  await page.getByTestId("transcript-search").fill("zzzznothing");
  await expect(count).toHaveText("0 matches");
  await expect(page.getByTestId("transcript-next")).toBeDisabled();
});

test("view zoom shrinks below 100% for arranging, floored at 25% (R17 §82)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await expect(page.getByTestId("view-zoom-level")).toHaveText("100%");
  const fitWidth = (await page.getByTestId("stage").boundingBox())!.width;

  // − below the fitted size actually shrinks the Player — real width, not a
  // CSS transform, so gesture calibration holds at every zoom.
  await page.getByTestId("view-zoom-out").click();
  await expect(page.getByTestId("view-zoom-level")).toHaveText("50%");
  await expect
    .poll(async () => (await page.getByTestId("stage").boundingBox())!.width)
    .toBeLessThan(fitWidth * 0.6);

  await page.getByTestId("view-zoom-out").click();
  await expect(page.getByTestId("view-zoom-level")).toHaveText("25%");
  await expect(page.getByTestId("view-zoom-out")).toBeDisabled();

  await page.getByTestId("view-zoom-fit").click();
  await expect(page.getByTestId("view-zoom-level")).toHaveText("100%");
});

test("Open raises the project picker; a recent click reopens the project (R17 §83)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await page.getByTestId("open-button").click();
  const picker = page.getByTestId("project-picker");
  await expect(picker).toBeVisible();
  // The folder browser lists real directories from the server.
  await expect(page.getByTestId("project-fs-list")).toBeVisible();
  // Esc dismisses the switcher (a project is open — there is a way back).
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  // The server recorded this workdir as recent when it opened it — clicking
  // that entry drives the full switch path: POST /api/workdir, reload, and
  // the picker closes on success.
  await page.getByTestId("open-button").click();
  const recent = page.getByTestId("project-recent").first();
  await expect(recent).toBeVisible();
  await recent.click();
  await expect(picker).toHaveCount(0);
  await settle(page);
  await expect(page.getByTestId("timeline-block-scene-0")).toBeVisible();
  // The top bar names the open project.
  await expect(page.getByTestId("workdir-label")).toBeVisible();
});

test("a component's boolean props are editable from the Inspector (§153)", async ({ page }) => {
  // Before this, the Inspector only rendered a Text field, and only for STRING
  // props — so a component's booleans had no control anywhere in the UI and
  // were reachable only by hand-editing overrides.json. The controls are
  // derived from the component's own schema, so this also proves the editor
  // can read the registry in the browser bundle.
  await page.goto("/");
  await settle(page);

  // StatCard.inverted — false in the fixture.
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-0"));
  const inverted = page.getByTestId("prop-inverted");
  await expect(inverted).toBeVisible();
  await expect(inverted).not.toBeChecked();
  await inverted.check();
  await expect(inverted).toBeChecked();

  // ScreenshotFrame.kenBurns — the schema default is TRUE, and the checkbox
  // must report what the scene actually renders rather than assuming false.
  await selectBlockAt(page, page.getByTestId("timeline-block-scene-3"));
  const kenBurns = page.getByTestId("prop-kenBurns");
  await expect(kenBurns).toBeVisible();
  await expect(kenBurns).toBeChecked();

  // The screenshot's own content is reachable too: its data-edit-id used to be
  // "image" while the prop is "src", so selecting it offered nothing to edit.
  await expect(page.locator('[data-edit-id="src"]').first()).toHaveCount(1);
});

test("color grade: picking a preset previews live and saves the doc-global override", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);

  // The Color section rides the NO-selection panel (doc-global, like the
  // theme tokens) — a fresh load has nothing selected, so it is already up.
  const source = page.getByTestId("grade-source");
  await expect(source).toBeVisible();

  // The fixture workdir has no baked grade and no config default, so the
  // stage starts filter-free — the assertion below is then unambiguous.
  await expect(page.locator('filter[id^="ossclip-grade-"]')).toHaveCount(0);
  await source.selectOption("preset:punchy");

  // Live preview, parametric path: the spec is computed client-side with
  // core's own gradeToSvgFilterSpec and lands in the Player's props — the
  // VideoStage mounts its SVG filter the moment the prop arrives.
  await expect(page.locator('filter[id^="ossclip-grade-"]').first()).toBeAttached();
  // …and the sliders appear, showing the preset's own default intensity.
  await expect(page.getByTestId("grade-intensity")).toBeVisible();

  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc.colorGrade).toEqual({ preset: "punchy" });

  // "Off" is an explicit false, not a deleted key — produce's override layer
  // treats them differently (off vs fall-through), so the write must too.
  await source.selectOption("off");
  await expect(page.locator('filter[id^="ossclip-grade-"]')).toHaveCount(0);
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc2 = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc2.colorGrade).toBe(false);
});

test("click-away deselects, and the sidebar resizes by its edge (field report 2026-08-31)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);

  // Select a block — the Inspector leaves the global panel.
  await selectBlockAt(page, page.locator('[data-testid^="timeline-block-"]').first());
  await expect(page.getByText("Nothing selected — global tokens.")).toHaveCount(0);

  // A press on the empty dark area AROUND the player clears the selection.
  // The stage is centered, so a point just inside the stage area's left edge
  // (vertically centered, clear of the zoom bar) is outside the stage box.
  const area = (await page.getByTestId("stage").locator("..").locator("..").boundingBox())!;
  await page.mouse.click(area.x + 8, area.y + area.height * 0.5);
  await expect(page.getByText("Nothing selected — global tokens.")).toBeVisible();

  // The sidebar's left edge drags to resize, and the width sticks.
  const sidebar = page.getByTestId("sidebar");
  const before = (await sidebar.boundingBox())!;
  const handle = (await page.getByTestId("sidebar-resize").boundingBox())!;
  await page.mouse.move(handle.x + 3, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 100, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  const after = (await sidebar.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 50);
});

test("click-away also clears the transcript selection and its menu (field report 2026-08-31)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await page.getByTestId("transcript-toggle").click();
  await expect(page.getByTestId("transcript-panel")).toBeVisible();

  // Select a word — the anchored selection menu appears.
  await page.getByTestId("transcript-word-3").click();
  await expect(page.getByTestId("transcript-selection-menu")).toBeVisible();

  // A press on the empty stage area (outside the panel) closes the menu and
  // drops the selection — same gesture that deselects a timeline block.
  const area = (await page.getByTestId("stage").locator("..").locator("..").boundingBox())!;
  await page.mouse.click(area.x + 8, area.y + area.height * 0.5);
  await expect(page.getByTestId("transcript-selection-menu")).toHaveCount(0);
});
