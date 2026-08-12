import { describe, expect, it } from "vitest";
import { OverrideDocSchema, type CaptionLine } from "@ossclip/core/browser";
import { editReducer, initialEditState } from "../src/useEdits";
import {
  anchorCaptionLines,
  captionSrcFromAttribute,
  droppedEditNotices,
  migrateLoadedDoc,
  migrationLossNotices,
} from "../src/captionAnchors";

/**
 * §137 Task 5 — the EDITOR side of source-anchored overrides.
 *
 * Tasks 2-4 re-keyed the core: caption edits live under `w<sourceMs>` and
 * split halves under a minted id. Until this task the editor still WROTE
 * positional keys, so `applyCaptionEdits` read a key space nothing wrote and
 * every retype silently reverted in front of the user (the field case).
 *
 * `addSplit` is deliberately not re-tested here: Task 3 already minted its id
 * through `mintSplitId` (useEdits.ts), and `useEdits.test.ts` covers it.
 */
describe("editor writes source-anchored caption keys (§137)", () => {
  it("patchCaption stores the edit under the word's source key, not its position", () => {
    const doc = OverrideDocSchema.parse({});
    const next = editReducer(
      { ...initialEditState(), doc },
      { type: "patchCaption", srcStart: 1.7675, was: "batch,", text: "Bash," },
    );
    // 1767.5ms rounds to 1768 — the assertion is on the DERIVATION, so a
    // reducer that passed the raw seconds (or the old index) through fails
    // here rather than merely changing shape.
    expect(next.doc.captions).toEqual({ w1768: { text: "Bash,", was: "batch," } });
  });

  it("keys a word at source zero as w0 rather than dropping it", () => {
    const doc = OverrideDocSchema.parse({});
    const next = editReducer(
      { ...initialEditState(), doc },
      { type: "patchCaption", srcStart: 0, was: "Claude", text: "CLAWD" },
    );
    expect(next.doc.captions).toEqual({ w0: { text: "CLAWD", was: "Claude" } });
  });

  it("retyping back to the original still clears the override", () => {
    const doc = OverrideDocSchema.parse({
      captions: { w1768: { text: "Bash,", was: "batch," } },
    });
    const next = editReducer(
      { ...initialEditState(), doc },
      { type: "patchCaption", srcStart: 1.7675, was: "Bash,", text: "batch," },
    );
    expect(next.doc.captions).toEqual({});
  });

  it("a re-edit under the same source key keeps the BASE guard (R15 §59 survives the re-key)", () => {
    let s = editReducer(initialEditState(), {
      type: "patchCaption", srcStart: 1.7675, text: "Bash,", was: "batch,",
    });
    s = editReducer(s, { type: "patchCaption", srcStart: 1.7675, text: "bash", was: "Bash," });
    expect(s.doc.captions.w1768).toEqual({ text: "bash", was: "batch," });
  });
});

/**
 * The load-path repair (§137). Pure so it can be tested without a server: the
 * fetch stays in `App.tsx`, this decides what the caption lines become.
 */
