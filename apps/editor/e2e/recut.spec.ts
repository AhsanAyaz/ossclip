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
 * other specs left them — only the source mapping moves.
 *
 * Two spans rather than a single shifted one, on purpose — but the second span
 * ALONE does not earn that: on the far side of the cut the projection is
 * exactly `start + 3`, so a "just add a constant" implementation satisfies it.
 * The discriminating case is a word on the NEAR side, where source and output
 * are equal and a constant offset is visibly wrong. Both sides are asserted
 * below; the pair is what separates "projected through the map" from "shifted
 * by a constant" (§137 review round 2 — the first version of this file claimed
 * the far side did that on its own, and it does not).
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

/** Every caption word in the file the server is currently serving, flattened. */
const fixtureWords = async (): Promise<Array<{ text: string; start: number }>> => {
  const props = JSON.parse(await readFile(PROPS, "utf8"));
  return props.captionLines.flatMap(
    (l: { words: Array<{ text: string; start: number }> }) => l.words,
  );
};

const readDoc = async () =>
  JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));

test("a retype after a cut is keyed by SOURCE time, not output time (§137)", async ({ page }) => {
  const words = await fixtureWords();
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
  const doc = await readDoc();

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
  const words = await fixtureWords();
  const index = words.findIndex((w) => w.start > CUT_AT_OUTPUT);

  await page.goto("/");
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  await page.getByTestId("transcript-toggle").click();
  const target = page.getByTestId(`transcript-word-${index}`);
  await target.scrollIntoViewIfNeeded();
  await expect(target).toHaveText("RECUT");
});

test("a word BEFORE the cut keys at its UNCHANGED source time — the projection is per-span, not a constant offset", async ({
  page,
}) => {
  // §137 review round 2. The far-side test above cannot tell a real projection
  // from `srcStart = start + REMOVED_SEC`: past the cut those are the same
  // number. This is the case that separates them — before the cut the map is
  // the identity, so a constant offset keys the edit `REMOVED_SEC` too late
  // and lands on a source instant this word never occupied.
  const words = await fixtureWords();
  const index = words.findIndex((w) => w.start < CUT_AT_OUTPUT);
  expect(index, "fixture must have a caption word before the cut").toBeGreaterThan(-1);
  const word = words[index]!;
  expect(expectedSrc(word.start), "this side of the cut must be the identity").toBeCloseTo(
    word.start,
    6,
  );

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
  await edit.fill("UNCUT");
  await edit.press("Enter");
  await expect(target).toHaveText("UNCUT");

  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const doc = await readDoc();

  const sourceKey = `w${Math.round(word.start * 1000)}`;
  // What a constant-offset implementation would have written instead.
  const offsetKey = `w${Math.round((word.start + REMOVED_SEC) * 1000)}`;
  expect(sourceKey).not.toBe(offsetKey);
  expect(doc.captions[sourceKey]).toEqual({ text: "UNCUT", was: word.text });
  expect(doc.captions[offsetKey]).toBeUndefined();
});

test("a pre-§137 positional edit is migrated on load and shows on its word (§137 Task 6)", async ({
  page,
}) => {
  // The wiring, end to end — and the only test that can see it. The unit
  // tests prove `anchorCaptionLines` and `migrateLoadedDoc` are each correct;
  // an App.tsx that simply never called the second would pass every one of
  // them. This is a doc exactly as a project saved before §137 holds it — the
  // flat word POSITION as the key — against a workdir whose render-props.json
  // predates `srcStart` and whose spans carry a real cut, so the load path has
  // to backfill the anchors AND migrate the key for the edit to appear.
  //
  // Written LAST in the last serialized project: it replaces the shared
  // workdir's overrides.json outright, so nothing after it may depend on what
  // the tests above saved.
  const words = await fixtureWords();
  const index = words.findIndex((w) => w.start > CUT_AT_OUTPUT);
  const word = words[index]!;
  await writeFile(
    join(WORKDIR, "overrides.json"),
    JSON.stringify({ captions: { [String(index)]: { text: "LEGACY", was: word.text } } }),
  );

  await page.goto("/");
  await page.waitForSelector('[data-testid^="timeline-block-"]');
  await page.getByTestId("transcript-toggle").click();
  const target = page.getByTestId(`transcript-word-${index}`);
  await target.scrollIntoViewIfNeeded();
  await expect(target).toHaveText("LEGACY");
  // And nothing was reported lost — the edit was placed, not merely survived.
  await expect(page.getByTestId("caption-migration-notice")).toHaveCount(0);
  await expect(page.getByTestId("caption-dropped-notice")).toHaveCount(0);
});
