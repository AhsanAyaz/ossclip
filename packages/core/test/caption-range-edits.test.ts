import { describe, expect, it } from "vitest";
import {
  applyCaptionLayers,
  applyCaptionRangeEdits,
  captionRangeEditWas,
  OverrideDocSchema,
} from "../src/overrides";
import type { CaptionLine } from "../src/captions";
import { TimeMap } from "../src/timemap";

// Same inert-stand-in convention as caption-word-hides.test.ts: no cutlist
// and no TimeMap here, so `srcStart` is set equal to `start` — NOT because
// the two coincide (§137). Anything needing a genuinely different source
// time must build a map.
const makeLines = (): CaptionLine[] => [
  {
    start: 0,
    // Past the last word's end: the packer's hold, asserted UNCHANGED below
    // — range edits never re-pack line windows.
    end: 1.35,
    words: [
      { text: "never", start: 0, end: 0.4, srcStart: 0 },
      { text: "gonna", start: 0.4, end: 0.7, srcStart: 0.4 },
      { text: "give", start: 0.7, end: 1, srcStart: 0.7 },
    ],
  },
  {
    start: 1.5,
    end: 2.5,
    words: [
      { text: "you", start: 1.5, end: 2.0, srcStart: 1.5 },
      { text: "up", start: 2.0, end: 2.5, srcStart: 2.0 },
    ],
  },
];

const edit = (fromKey: string, toKey: string, text: string, was: string) => ({
  fromKey,
  toKey,
  text,
  was,
});

describe("applyCaptionRangeEdits — single-word run (fromKey === toKey)", () => {
  it("splits one word into two inside its own measured window — the merged-word field case", () => {
    // Whisper merges a terminal ۔ and the next token into one Word
    // (transcribe.ts's whitespace rule; field case 2026-08-18, "ہوں۔اس") —
    // the remedy is a 1 → N range edit whose run is a single word.
    const { lines: out, dropped } = applyCaptionRangeEdits(makeLines(), [
      edit("w400", "w400", "gon na", "gonna"),
    ]);
    expect(dropped).toEqual([]);
    const [a, b, c, d] = out[0]!.words;
    expect([a!.text, b!.text, c!.text, d!.text]).toEqual(["never", "gon", "na", "give"]);
    // Both tokens live inside the original word's window, strictly increasing,
    // last end pinned to it.
    expect(b!.start).toBe(0.4);
    expect(b!.end).toBeGreaterThan(b!.start);
    expect(c!.start).toBeGreaterThanOrEqual(b!.end);
    expect(c!.end).toBe(0.7);
    // Degenerate minting span [fromSrc, toSrc] with fromSrc === toSrc: both
    // minted srcStarts collapse to the endpoint — the accepted shared-key
    // case the duplicate-anchor machinery reports on, never guesses about.
    expect(b!.srcStart).toBe(0.4);
    expect(c!.srcStart).toBe(0.4);
    // Neighbours untouched.
    expect(a).toEqual({ text: "never", start: 0, end: 0.4, srcStart: 0 });
    expect(d).toEqual({ text: "give", start: 0.7, end: 1, srcStart: 0.7 });
  });
});

describe("applyCaptionRangeEdits — equal-count fast path", () => {
  it("keeps measured stamps AND srcStarts verbatim; only text changes", () => {
    // The retime rule (producer/repair.ts): measured ASR boundaries beat any
    // interpolation, so a 2→2 rewrite must not touch a single number.
    const { lines: out, dropped } = applyCaptionRangeEdits(makeLines(), [
      edit("w400", "w700", "will hand", "gonna give"),
    ]);
    expect(dropped).toEqual([]);
    expect(out[0]!.words).toEqual([
      { text: "never", start: 0, end: 0.4, srcStart: 0 },
      { text: "will", start: 0.4, end: 0.7, srcStart: 0.4 },
      { text: "hand", start: 0.7, end: 1, srcStart: 0.7 },
    ]);
    expect(out[0]!.start).toBe(0);
    expect(out[0]!.end).toBe(1.35);
    expect(out[1]!.words.map((w) => w.text)).toEqual(["you", "up"]);
  });

  it("no range edits is the identity fast path", () => {
    const lines = makeLines();
    const { lines: out, dropped } = applyCaptionRangeEdits(lines, []);
    expect(out).toEqual(lines);
    expect(out).not.toBe(lines);
    expect(dropped).toEqual([]);
  });
});

