import { test, expect, type Page } from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;
const STORYBOARD = join(WORKDIR, "storyboard.json");
const TRANSCRIPT = join(WORKDIR, "transcript.json");
const OVERRIDES = join(WORKDIR, "overrides.json");
const PROPS = join(WORKDIR, "render-props.json");

/**
 * The storyboard panel end to end (storyboard design §10 "Table view"; plan
 * Task 5; §168), through the real edit server's `/api/storyboard` routes.
 *
 * The committed fixture carries `storyboard.json` (three shots, s3 dropped)
 * but no `transcript.json`, and a shot's words index the transcript. This
 * file gives the workdir one, the caption words flattened (the overlays.spec
 * posture), so transcript-panel word N and transcript word N are the same
 * word with the same start: the selection hand-off matches on exactly that
 * (`selectionSpan`). Adding the transcript to the committed fixture instead
 * would make every other spec's live caption rebuild read it. Starts from no
 * overrides.json so a cut another spec saved cannot cut a shot's words.
 * Everything is restored after. Its own serialized project, last.
 *
 * The fixture's shots: s1 on words 19–24 ("Most people use AI very
 * regularly."), s2 on 43–52 ("And I run agentic loops …"), s3 dropped on
 * 70–74 ("It's serving 5000 plus developers").
 *
 * SERIAL: each test edits the table the next one reads, the way an author
 * would. "Plan again" is only opened, never confirmed: the e2e server has no
 * mock provider, and on a machine with `claude` on its PATH a confirm would
 * be a real, billed call.
 */

test.describe.configure({ mode: "serial" });

let originalStoryboard = "";
let originalOverrides: string | null = null;

/** "just follow me and then", 27.61 s on: clear of every fixture shot. */
const ADD_FROM = 91;
const ADD_TO = 95;

test.beforeAll(async () => {
  originalStoryboard = await readFile(STORYBOARD, "utf8");
  originalOverrides = await readFile(OVERRIDES, "utf8").catch(() => null);
  const props = JSON.parse(await readFile(PROPS, "utf8")) as {
    captionLines: { words: { text: string; start: number; end: number }[] }[];
  };
  const words = props.captionLines.flatMap((l) => l.words.map(({ text, start, end }) => ({ text, start, end })));
  expect(words.slice(19, 25).map((w) => w.text).join(" ")).toBe("Most people use AI very regularly.");
  expect(words.slice(ADD_FROM, ADD_TO + 1).map((w) => w.text).join(" ")).toBe("just follow me and then");
  await writeFile(TRANSCRIPT, JSON.stringify({ language: "en", words }));
  await rm(OVERRIDES, { force: true });
});

test.afterAll(async () => {
  await writeFile(STORYBOARD, originalStoryboard);
  await rm(TRANSCRIPT, { force: true });
  if (originalOverrides !== null) await writeFile(OVERRIDES, originalOverrides);
  else await rm(OVERRIDES, { force: true });
});

const load = async (page: Page) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid^="timeline-block-"]');
};

const openPanel = async (page: Page) => {
  await page.getByTestId("storyboard-open").click();
  await expect(page.getByTestId("storyboard-modal")).toBeVisible();
  await expect(page.getByTestId("storyboard-row-s1")).toBeVisible();
};

const shotOnDisk = async (id: string) =>
  (JSON.parse(await readFile(STORYBOARD, "utf8")) as { shots: { id: string; idea: string; kept: boolean; touched: boolean; startWord: number; endWord: number; origin: string }[] }).shots.find(
    (s) => s.id === id,
  );

