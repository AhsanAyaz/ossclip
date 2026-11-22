import { test, expect, type Page } from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;
const PRODUCTION = join(WORKDIR, "production.json");
const OVERRIDES = join(WORKDIR, "overrides.json");

/**
 * The graphic editor end to end (graphic-editor-modal §5, §6): an add with a
 * pinned item, the stage entering that item on its word, Save and reload, an
 * edit that re-finds an auto item's word, the When row's timing pin, a
 * planner graphic saved unchanged, and the author's overlap report — through
 * the real edit server, reducer and live preview.
 *
 * The committed fixture's production.json has no transcript, so items have
 * no words to land on; this file gives it one, the caption words flattened
 * (the `added-graphics` spec's arrangement, so panel word N is transcript
 * word N on the fixture's identity clock). It starts from an overrides.json
 * that hides scene-0 (a StatCard over words 0–18), which the report's case
 * needs: a bullet list over the first words. Restores both after. Its own
 * serialized project, last, for the reason every rewriter is.
 *
 * Words 20–35 ("people use AI … expect an outcome which is", 5.46–11.04 s)
 * sit between scene-0 and scene-2 (12.1 s); words 75–78 (22.88–24.01 s)
 * between scene-3 (ends 21.76) and scene-5 (27.61), clear of both after
 * the 3 s floor.
 */

test.describe.configure({ mode: "serial" });

const HIDE_SCENE_0 = JSON.stringify({ scenes: { "scene-0": { hidden: true } } });
const ITEMS = ["use AI", "give a prompt", "expect an outcome"];

let originalProduction: string | null = null;
let originalOverrides: string | null = null;
/** Each transcript word's start, by index (identity clock: source == output). */
let starts: number[] = [];

test.beforeAll(async () => {
  originalProduction = await readFile(PRODUCTION, "utf8");
  originalOverrides = await readFile(OVERRIDES, "utf8").catch(() => null);
  const props = JSON.parse(await readFile(join(WORKDIR, "render-props.json"), "utf8")) as {
    captionLines: { words: { text: string; start: number; end: number }[] }[];
  };
  const words = props.captionLines.flatMap((l) => l.words.map(({ text, start, end }) => ({ text, start, end })));
  expect(words.slice(20, 34).map((w) => w.text).join(" ")).toBe(
    "people use AI very regularly. They give a prompt and then expect an outcome",
  );
  starts = words.map((w) => w.start);
  const production = JSON.parse(originalProduction);
  production.transcript = { language: "en", words };
  await writeFile(PRODUCTION, JSON.stringify(production));
  await writeFile(OVERRIDES, HIDE_SCENE_0);
});

test.afterAll(async () => {
  if (originalProduction !== null) await writeFile(PRODUCTION, originalProduction);
  if (originalOverrides !== null) await writeFile(OVERRIDES, originalOverrides);
  else await rm(OVERRIDES, { force: true });
});

const open = async (page: Page) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  await page.getByTestId("transcript-toggle").click();
  await expect(page.getByTestId("transcript-panel")).toBeVisible();
};

/** Select a run of transcript words. The shift-click is dispatched: the bar
 * hangs under the selection and covers the next line's words. */
const selectRun = async (page: Page, from: number, to: number) => {
  await page.getByTestId(`transcript-word-${from}`).click();
  if (to !== from) await page.getByTestId(`transcript-word-${to}`).dispatchEvent("click", { shiftKey: true });
  await expect(page.getByTestId("transcript-selection-menu")).toContainText(`${to - from + 1} words`);
};

const saved = async () =>
  JSON.parse(await readFile(OVERRIDES, "utf8")) as {
    addedScenes?: { id: string; component: string; props: Record<string, unknown> }[];
    scenes: Record<string, { itemPins?: { component: string; pins: ({ src: number; text: string } | null)[] }; timing?: Record<string, number> }>;
  };

/** Graphic… over `from`..`to`: the modal opens, or says why it will not. */
const graphicOver = async (page: Page, from: number, to: number) => {
  await selectRun(page, from, to);
  await page.getByTestId("transcript-add-graphic").click();
  await expect(page.getByTestId("graphic-editor")).toBeVisible();
};