describe("applyCaptionRangeEdits — the whole-run stale guard", () => {
  it("drops the WHOLE edit when one word was retyped underneath (hand-edited doc)", () => {
    // Never a partial rewrite of the words that still match: once the counts
    // differ there is no per-word truth to fall back on.
    const lines = makeLines();
    lines[0]!.words[1] = { ...lines[0]!.words[1]!, text: "gunna" };
    const { lines: out, dropped } = applyCaptionRangeEdits(lines, [
      edit("w400", "w700", "will hand", "gonna give"),
    ]);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["never", "gunna", "give"]);
    // The composite pair key, and the live joined run as `found`.
    expect(dropped).toEqual([
      { key: "w400..w700", expected: "gonna give", found: "gunna give" },
    ]);
  });

  it("compares NFC-normalized on both sides — decomposed live text still matches", () => {
    const lines = makeLines();
    // Decomposed alef-with-madda in the live word; the stored `was` holds the
    // composed form — the same trap the transcript search normalizes for.
    lines[0]!.words[1] = { ...lines[0]!.words[1]!, text: "آم" };
    const { dropped } = applyCaptionRangeEdits(lines, [
      edit("w400", "w700", "will hand", "آم give"),
    ]);
    expect(dropped).toEqual([]);
  });

  it("reports a missing fromKey with found: null", () => {
    const { lines: out, dropped } = applyCaptionRangeEdits(makeLines(), [
      edit("w9999", "w700", "x y", "gonna give"),
    ]);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["never", "gonna", "give"]);
    expect(dropped).toEqual([{ key: "w9999..w700", expected: "gonna give", found: null }]);
  });

  it("reports a missing toKey with found: null", () => {
    const { dropped } = applyCaptionRangeEdits(makeLines(), [
      edit("w400", "w9999", "x y", "gonna give"),
    ]);
    expect(dropped).toEqual([{ key: "w400..w9999", expected: "gonna give", found: null }]);
  });

  it("a toKey that only occurs BEFORE fromKey is found: null — forward walk only", () => {
    const { dropped } = applyCaptionRangeEdits(makeLines(), [
      edit("w700", "w400", "x y", "give gonna"),
    ]);
    expect(dropped).toEqual([{ key: "w700..w400", expected: "give gonna", found: null }]);
  });

  it("a whitespace-only text (past zod's min(1)) is a defensive stale-style drop", () => {
    const { lines: out, dropped } = applyCaptionRangeEdits(makeLines(), [
      edit("w400", "w700", "   ", "gonna give"),
    ]);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["never", "gonna", "give"]);
    expect(dropped).toEqual([
      { key: "w400..w700", expected: "gonna give", found: "gonna give" },
    ]);
  });
});

describe("applyCaptionRangeEdits — count change on one line", () => {
  it("mints strictly increasing stamps inside the window, last end pinned", () => {
    const { lines: out, dropped } = applyCaptionRangeEdits(makeLines(), [
      edit("w400", "w700", "will absolutely hand", "gonna give"),
    ]);
    expect(dropped).toEqual([]);
    const words = out[0]!.words;
    expect(words.map((w) => w.text)).toEqual(["never", "will", "absolutely", "hand"]);
    // The window [0.4, 1.0] is the run's measured edges — kept.
    expect(words[1]!.start).toBe(0.4);
    expect(words[3]!.end).toBe(1);
    for (let i = 1; i < words.length; i++) {
      expect(words[i]!.start).toBeGreaterThan(words[i - 1]!.start);
      expect(words[i]!.end).toBeGreaterThan(words[i]!.start);
      expect(words[i]!.end).toBeLessThanOrEqual(1);
    }
    // Line window untouched — no re-pack.
    expect(out[0]!.start).toBe(0);
    expect(out[0]!.end).toBe(1.35);
  });

  it("mints srcStarts linearly across [fromSrc, toSrc], endpoints verbatim", () => {
    // Endpoint preservation is what keeps a rewritten run RE-editable: its
    // endpoints still answer to the same (fromKey, toKey) pair.
    const { lines: out } = applyCaptionRangeEdits(makeLines(), [
      edit("w400", "w700", "will absolutely hand", "gonna give"),
    ]);
    const minted = out[0]!.words.slice(1);
    expect(minted[0]!.srcStart).toBe(0.4);
    expect(minted[1]!.srcStart).toBeCloseTo(0.55, 10);
    expect(minted[2]!.srcStart).toBe(0.7);
  });

  it("a single replacement token takes the run's fromSrc and the full window", () => {
    const { lines: out } = applyCaptionRangeEdits(makeLines(), [
      edit("w0", "w700", "nope", "never gonna give"),
    ]);
    expect(out[0]!.words).toEqual([{ text: "nope", start: 0, end: 1, srcStart: 0 }]);
    expect(out[0]!.end).toBe(1.35);
  });

  it("a span too short for 1ms-distinct keys shares quantised keys — documented, monotonic", () => {
    const lines: CaptionLine[] = [
      {
        start: 0,
        end: 1,
        words: [
          { text: "x", start: 0, end: 0.5, srcStart: 0.4 },
          { text: "y", start: 0.5, end: 1, srcStart: 0.401 },
        ],
      },
    ];
    const { lines: out, dropped } = applyCaptionRangeEdits(lines, [
      edit("w400", "w401", "a b c d", "x y"),
    ]);
    expect(dropped).toEqual([]);
    const srcs = out[0]!.words.map((w) => w.srcStart);
    // Monotonic (non-decreasing raw values) inside the span...
    for (let i = 1; i < srcs.length; i++) expect(srcs[i]!).toBeGreaterThanOrEqual(srcs[i - 1]!);
    expect(srcs[0]).toBe(0.4);
    expect(srcs[3]).toBe(0.401);
    // ...but the 1ms span cannot hold four distinct quantised keys — the
    // accepted duplicate-anchor case the per-word machinery reports if an
    // edit ever targets one.
    const keys = srcs.map((s) => `w${Math.round(s * 1000)}`);
    expect(new Set(keys).size).toBeLessThan(keys.length);
  });
});