describe("anchorCaptionLines — repairing a pre-§137 render-props.json", () => {
  /** A line as a legacy file holds it: no `srcStart` on any word. */
  const legacy = (...ws: Array<[string, number, number]>): CaptionLine => ({
    words: ws.map(([text, start, end]) => ({ text, start, end }) as CaptionLine["words"][number]),
    start: ws[0]![1],
    end: ws[ws.length - 1]![2],
  });

  it("backfills srcStart through the file's own spans", () => {
    // One kept span starting 10s into the source: an output instant of 0.09
    // is source 10.09.
    const out = anchorCaptionLines({
      captionLines: [legacy(["Claude", 0.09, 0.47])],
      spans: [{ srcIn: 10, srcOut: 41.9, outIn: 0, outOut: 31.9 }],
    });
    expect(out.captionLines![0]!.words[0]!.srcStart).toBeCloseTo(10.09, 6);
  });

  it("repairs baseCaptionLines too — that is the side the retype guard reads", () => {
    // App.tsx merges edits onto `baseCaptionLines ?? captionLines`. Repairing
    // only the live side would leave every edit unanchorable at the exact
    // point it is applied.
    const out = anchorCaptionLines({
      captionLines: [legacy(["Claude", 0.09, 0.47])],
      baseCaptionLines: [legacy(["Claude", 0.09, 0.47])],
      spans: [{ srcIn: 0, srcOut: 31.9, outIn: 0, outOut: 31.9 }],
    });
    expect(out.baseCaptionLines![0]!.words[0]!.srcStart).toBeCloseTo(0.09, 6);
  });

  it("leaves the lines ALONE when there are no spans", () => {
    // Load-bearing (§137, carried from Task 1's review): `mapFromKeptSpans([])`
    // maps every output instant to source 0, so backfilling here would give the
    // whole video ONE anchor — the precise failure this plan removes, arriving
    // as a successful-looking migration. Anchorless words are the honest
    // outcome; `applyCaptionEdits` reports the edits that then find no home.
    const lines = [legacy(["Claude", 0.09, 0.47], ["gave", 0.47, 0.78])];
    const out = anchorCaptionLines({ captionLines: lines, spans: [] });
    expect(out.captionLines).toBeUndefined();
    expect(lines[0]!.words.every((w) => w.srcStart === undefined)).toBe(true);
  });

  it("leaves the lines ALONE when spans is absent entirely", () => {
    const out = anchorCaptionLines({ captionLines: [legacy(["Claude", 0.09, 0.47])] });
    expect(out.captionLines).toBeUndefined();
  });

  it("refuses a NON-EMPTY spans array that still builds an EMPTY map", () => {
    // §137 review, Important 1. `TimeMap`'s constructor drops any span with
    // `srcOut <= srcIn`, so this array is non-empty but the map it builds is
    // not — and an empty map's `toSource` returns 0 for everything. A guard on
    // `spans.length` passes this straight through and puts the whole video on
    // `w0`: retyping word 7 would store `w0`/`was: "seven"`, the next load
    // would match word 0, the guard would mismatch, and the edit would be
    // dropped. Reachable because render-props.json is an unvalidated cast.
    const out = anchorCaptionLines({
      captionLines: [legacy(["Claude", 0.09, 0.47], ["gave", 0.47, 0.78])],
      spans: [{ srcIn: 5, srcOut: 5, outIn: 0, outOut: 0 }],
    });
    expect(out.captionLines).toBeUndefined();
  });

  it("treats a span set TimeMap refuses to build at all as no repair, not a throw", () => {
    // Overlapping and backwards spans make the constructor throw. This runs on
    // the load path, and one of its two callers sits inside a render-poll catch
    // whose recovery is to restart the interval — a deterministic throw there
    // retries forever with `render.running` stuck, which the Save guard turns
    // into a permanent save lockout with unsaved edits still in memory.
    const lines = [legacy(["Claude", 0.09, 0.47])];
    const overlapping = () =>
      anchorCaptionLines({
        captionLines: lines,
        spans: [
          { srcIn: 0, srcOut: 10, outIn: 0, outOut: 10 },
          { srcIn: 5, srcOut: 20, outIn: 10, outOut: 25 },
        ],
      });
    expect(overlapping).not.toThrow();
    expect(overlapping().captionLines).toBeUndefined();

    const backwards = () =>
      anchorCaptionLines({
        captionLines: lines,
        spans: [{ srcIn: 10, srcOut: 5, outIn: 0, outOut: 5 }],
      });
    expect(backwards).not.toThrow();
    expect(backwards().captionLines).toBeUndefined();
  });
});

/**
 * The other half of the load-path repair (§137 Task 6): a doc saved before
 * this change keys its caption edits by POSITION, and any cut shifts them.
 */
