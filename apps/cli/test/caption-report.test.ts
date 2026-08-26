import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OverrideDocSchema, TimeMap, type CaptionLine, type OverrideDoc } from "@ossclip/core";
import {
  appliedCaptionEditCount,
  captionDropLine,
  captionMigrationLine,
  reanchoredKeyCount,
  reconcileCaptionEdits,
} from "../src/caption-report";

/**
 * Every `reconcileCaptionEdits` case in this file reasons about the TEXT
 * layers, not the clock. One kept span over the whole source makes the pass's
 * `map` an identity (`toOutputClamped(t) === t`), so the window layer
 * (`applyCaptionLineWindows`, which is the only thing the map is there for) is
 * a no-op and these cases read exactly as they did before it existed — the
 * window layer's own behaviour is pinned in core, over a map with a cut in it,
 * where it can actually say something.
 */
const IDENTITY_MAP = new TimeMap([{ srcIn: 0, srcOut: 3600, kind: "keep" }]);
const reconcile = (d: OverrideDoc, ls: readonly CaptionLine[]) =>
  reconcileCaptionEdits(d, ls, IDENTITY_MAP);

/**
 * §137 Task 6 — what `produce` says about caption edits that did not apply.
 * Both halves of the old reporting were wrong in ways that hid exactly the
 * failure this plan exists to remove.
 */
describe("captionDropLine", () => {
  it("says the word was CUT, not that the transcript has `null`", () => {
    // The field case. `found: null` was interpolated straight into the
    // sentence, so the one drop §137 is about printed as
    // `the transcript now has "null"` — unreadable as the thing that happened.
    const line = captionDropLine({ key: "w1768", expected: "batch,", found: null });
    expect(line).not.toContain("null");
    expect(line).toContain("batch,");
    expect(line).toContain("w1768");
    expect(line).toContain("the cut removed");
  });

  it("does not blame the cut for a key that is a POSITION, not an anchor", () => {
    // Important 2: `"0"` never had a source moment to lose. On the one path
    // that prints it — an edit reaching produce without a migration — the old
    // wording sent the user to redo work sitting intact on screen.
    const line = captionDropLine({ key: "0", expected: "batch,", found: null });
    expect(line).not.toContain("the cut removed");
    expect(line).toContain("position 0");
    expect(line).toContain("before source anchors");
  });

  it("names the word the transcript holds now when there IS one", () => {
    const line = captionDropLine({ key: "w1768", expected: "batch,", found: "bash," });
    expect(line).toContain(`says "bash," there`);
    expect(line).not.toContain("the cut removed");
  });

  it("reports a duplicate anchor as a note about reach, not a dropped edit", () => {
    // `applyCaptionEdits` pushes this for the SECOND word carrying an anchor;
    // the edit itself applied to the first. Calling it "dropped" would send
    // the user to retype an edit that is already in the video.
    const line = captionDropLine({
      key: "w1768",
      expected: "batch,",
      found: "batch,",
      reason: "duplicate-anchor",
    });
    expect(line).not.toContain("dropped");
    expect(line).toContain("only the first was retyped");
  });
});

