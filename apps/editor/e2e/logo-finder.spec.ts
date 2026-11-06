import { test, expect, type Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;
const PRODUCTION = join(WORKDIR, "production.json");
const OVERRIDES = join(WORKDIR, "overrides.json");
const PROPS = join(WORKDIR, "render-props.json");
const CANDIDATES = join(WORKDIR, "logo-candidates");

/**
 * The logo finder's editor half end to end (logo-finder spec §Editor): a
 * suggestion chip in the overlay lane, its popover, "Use this" through the
 * real `POST /api/library {candidate}` → `/api/overlays/stage`, undo, and
 * Skip — each surviving a save and a reload.
 *
 * The overlays.spec posture: production.json gets a transcript (the caption
 * words, flattened, so the lane has a word space) plus two suggestions, a
 * candidate PNG is written into the temp workdir, and the run starts from NO
 * overrides.json. The library it adds into is playwright.config.ts's temp
 * HOME, never ~/.ossclip. Everything it wrote is restored or removed after.
 *
 * The candidate is a 1×1 PNG whose bytes differ from every seeded library
 * file: the server reuses an entry with identical bytes (Task 6 ruling), and
 * this spec wants a fresh add.
 */

test.describe.configure({ mode: "serial" });

/** Word 62 is "Code" of "Code with Ahsan"; word 0 is "Claude". */
const PICK_WORD = 62;
const SKIP_WORD = 0;
const CANDIDATE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

let originalProduction: string | null = null;
let originalOverrides: string | null = null;

test.beforeAll(async () => {
  originalProduction = await readFile(PRODUCTION, "utf8");
  originalOverrides = await readFile(OVERRIDES, "utf8").catch(() => null);
  const props = JSON.parse(await readFile(PROPS, "utf8")) as {
    captionLines: { words: { text: string; start: number; end: number }[] }[];
  };
  const words = props.captionLines.flatMap((l) => l.words.map(({ text, start, end }) => ({ text, start, end })));
  expect(words[PICK_WORD]?.text).toBe("Code");
  expect(words[SKIP_WORD]?.text).toBe("Claude");
  const production = JSON.parse(originalProduction);
  production.transcript = { language: "en", words };
  production.overlays = {
    entries: [],
    placements: [],
    suggestions: [
      {
        id: "code-with-ahsan",
        name: "Code with Ahsan",
        word: PICK_WORD,
        domain: "codewithahsan.dev",
        candidates: [{ file: "logo-candidates/code-with-ahsan/0.png", source: "header", width: 1, height: 1 }],
      },
      { id: "claude", name: "Claude", word: SKIP_WORD, candidates: [], note: "claude.ai timed out" },
    ],
  };
  await writeFile(PRODUCTION, JSON.stringify(production));
  await mkdir(join(CANDIDATES, "code-with-ahsan"), { recursive: true });
  await writeFile(join(CANDIDATES, "code-with-ahsan", "0.png"), CANDIDATE_PNG);
  await rm(OVERRIDES, { force: true });
});

test.afterAll(async () => {
  if (originalProduction !== null) await writeFile(PRODUCTION, originalProduction);
  if (originalOverrides !== null) await writeFile(OVERRIDES, originalOverrides);
  else await rm(OVERRIDES, { force: true });
  await rm(CANDIDATES, { recursive: true, force: true });
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
        added: { id: string; entryId: string; word: number; source: string; fromSuggestion?: string }[];
        skippedSuggestions?: string[];
      }
    | undefined;

test("Use this: the chip becomes an overlay, undo brings it back, and the pick survives a reload", async ({ page }) => {
  await open(page);
  const chip = page.getByTestId("logo-suggestion-code-with-ahsan");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Code with Ahsan");
  // Lane-only: nothing in the lane is an overlay yet.
  await expect(page.locator('[data-testid^="overlay-chip-"]')).toHaveCount(0);

  await chip.click();
  const popover = page.getByTestId("logo-suggestion-popover");
  await expect(popover).toBeVisible();
  await expect(page.getByTestId("logo-candidate-0")).toBeVisible();
  await expect(page.getByTestId("logo-name")).toHaveValue("Code with Ahsan");
  await page.getByTestId("logo-use").click();

  await expect(popover).toHaveCount(0);
  const overlay = page.locator('[data-testid^="overlay-chip-"]');
  await expect(overlay).toHaveCount(1);
  await expect(chip).toHaveCount(0);

  // ONE undo step takes the pick back and the chip returns (spec "Undo of a pick").
  await page.keyboard.press("Meta+z");
  await expect(overlay).toHaveCount(0);
  await expect(chip).toHaveCount(1);
  await page.keyboard.press("Meta+Shift+z");
  await expect(overlay).toHaveCount(1);
  await expect(chip).toHaveCount(0);
  await save(page);

  const doc = await overlaysDoc();
  expect(doc?.added).toHaveLength(1);
  expect(doc!.added[0]).toMatchObject({ word: PICK_WORD, source: "user", fromSuggestion: "code-with-ahsan" });
  // No skip was made, so the optional key never appears.
  expect(doc && "skippedSuggestions" in doc).toBe(false);

  await page.reload();
  await expect(page.getByTestId("overlay-lane")).toBeVisible();
  await expect(page.getByTestId(`overlay-chip-${doc!.added[0]!.id}`)).toHaveCount(1);
  await expect(page.getByTestId("logo-suggestion-code-with-ahsan")).toHaveCount(0);
  // The other suggestion is still asking.
  await expect(page.getByTestId("logo-suggestion-claude")).toBeVisible();
});

test("Skip hides a suggestion with no candidates, and the skip survives a reload", async ({ page }) => {
  await open(page);
  const chip = page.getByTestId("logo-suggestion-claude");
  // Opened from the keyboard (final review Minor 5): the chip is a
  // role="button", so it must take focus and answer Enter like a click.
  await chip.focus();
  await expect(chip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("logo-suggestion-popover")).toBeVisible();
  await expect(page.getByTestId("logo-suggestion-note")).toHaveText("claude.ai timed out");
  await expect(page.getByTestId("logo-candidate-0")).toHaveCount(0);
  await page.getByTestId("logo-skip").click();
  await expect(page.getByTestId("logo-suggestion-popover")).toHaveCount(0);
  await expect(chip).toHaveCount(0);
  await save(page);

  expect((await overlaysDoc())?.skippedSuggestions).toEqual(["claude"]);
  await page.reload();
  await expect(page.getByTestId("overlay-lane")).toBeVisible();
  await expect(page.getByTestId("logo-suggestion-claude")).toHaveCount(0);
  // The earlier pick is untouched by the skip.
  await expect(page.locator('[data-testid^="overlay-chip-"]')).toHaveCount(1);
});
