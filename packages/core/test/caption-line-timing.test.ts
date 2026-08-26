import { describe, expect, it } from "vitest";
import {
  applyCaptionLayers,
  applyCaptionLineTiming,
  captionKeyFor,
  OverrideDocSchema,
  scaleWordsIntoWindow,
} from "../src/overrides";
import type { CaptionLine } from "../src/captions";
import { TimeMap } from "../src/timemap";

/**
 * A GAP-FREE PARTITION — the shape a real caption stream actually has, and the
 * shape the fixture this file replaced did NOT have.
 *
 * The old `makeLines()` gave its words slack (a word ending at 3, a line ending
 * at 3, the next line starting at 3.5) "because a contiguous fixture leaves no
 * room for an unclamped nudge to land at all". That slack was the bug: the
 * packer chains words (`transcribe.ts`, `next.start = w.end`) and clamps each
 * line's end onto the next line's start (`captions.ts:203-213`), so on a live
 * workdir 116/116 inter-line gaps and 184/184 intra-line word boundaries
 * measured EXACTLY 0.0. A per-word clamp against that stream is inert, and the
 * gapped fixture is why the suite never said so. Everything below is measured
 * against the packed shape instead, and `describe("the fixture itself")` pins
 * the four properties so it cannot quietly regain slack.
 *
 * `srcStart` values are inert stand-ins (§137) — no cutlist and no `TimeMap`
 * here relates source time to output time — and deliberately DIFFERENT from
 * `start`, so a test that confused the two key spaces would fail rather than
 * pass by coincidence.
 */
const packedLines = (): CaptionLine[] => [
  {
    start: 0,
    end: 2,
    words: [
      { text: "one", start: 0, end: 0.8, srcStart: 10 },
      { text: "two", start: 0.8, end: 2, srcStart: 11 },
    ],
  },
  {
    start: 2,
    end: 3.5,
    words: [
      { text: "three", start: 2, end: 2.6, srcStart: 12 },
      { text: "four", start: 2.6, end: 3.5, srcStart: 13 },
    ],
  },
  {
    start: 3.5,
    end: 6,
    words: [
      { text: "five", start: 3.5, end: 4.4, srcStart: 14 },
      { text: "six", start: 4.4, end: 6, srcStart: 15 },
    ],
  },
];

/** The three lines' keys: each line is addressed by its FIRST word's anchor. */
const LINE_A = captionKeyFor(10);
const LINE_B = captionKeyFor(12);
const LINE_C = captionKeyFor(14);

/**
 * `frameWindow` (packages/scenes/src/frames.ts, §115), replicated rather than
 * imported: `@ossclip/scenes` is not a dependency of `@ossclip/core`, and
 * importing it here would break `pnpm typecheck`'s per-package `tsc`. Three
 * lines of arithmetic, copied verbatim — the invariant under test is that the
 * seam sweep feeds it windows it can never round onto a shared frame.
 */
const frameWindow = (
  startSec: number,
  endSec: number,
  fps: number,
): { from: number; durationInFrames: number } => {
  const from = Math.round(startSec * fps);
  const to = Math.round(endSec * fps);
  return { from, durationInFrames: Math.max(1, to - from) };
};

/** No two adjacent lines may share a frame (§115) — the guarantee the seam
 * model provides by construction, asserted rather than assumed. */
const expectNoSharedFrame = (lines: readonly CaptionLine[], fps: number): void => {
  for (let i = 1; i < lines.length; i++) {
    const prev = frameWindow(lines[i - 1]!.start, lines[i - 1]!.end, fps);
    const next = frameWindow(lines[i]!.start, lines[i]!.end, fps);
    const lastFrameOfPrev = prev.from + prev.durationInFrames - 1;
    expect(`${fps}fps line ${i - 1} last frame ${lastFrameOfPrev}`).toBe(
      `${fps}fps line ${i - 1} last frame ${Math.min(lastFrameOfPrev, next.from - 1)}`,
    );
  }
};

