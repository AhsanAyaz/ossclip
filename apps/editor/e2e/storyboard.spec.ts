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
 * would. "Plan again" is never confirmed against the real server: the e2e
 * server has no mock provider, and on a machine with `claude` on its PATH a
 * confirm would be a real, billed call. The one test that confirms it
 * answers `/api/storyboard/plan` itself.
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
  // s1 is drawn in the fixture (B2a, §169): restored, it is drawn again.
  await expect(page.getByTestId("storyboard-state-s1")).toHaveText("drawn (v1)");
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

test("a selection the author clears is forgotten by the table; the table's own Clear forgets it too (2026-11-21)", async ({
  page,
}) => {
  await load(page);
  await page.getByTestId("transcript-toggle").click();
  await page.getByTestId(`transcript-word-${ADD_FROM}`).click();
  await page.getByTestId(`transcript-word-${ADD_TO}`).click({ modifiers: ["Shift"] });
  await page.getByTestId("transcript-selection-clear").click();
  await expect(page.getByTestId("transcript-selection-menu")).toHaveCount(0);
  await openPanel(page);
  await expect(page.getByTestId("storyboard-selection")).toHaveText(/^Select words in the transcript first/);
  await expect(page.getByTestId("storyboard-add")).toBeDisabled();
  await expect(page.getByTestId("storyboard-selection-clear")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("storyboard-modal")).toHaveCount(0);

  // A word clicked once to seek is a selection the table holds…
  await page.getByTestId(`transcript-word-${ADD_FROM}`).click();
  await openPanel(page);
  await expect(page.getByTestId("storyboard-selection")).toContainText(`(words ${ADD_FROM}–${ADD_FROM})`);
  await expect(page.getByTestId("storyboard-add")).toBeEnabled();
  // …until the table's Clear drops it.
  await page.getByTestId("storyboard-selection-clear").click();
  await expect(page.getByTestId("storyboard-selection")).toHaveText(/^Select words in the transcript first/);
  await expect(page.getByTestId("storyboard-selection-clear")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-add")).toBeDisabled();
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

/**
 * B2a: drawing from the panel (plan Task 5; §169). The fixture's s1 is drawn:
 * `storyboard/s1/history.json` holds one ok version, the draft, drawn from
 * s1's idea as `storyboard.json` has it, beside `v1.tsx` and three stills.
 *
 * These tests NEVER press Draw, Draw all, Redraw, Preview, Approve or Remove
 * from video: the e2e server has no mock provider, so each would be a real
 * LLM call or a render. They read labels and enabled state only.
 */
test("a drawn shot reads drawn, s2 offers Draw, and s1 opens the shot view with its stills", async ({ page }, testInfo) => {
  await load(page);
  await openPanel(page);
  await expect(page.getByTestId("storyboard-state-s1")).toHaveText("drawn (v1)");
  // Drawn from its own idea: no Draw, no "Draw again".
  await expect(page.getByTestId("storyboard-draw-s1")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-stale-s1")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-draw-s2")).toHaveText("Draw");
  await expect(page.getByTestId("storyboard-draw-s2")).toBeEnabled();
  // A dropped shot is not drawn.
  await expect(page.getByTestId("storyboard-draw-s3")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-draw-all")).toHaveText("Draw all");
  await expect(page.getByTestId("storyboard-draw-all")).toBeEnabled();
  // No job has run on this server.
  await expect(page.getByTestId("storyboard-job")).toHaveCount(0);
  await page.getByTestId("storyboard-modal").screenshot({ path: testInfo.outputPath("storyboard-table-draw.png") });

  await page.getByTestId("storyboard-open-shot-s1").click();
  await expect(page.getByTestId("storyboard-shot-view")).toBeVisible();
  for (const k of [1, 2, 3]) {
    const still = page.getByTestId(`storyboard-still-${k}`);
    await expect(still).toBeVisible();
    // Served, not a broken image: the URL is the server's `/media/` one.
    await expect.poll(() => still.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  await expect(page.getByTestId("storyboard-still-4")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-version-1")).toContainText("ok");
  await expect(page.getByTestId("storyboard-version-1")).toContainText("the draft");
  await expect(page.getByTestId("storyboard-make-draft-1")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-preview")).toBeEnabled();
  await expect(page.getByTestId("storyboard-preview-video")).toHaveCount(0);
  // The note box and Redraw: Redraw waits for a note.
  await expect(page.getByTestId("storyboard-note-input")).toBeVisible();
  await expect(page.getByTestId("storyboard-redraw")).toBeDisabled();
  await page.getByTestId("storyboard-note-input").fill("Make the answer bubbles pop back one after another.");
  await expect(page.getByTestId("storyboard-redraw")).toBeEnabled();
  // A clean document: Approve can run, and nothing is in the video yet.
  await expect(page.getByTestId("storyboard-approve")).toBeEnabled();
  await expect(page.getByTestId("storyboard-approve-block")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-unapprove")).toHaveCount(0);
  await page.getByTestId("storyboard-modal").screenshot({ path: testInfo.outputPath("storyboard-shot-view.png") });

  await page.getByTestId("storyboard-shot-back").click();
  await expect(page.getByTestId("storyboard-shot-view")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-row-s1")).toBeVisible();
});

test("Approve says Save first while the document has unsaved edits, and is enabled once saved (Review Focus 4)", async ({
  page,
}) => {
  await load(page);
  await page.locator('[data-testid^="timeline-block-"]').first().click();
  await page.getByTestId("field-scale").fill("0.62");
  await expect(page.getByTestId("dirty")).toBeVisible();
  await openPanel(page);
  await page.getByTestId("storyboard-open-shot-s1").click();
  await expect(page.getByTestId("storyboard-approve")).toBeDisabled();
  await expect(page.getByTestId("storyboard-approve-block")).toContainText("Save first");
  // Escape backs out of the shot view first, then closes the panel.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("storyboard-shot-view")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("storyboard-modal")).toHaveCount(0);

  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  await openPanel(page);
  await page.getByTestId("storyboard-open-shot-s1").click();
  await expect(page.getByTestId("storyboard-approve")).toBeEnabled();
  await expect(page.getByTestId("storyboard-approve-block")).toHaveCount(0);
});

test("an approve outlives the closed panel: the button shows the job and its end reaches the render poll (§169)", async ({
  page,
}) => {
  // The job is the server's; this test owns only what the page does with it,
  // so the three routes are answered here and nothing is rendered.
  const jobState = {
    kind: "approve",
    shots: ["s1"],
    current: "s1",
    done: [] as { id: string; ok: boolean }[],
    lines: [],
    calls: 0,
    startedAt: Date.now(),
    stopping: false,
  };
  let phase: "idle" | "running" | "ended" = "idle";
  await page.route("**/api/storyboard/approve", (route) => {
    phase = "running";
    return route.fulfill({ status: 202, json: { ok: true } });
  });
  await page.route("**/api/storyboard/job", (route) =>
    route.fulfill({
      json:
        phase === "running"
          ? { job: jobState, last: null }
          : { job: null, last: phase === "ended" ? { ...jobState, current: null, done: [{ id: "s1", ok: true }] } : null },
    }),
  );
  let statusAsked = 0;
  await page.route("**/api/render/status", (route) => {
    statusAsked += 1;
    return route.fulfill({ json: { running: true, exitCode: null, lines: ["▸ updating the video"], startedAt: Date.now() } });
  });

  await load(page);
  await expect(page.getByTestId("storyboard-open-busy")).toHaveCount(0);
  await openPanel(page);
  await page.getByTestId("storyboard-open-shot-s1").click();
  await page.getByTestId("storyboard-approve").click();
  await expect(page.getByTestId("storyboard-open-busy")).toBeVisible();
  // Close the whole panel while the job runs: the author's real run.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("storyboard-modal")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-open-busy")).toBeVisible();
  await expect(page.getByTestId("storyboard-open")).toHaveAttribute("title", /Approving s1/);
  const before = statusAsked;

  phase = "ended";
  await expect(page.getByTestId("storyboard-open-busy")).toHaveCount(0);
  // The sync run the server started is now followed with no panel open.
  await expect.poll(() => statusAsked).toBeGreaterThan(before);
  await expect(page.getByTestId("render-status")).toBeVisible();
});

test("a plan outlives the closed panel: the button shows it, a reopened panel says Planning again, and its end shows the new table and what changed (§169)", async ({
  page,
}) => {
  // The job is the server's and a real plan is a billed call (this file's
  // header), so the plan, the job and the table read are answered here.
  const planJob = {
    kind: "plan",
    shots: ["plan"],
    current: "plan",
    done: [] as { id: string; ok: boolean }[],
    lines: [],
    calls: 1,
    startedAt: Date.now(),
    stopping: false,
  };
  const ended = {
    ...planJob,
    current: null,
    done: [{ id: "plan", ok: true }],
    plan: {
      changes: [{ index: 1, kind: "dropped", reason: "the plan covered more than 60% of the video" }],
      usage: "▸ llm: 1 calls · 1,000 in / 100 out",
    },
  };
  let phase: "idle" | "running" | "ended" = "idle";
  const pair = () =>
    phase === "running" ? { job: planJob, last: null } : { job: null, last: phase === "ended" ? ended : null };
  let planPosts = 0;
  await page.route("**/api/storyboard/plan", (route) => {
    planPosts += 1;
    phase = "running";
    return route.fulfill({ status: 202, json: { ok: true } });
  });
  await page.route("**/api/storyboard/job", (route) => route.fulfill({ json: pair() }));
  // The real table, with this test's job; once the plan has ended, the table
  // the plan saved: s2 replaced by a new planner shot on the same words.
  await page.route(
    (url) => url.pathname === "/api/storyboard",
    async (route) => {
      const real = (await (await route.fetch()).json()) as { storyboard: { shots: { id: string; idea: string }[] } };
      const storyboard =
        phase === "ended"
          ? {
              ...real.storyboard,
              shots: real.storyboard.shots.map((s) =>
                s.id === "s2" ? { ...s, id: "s9", idea: "a freshly planned shot", touched: false } : s,
              ),
            }
          : real.storyboard;
      return route.fulfill({ json: { ...real, storyboard, job: pair() } });
    },
  );

  await load(page);
  await expect(page.getByTestId("storyboard-open-busy")).toHaveCount(0);
  await openPanel(page);
  await page.getByTestId("storyboard-plan-again").click();
  await page.getByTestId("storyboard-plan-confirm").click();
  await expect(page.getByTestId("storyboard-open-busy")).toBeVisible();
  await expect(page.getByTestId("storyboard-job")).toContainText("Planning again (one LLM call) · 1 call");
  // One call cannot be stopped halfway: no Cancel.
  await expect(page.getByTestId("storyboard-job-cancel")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-plan-again")).toHaveText("Planning again… (one LLM call)");
  await expect(page.getByTestId("storyboard-plan-again")).toBeDisabled();

  // Close the panel while the plan runs: the author's real run.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("storyboard-modal")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-open-busy")).toBeVisible();
  await expect(page.getByTestId("storyboard-open")).toHaveAttribute("title", /Planning again \(one LLM call\)/);

  // Reopened while it runs: the panel says so, from the server's job.
  await openPanel(page);
  await expect(page.getByTestId("storyboard-plan-again")).toHaveText("Planning again… (one LLM call)");
  await expect(page.getByTestId("storyboard-plan-again")).toBeDisabled();
  await expect(page.getByTestId("storyboard-plan-result")).toHaveCount(0);

  phase = "ended";
  await expect(page.getByTestId("storyboard-row-s9")).toBeVisible();
  await expect(page.getByTestId("storyboard-row-s9")).toContainText("a freshly planned shot");
  await expect(page.getByTestId("storyboard-row-s2")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-plan-result")).toContainText("▸ llm: 1 calls · 1,000 in / 100 out");
  await expect(page.getByTestId("storyboard-plan-result")).toContainText("1 planner shot was changed by the limits.");
  await expect(page.getByTestId("storyboard-job-result")).toHaveText("Last job: Planned again");
  await expect(page.getByTestId("storyboard-open-busy")).toHaveCount(0);
  await expect(page.getByTestId("storyboard-plan-again")).toHaveText("Plan again (one LLM call)");
  await expect(page.getByTestId("storyboard-plan-again")).toBeEnabled();

  // Reopened after it ended: the result is the job's, so it is still there.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("storyboard-modal")).toHaveCount(0);
  await openPanel(page);
  await expect(page.getByTestId("storyboard-row-s9")).toBeVisible();
  await expect(page.getByTestId("storyboard-plan-result")).toContainText("1 planner shot was changed by the limits.");
  expect(planPosts).toBe(1);
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