describe("appliedCaptionEditCount", () => {
  const edit = (was: string) => ({ text: was.toUpperCase(), was });

  it("counts every edit when nothing was dropped", () => {
    expect(appliedCaptionEditCount({ w1: edit("a"), w2: edit("b") }, [])).toBe(2);
  });

  it("does not count an edit whose word was cut or had moved on", () => {
    expect(
      appliedCaptionEditCount({ w1: edit("a"), w2: edit("b") }, [
        { key: "w1", expected: "a", found: null },
      ]),
    ).toBe(1);
  });

  it("STILL counts an edit that only ever appears as a duplicate anchor", () => {
    // The edit applied to the first word carrying `w1`; the report is about
    // the second. `keys.length - dropped.length` scored this as 0 applied.
    expect(
      appliedCaptionEditCount({ w1: edit("a") }, [
        { key: "w1", expected: "a", found: "a", reason: "duplicate-anchor" },
      ]),
    ).toBe(1);
  });

  it("never goes negative when one key is reported more than once", () => {
    // Three words sharing one anchor: two duplicate reports for a single key,
    // plus a real drop for the other. The subtraction this replaces returned
    // 2 - 3 = -1, which the caller's `> 0` guard silenced completely.
    const dropped = [
      { key: "w1", expected: "a", found: "a", reason: "duplicate-anchor" as const },
      { key: "w1", expected: "a", found: "a", reason: "duplicate-anchor" as const },
      { key: "w2", expected: "b", found: null },
    ];
    expect(appliedCaptionEditCount({ w1: edit("a"), w2: edit("b") }, dropped)).toBe(1);
  });

  it("counts a key reported BOTH ways as not applied", () => {
    // The first word carrying `w1` mismatched (reason absent — a real drop)
    // and a second word carried the same anchor. The `reason`-less entry is
    // the verdict; the duplicate note must not overturn it.
    const dropped = [
      { key: "w1", expected: "a", found: "z" },
      { key: "w1", expected: "a", found: "a", reason: "duplicate-anchor" as const },
    ];
    expect(appliedCaptionEditCount({ w1: edit("a") }, dropped)).toBe(0);
  });
});

describe("captionMigrationLine", () => {
  const REASONS = [
    "not-found",
    "out-of-range",
    "ambiguous",
    "unanchorable",
    "collision",
    "superseded",
  ] as const;
  const line = (reason: (typeof REASONS)[number]) =>
    captionMigrationLine({ key: "3", was: "batch,", reason });

  it("names the CAUSE — four of the five leave the word on screen", () => {
    // Minor 7: one message blaming the cut sends the user hunting for a word
    // that never moved.
    expect(line("not-found")).toContain("no word says it any more");
    expect(line("out-of-range")).toContain("the word is still here");
    expect(line("ambiguous")).toContain("more than one word says it");
    expect(line("unanchorable")).toContain("no source timing");
    expect(line("collision")).toContain("two stored edits point at the same word");
    expect(line("superseded")).toContain("a newer edit already covers that word");
  });

  it("blames the cut ONLY for the edit whose word is actually gone", () => {
    // `out-of-range` is the one added by the final review (Important 2), and
    // it exists precisely so this sentence stops being shared with it.
    expect(line("not-found")).toContain("removed it");
    expect(line("out-of-range")).not.toContain("removed");
  });

  it("says an out-of-range edit is KEPT, because it is (Critical 1)", () => {
    // The produce run leaves it in overrides.json, so a user told to "retype
    // it if you still want it" would be redoing work they still have.
    expect(line("out-of-range")).toContain("kept in overrides.json");
  });

  it("only asks for a retype where a retype is the answer", () => {
    // `superseded` kept the newer edit and `unanchorable` is a defect in the
    // project's files — telling either user to retype is telling them to redo
    // work that is not lost.
    expect(line("superseded")).not.toContain("etype");
    expect(line("unanchorable")).not.toContain("etype");
    expect(line("not-found")).toContain("etype");
    expect(line("ambiguous")).toContain("etype");
  });

  it("always names the word and the key it was stored under", () => {
    for (const r of REASONS) {
      expect(line(r)).toContain('"batch,"');
      expect(line(r)).toContain("(3)");
    }
  });
});

describe("reanchoredKeyCount", () => {
  const edit = { text: "Bash,", was: "batch," };

  it("counts only the edits that came out under a NEW key", () => {
    expect(reanchoredKeyCount({ "0": edit }, { edits: { w1768: edit }, unresolved: [] })).toBe(1);
    expect(reanchoredKeyCount({ w1768: edit }, { edits: { w1768: edit }, unresolved: [] })).toBe(0);
  });

  it("counts nothing for a MIXED doc whose source-keyed edit simply won", () => {
    // The count that used to be `Object.keys(edits).length` said "1
    // re-anchored" here, about a key the migration never touched.
    expect(
      reanchoredKeyCount(
        { "0": edit, w1768: edit },
        { edits: { w1768: edit }, unresolved: [{ key: "0", was: "batch,", reason: "superseded" }] },
      ),
    ).toBe(0);
  });
});