describe("the fixture itself is PACKED (the property the old suite lacked)", () => {
  const lines = packedLines();

  it("has zero inter-line gaps", () => {
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]!.start - lines[i - 1]!.end).toBe(0);
    }
  });

  it("has zero intra-line word gaps", () => {
    for (const line of lines) {
      for (let i = 1; i < line.words.length; i++) {
        expect(line.words[i]!.start - line.words[i - 1]!.end).toBe(0);
      }
    }
  });

  it("starts each line on its first word and ends it on its last", () => {
    for (const line of lines) {
      expect(line.start).toBe(line.words[0]!.start);
      expect(line.end).toBe(line.words[line.words.length - 1]!.end);
    }
  });
});

describe("applyCaptionLineTiming — a lead MOVES the line's window", () => {
  it("opens line B early, and line A's end follows it to the same seam", () => {
    // The exact gesture the deleted per-word layer could not perform: on a
    // packed stream every word's clamp collapsed to its own stamps, so the
    // drag stored zeros. Here the SEAM moves, and both lines that meet on it
    // change.
    const lines = packedLines();
    const { lines: out, dropped } = applyCaptionLineTiming(lines, {
      [LINE_B]: { lead: -0.5, tail: 0 },
    });
    expect(dropped).toEqual([]);
    expect(out[1]!.start).toBeCloseTo(1.5, 10);
    expect(out[0]!.end).toBeCloseTo(1.5, 10);
    // Only the seam between A and B moved: A's opening and B's close are
    // where they were.
    expect(out[0]!.start).toBe(0);
    expect(out[1]!.end).toBe(3.5);
    // Line C shares no moved seam, so it comes back VERBATIM — a nudge on one
    // caption must not perturb the rest of the track.
    expect(out[2]).toBe(lines[2]);
  });

  it("scales BOTH lines' words into their new windows (the karaoke highlight)", () => {
    const { lines: out } = applyCaptionLineTiming(packedLines(), {
      [LINE_B]: { lead: -0.5, tail: 0 },
    });
    // A: [0, 2] → [0, 1.5], ratio 0.75.
    expect(out[0]!.words.map((w) => [w.start, w.end])).toEqual([
      [0, 0.6000000000000001],
      [0.6000000000000001, 1.5],
    ]);
    // B: [2, 3.5] → [1.5, 3.5], ratio 4/3.
    expect(out[1]!.words[0]!.start).toBeCloseTo(1.5, 10);
    expect(out[1]!.words[0]!.end).toBeCloseTo(2.3, 10);
    expect(out[1]!.words[1]!.start).toBeCloseTo(2.3, 10);
    expect(out[1]!.words[1]!.end).toBeCloseTo(3.5, 10);
    // Text and srcStart survive verbatim — timing says WHEN, never WHAT.
    expect(out[1]!.words.map((w) => [w.text, w.srcStart])).toEqual([
      ["three", 12],
      ["four", 13],
    ]);
  });

  it("a lead on the FIRST line moves the track's opening seam; nothing precedes it", () => {
    const { lines: out } = applyCaptionLineTiming(packedLines(), {
      [LINE_A]: { lead: 0.3, tail: 0 },
    });
    expect(out[0]!.start).toBeCloseTo(0.3, 10);
    expect(out[0]!.end).toBe(2);
    expect(out[1]!.start).toBe(2);
  });
});

