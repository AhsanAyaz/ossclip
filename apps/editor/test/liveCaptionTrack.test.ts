import { describe, expect, it } from "vitest";
import {
  buildCaptionLines,
  captionKeyFor,
  livePreviewMap,
  OverrideDocSchema,
  TimeMap,
  type CaptionLine,
  type Segment,
  type Transcript,
} from "@ossclip/core/browser";
import { applyWindowsOnLastRenderClock, rebuildCaptionTrack } from "../src/liveCaptionTrack";

/**
 * The field bug, at the seam where it is provable (cut-review rework phase 2):
 * produce proposed a pause removal, the last render cut it, the user keeps the
 * retake — and every word inside that stretch existed in NO stream the
 * Transcript panel was fed, so it could not be retyped, hidden or deleted.
 *
 * `rebuildCaptionTrack` is the pure half of the fix; App owns the fetch, the
 * clock and the cue carve. Testing here rather than through `<App/>` is the
 * repo's own split — there is no App harness, and the interesting decision is
 * not in the JSX.
 */
/**
 * The NO-TRANSCRIPT fallback's window layer (2026-08-26 carry-over): on an old
 * workdir the track cannot be rebuilt, so the Player gets App's old-clock
 * chain — which stopped at the timing layer while `applyCaptionLayers` (the
 * render) ran windows last of all. A placed caption then previewed at its
 * derived position and rendered at its window: exactly the divergence the
 * composer's docstring says the chokepoint exists to prevent. This helper is
 * the fallback chain's missing last stop, pure so the divergence is provable
 * without an App harness (the `rebuildCaptionTrack` split, one file up).
 */
describe("applyWindowsOnLastRenderClock — the fallback chain's window layer", () => {
  /** The last render kept 0..5 and 7..10, so source 8 plays at output 6. */
  const spans = new TimeMap([
    { srcIn: 0, srcOut: 5, kind: "keep" },
    { srcIn: 5, srcOut: 7, kind: "remove", reason: "pause", confidence: 0.9 },
    { srcIn: 7, srcOut: 10, kind: "keep" },
  ]).spans;
  const transcript: Transcript = {
    language: "en",
    words: [
      { text: "early", start: 3, end: 3.3 },
      { text: "late", start: 8, end: 8.3 },
    ],
  };
  const lines = () =>
    buildCaptionLines(transcript, new TimeMap([
      { srcIn: 0, srcOut: 5, kind: "keep" },
      { srcIn: 7, srcOut: 10, kind: "keep" },
    ]), {});

  it("places a stored window through the LAST RENDER's clock — source seconds in, output out", () => {
    // The window spans source 7.5..9, which the kept spans play at output
    // 5.5..7 — the exact conversion the render's own layer makes.
    const applied = applyWindowsOnLastRenderClock(
      lines(),
      { [captionKeyFor(8)]: { srcStart: 7.5, srcEnd: 9 } },
      spans,
    );
    const late = applied.lines.find((l) => l.words[0]!.text === "late")!;
    expect(late.start).toBeCloseTo(5.5, 6);
    expect(late.end).toBeCloseTo(7, 6);
    expect(applied.dropped).toEqual([]);
  });

  it("no windows is a verbatim pass-through, whatever the spans", () => {
    const base = lines();
    for (const s of [spans, [] as typeof spans]) {
      const applied = applyWindowsOnLastRenderClock(base, {}, s);
      expect(applied.lines).toEqual(base);
      expect(applied.dropped).toEqual([]);
    }
  });

  it("windows with NO spans to build a clock from are dropped WITH a report, never guessed", () => {
    // A props file that stores windows but no spans should not exist (spans
    // predate the window layer) — but a hand-edited one must not place a
    // SOURCE-seconds window on the output clock unconverted, and must not
    // vanish it silently either (§137's rule).
    const base = lines();
    const applied = applyWindowsOnLastRenderClock(
      base,
      { [captionKeyFor(8)]: { srcStart: 7.5, srcEnd: 9 } },
      [],
    );
    expect(applied.lines).toEqual(base);
    expect(applied.dropped).toEqual([{ key: captionKeyFor(8), expected: "", found: null }]);
  });
});