/** Choose BulletList and type the items. */
const bulletList = async (page: Page, items: string[]) => {
  await page.getByTestId("graphic-editor-type-BulletList").click();
  for (const [k, text] of items.entries()) {
    await page.getByTestId("graphic-editor-add-item").click();
    await page.getByTestId(`graphic-editor-item-${k}`).fill(text);
  }
};

/** The stage's bullet `k`, as the scene draws it (its `item-k` edit id). */
const stageItem = (page: Page, k: number) => page.getByTestId("stage").locator(`[data-edit-id="item-${k}"]`);
const opacity = async (page: Page, k: number) =>
  Number(await stageItem(page, k).evaluate((el) => getComputedStyle(el).opacity));

test("the author's report: a bullet list over the first words, then a selection far later is not refused — after a drag, and after Save and reload", async ({
  page,
}) => {
  await open(page);
  await graphicOver(page, 0, 11);
  await bulletList(page, ["Claude gave me", "the max plan"]);
  await page.getByTestId("graphic-editor-save").click();
  await expect(page.getByTestId("timeline-block-added-1")).toBeVisible();

  const notRefused = async () => {
    await graphicOver(page, 75, 78);
    await expect(page.getByTestId("graphic-editor-refusal")).toHaveCount(0);
    await expect(page.getByTestId("graphic-editor-type-TitleCard")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("graphic-editor")).toHaveCount(0);
  };
  // Not rendered: the add previews from the doc alone.
  await notRefused();

  // The block's right edge dragged out (a src timing pin).
  const block = page.getByTestId("timeline-block-added-1");
  await block.click();
  const before = (await block.boundingBox())!;
  const handle = (await block.locator('div[style*="ew-resize"]').last().boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await block.boundingBox())!.width).toBeGreaterThan(before.width + 20);
  await notRefused();

  // Saved and read back.
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  expect((await saved()).addedScenes?.map((e) => e.component)).toEqual(["BulletList"]);
  await page.reload();
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  await page.getByTestId("transcript-toggle").click();
  await notRefused();

  // The rest of the file starts from the hidden StatCard alone.
  await writeFile(OVERRIDES, HIDE_SCENE_0);
});

test("add a bullet list, pin item 3, Add: the stage enters item 3 on its word", async ({ page }) => {
  await open(page);
  await graphicOver(page, 20, 35);
  await bulletList(page, ITEMS);
  // Auto items found their words from the first preview (G2).
  await expect(page.getByTestId("graphic-editor-lands-0")).toHaveAttribute("data-state", "auto");
  await expect(page.getByTestId("graphic-editor-lands-2")).toContainText("“expect”");
  // Pin item 3 on "outcome" (33).
  await page.getByTestId("graphic-editor-lands-2").click();
  await expect(page.getByTestId("graphic-editor-picking")).toContainText("Pick the word item 3 lands on");
  await page.getByTestId("graphic-editor-word-33").click();
  await expect(page.getByTestId("graphic-editor-lands-2")).toHaveAttribute("data-state", "pinned");
  await expect(page.getByTestId("graphic-editor-lands-2")).toContainText("“outcome”");
  // Focus is back on the box the pick started from.
  await expect(page.getByTestId("graphic-editor-lands-2")).toBeFocused();
  await page.getByTestId("graphic-editor-save").click();
  await expect(page.getByTestId("graphic-editor")).toHaveCount(0);
  await expect(page.getByTestId("timeline-block-added-1")).toBeVisible();

  // Item 3 enters ITEM_LEAD_SEC (0.15 s) before "outcome" (10.04 s): not
  // yet on "expect" (9.31 s), whole by "is" (10.88 s). Clicking a word seeks
  // the stage to it (dispatched: the selection bar may cover the word).
  const seekWord = (i: number) => page.getByTestId(`transcript-word-${i}`).dispatchEvent("click");
  await seekWord(31);
  await expect.poll(() => opacity(page, 2)).toBe(0);
  await expect.poll(() => opacity(page, 1)).toBeGreaterThan(0.99);
  await seekWord(35);
  await expect.poll(() => opacity(page, 2)).toBeGreaterThan(0.99);

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = await saved();
  expect(doc.addedScenes).toEqual([
    expect.objectContaining({ id: "added-1", component: "BulletList", props: { items: ITEMS } }),
  ]);
  expect(doc.scenes["added-1"]!.itemPins).toEqual({
    component: "BulletList",
    pins: [null, null, { src: starts[33], text: "expect an outcome" }],
  });
});