describe("applyCaptionLineTiming — a tail, and a rigid group move", () => {
  it("holds line A longer, and line B opens on the same moved seam", () => {
    const { lines: out } = applyCaptionLineTiming(packedLines(), {
      [LINE_A]: { lead: 0, tail: 0.7 },
    });
    expect(out[0]!.end).toBeCloseTo(2.7, 10);
    expect(out[1]!.start).toBeCloseTo(2.7, 10);
    expect(out[1]!.end).toBe(3.5);
  });

  it("moves line B RIGIDLY: both of its seams by the same delta, duration intact", () => {
    // The shape the UI writes for a drag of a whole caption: the moved line
    // carries lead+tail, and each neighbour carries the matching delta on the
    // seam it shares (`applyCaptionLineTiming` resolves the shared seam to the
    // later line's lead, which is why both sides agreeing is a no-op).
    const { lines: out } = applyCaptionLineTiming(packedLines(), {
      [LINE_A]: { lead: 0, tail: 0.5 },
      [LINE_B]: { lead: 0.5, tail: 0.5 },
      [LINE_C]: { lead: 0.5, tail: 0 },
    });
    expect(out[1]!.start).toBeCloseTo(2.5, 10);
    expect(out[1]!.end).toBeCloseTo(4, 10);
    expect(out[1]!.end - out[1]!.start).toBeCloseTo(1.5, 10);
    // The neighbours absorbed it: A grew by 0.5, C lost 0.5, the track's outer
    // bounds are untouched.
    expect(out[0]!.start).toBe(0);
    expect(out[0]!.end).toBeCloseTo(2.5, 10);
    expect(out[2]!.start).toBeCloseTo(4, 10);
    expect(out[2]!.end).toBe(6);
  });

  it("resolves BOTH sides of one seam to the LATER line's lead", () => {
    // A's tail asks for 2.5, B's lead asks for 1.5. Documented winner: the
    // later line's lead. (Only reachable from a hand-edited doc — the UI
    // writes both sides of a seam consistently.)
    const { lines: out } = applyCaptionLineTiming(packedLines(), {
      [LINE_A]: { lead: 0, tail: 0.5 },
      [LINE_B]: { lead: -0.5, tail: 0 },
    });
    expect(out[0]!.end).toBeCloseTo(1.5, 10);
    expect(out[1]!.start).toBeCloseTo(1.5, 10);
  });
});

describe("applyCaptionLineTiming — the seam invariants (§115, by construction)", () => {
  // Arbitrary deltas, including ones far past every neighbour and past the
  // track's own ends. Every one of them must still come out as an ordered,
  // non-overlapping partition — that is the whole argument for editing seams
  // instead of windows.
  const deltas = [-9, -1.4, -0.5, 0, 0.4, 1.7, 9];

  it("leaves the seams STRICTLY ordered, and no adjacent pair sharing a frame", () => {
    for (const a of deltas) {
      for (const b of deltas) {
        for (const c of deltas) {
          const { lines: out } = applyCaptionLineTiming(packedLines(), {
            [LINE_A]: { lead: a, tail: b },
            [LINE_B]: { lead: c, tail: a },
            [LINE_C]: { lead: b, tail: c },
          });
          const where = `deltas ${a}/${b}/${c}`;
          for (const line of out) {
            // A window that inverted would render nothing at all.
            expect(`${where}: ${line.end > line.start}`).toBe(`${where}: true`);
          }
          for (let i = 1; i < out.length; i++) {
            expect(`${where}: ${out[i]!.start >= out[i - 1]!.end}`).toBe(`${where}: true`);
          }
          // §115 at the two fps the renderer actually uses.
          expectNoSharedFrame(out, 30);
          expectNoSharedFrame(out, 60);
        }
      }
    }
  });

  it("never grows the track's outer bounds", () => {
    // A lead before the first caption and a tail past the last one have no
    // output to be shown over — clamped to the track, never beyond it.
    const { lines: out } = applyCaptionLineTiming(packedLines(), {
      [LINE_A]: { lead: -5, tail: 0 },
      [LINE_C]: { lead: 0, tail: 9 },
    });
    expect(out[0]!.start).toBe(0);
    expect(out[2]!.end).toBe(6);
  });

  it("clamps to the minimum caption duration rather than swallowing a neighbour", () => {
    // B's lead runs 5s past A's own opening. A may give B time; it may not be
    // erased by it.
    const { lines: out } = applyCaptionLineTiming(packedLines(), {
      [LINE_B]: { lead: -5, tail: 0 },
    });
    expect(out[0]!.start).toBe(0);
    expect(out[0]!.end).toBeCloseTo(0.05, 10);
    expect(out[1]!.start).toBeCloseTo(0.05, 10);
    expect(out[1]!.end).toBe(3.5);
  });

  it("keeps every word inside its line's window, in proportion", () => {
    const before = packedLines();
    const { lines: out } = applyCaptionLineTiming(before, {
      [LINE_B]: { lead: -0.5, tail: 0.9 },
    });
    for (let i = 0; i < out.length; i++) {
      const line = out[i]!;
      const src = before[i]!;
      const ratio = (line.end - line.start) / (src.end - src.start);
      for (let w = 0; w < line.words.length; w++) {
        expect(line.words[w]!.start).toBeGreaterThanOrEqual(line.start - 1e-9);
        expect(line.words[w]!.end).toBeLessThanOrEqual(line.end + 1e-9);
        // Proportional: each word's offset into the window scales by the same
        // ratio the window did.
        expect(line.words[w]!.start - line.start).toBeCloseTo(
          (src.words[w]!.start - src.start) * ratio,
          10,
        );
      }
    }
  });
});