describe("reconcileCaptionEdits — produce's caption pass (§137 Task 6, Critical 1)", () => {
  const lines = (...ws: Array<[string, number]>): CaptionLine[] => [
    {
      words: ws.map(([text, srcStart], i) => ({ text, start: i, end: i + 1, srcStart })),
      start: 0,
      end: ws.length,
    },
  ];
  const doc = (captions: Record<string, { text: string; was: string }>) =>
    OverrideDocSchema.parse({ captions });

  it("APPLIES a pre-§137 positional edit — the render used to ship without it", () => {
    // The field case this fix exists for: the editor repairs the doc in
    // memory, `edits.load` leaves it clean, and a Render that saves nothing
    // hands produce the untouched legacy doc. Migrate-then-apply is what puts
    // the retype in the video.
    const out = reconcile(doc({ "1": { text: "Zsh,", was: "edge," } }), lines(["status", 5], ["edge,", 6]));
    expect(out.lines[0]!.words.map((w) => w.text)).toEqual(["status", "Zsh,"]);
    expect(out.doc.captions).toEqual({ w6000: { text: "Zsh,", was: "edge," } });
    expect(out.reanchored).toBe(true);
    expect(out.log.join("\n")).toContain("re-anchored");
  });

  it("leaves a source-keyed doc completely alone — no write-back, no noise", () => {
    const before = doc({ w6000: { text: "Zsh,", was: "edge," } });
    const out = reconcile(before, lines(["status", 5], ["edge,", 6]));
    expect(out.doc).toEqual(before);
    expect(out.reanchored).toBe(false);
    // One line only: the count. A re-anchor line here would claim a migration
    // that did not happen, on every run, forever.
    expect(out.log).toEqual(["▸ 1 caption word(s) retyped by the editor"]);
  });

  it("reports an edit it could not re-anchor, KEEPS it, and does not earn the write", () => {
    // Final review, Criticals 1 and 2 in one case. This used to return an
    // EMPTY caption map with `keysChanged: true`: pure destruction, on a run
    // that repaired nothing — every retype gone from the user's file and the
    // `.bak` (their last pre-cut copy) spent to record it.
    const before = doc({ "0": { text: "Zsh", was: "gone" } });
    const out = reconcile(before, lines(["status", 5]));
    expect(out.doc.captions).toEqual({ "0": { text: "Zsh", was: "gone" } });
    expect(out.reanchored).toBe(false);
    expect(out.log.join("\n")).toContain('"gone"');
    // Never the old misdiagnosis: the doc's key was a POSITION, so nothing was
    // "cut" out from under a source anchor.
    expect(out.log.join("\n")).not.toContain("the cut removed the word");
    // And no "0 caption edit(s) re-anchored" over the top of the explanation:
    // nothing was moved.
    expect(out.log.join("\n")).not.toContain("re-anchored from word positions");
    // One report per edit, not two. The unplaceable edit is deliberately kept
    // OUT of the apply pass (it addresses no word), so `applyCaptionEdits`
    // cannot report it a second time under a different, wronger sentence.
    expect(out.log.filter((l) => l.includes('"gone"'))).toHaveLength(1);
  });

  it("keeps an out-of-range edit so a later run can still place it", () => {
    // Drift past `MIGRATION_SEARCH_RADIUS`: the word is on screen, the stored
    // position is too stale to trust, and the honest outcome is a report plus
    // a doc that still holds the edit — not a delete (Critical 1).
    const words: Array<[string, number]> = [
      ["edge,", 6],
      ...Array.from({ length: 12 }, (_, i): [string, number] => [`filler${i}`, 7 + i]),
    ];
    const before = doc({ "12": { text: "Zsh,", was: "edge," } });
    const out = reconcile(before, lines(...words));
    expect(out.doc.captions).toEqual({ "12": { text: "Zsh,", was: "edge," } });
    expect(out.reanchored).toBe(false);
    expect(out.log.join("\n")).toContain("the word is still here");
  });

  it("a MIXED doc keeps the source-keyed edit, retires the legacy one, and does NOT earn the write", () => {
    // Important 3 reaching produce: a project edited before AND after this
    // change holds both key spaces over one word. The newer edit is the one
    // that renders and the legacy one is retired by name — but nothing MOVED,
    // so neither the count line nor the write-back fires. The gate is "did
    // anything re-anchor", not "did the doc change" (final review, Critical
    // 2): a retirement costs nothing to leave on disk for another run, and an
    // unnecessary write is one more overwrite of a single-generation `.bak`.
    const out = reconcile(
      doc({ "0": { text: "Zsh,", was: "edge," }, w6000: { text: "Fish,", was: "edge," } }),
      lines(["edge,", 6]),
    );
    expect(out.doc.captions).toEqual({ w6000: { text: "Fish,", was: "edge," } });
    expect(out.lines[0]!.words.map((w) => w.text)).toEqual(["Fish,"]);
    expect(out.reanchored).toBe(false);
    expect(out.log.join("\n")).not.toContain("re-anchored from word positions");
    expect(out.log.join("\n")).toContain("a newer edit already covers that word");
  });

  it("keeps the doc's other fields when it rewrites the captions", () => {
    const before = OverrideDocSchema.parse({
      captions: { "0": { text: "Zsh,", was: "edge," } },
      splits: [{ at: 5, id: "s1" }],
      captionsHidden: true,
    });
    const out = reconcile(before, lines(["edge,", 6]));
    expect(out.doc.splits).toEqual(before.splits);
    expect(out.doc.captionsHidden).toBe(true);
  });
});

