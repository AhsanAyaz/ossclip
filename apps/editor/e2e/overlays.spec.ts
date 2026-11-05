import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;
const HOME = process.env.OSSCLIP_E2E_HOME!;
const LIBRARY = join(HOME, ".ossclip", "library");
const PRODUCTION = join(WORKDIR, "production.json");
const OVERRIDES = join(WORKDIR, "overrides.json");
const PROPS = join(WORKDIR, "render-props.json");

/**
 * The overlay library end to end (overlay-library spec §Editor): the tray's
 * paste-a-path add, the Inspector's look and swap, delete, and "Find library
 * matches" — through the real edit server, against a library that lives in
 * the TEMP HOME playwright.config.ts builds (ruling R7), never ~/.ossclip.
 *
 * The committed fixture's production.json carries no transcript, so the
 * overlay lane (which needs production.json's word space) is not drawn for
 * any other spec. This file gives it one — the caption words, flattened, so
 * transcript-panel word N and placement word N are the same word — and starts
 * from NO overrides.json, so a cut another spec saved cannot move a word out
 * from under it. Both files are restored after. Its own serialized project
 * (playwright.config.ts), last, for the reason every rewriter is.
 *
 * The four tests are SERIAL and build on each other — the chip the first one
 * adds is the one the next ones edit, the way a user would.
 *
 * Find matches places "max plan" (the seeded library entry): the fixture says
 * "the max plan" at words 6–8, so the first mention is word 7. (The plan's
 * brief used "clean edit" at word 19, which this fixture never says.)
 */

test.describe.configure({ mode: "serial" });

let originalProduction: string | null = null;
let originalOverrides: string | null = null;

/** Word 20 is "people" (5.46s) — far from "max plan" (2.05s), so the chip the
 * add test places never sits inside find-matches' overlap gap. */
const ADD_WORD = 20;
const MAX_PLAN_WORD = 7;

