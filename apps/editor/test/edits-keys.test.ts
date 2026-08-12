import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OverrideDocSchema, type CaptionLine } from "@ossclip/core/browser";
import { editReducer, initialEditState } from "../src/useEdits";
import {
  anchorCaptionLines,
  captionSrcFromAttribute,
  droppedEditNotices,
  migrateLoadedDoc,
  migrationLossNotices,
  renderLossNotices,
  sourceKeyedCaptionEdits,
  vanishedCaptionEdits,
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
    // reported lost, and NOTHING is placed. A test that only ever ran against
    // repaired lines would have called that a passing migration.
    const props = { captionLines: [legacy(["Claude", 0.09, 0.47], ["gave", 0.47, 0.78])] };
    const doc = OverrideDocSchema.parse({ captions: { "1": { text: "GAVE", was: "gave" } } });
    const out = migrateLoadedDoc(doc, props);
    expect(out.unresolved).toEqual([{ key: "1", was: "gave", reason: "unanchorable" }]);
    // And the edit is still THERE. It used to come back as `{}` — which meant
    // the very next ⌘S wrote that emptiness to disk, over a project whose only
    // defect was an old render-props.json (final review, Important 5).
    expect(out.doc.captions).toEqual({ "1": { text: "GAVE", was: "gave" } });
  });

  it("KEEPS what it could not place, so a save round-trips it (Important 5)", () => {
    // `edits.load` marks the doc clean AND clears undo, so a stripped edit had
    // no route back: dismiss the banner, change anything, save, gone for good.
    // The doc the editor holds must be a superset of what it loaded.
    const props = { baseCaptionLines: [anchoredLine("Claude", 0.09, 0.09)] };
    const doc = OverrideDocSchema.parse({
      captions: { "7": { text: "GONE", was: "nothing-says-this" } },
    });
    const out = migrateLoadedDoc(doc, props);
    expect(out.doc.captions).toEqual(doc.captions);
    expect(out.unresolved).toEqual([
      { key: "7", was: "nothing-says-this", reason: "not-found" },
    ]);
  });

  it("still retires a `superseded` legacy duplicate — the one deletion that is not a loss", () => {
    const props = { baseCaptionLines: [anchoredLine("Claude", 0.09, 0.09)] };
    const doc = OverrideDocSchema.parse({
      captions: { "0": { text: "OLD", was: "Claude" }, w90: { text: "NEW", was: "Claude" } },
    });
    const out = migrateLoadedDoc(doc, props);
    expect(out.doc.captions).toEqual({ w90: { text: "NEW", was: "Claude" } });
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
  const REASONS = [
    "not-found",
    "out-of-range",
    "ambiguous",
    "unanchorable",
    "collision",
    "superseded",
  ] as const;
  const loss = (reason: (typeof REASONS)[number]) =>
    migrationLossNotices([{ key: "3", was: "batch,", reason }])[0]!;

  it("names the word, whatever the cause", () => {
    for (const r of REASONS) expect(loss(r)).toContain("batch,");
  });

  it("blames the cut ONLY when the word is actually gone (Minor 7)", () => {
    // The other four leave the word sitting on screen — an earlier version
    // told the user it had been cut, which is a search for something that
    // never moved. `out-of-range` is the newest member of that group (final
    // review, Important 2) and the most misleading one to get wrong: the word
    // is not merely still on screen, it is still the RIGHT word.
    expect(loss("not-found")).toContain("the cut probably removed it");
    expect(loss("out-of-range")).not.toContain("cut");
    expect(loss("ambiguous")).not.toContain("cut");
    expect(loss("collision")).not.toContain("cut");
    expect(loss("superseded")).not.toContain("cut");
    expect(loss("unanchorable")).not.toContain("cut");
  });

  it("tells the out-of-range user their edit is still saved", () => {
    // It is: the doc keeps it (`captionEditsToKeep`). A sentence that read as
    // a loss would have them redo work they still have.
    expect(loss("out-of-range")).toContain("still saved");
    expect(loss("out-of-range")).toContain("too far");
  });

  it("asks for a retype only where a retype is the answer", () => {
    // "Retype", capitalised: every sentence opens with "was retyped in an
    // older version", so a bare substring match would pass on all of them.
    expect(loss("not-found")).toContain("Retype");
    expect(loss("out-of-range")).toContain("Retype");
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
 * The doc now carries edits the migration could not place, and they are keyed
 * by POSITION — so the apply pass has to be handed a narrower set than the doc
 * (final review, Important 5, second-order).
 */
describe("sourceKeyedCaptionEdits", () => {
  const edit = { text: "Bash,", was: "batch," };

  it("drops the positional keys the apply pass cannot address", () => {
    // Left in, `applyCaptionEdits` reports each as `found: null` — "no word in
    // this cut sits at that moment any more" — which is the wrong diagnosis
    // (the key never named a moment) and a second banner for something the
    // migration notice already covered.
    expect(sourceKeyedCaptionEdits({ "0": edit, w1768: edit })).toEqual({ w1768: edit });
  });

  it("is a no-op for the ordinary source-keyed doc, including w0", () => {
    const doc = { w0: edit, w1768: edit };
    expect(sourceKeyedCaptionEdits(doc)).toEqual(doc);
    expect(sourceKeyedCaptionEdits({})).toEqual({});
  });
});

/**
 * The render is the one moment the editor adopts a doc it did not write, and
 * on SUCCESS every other channel is already empty: `setRender(null)` throws
 * away the log that named anything produce dropped, and the reloaded doc is
 * clean so neither `unresolved` nor `dropped` has anything to say (final
 * review, Important 4).
 */
describe("vanishedCaptionEdits", () => {
  const zsh = { text: "Zsh,", was: "edge," };
  const bash = { text: "Bash,", was: "batch," };

  it("says NOTHING about a successful re-key — the whole point of the render", () => {
    // By content, not by key. A key diff would report every repair this branch
    // exists to perform as a loss, which is worse than saying nothing.
    expect(vanishedCaptionEdits({ "1": zsh }, { w6000: zsh })).toEqual([]);
  });

  it("names an edit that did not come back", () => {
    expect(vanishedCaptionEdits({ w6000: zsh, w1768: bash }, { w6000: zsh })).toEqual([bash]);
  });

  it("counts, so one of two identical retypes going missing is still reported", () => {
    // Two words can carry the same retype over the same `was`; a set-based
    // check would see the survivor and call the other one fine.
    const lost = vanishedCaptionEdits({ w1: bash, w2: bash }, { w1: bash });
    expect(lost).toEqual([bash]);
  });

  it("treats a CHANGED replacement as a loss — the old text is not on screen any more", () => {
    expect(vanishedCaptionEdits({ w6000: zsh }, { w6000: { text: "Fish,", was: "edge," } })).toEqual(
      [zsh],
    );
  });

  it("does not let a same-text retype over a DIFFERENT word stand in for the lost one", () => {
    // Both halves of the pair are the identity, not just the replacement: two
    // words retyped to the same string are two different edits, and treating
    // one as the other's survivor loses one silently — the failure mode this
    // whole diff exists to close.
    const overEdge = { text: "X", was: "edge," };
    const overStatus = { text: "X", was: "status" };
    expect(vanishedCaptionEdits({ w6000: overEdge }, { w5000: overStatus })).toEqual([overEdge]);
  });

  it("cannot be fooled by a pair that reads the same when joined", () => {
    // `text` is free-form user input, so any separator it might contain is one
    // a crafted pair could forge into a false survivor.
    const a = { text: "a", was: "b,c" };
    const b = { text: "a,b", was: "c" };
    expect(vanishedCaptionEdits({ w1: a }, { w1: b })).toEqual([a]);
  });

  it("says nothing when the doc is untouched, or empty on both sides", () => {
    expect(vanishedCaptionEdits({ w6000: zsh }, { w6000: zsh })).toEqual([]);
    expect(vanishedCaptionEdits({}, {})).toEqual([]);
    expect(vanishedCaptionEdits({}, { w6000: zsh })).toEqual([]);
  });
});

describe("renderLossNotices", () => {
  it("names both the original word and what it was retyped to", () => {
    const [line] = renderLossNotices([{ text: "Zsh,", was: "edge," }]);
    expect(line).toContain("edge,");
    expect(line).toContain("Zsh,");
  });

  it("invents no cause, and does not send the user to a .bak that may not have it", () => {
    // The reason is in a run log the component has already discarded, and the
    // `.bak` only holds the edit if it ever reached disk — false for the other
    // way this fires (a retype made WHILE the render ran).
    const [line] = renderLossNotices([{ text: "Zsh,", was: "edge," }]);
    expect(line).not.toContain("cut");
    expect(line).not.toContain(".bak");
    expect(line).toContain("Retype it");
  });

  it("says nothing when nothing vanished", () => {
    expect(renderLossNotices([])).toEqual([]);
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

/**
 * The App.tsx side of the render-loss disclosure, guarded by reading the
 * source — the same crude shape, and the same justification, as produce's
 * wiring guard in `apps/cli/test/caption-report.test.ts`.
 *
 * No test in this repo drives a SUCCESSFUL render: `renderflow.spec.ts`'s two
 * runs are a slow fake that gets cancelled, so the poll's `exitCode === 0`
 * branch — the only place the editor adopts a doc it did not write — executes
 * nowhere. That is precisely the branch the final review found silent
 * (Important 4): the run log is discarded on success and the reloaded doc is
 * clean, so the pure functions above can be perfect and the user still sees
 * nothing. Mounting `<App>` to reach it means jsdom plus `<Player>`, which
 * `scene-layer-structure.test.ts` already ruled out for this codebase.
 *
 * A stand-in for a real test of that branch, not a substitute for one.
 */
describe("App.tsx §137 loss wiring (source-text guard)", () => {
  const src = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  it("DIFFS the reloaded doc against the one the render started with", () => {
    // Bound to the pre-reload snapshot on one side and the migrated doc on the
    // other: diffing `migrated.doc` against itself, or against the doc as it
    // was at mount, both typecheck and both report nothing, forever.
    expect(src).toMatch(/const\s+before\s*=\s*captionsRef\.current/);
    expect(src).toMatch(/vanishedCaptionEdits\(\s*before,\s*migrated\.doc\.captions\s*\)/);
  });

  it("SHOWS what that diff found — a computed list nobody renders is the same silence", () => {
    expect(src).toMatch(/setRenderCaptionLoss\(\s*lost\s*\)/);
    expect(src).toMatch(/renderCaptionLoss\.length\s*>\s*0/);
    expect(src).toMatch(/\.\.\.renderCaptionLoss/);
  });

  it("keeps positional keys out of the apply pass", () => {
    // The doc carries edits the migration could not place (Important 5), and
    // they address no word — passing the raw map here reports every one of
    // them as cut-removed on every render.
    expect(src).toMatch(/applyCaptionEdits\(\s*base,\s*sourceKeyedCaptionEdits\(/);
  });
});