describe("reconcileCaptionEdits — the caption word-hide layer (§59b, revisited 2026-08-18)", () => {
  const lines = (...ws: Array<[string, number]>): CaptionLine[] => [
    {
      words: ws.map(([text, srcStart], i) => ({ text, start: i, end: i + 1, srcStart })),
      start: 0,
      end: ws.length,
    },
  ];

  it("drops a hidden word from the returned captionLines and writes the doc back untouched", () => {
    const before = OverrideDocSchema.parse({ captionWordsHidden: { w6000: { was: "edge," } } });
    const out = reconcile(before, lines(["status", 5], ["edge,", 6]));
    expect(out.lines[0]!.words.map((w) => w.text)).toEqual(["status"]);
    // The write-back carries the hide layer through as-is — hides never had a
    // positional-key era, so there is nothing for the migration to touch.
    expect(out.doc.captionWordsHidden).toEqual({ w6000: { was: "edge," } });
    // A hide alone earns no write: nothing re-anchored.
    expect(out.reanchored).toBe(false);
  });

  it("applies hides AFTER retypes — a hide whose `was` is the post-retype text lands", () => {
    // The layering contract (`applyCaptionLayers`): the user retyped "edge,"
    // to "Zsh," and THEN hid the word they saw, so the hide's `was` is the
    // live text. Hides running first would stale it against the base.
    const before = OverrideDocSchema.parse({
      captions: { w6000: { text: "Zsh,", was: "edge," } },
      captionWordsHidden: { w6000: { was: "Zsh," } },
    });
    const out = reconcile(before, lines(["status", 5], ["edge,", 6]));
    expect(out.lines[0]!.words.map((w) => w.text)).toEqual(["status"]);
    expect(out.log.join("\n")).not.toContain("hidden word");
  });

  it("reports a stale hide — text changed — with the hidden-word prefix, and keeps the word", () => {
    const before = OverrideDocSchema.parse({ captionWordsHidden: { w6000: { was: "edge," } } });
    const out = reconcile(before, lines(["hedge,", 6]));
    // Left visible rather than deleting a word the user never pointed at.
    expect(out.lines[0]!.words.map((w) => w.text)).toEqual(["hedge,"]);
    const log = out.log.join("\n");
    expect(log).toContain('hidden word "edge,"');
    expect(log).toContain('"hedge,"');
  });

  it("reports a hide whose word the cut removed — nothing left to hide", () => {
    const before = OverrideDocSchema.parse({ captionWordsHidden: { w6000: { was: "edge," } } });
    const out = reconcile(before, lines(["status", 5]));
    expect(out.lines[0]!.words.map((w) => w.text)).toEqual(["status"]);
    const log = out.log.join("\n");
    expect(log).toContain('hidden word "edge,"');
    expect(log).toContain("nothing left to hide");
    expect(log).not.toContain("null");
  });
});