describe("applyCaptionLineTiming — a GAPPED stream (hand-edited, or hide-shortened)", () => {
  // Not what the packer emits (the measurements say 116/116 gaps are zero),
  // but reachable: `applyCaptionWordHides` re-bases a line's edges onto its
  // surviving words, and an overrides.json can be edited by hand.
  const gapped = (): CaptionLine[] => [
    { start: 0, end: 1, words: [{ text: "a", start: 0, end: 1, srcStart: 10 }] },
    { start: 2, end: 3, words: [{ text: "b", start: 2, end: 3, srcStart: 12 }] },
    { start: 4, end: 5, words: [{ text: "c", start: 4, end: 5, srcStart: 14 }] },
  ];

  it("moves ONLY the nudged line when its lead lands inside the gap ahead of it", () => {
    const lines = gapped();
    const { lines: out } = applyCaptionLineTiming(lines, { [LINE_C]: { lead: -0.5, tail: 0 } });
    // C's start (4) and B's end (3) are two different numbers, so a lead that
    // opens C at 3.5 lands in the SILENCE — B is not stretched to meet it, and
    // neither is A.
    expect(out[0]).toBe(lines[0]);
    expect(out[1]).toBe(lines[1]);
    expect(out[2]!.start).toBeCloseTo(3.5, 10);
    expect(out[2]!.end).toBe(5);
  });

  it("BLOCKS a lead at the previous line's own end instead of pushing it", () => {
    // C's lead asks for 2, which is inside B's window. Ordering is enforced
    // against B's OWN end (3): the gap is consumed, C opens where B closes,
    // and B — a caption the user never touched — does not move.
    const lines = gapped();
    const { lines: out } = applyCaptionLineTiming(lines, { [LINE_C]: { lead: -2, tail: 0 } });
    expect(out[0]).toBe(lines[0]);
    expect(out[1]).toBe(lines[1]);
    expect(out[2]!.start).toBe(3);
    expect(out[2]!.end).toBe(5);
  });

  it("never inverts a line whose start is dragged into the gap ahead of it", () => {
    // B's own end (3) is BEFORE C's start (4), so a +1.5 lead moves its start
    // past its own end. The floor applies to the window, and it still cannot
    // reach C.
    const lines = gapped();
    const { lines: out } = applyCaptionLineTiming(lines, { [LINE_B]: { lead: 1.5, tail: 0 } });
    expect(out[1]!.start).toBeCloseTo(3.5, 10);
    expect(out[1]!.end).toBeCloseTo(3.55, 10);
    expect(out[1]!.end).toBeLessThanOrEqual(out[2]!.start);
    // A is on the far side of a gap: it keeps its own end, verbatim.
    expect(out[0]).toBe(lines[0]);
  });

  it("leaves the caption AFTER the gap alone on a lead-only drag (the live probe)", () => {
    // The exact regression that killed the shared seam array (review
    // 2026-08-19): `[0,2] [2,4] [5,6]`, `{lead: -0.05, tail: 0}` on the middle
    // line — what the editor writes for a lead-only drag. The old model read
    // the boundary after line B off C's start (5) while the entry loop wrote
    // B's own end (4) into it, so C was rebuilt as [4,6]: a full second early,
    // its single word stretched 2x, and nothing reported.
    const lines: CaptionLine[] = [
      { start: 0, end: 2, words: [{ text: "a", start: 0, end: 2, srcStart: 10 }] },
      { start: 2, end: 4, words: [{ text: "b", start: 2, end: 4, srcStart: 12 }] },
      { start: 5, end: 6, words: [{ text: "c", start: 5, end: 6, srcStart: 14 }] },
    ];
    const { lines: out, dropped } = applyCaptionLineTiming(lines, {
      [LINE_B]: { lead: -0.05, tail: 0 },
    });
    expect(dropped).toEqual([]);
    // A shares the boundary B's lead moved (2 === 2), so it follows.
    expect(out[0]!.start).toBe(0);
    expect(out[0]!.end).toBeCloseTo(1.95, 10);
    expect(out[1]!.start).toBeCloseTo(1.95, 10);
    expect(out[1]!.end).toBe(4);
    // C shares nothing with B. It must come back untouched — window AND word
    // stamps.
    expect(out[2]).toBe(lines[2]);
    expect(out[2]!.words).toEqual([{ text: "c", start: 5, end: 6, srcStart: 14 }]);
  });
});

