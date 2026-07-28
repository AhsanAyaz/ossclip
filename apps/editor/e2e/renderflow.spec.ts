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

test.beforeAll(async () => {
  await writeFile(
    COMMAND,
    JSON.stringify({
      execPath: process.execPath,
      execArgv: [],
      script: "-e",
      args: [
        "let i=0; setInterval(() => { console.log(`  ${Math.min(90, i * 10)}%`); i++; if (i > 100) process.exit(0); }, 500);",
      ],
      cwd: WORKDIR,
    }),
  );
});

test.afterAll(async () => {
  await rm(COMMAND, { force: true });
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
