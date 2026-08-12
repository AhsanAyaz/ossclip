import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;
const PROPS = join(WORKDIR, "render-props.json");

/**
 * Source time is NOT output time (§137 review, Minor 6).
 *
 * The committed fixture's `spans` are a single identity map
 * (`srcIn 0 → outIn 0`), so every caption word's source start equals its output
 * start — which means the retype specs in `interactions.spec.ts` would pass
 * unchanged if the editor keyed edits on the word's OUTPUT time. That is the
 * distinction the whole change is about, and nothing end-to-end pinned it.
 * Task 1's review predicted exactly this gap.
 *
 * So: rewrite the shared workdir's spans to a real cut, in this file's own
 * serialized project (the `landscape` pattern — the edit server reads the file
 * per request, so one server serves both). Three seconds are removed at output
 * 5s:
 *
 *   output 0…5      →  source 0…5      (unchanged)
 *   output 5…31.92  →  source 8…34.92  (+3)
 *
 * Total output duration is deliberately UNCHANGED, so the timeline, the
 * caption line timings and every other on-screen thing stay exactly as the
 * other specs left them — only the source mapping moves. Two spans rather than
 * a single shifted one, on purpose: a constant offset would also be produced by
 * an implementation that simply added a number, and this fixture separates
 * "projected through the map" from "shifted by a constant".
 */

const CUT_AT_OUTPUT = 5;
const REMOVED_SEC = 3;

let originalProps = "";

test.beforeAll(async () => {
  originalProps = await readFile(PROPS, "utf8");
  const props = JSON.parse(originalProps);
  const total = props.outputDurationSec;
  props.spans = [
    { srcIn: 0, srcOut: CUT_AT_OUTPUT, outIn: 0, outOut: CUT_AT_OUTPUT },
    {
      srcIn: CUT_AT_OUTPUT + REMOVED_SEC,
      srcOut: total + REMOVED_SEC,
      outIn: CUT_AT_OUTPUT,
      outOut: total,
    },
  ];
  await writeFile(PROPS, JSON.stringify(props));
});

test.afterAll(async () => {
  if (originalProps) await writeFile(PROPS, originalProps);
});

/** The word's source start under the spans above — the projection, by hand. */
const expectedSrc = (outputStart: number) =>
  outputStart < CUT_AT_OUTPUT ? outputStart : outputStart + REMOVED_SEC;

test("a retype after a cut is keyed by SOURCE time, not output time (§137)", async ({ page }) => {
  const props = JSON.parse(await readFile(PROPS, "utf8"));
  const words: Array<{ text: string; start: number }> = props.captionLines.flatMap(
    (l: { words: Array<{ text: string; start: number }> }) => l.words,
  );
  // A word on the FAR side of the cut, where source and output disagree.
  const index = words.findIndex((w) => w.start > CUT_AT_OUTPUT);
  expect(index, "fixture must have a caption word after the cut").toBeGreaterThan(-1);
  const word = words[index]!;

  await page.goto("/");
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  await page.getByTestId("transcript-toggle").click();
  await expect(page.getByTestId("transcript-panel")).toBeVisible();

  const target = page.getByTestId(`transcript-word-${index}`);
  await target.scrollIntoViewIfNeeded();
  await expect(target).toHaveText(word.text);
  await target.dblclick();
  const edit = page.getByTestId("transcript-edit");
  await expect(edit).toBeVisible();
  await edit.fill("RECUT");
  await edit.press("Enter");
  await expect(target).toHaveText("RECUT");

  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));

  const sourceKey = `w${Math.round(expectedSrc(word.start) * 1000)}`;
  const outputKey = `w${Math.round(word.start * 1000)}`;
  // The two must actually differ, or this test proves nothing.
  expect(sourceKey).not.toBe(outputKey);
  expect(doc.captions[sourceKey]).toEqual({ text: "RECUT", was: word.text });
  expect(doc.captions[outputKey]).toBeUndefined();
  // Nor the pre-§137 positional key.
  expect(doc.captions[String(index)]).toBeUndefined();
});

test("the edit survives a reload — the anchor is re-derived to the same key", async ({ page }) => {
  // The half that matters in the field: an edit is only useful if the NEXT
  // load finds the word again. It reaches `applyCaptionEdits` through the same
  // backfill, so a projection that is merely self-consistent at write time but
  // wrong at read time would show up here as a reverted word.
  const props = JSON.parse(await readFile(PROPS, "utf8"));
  const words: Array<{ text: string; start: number }> = props.captionLines.flatMap(
    (l: { words: Array<{ text: string; start: number }> }) => l.words,
  );
  const index = words.findIndex((w) => w.start > CUT_AT_OUTPUT);

  await page.goto("/");
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  await page.getByTestId("transcript-toggle").click();
  const target = page.getByTestId(`transcript-word-${index}`);
  await target.scrollIntoViewIfNeeded();
  await expect(target).toHaveText("RECUT");
});