describe("applyCaptionLineTiming — the reporting contract", () => {
  it("reports an unmatched key (a later cut removed the caption) with found: null", () => {
    const lines = packedLines();
    const { lines: out, dropped } = applyCaptionLineTiming(lines, {
      w99000: { lead: 0.1, tail: 0.1 },
    });
    expect(out).toEqual(lines);
    // `expected` is "" — the record stores no text to expect (no `was` guard,
    // deliberately: timing is text-orthogonal).
    expect(dropped).toEqual([{ key: "w99000", expected: "", found: null }]);
  });

  it("has NO text guard — a retyped first word under a nudge still re-times", () => {
    const lines = packedLines();
    lines[1]!.words[0]!.text = "totally-retyped";
    const { lines: out, dropped } = applyCaptionLineTiming(lines, {
      [LINE_B]: { lead: -0.5, tail: 0 },
    });
    expect(out[1]!.start).toBeCloseTo(1.5, 10);
    expect(dropped).toEqual([]);
  });

  it("re-times only the FIRST of two lines starting on a shared ms-quantised anchor", () => {
    // captions.ts:44-50 manufactures duplicate srcStarts by design — one nudge
    // must not fan out onto two captions.
    const lines: CaptionLine[] = [
      { start: 0, end: 1, words: [{ text: "the", start: 0, end: 1, srcStart: 2 }] },
      { start: 1, end: 2, words: [{ text: "the", start: 1, end: 2, srcStart: 2 }] },
    ];
    const { lines: out, dropped } = applyCaptionLineTiming(lines, {
      w2000: { lead: 0, tail: 0.5 },
    });
    expect(out[0]!.end).toBeCloseTo(1.5, 10);
    expect(out[1]!.start).toBeCloseTo(1.5, 10);
    expect(dropped).toEqual([
      { key: "w2000", expected: "", found: "the", reason: "duplicate-anchor" },
    ]);
  });

  it("a line whose first word carries no anchor cannot be addressed", () => {
    // Pre-§137 render props: the word has no `srcStart`, so nothing keys on
    // it and the stored nudge falls out of the sweep as `found: null`.
    const lines = [
      {
        start: 0,
        end: 2,
        words: [{ text: "one", start: 0, end: 2 } as unknown as CaptionLine["words"][number]],
      },
    ];
    const { lines: out, dropped } = applyCaptionLineTiming(lines, {
      [LINE_A]: { lead: 0.2, tail: 0 },
    });
    expect(out).toEqual(lines);
    expect(dropped).toEqual([{ key: LINE_A, expected: "", found: null }]);
  });

  it("no nudges is the identity fast path", () => {
    const lines = packedLines();
    const { lines: out, dropped } = applyCaptionLineTiming(lines, {});
    expect(out).toEqual(lines);
    expect(out).not.toBe(lines);
    expect(dropped).toEqual([]);
  });

  it("no LINES still REPORTS every stored nudge — an anchor nothing starts on", () => {
    // The empty-lines early return used to skip the sweep, contradicting this
    // function's own docstring and letting produce print "N nudges applied"
    // for a run where none were. The editor's false-banner guard is at the
    // CALLER (App.tsx's `if (!renderProps)`), which is what distinguishes
    // "nothing loaded yet" from "this cut has no captions" — and the sibling
    // layers (`applyCaptionEdits`, `applyCaptionWordHides`) never took the
    // shortcut either.
    const { lines: out, dropped } = applyCaptionLineTiming([], {
      [LINE_A]: { lead: 0.2, tail: 0 },
      [LINE_B]: { lead: 0, tail: -0.3 },
    });
    expect(out).toEqual([]);
    expect(dropped).toEqual([
      { key: LINE_A, expected: "", found: null },
      { key: LINE_B, expected: "", found: null },
    ]);
  });

  it("no lines AND no nudges reports nothing", () => {
    expect(applyCaptionLineTiming([], {})).toEqual({ lines: [], dropped: [] });
  });
});