describe("reconcileCaptionEdits — the caption RANGE-edit layer (2026-08-18)", () => {
  const lines = (...ws: Array<[string, number]>): CaptionLine[] => [
    {
      words: ws.map(([text, srcStart], i) => ({ text, start: i, end: i + 1, srcStart })),
      start: 0,
      end: ws.length,
    },
  ];

  it("applies a range rewrite in the produce path, logs it, and carries the array through the write-back", () => {
    const before = OverrideDocSchema.parse({
      captionRangeEdits: [
        { fromKey: "w5000", toKey: "w6000", text: "one two three", was: "status edge," },
      ],
    });
    const out = reconcile(before, lines(["status", 5], ["edge,", 6]));
    expect(out.lines[0]!.words.map((w) => w.text)).toEqual(["one", "two", "three"]);
    expect(out.log.join("\n")).toContain("1 caption range(s) rewritten by the editor");
    // The write-back spreads the array through untouched — range edits never
    // had a positional-key era, so the migration must not touch them.
    expect(out.doc.captionRangeEdits).toEqual(before.captionRangeEdits);
    // A range edit alone earns no write: nothing re-anchored.
    expect(out.reanchored).toBe(false);
  });

  it("applies range rewrites AFTER retypes — a run whose `was` is the post-retype text lands", () => {
    // The layering contract (`applyCaptionLayers`): the user retyped "edge,"
    // to "Zsh," and then rewrote the run they SAW, so the run's `was` holds
    // the live text. Ranges running first would stale it against the base.
    const before = OverrideDocSchema.parse({
      captions: { w6000: { text: "Zsh,", was: "edge," } },
      captionRangeEdits: [
        { fromKey: "w5000", toKey: "w6000", text: "rewritten run", was: "status Zsh," },
      ],
    });
    const out = reconcile(before, lines(["status", 5], ["edge,", 6]));
    expect(out.lines[0]!.words.map((w) => w.text)).toEqual(["rewritten", "run"]);
    expect(out.log.join("\n")).not.toContain("range edit");
  });

  it("logs a stale range rewrite with the range prefix and leaves the run alone", () => {
    const before = OverrideDocSchema.parse({
      captionRangeEdits: [
        { fromKey: "w5000", toKey: "w6000", text: "x y", was: "not the run" },
      ],
    });
    const out = reconcile(before, lines(["status", 5], ["edge,", 6]));
    expect(out.lines[0]!.words.map((w) => w.text)).toEqual(["status", "edge,"]);
    const log = out.log.join("\n");
    expect(log).toContain('range edit "not the run"');
    expect(log).toContain("w5000..w6000");
    // The rewrite failed WHOLE — no count line claiming it landed.
    expect(log).not.toContain("rewritten by the editor");
    // The doc keeps the entry: a run that cannot place it today is not a
    // licence to delete it (the captionEditsToKeep philosophy).
    expect(out.doc.captionRangeEdits).toEqual(before.captionRangeEdits);
  });

  it("logs a range rewrite whose run the cut removed — found: null, no 'null' in the sentence", () => {
    const before = OverrideDocSchema.parse({
      captionRangeEdits: [
        { fromKey: "w5000", toKey: "w9000", text: "x y", was: "status gone" },
      ],
    });
    const out = reconcile(before, lines(["status", 5], ["edge,", 6]));
    const log = out.log.join("\n");
    expect(log).toContain('range edit "status gone"');
    expect(log).toContain("no longer sit at those source moments");
    expect(log).not.toContain("null");
  });
});

