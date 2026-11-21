import { test, expect, type Page } from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;
const PRODUCTION = join(WORKDIR, "production.json");
const OVERRIDES = join(WORKDIR, "overrides.json");
const PROPS = join(WORKDIR, "render-props.json");

/**
 * Adding a template graphic from a transcript selection, end to end
 * (editor-added-graphics §5): the bar's Graphic…, the type list, the form,
 * Add, the block on the timeline and on stage, undo, Save and reload, and
 * the overlap refusal — through the real edit server and reducer.
 *
 * An add made since the last run previews only with the repaired word list
 * (`/api/sfx/plan`'s `words`, §4), and the committed fixture's
 * production.json carries no transcript, so this file gives it one — the
 * caption words flattened, the `overlays` spec's arrangement, so panel word
 * N is transcript word N. Starts from NO overrides.json (another spec's
 * retype or cut must not move a word under it) and restores both after. Its
 * own serialized project, last, for the reason every rewriter is.
 *
 * Words 20–24 ("people use AI very regularly.", 5.46–7.85 s) sit in the gap
 * between scene-0 (ends 5.09) and scene-2 (starts 12.1), clear of both even
 * after the 3 s floor this 32 s video gets. Serial: the block the first test
 * saves is the one the overlap test is refused by.
 */

test.describe.configure({ mode: "serial" });

const FROM = 20;
const TO = 24;
const TITLE = "Agents in a loop";

let originalProduction: string | null = null;
let originalOverrides: string | null = null;

test.beforeAll(async () => {
  originalProduction = await readFile(PRODUCTION, "utf8");
  originalOverrides = await readFile(OVERRIDES, "utf8").catch(() => null);
  const props = JSON.parse(await readFile(PROPS, "utf8")) as {
    captionLines: { words: { text: string; start: number; end: number }[] }[];
  };
  const words = props.captionLines.flatMap((l) => l.words.map(({ text, start, end }) => ({ text, start, end })));
  expect(words.slice(FROM, TO + 1).map((w) => w.text)).toEqual(["people", "use", "AI", "very", "regularly."]);
  const production = JSON.parse(originalProduction);
  production.transcript = { language: "en", words };
  await writeFile(PRODUCTION, JSON.stringify(production));
  await rm(OVERRIDES, { force: true });
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

/** Park the playhead inside a block through the ruler — the seek surface. */
const seekInto = async (page: Page, testid: string) => {
  const b = (await page.getByTestId(testid).boundingBox())!;
  const ruler = (await page.getByTestId("ruler").boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.4, ruler.y + ruler.height / 2);
};

const selectRun = async (page: Page, from: number, to: number) => {
  await page.getByTestId(`transcript-word-${from}`).click();
  await page.getByTestId(`transcript-word-${to}`).click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("transcript-selection-menu")).toContainText(`${to - from + 1} words`);
};

const addedDoc = async () =>
  (JSON.parse(await readFile(OVERRIDES, "utf8")) as { addedScenes?: Record<string, unknown>[] }).addedScenes;

test("select words, Graphic…, TitleCard, type, Add: a block on the timeline and on stage; undo takes it away", async ({
  page,
}) => {
  await open(page);
  await selectRun(page, FROM, TO);
  await page.getByTestId("transcript-add-graphic").click();
  const popover = page.getByTestId("transcript-add-graphic-popover");
  await expect(popover).toBeVisible();
  await expect(page.getByTestId("add-graphic-words")).toContainText("people use AI very regularly.");
  // A fresh add with a clock and a word list previews at once: no deferral note.
  await expect(page.getByTestId("add-graphic-note")).toHaveCount(0);
  await page.getByTestId("add-graphic-type-TitleCard").click();
  // Prefilled with the selection — it fits TitleCard's 48.
  const title = page.getByTestId("add-graphic-field-title");
  await expect(title).toHaveValue("people use AI very regularly.");
  await title.fill(TITLE);
  await page.getByTestId("add-graphic-add").click();
  await expect(popover).toHaveCount(0);

  const block = page.getByTestId("timeline-block-added-1");
  await expect(block).toBeVisible();
  await seekInto(page, "timeline-block-added-1");
  await expect(page.getByTestId("stage")).toContainText(TITLE);

  await page.keyboard.press("Control+z");
  await expect(block).toHaveCount(0);
  await expect(page.getByTestId("stage")).not.toContainText(TITLE);
});

test("Save and reload: the added block is still there", async ({ page }) => {
  await open(page);
  await selectRun(page, FROM, TO);
  await page.getByTestId("transcript-add-graphic").click();
  await page.getByTestId("add-graphic-type-TitleCard").click();
  await page.getByTestId("add-graphic-field-title").fill(TITLE);
  await page.getByTestId("add-graphic-add").click();
  await expect(page.getByTestId("timeline-block-added-1")).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);

  const added = await addedDoc();
  expect(added).toHaveLength(1);
  expect(added![0]).toMatchObject({ id: "added-1", component: "TitleCard", props: { title: TITLE }, srcStart: 5.46 });
  // The last word's source end: the fixture's spans are the identity.
  expect(added![0]!.srcEnd as number).toBeCloseTo(7.85, 6);

  await page.reload();
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  await expect(page.getByTestId("timeline-block-added-1")).toBeVisible();
  await seekInto(page, "timeline-block-added-1");
  await expect(page.getByTestId("stage")).toContainText(TITLE);
});

test("an overlapping selection is refused with the reason — a planned block and an added one alike", async ({
  page,
}) => {
  await open(page);
  const refusal = page.getByTestId("add-graphic-refusal");

  await page.getByTestId("transcript-word-0").click();
  await page.getByTestId("transcript-add-graphic").click();
  await expect(refusal).toHaveText(
    "These words overlap the graphic ‘StatCard’ at 0:00. Trim that block or pick other words.",
  );
  await expect(page.locator('[data-testid^="add-graphic-type-"]')).toHaveCount(0);
  // Escape closes the popover and keeps the selection: the bar is back.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("transcript-add-graphic-popover")).toHaveCount(0);
  await expect(page.getByTestId("transcript-selection-menu")).toContainText("1 word");

  // The block the previous test saved counts like any other.
  await page.getByTestId("transcript-word-22").click();
  await page.getByTestId("transcript-add-graphic").click();
  await expect(refusal).toHaveText(
    "These words overlap the graphic ‘TitleCard’ at 0:05. Trim that block or pick other words.",
  );
});

test("the transcript's own gestures still work with Graphic… on the bar", async ({ page }) => {
  await open(page);
  const bar = page.getByTestId("transcript-selection-menu");

  // Drag-select.
  const from = (await page.getByTestId("transcript-word-3").boundingBox())!;
  const to = (await page.getByTestId("transcript-word-5").boundingBox())!;
  await page.mouse.move(from.x + 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(bar).toContainText("3 words");
  await expect(page.getByTestId("transcript-add-graphic")).toBeVisible();

  // Shift-extend — backwards, onto a word above the bar (it hangs under the
  // selection and covers the next line). The anchor stays at word 3.
  await page.getByTestId("transcript-word-0").click({ modifiers: ["Shift"] });
  await expect(bar).toContainText("4 words");

  // ✕ clears.
  await page.getByTestId("transcript-selection-clear").click();
  await expect(bar).toHaveCount(0);

  // Double-click retypes.
  await page.getByTestId("transcript-word-40").dblclick();
  const edit = page.getByTestId("transcript-edit");
  await expect(edit).toBeVisible();
  await edit.press("Escape");
  await expect(edit).toHaveCount(0);
});