describe("scaleWordsIntoWindow", () => {
  const words = () => [
    { text: "one", start: 2, end: 2.6, srcStart: 12 },
    { text: "two", start: 2.6, end: 3.5, srcStart: 13 },
  ];

  it("maps the SOURCE WINDOW onto the target window, proportionally", () => {
    const out = scaleWordsIntoWindow(words(), 2, 3.5, 1.5, 3.5);
    expect(out[0]!.start).toBeCloseTo(1.5, 10);
    expect(out[0]!.end).toBeCloseTo(2.3, 10);
    expect(out[1]!.start).toBeCloseTo(2.3, 10);
    expect(out[1]!.end).toBeCloseTo(3.5, 10);
  });

  it("preserves the slack a line carries either side of its words", () => {
    // The hide layer can leave a line opening before its first word or holding
    // past its last; mapping the WINDOW keeps that slack proportional instead
    // of stretching the words over it.
    const out = scaleWordsIntoWindow(words(), 1.5, 4, 3, 8);
    expect(out[0]!.start).toBeCloseTo(4, 10);
    expect(out[1]!.end).toBeCloseTo(7, 10);
  });

  it("is the identity on a degenerate source window — never NaN", () => {
    const out = scaleWordsIntoWindow(words(), 2, 2, 0, 4);
    expect(out.map((w) => [w.start, w.end])).toEqual([
      [2, 2.6],
      [2.6, 3.5],
    ]);
  });

  it("copies rather than mutating — the caller's lines are inputs, not scratch", () => {
    const src = words();
    const out = scaleWordsIntoWindow(src, 2, 3.5, 0, 1);
    expect(src[0]!.start).toBe(2);
    expect(out[0]).not.toBe(src[0]);
    expect(out[0]!.text).toBe("one");
  });

  it("carries text and srcStart through untouched", () => {
    expect(scaleWordsIntoWindow(words(), 2, 3.5, 0, 1).map((w) => [w.text, w.srcStart])).toEqual([
      ["one", 12],
      ["two", 13],
    ]);
  });
});