describe("reconcileCaptionEdits — the caption LINE TIMING layer (2026-08-18)", () => {
  // A PACKED pair of lines, the shape a real caption stream has: no gap
  // between them, each line starting on its first word and ending on its last
  // (`applyCaptionLineTiming`'s docstring has the measurements).
  const lines = (): CaptionLine[] => [
    {
      words: [
        { text: "status", start: 0, end: 0.6, srcStart: 5 },
        { text: "edge,", start: 0.6, end: 1, srcStart: 6 },
      ],
      start: 0,
      end: 1,
    },
    {
      words: [{ text: "here", start: 1, end: 2, srcStart: 9 }],
      start: 1,
      end: 2,
    },
  ];

  it("applies a nudge to the returned lines, logs the count, and writes the doc back untouched", () => {
    const before = OverrideDocSchema.parse({
      captionLineTiming: { w9000: { lead: -0.3, tail: 0 } },
    });
    const out = reconcile(before, lines());
    // The seam between the two lines moved, so BOTH windows did.
    expect(out.lines[1]!.start).toBeCloseTo(0.7, 10);
    expect(out.lines[0]!.end).toBeCloseTo(0.7, 10);
    expect(out.log.join("\n")).toContain("1 caption timing nudge(s) applied");
    // The write-back carries the timing layer through as-is — nudges never
    // had a positional-key era, so there is nothing for the migration to
    // touch.
    expect(out.doc.captionLineTiming).toEqual({ w9000: { lead: -0.3, tail: 0 } });
    // A nudge alone earns no write: nothing re-anchored.
    expect(out.reanchored).toBe(false);
  });

  it("applies timing AFTER hides — a nudge on a line the hides emptied reports as dropped", () => {
    // The layering contract (`applyCaptionLayers`): timing moves the seams
    // between SURVIVING lines, so a nudge whose line the hide layer removed
    // has nothing left to move — reported, never guessed at.
    const before = OverrideDocSchema.parse({
      captionWordsHidden: { w9000: { was: "here" } },
      captionLineTiming: { w9000: { lead: -0.3, tail: 0 } },
    });
    const out = reconcile(before, lines());
    expect(out.lines).toHaveLength(1);
    const log = out.log.join("\n");
    expect(log).toContain("caption timing (w9000)");
    expect(log).not.toContain("timing nudge(s) applied");
  });

  it("logs a nudge whose caption the cut removed with the caption-timing prefix, no 'null'", () => {
    const before = OverrideDocSchema.parse({
      captionLineTiming: { w99000: { lead: 0.1, tail: 0.1 } },
    });
    const out = reconcile(before, lines());
    const log = out.log.join("\n");
    expect(log).toContain("caption timing (w99000)");
    expect(log).toContain("no caption starts at that source moment");
    expect(log).not.toContain("null");
    // The failed nudge must not be counted as applied.
    expect(log).not.toContain("timing nudge(s) applied");
    // The doc keeps the entry: a run that cannot place it today is not a
    // licence to delete it (the captionEditsToKeep philosophy).
    expect(out.doc.captionLineTiming).toEqual(before.captionLineTiming);
  });

  /**
   * The count must not be able to erase itself (2026-08-19 review).
   * `applyCaptionLineTiming` pushes one `duplicate-anchor` drop per EXTRA line
   * claiming the anchor, so the old `keys - drops` arithmetic hit 0 with one
   * duplicate and went NEGATIVE with two — and the `> 0` gate then printed
   * NOTHING about a nudge that had applied. Same failure §137 already fixed
   * for retypes, which is why both now go through `appliedCaptionEditCount`.
   */
  const claimants = (n: number): CaptionLine[] => {
    // One opening line on a different anchor, then `n` lines that all start on
    // source second 9 — ms-quantised anchors really do collide
    // (captions.ts:44-50), which is why the layer has a first-claimant rule.
    const out: CaptionLine[] = [
      { words: [{ text: "status", start: 0, end: 1, srcStart: 5 }], start: 0, end: 1 },
    ];
    for (let i = 0; i < n; i++) {
      out.push({
        words: [{ text: "here", start: i + 1, end: i + 2, srcStart: 9 }],
        start: i + 1,
        end: i + 2,
      });
    }
    return out;
  };

  it("still counts a nudge whose anchor a SECOND caption also claims", () => {
    const before = OverrideDocSchema.parse({
      captionLineTiming: { w9000: { lead: -0.3, tail: 0 } },
    });
    const out = reconcile(before, claimants(2));
    // It applied — to the FIRST claimant, whose opening seam moved.
    expect(out.lines[1]!.start).toBeCloseTo(0.7, 10);
    const log = out.log.join("\n");
    expect(log).toContain("1 caption timing nudge(s) applied");
    // And the duplicate is still reported as reach, not as a failure.
    expect(log).toContain("only the first was re-timed");
  });

  it("still counts a nudge two other captions claim — the old subtraction went NEGATIVE", () => {
    const before = OverrideDocSchema.parse({
      captionLineTiming: { w9000: { lead: -0.3, tail: 0 } },
    });
    const out = reconcile(before, claimants(3));
    expect(out.lines[1]!.start).toBeCloseTo(0.7, 10);
    // `1 - 2 = -1` under the old count, which the `> 0` gate swallowed whole.
    expect(out.log.join("\n")).toContain("1 caption timing nudge(s) applied");
  });
});