describe("migrateLoadedDoc — upgrading a pre-§137 overrides.json", () => {
  /** A line as a legacy render-props.json holds it: no `srcStart` anywhere. */
  const legacy = (...ws: Array<[string, number, number]>): CaptionLine => ({
    words: ws.map(([text, start, end]) => ({ text, start, end }) as CaptionLine["words"][number]),
    start: ws[0]![1],
    end: ws[ws.length - 1]![2],
  });
  const anchoredLine = (text: string, start: number, srcStart: number): CaptionLine => ({
    words: [{ text, start, end: start + 0.3, srcStart }],
    start,
    end: start + 0.3,
  });
  // 10s of source removed before the first word: source time and output time
  // disagree, so a migration that quietly keyed on `start` fails these.
  const CUT_SPANS = [{ srcIn: 10, srcOut: 41.9, outIn: 0, outOut: 31.9 }];

  it("re-keys a positional edit to the word's SOURCE anchor", () => {
    const raw = { captionLines: [legacy(["Claude", 0.09, 0.47], ["gave", 0.47, 0.78])], spans: CUT_SPANS };
    const props = { ...raw, ...anchorCaptionLines(raw) };
    const doc = OverrideDocSchema.parse({ captions: { "1": { text: "GAVE", was: "gave" } } });
    const out = migrateLoadedDoc(doc, props);
    // Output 0.47 through the spans above is source 10.47 — NOT 0.47, which
    // is what an output-keyed migration would have written.
    expect(out.doc.captions).toEqual({ w10470: { text: "GAVE", was: "gave" } });
    expect(out.unresolved).toEqual([]);
  });

  it("is INERT against un-anchored lines — the reason the server does not do this", () => {
    // §137 Task 6's decision, pinned. `apps/cli/src/edit.ts` serves
    // render-props.json exactly as it sits on disk, so a migration bolted on
    // there would see this: every word answers "no anchor", every edit is
    // reported lost, and the doc comes back empty. A test that only ever ran
    // against repaired lines would have called that a passing migration.
    const props = { captionLines: [legacy(["Claude", 0.09, 0.47], ["gave", 0.47, 0.78])] };
    const doc = OverrideDocSchema.parse({ captions: { "1": { text: "GAVE", was: "gave" } } });
    const out = migrateLoadedDoc(doc, props);
    expect(out.doc.captions).toEqual({});
    expect(out.unresolved).toEqual([{ key: "1", was: "gave", reason: "unanchorable" }]);
  });

  it("resolves against baseCaptionLines, the lines the edits are actually merged onto", () => {
    // `captionLines` already has the last run's edits baked in, so the word at
    // position 0 there says "EDITED" and the `was` guard could never confirm
    // it. Only the pristine base can, and that is the side App.tsx merges onto.
    const props = {
      captionLines: [anchoredLine("EDITED", 0.09, 0.09)],
      baseCaptionLines: [anchoredLine("Claude", 0.09, 0.09)],
    };
    const doc = OverrideDocSchema.parse({ captions: { "0": { text: "CLAWD", was: "Claude" } } });
    const out = migrateLoadedDoc(doc, props);
    expect(out.doc.captions).toEqual({ w90: { text: "CLAWD", was: "Claude" } });
  });

  it("leaves an already source-keyed doc alone, and never touches the rest of it", () => {
    // Every load runs this, not just legacy ones — so a modern doc has to come
    // back identical, splits/cuts/theme included.
    const props = { baseCaptionLines: [anchoredLine("Claude", 0.09, 0.09)] };
    const doc = OverrideDocSchema.parse({
      captions: { w90: { text: "CLAWD", was: "Claude" } },
      splits: [{ at: 5, id: "s1" }],
      captionsHidden: true,
    });
    const out = migrateLoadedDoc(doc, props);
    expect(out.doc).toEqual(doc);
    expect(out.unresolved).toEqual([]);
  });
});