describe("captionLineTiming schema", () => {
  it("defaults to {} so an empty doc parses", () => {
    expect(OverrideDocSchema.parse({}).captionLineTiming).toEqual({});
  });

  it("a pre-existing doc WITHOUT the field still parses", () => {
    const doc = OverrideDocSchema.parse({
      captions: { w500: { text: "escape", was: "scape" } },
    });
    expect(doc.captionLineTiming).toEqual({});
    expect(doc.captions.w500).toEqual({ text: "escape", was: "scape" });
  });

  it("a doc carrying the REMOVED captionWordTiming field still parses, and it is stripped", () => {
    // The per-word field never had an effect (it was provably inert against a
    // packed stream — `captionLineTiming`'s docstring), so zod dropping it is
    // the whole migration: nothing to re-key, nothing to preserve.
    const doc = OverrideDocSchema.parse({
      captionWordTiming: { w10000: { lead: -0.2, tail: 0.3 } },
      captions: { w500: { text: "escape", was: "scape" } },
    });
    expect("captionWordTiming" in doc).toBe(false);
    expect(doc.captionLineTiming).toEqual({});
    expect(doc.captions.w500).toEqual({ text: "escape", was: "scape" });
  });

  it("round-trips entries", () => {
    const doc = OverrideDocSchema.parse({
      captionLineTiming: { w10000: { lead: -0.2, tail: 0.3 } },
    });
    expect(doc.captionLineTiming).toEqual({ w10000: { lead: -0.2, tail: 0.3 } });
    // A JSON.parse(JSON.stringify(...)) round trip is what overrides.json is.
    expect(OverrideDocSchema.parse(JSON.parse(JSON.stringify(doc))).captionLineTiming).toEqual({
      w10000: { lead: -0.2, tail: 0.3 },
    });
  });

  it("rejects a delta outside ±30s — parsed, never coerced", () => {
    expect(() =>
      OverrideDocSchema.parse({ captionLineTiming: { w10000: { lead: 31, tail: 0 } } }),
    ).toThrow();
  });
});

describe("applyCaptionLayers — line timing is the LAST layer", () => {
  /**
   * None of these docs hold a `captionLineWindows` entry, so the window layer
   * the composer runs last is inert — this map exists only because it takes
   * one. A single kept span over the whole source also makes its src→output
   * conversion a plain identity, so nothing here reads differently than it did
   * before the layer existed (`applyCaptionLineWindows` is pinned on its own,
   * over a map with a cut in it, in caption-line-windows.test.ts).
   */
  const noWindows = new TimeMap([{ srcIn: 0, srcOut: 3600, kind: "keep" }]);

  it("re-times the POST-hide window: a hide moved it, and the nudge moves it again", () => {
    const lines: CaptionLine[] = [
      {
        start: 0,
        end: 2,
        words: [
          { text: "one", start: 0, end: 1, srcStart: 10 },
          { text: "two", start: 1, end: 2, srcStart: 11 },
        ],
      },
      {
        start: 2,
        end: 4,
        words: [{ text: "three", start: 2, end: 4, srcStart: 12 }],
      },
    ];
    const doc = OverrideDocSchema.parse({
      // Hiding the LAST word re-bases line 1's end onto "one" (1.0) —
      // `applyCaptionWordHides`' own rule.
      captionWordsHidden: { w11000: { was: "two" } },
      captionLineTiming: { w12000: { lead: -0.5, tail: 0 } },
    });
    const { lines: out, dropped } = applyCaptionLayers(lines, doc, noWindows);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["one"]);
    // The hide left line 1 ending at 1.0 against line 2's start of 2.0 — a
    // GAP — so the nudge moves line 2's start into it and NOTHING else. That
    // the nudge starts from 2.0 (not the pre-hide window) is the proof the
    // layer ran last, on the post-hide lines; that line 1 keeps its re-based
    // end of 1.0 is the proof the two edges are separate numbers (the shared
    // seam array stretched this untouched caption to 1.5).
    expect(out[1]!.start).toBeCloseTo(1.5, 10);
    expect(out[1]!.end).toBe(4);
    expect(out[0]!.start).toBe(0);
    expect(out[0]!.end).toBe(1);
    expect(dropped).toEqual([]);
  });

  it("a nudge on a line the hides EMPTIED reports found: null, tagged layer: timing", () => {
    const lines: CaptionLine[] = [
      { start: 0, end: 1, words: [{ text: "one", start: 0, end: 1, srcStart: 10 }] },
      { start: 1, end: 2, words: [{ text: "two", start: 1, end: 2, srcStart: 11 }] },
    ];
    const doc = OverrideDocSchema.parse({
      captionWordsHidden: { w11000: { was: "two" } },
      captionLineTiming: { w11000: { lead: 0.1, tail: 0 } },
    });
    const { dropped } = applyCaptionLayers(lines, doc, noWindows);
    expect(dropped).toEqual([{ key: "w11000", expected: "", found: null, layer: "timing" }]);
  });
});