/**
 * Everything above tests `reconcileCaptionEdits` in isolation. This tests that
 * `produce.ts` still CALLS it — by reading the source, which is normally the
 * wrong tool and is the right one here.
 *
 * Nothing in this repo invokes `produce()`: a behavioural test of it needs
 * ffmpeg on PATH, a real transcript, a work directory and a render, and the
 * editor's `renderflow.spec.ts` "render" is a fake child process. So no test
 * in the suite executes ANY of the three lines below (`produce.ts:1958-1961`
 * plus the gate at `:2207`). That was measured, not assumed — deleting any one
 * of them LEFT THE WHOLE SUITE GREEN, which is one line away from re-creating
 * the Critical §137 just fixed.
 *
 * And what they guard is the failure most deserving of even a crude test:
 * silent, user-visible data loss, in three distinct shapes.
 *  - No `reconcileCaptionEdits` call: a legacy doc is never migrated, so every
 *    retype shows on screen and is absent from the render.
 *  - The call, but no `overrideDoc = captionWork.doc`: WORSE than not calling
 *    it, and it typechecks, because `captionWork` is still read for its lines,
 *    its log and `reanchored`. The migration is computed and thrown away, the
 *    render still ships without the retypes — and `reanchored` is still true,
 *    so the write gate below fires, overwrites the user's `overrides.json.bak`
 *    with the UN-migrated doc and prints "re-anchored to source-time caption
 *    keys". A false success line over destroyed evidence (§137 review,
 *    Important 1).
 *  - No `captionKeysReanchored` in the write gate: the migration happens and is
 *    discarded on exit, and each further run loses a little more of it for good
 *    (a legacy key is found by the word it names, so the next re-plan that
 *    rewrites that word retires it).
 *
 * Precedent: `doctor.test.ts`'s version-literal check (R22 §113) — the same
 * shape, for the same reason. This is a stand-in, not the answer: a real
 * harness (`produce()` over the `pnpm fixture` video with `--no-render`) would
 * subsume it.
 */