test.beforeAll(async () => {
  originalProduction = await readFile(PRODUCTION, "utf8");
  originalOverrides = await readFile(OVERRIDES, "utf8").catch(() => null);
  const props = JSON.parse(await readFile(PROPS, "utf8")) as {
    captionLines: { words: { text: string; start: number; end: number }[] }[];
  };
  const words = props.captionLines.flatMap((l) => l.words.map(({ text, start, end }) => ({ text, start, end })));
  expect(words[ADD_WORD]?.text).toBe("people");
  expect(words.slice(MAX_PLAN_WORD, MAX_PLAN_WORD + 2).map((w) => w.text)).toEqual(["max", "plan"]);
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
  await expect(page.getByTestId("overlay-lane")).toBeVisible();
};

const save = async (page: Page) => {
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
};

const overlaysDoc = async () =>
  (JSON.parse(await readFile(OVERRIDES, "utf8")) as { overlays?: Record<string, unknown> }).overlays as
    | {
        added: { id: string; entryId: string; word: number; look?: string; source: string }[];
        edits: Record<string, unknown>;
        entries: { id: string; ext: string }[];
      }
    | undefined;

let addedId = "";

test("add from tray via local path: chip at the word, persists, library has the entry", async ({ page }) => {
  await open(page);
  await page.getByTestId("transcript-toggle").click();
  await page.getByTestId(`transcript-word-${ADD_WORD}`).click({ button: "right" });
  await page.getByTestId("context-menu-item-Add logo/image here…").click();

  const tray = page.getByTestId("overlay-tray");
  await expect(tray).toBeVisible();
  // The seeded library shows in the grid before anything is added.
  await expect(page.getByTestId("overlay-tray-item-max-plan")).toBeVisible();

  await page.getByTestId("overlay-tray-paste").fill(join(HOME, "assets", "clean-edit.png"));
  // Name pre-filled from the file name (spec §Editor), then overwritten.
  await expect(page.getByTestId("overlay-tray-name")).toHaveValue("clean edit");
  await page.getByTestId("overlay-tray-name").fill("Clean Edit");
  await expect(page.getByTestId("overlay-tray-kind")).toHaveValue("logo");
  await page.getByTestId("overlay-tray-add").click();
  await expect(tray).toHaveCount(0);

  const chip = page.locator('[data-testid^="overlay-chip-clean-edit-"]');
  await expect(chip).toHaveCount(1);
  await save(page);

  const doc = await overlaysDoc();
  expect(doc?.added).toHaveLength(1);
  expect(doc!.added[0]).toMatchObject({ entryId: "clean-edit", word: ADD_WORD, source: "user" });
  expect(doc!.entries.map((e) => e.id)).toEqual(["clean-edit"]);
  addedId = doc!.added[0]!.id;
  // Copied into the GLOBAL library (temp HOME) and staged into the workdir.
  const index = JSON.parse(await readFile(join(LIBRARY, "library.json"), "utf8")) as {
    entries: { id: string; names: string[] }[];
  };
  expect(index.entries.map((e) => e.id).sort()).toEqual(["clean-edit", "max-plan"]);
  expect(index.entries.find((e) => e.id === "clean-edit")?.names).toEqual(["Clean Edit"]);
  expect(existsSync(join(LIBRARY, "clean-edit.png"))).toBe(true);
  expect(existsSync(join(WORKDIR, "library", "clean-edit.png"))).toBe(true);

  await page.reload();
  await expect(page.getByTestId(`overlay-chip-${addedId}`)).toHaveCount(1);
});

test("swap look to card", async ({ page }) => {
  await open(page);
  await page.getByTestId(`overlay-chip-${addedId}`).click();
  await page.getByTestId("overlay-look-card").check();
  await save(page);
  expect((await overlaysDoc())!.added[0]).toMatchObject({ id: addedId, look: "card" });
});

test("swap image through the tray: the placement points at the picked entry, snapshot stored", async ({ page }) => {
  await open(page);
  await page.getByTestId(`overlay-chip-${addedId}`).click();
  await page.getByTestId("overlay-image").click();
  await expect(page.getByTestId("overlay-tray")).toBeVisible();
  // The grid search narrows by name.
  await page.getByTestId("overlay-tray-search").fill("max");
  await expect(page.getByTestId("overlay-tray-item-clean-edit")).toHaveCount(0);
  await page.getByTestId("overlay-tray-item-max-plan").click();
  await expect(page.getByTestId("overlay-tray")).toHaveCount(0);
  await save(page);
  const doc = (await overlaysDoc())!;
  expect(doc.added[0]).toMatchObject({ id: addedId, entryId: "max-plan", look: "card" });
  expect(doc.entries.map((e) => e.id).sort()).toEqual(["clean-edit", "max-plan"]);
  expect(existsSync(join(WORKDIR, "library", "max-plan.png"))).toBe(true);
});

/** Park the playhead inside a chip's window — the ruler is the seek surface,
 * on the lane's x scale; 60% in is past the entrance pop. */
const seekIntoChip = async (page: Page, chipTestId: string) => {
  const chip = (await page.getByTestId(chipTestId).boundingBox())!;
  const ruler = (await page.getByTestId("ruler").boundingBox())!;
  await page.mouse.click(chip.x + chip.width * 0.6, ruler.y + ruler.height / 2);
};

test("move and resize the picture on the stage, then reset its position (overlay-transform)", async ({ page }) => {
  await open(page);
  // Park the playhead elsewhere first: the chip click alone must bring the
  // picture on screen (a lane click seeks to the object it selects).
  const ruler = (await page.getByTestId("ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * 0.95, ruler.y + ruler.height / 2);
  await page.getByTestId(`overlay-chip-${addedId}`).click();
  await page.getByTestId("overlay-look-overlay").check();
  const pic = page.locator(`[data-testid="stage"] [data-edit-overlay="${addedId}"]`);
  await expect(pic).toBeVisible();
  const before = (await pic.boundingBox())!;

  // One press on the picture selects it AND grabs it.
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 - 30, before.y + before.height / 2 - 50, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("overlay-image-box")).toBeVisible();
  await expect(page.getByTestId("overlay-reset-position")).toBeEnabled();
  const moved = (await pic.boundingBox())!;
  expect(moved.x).toBeLessThan(before.x - 20);
  expect(moved.y).toBeLessThan(before.y - 35);
  expect(moved.width).toBeCloseTo(before.width, 0);

  // A corner drag grows it with the aspect kept.
  const se = (await page.getByTestId("overlay-corner-se").boundingBox())!;
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down();
  await page.mouse.move(se.x + se.width / 2 + 30, se.y + se.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  const grown = (await pic.boundingBox())!;
  expect(grown.width).toBeGreaterThan(moved.width + 10);
  expect(grown.width / grown.height).toBeCloseTo(moved.width / moved.height, 1);

  await save(page);
  const rect = (await overlaysDoc())!.added[0] as { rect?: { x: number; y: number; w: number; h: number } };
  expect(rect.rect).toBeDefined();

  await page.getByTestId("overlay-reset-position").click();
  await save(page);
  expect("rect" in (await overlaysDoc())!.added[0]!).toBe(false);
});

test("delete: the chip is gone after reload", async ({ page }) => {
  await open(page);
  await page.getByTestId(`overlay-chip-${addedId}`).click();
  await page.getByTestId("overlay-delete").click();
  await expect(page.getByTestId(`overlay-chip-${addedId}`)).toHaveCount(0);
  await save(page);
  await page.reload();
  await expect(page.getByTestId("overlay-lane")).toBeVisible();
  await expect(page.getByTestId(`overlay-chip-${addedId}`)).toHaveCount(0);
  expect((await overlaysDoc())?.added ?? []).toEqual([]);
});

test("find matches: places the library's first mention and says so", async ({ page }) => {
  await open(page);
  await page.getByTestId("overlay-find-matches").click();
  await expect(page.getByTestId("overlay-match-status")).toContainText("added 1");
  await expect(page.getByTestId(`overlay-chip-max-plan-${MAX_PLAN_WORD}`)).toHaveCount(1);
  await save(page);
  expect((await overlaysDoc())!.added).toEqual([
    { id: `max-plan-${MAX_PLAN_WORD}`, entryId: "max-plan", word: MAX_PLAN_WORD, source: "match" },
  ]);

  // A second run adds nothing: the entry is already placed.
  await page.getByTestId("overlay-find-matches").click();
  await expect(page.getByTestId("overlay-match-status")).toContainText("added 0, skipped 1");
});

test("Add an image → Add at playhead opens the image grid and places the pick at the playhead (overlay-transform)", async ({ page }) => {
  await open(page);
  await seekIntoChip(page, `overlay-chip-max-plan-${MAX_PLAN_WORD}`);
  await page.getByTestId("overlay-add").click();
  await expect(page.getByTestId("overlay-tray")).toBeVisible();
  await page.getByTestId("overlay-tray-item-clean-edit").click();
  await expect(page.getByTestId("overlay-tray")).toHaveCount(0);
  await expect(page.locator('[data-testid^="overlay-chip-clean-edit-"]')).toHaveCount(1);
  await save(page);
  const added = (await overlaysDoc())!.added;
  const placed = added.find((a) => a.entryId === "clean-edit");
  // The word under the playhead: inside "max plan"'s window, so 7 or a neighbour.
  expect(placed?.word).toBeGreaterThanOrEqual(MAX_PLAN_WORD);
  expect(placed?.word).toBeLessThanOrEqual(MAX_PLAN_WORD + 3);
});