describe("rebuildCaptionTrack over revived material", () => {
  /** The last render cut source 5..7; the veto puts it back. */
  const proposal: Segment[] = [
    { srcIn: 0, srcOut: 5, kind: "keep" },
    { srcIn: 5, srcOut: 7, kind: "remove", reason: "pause", confidence: 0.9 },
    { srcIn: 7, srcOut: 10, kind: "keep" },
  ];
  const clocks = () =>
    livePreviewMap(proposal, { reasons: { pause: false } }, [], new TimeMap(proposal).spans)!;

  /** "during" sits INSIDE the removed stretch — the word the panel could not
   * see. The other two straddle it, far enough apart (> `maxGap`) that each
   * word packs onto its own line. */
  const transcript: Transcript = {
    language: "en",
    words: [
      { text: "early", start: 3, end: 3.3 },
      { text: "during", start: 6, end: 6.3 },
      { text: "late", start: 8, end: 8.3 },
    ],
  };
  const texts = (lines: CaptionLine[]): string[] => lines.flatMap((l) => l.words.map((w) => w.text));
  const doc = OverrideDocSchema.parse({});

  it("the OLD clock genuinely cannot see the revived word — the bug this closes", () => {
    // Not a strawman: this is exactly what `renderProps.captionLines` (and
    // every stream derived from it) holds. `mapWord` returns null for a word
    // with no image in the last render's cut, so the word is simply absent.
    const old = buildCaptionLines(transcript, clocks().oldMap, {});
    expect(texts(old)).toEqual(["early", "late"]);
  });

  it("all three panel streams carry the revived word, on the live clock", () => {
    const track = rebuildCaptionTrack(transcript, clocks().newMap, doc, {
      breakpoints: [],
      landscape: false,
    });
    for (const stream of [track.baseLines, track.liveLines, track.timingLines, track.lines]) {
      expect(texts(stream)).toEqual(["early", "during", "late"]);
    }
    // LIVE output seconds, not the old clock's: with the pause revived the
    // source instant 6 plays at 6. On the old clock 6 was "late" — which is
    // why the panel is fed the identity mappers alongside these streams.
    const during = track.liveLines.flatMap((l) => l.words).find((w) => w.text === "during")!;
    expect(during.start).toBeCloseTo(6, 6);
    // The SOURCE anchor is the raw stamp either way (§137) — that is what
    // makes an edit made on one clock land on the other.
    expect(during.srcStart).toBeCloseTo(6, 6);
  });

  it("a retype and a hide keyed to the revived word land on the rebuilt lines", () => {
    // Source-anchored keys (§137) are the whole reason a rebuild can carry
    // the user's existing edits: nothing about the key mentions a clock.
    const key = captionKeyFor(6);
    const edited = OverrideDocSchema.parse({
      captions: { [key]: { text: "DURING", was: "during" } },
      captionWordsHidden: { [captionKeyFor(8)]: { was: "late" } },
    });
    const track = rebuildCaptionTrack(transcript, clocks().newMap, edited, {
      breakpoints: [],
      landscape: false,
    });
    // Pristine, so the panel's retype guard still compares against the truth.
    expect(texts(track.baseLines)).toEqual(["early", "during", "late"]);
    // Post-retype, PRE-hide: the hidden word is still rendered (struck
    // through) so it can be selected and restored.
    expect(texts(track.liveLines)).toEqual(["early", "DURING", "late"]);
    // Post-hide: the track core times, and the one the Player gets.
    expect(texts(track.timingLines)).toEqual(["early", "DURING"]);
    expect(texts(track.lines)).toEqual(["early", "DURING"]);
  });

  it("a range rewrite over the revived word lands too, word count and all", () => {
    const rewritten = OverrideDocSchema.parse({
      captionRangeEdits: [
        { fromKey: captionKeyFor(6), toKey: captionKeyFor(6), text: "two words", was: "during" },
      ],
    });
    const track = rebuildCaptionTrack(transcript, clocks().newMap, rewritten, {
      breakpoints: [],
      landscape: false,
    });
    expect(texts(track.liveLines)).toEqual(["early", "two", "words", "late"]);
  });

  it("a nudge whose key no longer HEADS a line is dropped WITH a report", () => {
    // Re-packing is the phase-2 caution made concrete: the rebuilt track is
    // packed fresh over material the last render never had, so a line head
    // can stop being one. Two words 0.05s apart pack into ONE line, whose
    // head is the first — a nudge stored against the SECOND addresses no
    // line, and `applyCaptionLineTiming` says so instead of silently doing
    // nothing (App pipes this into the §137 console/banner channel).
    const packed: Transcript = {
      language: "en",
      words: [
        { text: "during", start: 6, end: 6.3 },
        { text: "this", start: 6.35, end: 6.6 },
      ],
    };
    const nudged = OverrideDocSchema.parse({
      captionLineTiming: { [captionKeyFor(6.35)]: { lead: -0.2, tail: 0 } },
    });
    const track = rebuildCaptionTrack(packed, clocks().newMap, nudged, {
      breakpoints: [],
      landscape: false,
    });
    expect(track.timingLines).toHaveLength(1);
    expect(track.dropped).toEqual([{ key: captionKeyFor(6.35), expected: "", found: null }]);
    // Dropped means DROPPED — the line kept the window the packer gave it.
    expect(track.lines[0]!.start).toBeCloseTo(track.timingLines[0]!.start, 6);
  });

  it("a nudge on the line's own head still applies over the rebuilt track", () => {
    // The other half of the caution: the report above must not mean "nudges
    // never survive a rebuild". A key that still heads a line moves it.
    const nudged = OverrideDocSchema.parse({
      captionLineTiming: { [captionKeyFor(6)]: { lead: -0.5, tail: 0 } },
    });
    const track = rebuildCaptionTrack(transcript, clocks().newMap, nudged, {
      breakpoints: [],
      landscape: false,
    });
    expect(track.dropped).toEqual([]);
    const before = track.timingLines.find((l) => l.words[0]!.text === "during")!;
    const after = track.lines.find((l) => l.words[0]!.text === "during")!;
    expect(after.start).toBeCloseTo(before.start - 0.5, 6);
  });
});