describe("produce's §137 caption wiring (source-text guard)", () => {
  const src = readFileSync(new URL("../src/produce.ts", import.meta.url), "utf8");

  it("MIGRATES legacy caption keys — `reconcileCaptionEdits` is called, not just imported", () => {
    // The result must be bound to something (`= reconcileCaptionEdits(`), so
    // the import line alone cannot satisfy this.
    expect(src).toMatch(/=\s*reconcileCaptionEdits\(/);
  });

  it("ADOPTS the migrated doc — a result that is computed and not assigned is the same silence", () => {
    // The assertion above only proves the call happened. Everything downstream
    // — the render, the orphan reports, the write gate — reads `overrideDoc`,
    // so this one line is what makes the migration real. Guarded separately
    // because deleting it passes the call assertion AND typechecks: see the
    // second bullet above for what that ships.
    expect(src).toMatch(/overrideDoc\s*=\s*captionWork\.doc/);
  });

  it("WRITES the migrated doc back — the save gate is not a bare cut check", () => {
    // `cutResult.changed` alone was the gate before §137, and a caption-key
    // migration changes the doc without changing the cut, so the repaired file
    // never reached disk. Either operand order satisfies this: what must not
    // survive is one of them going missing, or the `||` narrowing to `&&`.
    // `hidesPruned` joined the gate with the §59b-revisited word delete — a
    // pruned hide is a doc change with neither a cut change nor a migration
    // behind it, the identical shape. `sceneKeysRemapped` joined with
    // handoff-edit-anchoring — a scene edit re-keyed to its anchor's new id
    // is again a doc change none of the others see — so the regex requires
    // all four.
    // `splitSrcResolved` joined with the cut-review rework — a backfilled
    // source anchor is a doc change none of the others see, same shape again.
    expect(src).toMatch(
      /if\s*\(\s*(cutResult\.changed\s*\|\|\s*captionKeysReanchored|captionKeysReanchored\s*\|\|\s*cutResult\.changed)\s*\|\|\s*hidesPruned\s*\|\|\s*sceneKeysRemapped\s*\|\|\s*splitSrcResolved\s*\)/,
    );
  });

  it("PRUNES hides the final cutlist removed — `pruneHidesInsideCuts` is called AND adopted", () => {
    // Same two-part shape as the reconcile assertions above, for the same
    // reason: computing the prune and dropping the result typechecks, still
    // reads the pruned list for the log line, and ships a doc that reports
    // "the cut removed it" (`captionHideDropLine`) on every run forever —
    // the exact permanent noise the prune exists to retire.
    expect(src).toMatch(/=\s*pruneHidesInsideCuts\(/);
    expect(src).toMatch(/overrideDoc\s*=\s*hidePrune\.doc/);
  });

  it("spends the `.bak` on the CUT re-anchoring only, never on the caption one", () => {
    // Final review round 2. Gating the WRITE on work done left the marquee
    // case wide open: on the field workdir the caption migration re-anchors
    // three edits, so the gate fires with `cutResult.changed` false — and an
    // unconditional backup then copies the damaged doc over the user's only
    // pre-cut save. `refreshBackup: cutResult.changed` is the whole fix, and
    // it lives on the one line no test executes. `writeOverrideDoc`'s own
    // behaviour is tested for real in `overrides-write.test.ts`; this pins
    // that produce passes it the right flag.
    // Anchored on the closing brace, not just on the prefix: the mutation
    // that actually reintroduces the bug is `cutResult.changed ||
    // captionKeysReanchored` — i.e. the write gate copied into the backup
    // decision — and a prefix match accepts it happily. (It did, on the first
    // cut of this assertion.)
    expect(src).toMatch(/\{\s*refreshBackup:\s*cutResult\.changed\s*\}/);
    expect(src).not.toMatch(/refreshBackup:\s*true/);
  });

  it("gates that write on work DONE, never on `keysChanged`", () => {
    // Final review, Critical 2. The gate that shipped fired whenever anything
    // was unresolved, so the first produce after upgrading the field workdir
    // wrote on a run that repaired nothing — and spent `overrides.json.bak`,
    // the user's only pre-cut save, doing it. The variable is now bound to
    // `captionWork.reanchored`, and this pins that binding: a rename back to
    // the old predicate has to come past here.
    expect(src).toMatch(/captionKeysReanchored\s*=\s*captionWork\.reanchored/);
    expect(src).not.toContain("keysChanged");
  });
});