test("Save and reload: item 3 is still pinned; editing an auto item's text moves its marker; the When row writes a timing pin", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("timeline-block-added-1").click();
  await page.getByTestId("edit-graphic").click();
  const modal = page.getByTestId("graphic-editor");
  await expect(modal).toBeVisible();
  // Edit hides the type column and says Save.
  await expect(page.locator('[data-testid^="graphic-editor-type-"]')).toHaveCount(0);
  await expect(page.getByTestId("graphic-editor-save")).toHaveText("Save");
  await expect(page.getByTestId("graphic-editor-lands-2")).toHaveAttribute("data-state", "pinned");
  await expect(page.getByTestId("graphic-editor-word-33").locator('[data-mark="pinned"]')).toHaveText("3");

  // Item 2 "give a prompt" is on "give" (26); "then expect" finds "expect" (31).
  await expect(page.getByTestId("graphic-editor-word-26").locator('[data-mark="auto"]')).toHaveText("2");
  await page.getByTestId("graphic-editor-item-1").fill("then expect");
  await expect(page.getByTestId("graphic-editor-word-26").locator('[data-mark="auto"]')).toHaveCount(0);
  await expect(page.getByTestId("graphic-editor-word-31").locator('[data-mark="auto"]')).toHaveText("2");

  // The block starts on "people" (20) and item 1 on "use" (21): the start
  // flag is up, and "Start with item 1" moves the start onto item 1's word.
  await expect(page.getByTestId("graphic-editor-word-20").locator('[data-mark="start"]')).toBeVisible();
  await page.getByTestId("graphic-editor-start-item1").click();
  await expect(page.getByTestId("graphic-editor-start")).toContainText("With item 1");
  await page.getByTestId("graphic-editor-save").click();
  await expect(modal).toHaveCount(0);

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const scene = (await saved()).scenes["added-1"]!;
  // ENTRY_LEAD_SEC (0.3 s) ahead of "use", on the identity clock.
  expect(scene.timing!.srcStart).toBeCloseTo(starts[21]! - 0.3, 3);
  expect(scene.timing!.srcEnd).toBeGreaterThan(starts[33]!);
  expect(scene.itemPins!.pins[1]).toBeNull();
  expect((await saved()).addedScenes![0]!.props).toEqual({ items: ITEMS });
  expect((await saved()).scenes["added-1"]).toMatchObject({ props: { items: [ITEMS[0], "then expect", ITEMS[2]] } });
});

test("a planner graphic saved without changes leaves overrides.json as it was", async ({ page }) => {
  await open(page);
  const before = await readFile(OVERRIDES, "utf8");
  await page.getByTestId("timeline-block-scene-2").click();
  await page.getByTestId("edit-graphic").click();
  await expect(page.getByTestId("graphic-editor")).toBeVisible();
  await page.getByTestId("graphic-editor-save").click();
  await expect(page.getByTestId("graphic-editor")).toHaveCount(0);
  // Nothing was dispatched: no unsaved edit, no undo step, the file untouched.
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  await page.keyboard.press("Control+s");
  expect(await readFile(OVERRIDES, "utf8")).toBe(before);
});

test("opening the modal pauses the stage, from Graphic… and from the Inspector", async ({ page }) => {
  await open(page);
  const playing = () => page.getByTestId("stage").getAttribute("data-playing");
  // From the Inspector: a block selected, the stage playing.
  await page.getByTestId("timeline-block-scene-2").click();
  await page.keyboard.press("Space");
  await expect.poll(playing).toBe("true");
  await page.getByTestId("edit-graphic").click();
  await expect(page.getByTestId("graphic-editor")).toBeVisible();
  await expect.poll(playing).toBe("false");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("graphic-editor")).toHaveCount(0);

  // From the transcript's Graphic….
  // Space with the selection up still drives the transport (the panel
  // claims no Space).
  await selectRun(page, 75, 78);
  await page.keyboard.press("Space");
  await expect.poll(playing).toBe("true");
  await page.getByTestId("transcript-add-graphic").click();
  await expect(page.getByTestId("graphic-editor")).toBeVisible();
  await expect.poll(playing).toBe("false");
});