describe("applyCaptionRangeEdits — a run spanning lines", () => {
  it("distributes tokens proportionally to each line's run duration; windows unchanged", () => {
    // Run "give you": 0.3s on line 0, 0.5s on line 1, four tokens → largest
    // remainder splits 2/2 (the 1.5/2.5 quotas tie at .5, earlier line wins).
    const { lines: out, dropped } = applyCaptionRangeEdits(makeLines(), [
      edit("w700", "w1500", "gave it to ya", "give you"),
    ]);
    expect(dropped).toEqual([]);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["never", "gonna", "gave", "it"]);
    expect(out[1]!.words.map((w) => w.text)).toEqual(["to", "ya", "up"]);
    // Each line's minted words stay inside that line's run window.
    expect(out[0]!.words[2]!.start).toBe(0.7);
    expect(out[0]!.words[3]!.end).toBe(1);
    expect(out[1]!.words[0]!.start).toBe(1.5);
    expect(out[1]!.words[1]!.end).toBe(2);
    // Neither line's window moved — Sequence windows and breakpoint
    // semantics stay as produced.
    expect(out[0]!.start).toBe(0);
    expect(out[0]!.end).toBe(1.35);
    expect(out[1]!.start).toBe(1.5);
    expect(out[1]!.end).toBe(2.5);
    // srcStarts are minted across the WHOLE run, monotonic through the seam.
    const minted = [...out[0]!.words.slice(2), ...out[1]!.words.slice(0, 2)];
    for (let i = 1; i < minted.length; i++) {
      expect(minted[i]!.srcStart).toBeGreaterThan(minted[i - 1]!.srcStart);
    }
    expect(minted[0]!.srcStart).toBe(0.7);
    expect(minted[3]!.srcStart).toBe(1.5);
  });

  it("omits a line allotted zero tokens once it has no words left", () => {
    const lines: CaptionLine[] = [
      { start: 0, end: 0.1, words: [{ text: "a", start: 0, end: 0.1, srcStart: 0 }] },
      { start: 1, end: 2, words: [{ text: "b", start: 1, end: 2, srcStart: 1 }] },
    ];
    const { lines: out, dropped } = applyCaptionRangeEdits(lines, [
      edit("w0", "w1000", "c", "a b"),
    ]);
    expect(dropped).toEqual([]);
    // Line 0's 0.1s share of a 1.1s run rounds to zero of the one token; its
    // only word was the run's, so the line goes — the applyCaptionWordHides
    // rule, no zero-word Sequence.
    expect(out).toHaveLength(1);
    expect(out[0]!.words).toEqual([{ text: "c", start: 1, end: 2, srcStart: 0 }]);
  });
});

