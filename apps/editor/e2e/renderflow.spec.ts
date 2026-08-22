import { test, expect } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;
const COMMAND = join(WORKDIR, "command.json");

/**
 * The render lifecycle across a refresh (R16 §60). Its own project,
 * serialized after the others: it plants a command.json in the shared
 * workdir, which the main project's R11 test asserts is absent.
 *
 * The recorded "render" is a slow fake — a node loop printing progress
 * lines for ~50s — long enough to refresh into and cancel, harmless if a
 * failure ever leaks it (the server kills the child on close).
 */

// A script FILE, not `node -e` (§129): the render endpoint prepends the
// `produce` literal to recorded args that lack it, and with `-e` the first
// arg IS the program text — the healed argv would evaluate the string
// "produce" and exit instantly instead of running the slow fake.
const FAKE_RENDER = join(WORKDIR, "renderflow-fake.cjs");

test.beforeAll(async () => {
  await writeFile(
    FAKE_RENDER,
    "let i=0; setInterval(() => { console.log(`  ${Math.min(90, i * 10)}%`); i++; if (i > 100) process.exit(0); }, 500);",
  );
  await writeFile(
    COMMAND,
    JSON.stringify({
      execPath: process.execPath,
      execArgv: [],
      script: FAKE_RENDER,
      args: ["produce"],
      cwd: WORKDIR,
    }),
  );
});

/**
 * Leave no render running (§147). Both fixtures deliberately stay alive for
 * ~50s so a run can be refreshed into and cancelled, and every test here ends
 * by cancelling its own — but a test that FAILS in between never gets there,
 * and the child outlives it. The next attempt then loads a page whose Render
 * button is disabled and reads "Rendering…", and fails on a 30s click timeout
 * that has nothing to do with what actually broke. That is how the real bug
 * in §147 arrived at CI wearing a second, misleading error on top of it.
 *
 * Cancelled through the API rather than the UI on purpose: this has to work
 * precisely when the test failed BECAUSE the UI was not in the state it
 * expected, so it cannot depend on a button being present or enabled.
 */
test.afterEach(async ({ request }) => {
  const status = await request.get("/api/render/status");
  if (!status.ok()) return;
  const { running } = (await status.json()) as { running: boolean };
  if (running) await request.post("/api/render/cancel");
});

test.afterAll(async () => {
  await rm(COMMAND, { force: true });
  await rm(FAKE_RENDER, { force: true });
  await rm(join(WORKDIR, "renderflow-burst-fake.cjs"), { force: true });
});

test("a running render survives a refresh, and can be cancelled (R16 §60)", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  await page.getByTestId("render-button").click();
  await expect(page.getByTestId("render-status")).toBeVisible();
  // Progress lines are flowing before we pull the rug.
  await expect(page.getByTestId("render-log")).toContainText("%");

  // The reported bug: a refresh orphaned the run — no logs, no progress, no
  // way to stop it, while the child kept rendering server-side.
  await page.reload();
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  await expect(page.getByTestId("render-status")).toBeVisible();
  await expect(page.getByTestId("render-log")).toContainText("%");
  // The elapsed clock resumes from the SERVER's spawn stamp, not from zero —
  // by the time the reload settles, the run is seconds old.
  await expect(page.getByTestId("render-status")).not.toContainText("0:00");

  // …and the run can be stopped, reading as a CANCEL, not a failure.
  await page.getByTestId("render-cancel").click();
  await expect(page.getByTestId("render-cancelled")).toBeVisible();
  await expect(page.getByTestId("render-cancelled")).toContainText("render cancelled");
  await page.getByText("Dismiss").click();
  await expect(page.getByTestId("render-log")).toHaveCount(0);
});

test("the render log is a scrollable tail and collapses behind the toggle (R17 §84)", async ({
  page,
}) => {
  // A burst-printer: more lines at once than the tail box can show, then
  // stays alive so the run can be cancelled. A script FILE like the first
  // test's fake, not `node -e` (§129): the render endpoint prepends the
  // `produce` literal to recorded args that lack it, and with `-e` the
  // healed argv evaluates the string "produce" and dies with a
  // ReferenceError instead of printing lines — this exact fixture broke CI
  // on the §129 release.
  const burstFake = join(WORKDIR, "renderflow-burst-fake.cjs");
  await writeFile(
    burstFake,
    "for (let i = 0; i < 60; i++) console.log(`line ${i}`); setTimeout(() => {}, 50000);",
  );
  await writeFile(
    COMMAND,
    JSON.stringify({
      execPath: process.execPath,
      execArgv: [],
      script: burstFake,
      args: ["produce"],
      cwd: WORKDIR,
    }),
  );
  await page.goto("/");
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  await page.getByTestId("render-button").click();
  await expect(page.getByTestId("render-status")).toBeVisible();

  // A NEW run opens its own log (§147). Asserted rather than assumed: the
  // first test leaves a finished run in the server's ring buffer, this test's
  // goto restores it, and the restore path collapses the log — which used to
  // govern this run too, so the tail below simply did not exist. Every
  // assertion after this line silently depended on that not happening.
  const tail = page.getByTestId("render-tail");
  await expect(tail).toBeVisible();

  // The tail holds ALL 60 lines in a bounded, scrollable box — not the old
  // last-six-lines slice — and sticks to the bottom as they arrive.
  await expect(tail).toContainText("line 59");
  expect(await tail.evaluate((el) => el.scrollHeight > el.clientHeight + 20)).toBe(true);
  expect(
    await tail.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 8),
    "the tail follows the newest line until the user scrolls away",
  ).toBe(true);
  // Scrolling to the top lets the log be READ mid-run; the earliest line is
  // reachable, which the six-line slice never allowed.
  await tail.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(tail).toContainText("line 0");

  // Collapse: the tail folds away, the status row (spinner, elapsed,
  // cancel) stays. Expand brings it back.
  await page.getByTestId("render-logs-toggle").click();
  await expect(tail).toHaveCount(0);
  await expect(page.getByTestId("render-status")).toBeVisible();
  await page.getByTestId("render-logs-toggle").click();
  await expect(page.getByTestId("render-tail")).toBeVisible();

  await page.getByTestId("render-cancel").click();
  await expect(page.getByTestId("render-cancelled")).toBeVisible();
  await page.getByText("Dismiss").click();
});
