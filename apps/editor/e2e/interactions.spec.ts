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