describe("applyCaptionRangeEdits — duplicate anchors (hand-edited docs)", () => {
  it("drops a second entry with the same pair as duplicate-anchor", () => {
    const { lines: out, dropped } = applyCaptionRangeEdits(makeLines(), [
      edit("w400", "w700", "will hand", "gonna give"),
      edit("w400", "w700", "other text", "gonna give"),
    ]);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["never", "will", "hand"]);
    expect(dropped).toEqual([
      {
        key: "w400..w700",
        expected: "gonna give",
        found: "will",
        reason: "duplicate-anchor",
      },
    ]);
  });

  it("drops an entry whose fromKey an earlier run already consumed", () => {
    const { dropped } = applyCaptionRangeEdits(makeLines(), [
      edit("w0", "w700", "always will", "never gonna give"),
      // w400 was inside (and consumed by) the run above.
      edit("w400", "w1500", "x y", "gonna give you"),
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.key).toBe("w400..w1500");
    expect(dropped[0]!.reason).toBe("duplicate-anchor");
  });
});

describe("captionRangeEditWas", () => {
  const existing = [edit("w400", "w700", "will hand", "gonna give")];

  it("keeps the FIRST edit's was for a re-edit of the same pair", () => {
    // The captionEditWas rule: the re-editor sees the LIVE rewritten text,
    // and storing that would stale the guard against the base lines.
    expect(captionRangeEditWas(existing, "w400", "w700", "will hand")).toBe("gonna give");
  });

  it("returns the seen text for a pair with no stored entry", () => {
    expect(captionRangeEditWas(existing, "w0", "w700", "never gonna give")).toBe(
      "never gonna give",
    );
  });
});

describe("captionRangeEdits schema", () => {
  it("defaults to [] so every pre-existing doc parses", () => {
    expect(OverrideDocSchema.parse({}).captionRangeEdits).toEqual([]);
    expect(
      OverrideDocSchema.parse({ captions: { w500: { text: "a", was: "b" } } }).captionRangeEdits,
    ).toEqual([]);
  });

  it("round-trips entries through a JSON cycle", () => {
    const doc = OverrideDocSchema.parse({
      captionRangeEdits: [edit("w400", "w700", "will hand", "gonna give")],
    });
    expect(
      OverrideDocSchema.parse(JSON.parse(JSON.stringify(doc))).captionRangeEdits,
    ).toEqual([{ fromKey: "w400", toKey: "w700", text: "will hand", was: "gonna give" }]);
  });

  it("rejects keys that are not §137 source keys — parsed, never coerced", () => {
    expect(
      OverrideDocSchema.safeParse({
        captionRangeEdits: [edit("400", "w700", "x", "y z")],
      }).success,
    ).toBe(false);
    expect(
      OverrideDocSchema.safeParse({
        captionRangeEdits: [{ fromKey: "w400", toKey: "w700", text: "", was: "y z" }],
      }).success,
    ).toBe(false);
  });
});

describe("applyCaptionLayers — range edits between retypes and hides", () => {
  /**
   * None of these docs hold a `captionLineWindows` entry, so the window layer
   * the composer runs last is inert — this map exists only because it takes
   * one. A single kept span over the whole source also makes its src→output
   * conversion a plain identity, so nothing here reads differently than it did
   * before the layer existed (`applyCaptionLineWindows` is pinned on its own,
   * over a map with a cut in it, in caption-line-windows.test.ts).
   */
  const noWindows = new TimeMap([{ srcIn: 0, srcOut: 3600, kind: "keep" }]);

  it("composes edit → range → hide and tags a range drop as layer: range", () => {
    const doc = OverrideDocSchema.parse({
      captions: { w0: { text: "always", was: "never" } },
      captionRangeEdits: [
        edit("w400", "w700", "will hand", "gonna give"),
        // A stale one, to pin the tag.
        edit("w1500", "w2000", "x y", "not the run"),
      ],
      captionWordsHidden: { w2000: { was: "up" } },
    });
    const { lines: out, dropped } = applyCaptionLayers(makeLines(), doc, noWindows);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["always", "will", "hand"]);
    expect(out[1]!.words.map((w) => w.text)).toEqual(["you"]);
    expect(dropped).toEqual([
      { key: "w1500..w2000", expected: "not the run", found: "you up", layer: "range" },
    ]);
  });

  it("a range edit whose run holds a RETYPED word applies — edits run first", () => {
    // The run's `was` records the LIVE post-retype text the user was looking
    // at; ranges running before edits would stale it against the base.
    const doc = OverrideDocSchema.parse({
      captions: { w400: { text: "gunna", was: "gonna" } },
      captionRangeEdits: [edit("w400", "w700", "will hand", "gunna give")],
    });
    const { lines: out, dropped } = applyCaptionLayers(makeLines(), doc, noWindows);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["never", "will", "hand"]);
    expect(dropped).toEqual([]);
  });
});