test("the Storyboard button opens the table with the fixture's shots", async ({ page }, testInfo) => {
  await load(page);
  await expect(page.getByTestId("storyboard-open")).toBeVisible();
  await openPanel(page);
  // Two kept shots; s3 is dropped and covers nothing.
  await expect(page.getByTestId("storyboard-summary")).toHaveText(/^2 shots · covers \d+% of the video$/);
  await expect(page.getByTestId("storyboard-idea-s1")).toContainText("A crowd of small figures");
  await expect(page.getByTestId("storyboard-idea-s2")).toContainText("A loop arrow circles a small robot");
  await expect(page.getByTestId("storyboard-idea-s3")).toContainText("A counter ticks up to 5000");
  // The spoken line under a row is its words, from the transcript.
  await expect(page.getByTestId("storyboard-row-s1")).toContainText("Most people use AI very regularly.");
  await expect(page.getByTestId("storyboard-row-s1")).toContainText("0:05.1 – ");
  // A dropped row offers Restore and nothing else.
  await expect(page.getByTestId("storyboard-restore-s3")).toBeVisible();
  await expect(page.getByTestId("storyboard-drop-s3")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-state-s3")).toHaveText("dropped");
  // No selection made yet: the selection actions say why they are off.
  await expect(page.getByTestId("storyboard-use-selection-s1")).toBeDisabled();
  await expect(page.getByTestId("storyboard-use-selection-s1")).toHaveAttribute("title", /Select words in the transcript/);
  await page.getByTestId("storyboard-modal").screenshot({ path: testInfo.outputPath("storyboard-panel.png") });
  // Escape with no field open closes the panel.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("storyboard-modal")).toHaveCount(0);
});

test("a reworded idea is saved and survives a reload", async ({ page }) => {
  await load(page);
  await openPanel(page);
  await page.getByTestId("storyboard-idea-s2").click();
  const input = page.getByTestId("storyboard-idea-input-s2");
  await input.fill("A robot runs its own code in a loop, and a green tick lands after each lap.");
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(page.getByTestId("storyboard-idea-s2")).toHaveText(
    "A robot runs its own code in a loop, and a green tick lands after each lap.",
  );
  expect((await shotOnDisk("s2"))?.touched).toBe(true);

  await load(page);
  await openPanel(page);
  await expect(page.getByTestId("storyboard-idea-s2")).toHaveText(
    "A robot runs its own code in a loop, and a green tick lands after each lap.",
  );
});

test("an empty idea is refused with the server's message and the field stays open", async ({ page }) => {
  await load(page);
  await openPanel(page);
  await page.getByTestId("storyboard-idea-s1").click();
  const input = page.getByTestId("storyboard-idea-input-s1");
  await input.fill("   ");
  await input.press("Enter");
  await expect(page.getByTestId("storyboard-idea-error-s1")).toContainText("the idea is empty");
  await expect(input).toBeVisible();
  // Escape cancels the field, and the panel stays open.
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(page.getByTestId("storyboard-modal")).toBeVisible();
  await expect(page.getByTestId("storyboard-idea-s1")).toContainText("A crowd of small figures");
});

test("Drop then Restore round-trips", async ({ page }) => {
  await load(page);
  await openPanel(page);
  await page.getByTestId("storyboard-drop-s1").click();
  await expect(page.getByTestId("storyboard-state-s1")).toHaveText("dropped");
  await expect(page.getByTestId("storyboard-summary")).toHaveText(/^1 shot · covers/);
  expect((await shotOnDisk("s1"))?.kept).toBe(false);
  await page.getByTestId("storyboard-restore-s1").click();
  await expect(page.getByTestId("storyboard-drop-s1")).toBeVisible();
  await expect(page.getByTestId("storyboard-state-s1")).toHaveText("planned");
  expect((await shotOnDisk("s1"))?.kept).toBe(true);
});

test("a transcript selection survives opening the panel and adds a shot", async ({ page }) => {
  await load(page);
  await page.getByTestId("transcript-toggle").click();
  await page.getByTestId(`transcript-word-${ADD_FROM}`).click();
  await page.getByTestId(`transcript-word-${ADD_TO}`).click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("transcript-selection-menu")).toBeVisible();
  // Pressing the button is a click outside the transcript, which clears its
  // own selection; App keeps the last one for the table.
  await openPanel(page);
  await expect(page.getByTestId("storyboard-selection")).toContainText(
    `“just follow me and then” (words ${ADD_FROM}–${ADD_TO})`,
  );
  await page.getByTestId("storyboard-add").click();
  await page.getByTestId("storyboard-add-idea").fill("A hand taps a Follow button, then a speech bubble reads AGENTS.");
  await page.getByTestId("storyboard-add-confirm").click();
  await expect(page.getByTestId("storyboard-row-s4")).toBeVisible();
  await expect(page.getByTestId("storyboard-idea-s4")).toHaveText(
    "A hand taps a Follow button, then a speech bubble reads AGENTS.",
  );
  await expect(page.getByTestId("storyboard-add-idea")).toHaveCount(0);
  const added = await shotOnDisk("s4");
  expect(added).toMatchObject({ startWord: ADD_FROM, endWord: ADD_TO, origin: "author", kept: true });
});

test("Plan again asks in the panel before it spends a call", async ({ page }) => {
  await load(page);
  await openPanel(page);
  await expect(page.getByTestId("storyboard-plan-again")).toHaveText("Plan again (one LLM call)");
  await page.getByTestId("storyboard-plan-again").click();
  await expect(page.getByTestId("storyboard-plan-confirm-box")).toContainText(
    "This replaces every shot you have not touched. Reworded, added and drawn shots are kept.",
  );
  await expect(page.getByTestId("storyboard-plan-confirm")).toBeVisible();
  await page.getByTestId("storyboard-plan-cancel").click();
  await expect(page.getByTestId("storyboard-plan-confirm-box")).toHaveCount(0);
});

test("a project without storyboard.json has no Storyboard button", async ({ page }) => {
  await rm(STORYBOARD, { force: true });
  // The answer is awaited before the absence is read: a button not drawn YET
  // would pass this test for the wrong reason.
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/storyboard");
  await load(page);
  const res = await answered;
  expect(((await res.json()) as { storyboard: unknown }).storyboard).toBeNull();
  await expect(page.getByTestId("storyboard-open")).toHaveCount(0);
});