describe("what the user is told about caption edits that did not land (§137)", () => {
  const loss = (reason: "not-found" | "ambiguous" | "unanchorable" | "collision" | "superseded") =>
    migrationLossNotices([{ key: "3", was: "batch,", reason }])[0]!;

  it("names the word, whatever the cause", () => {
    for (const r of ["not-found", "ambiguous", "unanchorable", "collision", "superseded"] as const) {
      expect(loss(r)).toContain("batch,");
    }
  });

  it("blames the cut ONLY when the word is actually gone (Minor 7)", () => {
    // The other three leave the word sitting on screen — an earlier version
    // told the user it had been cut, which is a search for something that
    // never moved.
    expect(loss("not-found")).toContain("the cut probably removed it");
    expect(loss("ambiguous")).not.toContain("cut");
    expect(loss("collision")).not.toContain("cut");
    expect(loss("superseded")).not.toContain("cut");
    expect(loss("unanchorable")).not.toContain("cut");
  });

  it("asks for a retype only where a retype is the answer", () => {
    // "Retype", capitalised: every sentence opens with "was retyped in an
    // older version", so a bare substring match would pass on all five.
    expect(loss("not-found")).toContain("Retype");
    expect(loss("ambiguous")).toContain("Retype");
    expect(loss("collision")).toContain("Retype");
    // The newer edit was KEPT — there is nothing for the user to redo.
    expect(loss("superseded")).not.toContain("Retype");
    // Nor here: no source timing is a defect in the project's files, and the
    // fix is to re-run produce, not to type the word again.
    expect(loss("unanchorable")).toContain("Re-run produce");
  });

  it("says the word is GONE when nothing carries the anchor any more", () => {
    // The field case: `found: null` means the cut removed the word. The line
    // must not read as "the transcript says null there".
    const [line] = droppedEditNotices([{ key: "w1768", expected: "batch,", found: null }]);
    expect(line).toContain("batch,");
    expect(line).toContain("no word in this cut");
    expect(line).not.toContain("null");
  });

  it("names the word the transcript holds instead when there is one", () => {
    const [line] = droppedEditNotices([{ key: "w1768", expected: "batch,", found: "bash," }]);
    expect(line).toContain("bash,");
  });

  it("treats a duplicate anchor as a note, not a lost edit", () => {
    // The edit APPLIED, to the first word carrying that source moment. Telling
    // the user to retype something already on screen would be worse than
    // silence.
    const [line] = droppedEditNotices([
      { key: "w1768", expected: "batch,", found: "batch,", reason: "duplicate-anchor" },
    ]);
    expect(line).toContain("only the first was retyped");
  });

  it("says a MIXED doc kept the newer edit rather than losing it (Important 3)", () => {
    const { doc: out, unresolved } = migrateLoadedDoc(
      OverrideDocSchema.parse({
        captions: {
          "0": { text: "Zsh,", was: "edge," },
          w6000: { text: "Fish,", was: "edge," },
        },
      }),
      { baseCaptionLines: [{ words: [{ text: "edge,", start: 0, end: 1, srcStart: 6 }], start: 0, end: 1 }] },
    );
    // A project edited before AND after this change holds both key spaces over
    // one word. Refusing both deleted the current-format edit.
    expect(out.captions).toEqual({ w6000: { text: "Fish,", was: "edge," } });
    expect(unresolved).toEqual([{ key: "0", was: "edge,", reason: "superseded" }]);
  });

  it("says nothing at all when nothing was dropped", () => {
    expect(droppedEditNotices([])).toEqual([]);
    expect(migrationLossNotices([])).toEqual([]);
  });
});

/**
 * The DOM boundary between `CaptionTrack` and `Overlay` (§137). The stage
 * double-click has no caption lines to consult, so the anchor re-enters the
 * editor as an attribute string here.
 */
describe("captionSrcFromAttribute", () => {
  it("parses a real anchor, including zero", () => {
    expect(captionSrcFromAttribute("1.7675")).toBeCloseTo(1.7675, 6);
    // A word at the very start of the source is anchorable; anything that
    // treated "0" as falsy would make the first word un-retypable.
    expect(captionSrcFromAttribute("0")).toBe(0);
  });

  it("returns null for every shape that means `no anchor`", () => {
    // CaptionTrack OMITS the attribute for an unanchorable word, so `undefined`
    // is the normal case, not an error. `Number("")` is 0 — an empty attribute
    // must not read as an anchor at the start of the source.
    expect(captionSrcFromAttribute(undefined)).toBeNull();
    expect(captionSrcFromAttribute("")).toBeNull();
    expect(captionSrcFromAttribute("   ")).toBeNull();
    expect(captionSrcFromAttribute("NaN")).toBeNull();
    expect(captionSrcFromAttribute("Infinity")).toBeNull();
    expect(captionSrcFromAttribute("not-a-number")).toBeNull();
  });

  it("never re-derives an anchor a word already carries", () => {
    // A file written AFTER §137 has real source times from the map that
    // actually produced them; re-projecting through `spans` would overwrite
    // truth with an approximation.
    const anchored: CaptionLine = {
      words: [{ text: "Claude", start: 0.09, end: 0.47, srcStart: 99 }],
      start: 0.09,
      end: 0.47,
    };
    const out = anchorCaptionLines({
      captionLines: [anchored],
      spans: [{ srcIn: 0, srcOut: 31.9, outIn: 0, outOut: 31.9 }],
    });
    expect(out.captionLines![0]!.words[0]!.srcStart).toBe(99);
  });
});
