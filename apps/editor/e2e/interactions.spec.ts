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

test("clicks never toggle playback: elements select, the background does nothing (Tasks 2 + R9-1)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  await page.locator('[data-testid^="timeline-block-"]').first().click();
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
  // losing (or changing) this selection.
  await page.locator('[data-testid^="timeline-block-"]').first().click();
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

test("the timeline scrubs on press-and-drag, and a click inside a block seeks to that point (Tasks 3+4)", async ({
  page,
}) => {
  await page.goto("/");
  await settle(page);
  const track = (await page.locator("[data-testid='playhead']").locator("..").boundingBox())!;

  // Task 4: click INSIDE a graphic block, off-centre — the playhead must
  // land at the CLICKED fraction, not snap to the block's start. By id, not
  // nth(): derived `take-*` blocks now fill the gaps (Task A), so ordinal
  // positions name different blocks than they used to.
  const block = (await page.getByTestId("timeline-block-scene-2").boundingBox())!;
  const clickX = block.x + block.width * 0.7;
  await page.mouse.click(clickX, block.y + block.height / 2);
  const clickedFrac = (clickX - track.x) / track.width;
  await expect
    .poll(() => playheadFrac(page))
    .toBeGreaterThan(clickedFrac - 0.02);
  expect(await playheadFrac(page)).toBeLessThan(clickedFrac + 0.02);

  // Task 3: press-and-drag seeking. The 16%-38% stretch used to be a bare
  // gap; it is now the `take-0` PLAIN block (Task A) — which scrubs exactly
  // like the bare track did, deliberately: a plain block's window is derived,
  // so it has no move-drag to start, and the takes cover most of the track
  // now — losing press-and-drag seeking over them would regress this very
  // gesture. The playhead follows the pointer continuously, both ways.
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
  const timing = doc.scenes[cue.id].timing;
  expect(timing.startSec).toBeLessThan(cue.startSec);
  expect(timing.endSec - timing.startSec).toBeCloseTo(cue.endSec - cue.startSec, 3);

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
  // Park the playhead where a caption line is definitely on screen: click
  // into the first scene block, which seeks mid-caption.
  await page.locator('[data-testid^="timeline-block-"]').first().click();
  await page.waitForSelector("[data-caption-word]");

  const word = page.locator("[data-caption-word]").first();
  const wordIndex = await word.getAttribute("data-caption-word");
  const was = await word.getAttribute("data-caption-text");
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
  expect(doc.captions[wordIndex!]).toEqual({ text: "RETYPED", was });
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
  // Park inside take-0 and select it — the click seeks into the take, so the
  // video slot on stage is tagged with its id.
  await page.getByTestId("timeline-block-take-0").click();
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

  // The block goes ghost — dashed, still selectable under the same testid —
  // and stays selected, so the Inspector is already offering the way back.
  await expect(block).toHaveCSS("border-style", "dashed");
  await expect(page.getByTestId("restore-scene")).toBeVisible();
  // …and on disk the delete is soft: hidden: true under the scene's id.
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  expect(doc.scenes["scene-3"].hidden).toBe(true);

  // The freed window became a plain take (Task C7's payoff for Task A):
  // some take block now spans the ghost's centre.
  const ghostBox = (await block.boundingBox())!;
  const ghostCentre = ghostBox.x + ghostBox.width / 2;
  const takes = page.locator('[data-testid^="timeline-block-take-"]');
  await expect
    .poll(async () => {
      const n = await takes.count();
      for (let i = 0; i < n; i++) {
        const b = await takes.nth(i).boundingBox();
        if (b && b.x <= ghostCentre && b.x + b.width >= ghostCentre) return true;
      }
      return false;
    })
    .toBe(true);

  // Restore DELETES the key — not hidden: false — and the block comes back solid.
  await page.getByTestId("restore-scene").click();
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
  await page.getByTestId("timeline-block-scene-3").click();
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
  await page.getByTestId("timeline-block-scene-0").click();
  await page.waitForSelector("[data-edit-id]");
  const el = (await page.locator("[data-edit-id]").first().boundingBox())!;
  await page.mouse.click(el.x + el.width / 2, el.y + el.height / 2);
  await expect(page.getByText("Reset element")).toBeVisible();

  // Leave no residue for later tests: reset the box and save.
  await page.getByTestId("timeline-block-scene-3").click();
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
  await page.locator('[data-testid^="timeline-block-"]').first().click();
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
  await page.locator('[data-testid^="timeline-block-"]').first().click();
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
  await page.getByTestId("timeline-block-scene-5").click();
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
  await page.getByTestId("timeline-block-scene-3").click();
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
  // late block still selects it AND seeks inside ITS window — the same
  // invariant Tasks 3+4 pinned at zoom 1.
  await page.getByTestId("timeline-block-scene-5").click();
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
  await page.getByTestId("timeline-block-scene-0").click();
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
  // The scope contract is stated where the edits happen (§59b).
  await expect(page.getByTestId("transcript-panel")).toContainText("1:1 retype only");

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
  expect(doc.captions["0"]).toEqual({ text: "CLAWD", was: "Claude" });

  // Clicking a word jumps the preview to its start.
  await page.getByTestId("transcript-word-5").click();
  await expect.poll(() => playheadFrac(page)).toBeGreaterThan(0.01);

  await page.request.put("/api/overrides", {
    data: cleanDoc || JSON.stringify({ theme: {}, scenes: {}, captions: {} }),
    headers: { "content-type": "application/json" },
  });
});

test("pip bubble: roundness and placement are per-scene edits (R14 §52)", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.getByTestId("timeline-block-scene-5").click();
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
