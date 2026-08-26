import { describe, expect, it } from "vitest";
import {
  applyCaptionLayers,
  applyCaptionLineWindows,
  MIN_CAPTION_SEC,
  OverrideDocSchema,
} from "../src/overrides";
import type { CaptionLine } from "../src/captions";
import { TimeMap } from "../src/timemap";

/**
 * `captionLineWindows` — the audio-first timing tool's storage. The whole
 * point of the record is that it is stated in SOURCE seconds, so every case
 * here runs over a map with a REAL cut in it: on an identity map the layer's
 * conversion is invisible and a src→output bug would pass.
 *
 * The cut removes source 5..7, so the clock is:
 *   src 0..5   → out 0..5
 *   src 7..12  → out 5..10
 */
const map = new TimeMap([
  { srcIn: 0, srcOut: 5, kind: "keep" },
  { srcIn: 5, srcOut: 7, kind: "remove" },
  { srcIn: 7, srcOut: 12, kind: "keep" },
]);

/** Two packed lines on the OUTPUT clock above, each with a source-anchored
 * first word — a gap-free partition, the shape a real caption stream has. */
const makeLines = (): CaptionLine[] => [
  {
    start: 0,
    end: 2,
    words: [
      { text: "one", start: 0, end: 1, srcStart: 0 },
      { text: "two", start: 1, end: 2, srcStart: 1 },
    ],
  },
  {
    start: 2,
    end: 4,
    words: [
      { text: "three", start: 2, end: 3, srcStart: 2 },
      { text: "four", start: 3, end: 4, srcStart: 3 },
    ],
  },
];

describe("OverrideDocSchema.captionLineWindows", () => {
  it("parses a source-anchored window and defaults to {} on docs that predate it", () => {
    const doc = OverrideDocSchema.parse({
      captionLineWindows: { w2000: { srcStart: 8, srcEnd: 9.5 } },
    });
    expect(doc.captionLineWindows).toEqual({ w2000: { srcStart: 8, srcEnd: 9.5 } });
    expect(OverrideDocSchema.parse({}).captionLineWindows).toEqual({});
  });

  it("REFUSES an inverted or sub-floor window — parsed, never coerced", () => {
    // A backwards window would mirror the line's word order through
    // `scaleWordsIntoWindow`, and one under the floor is a delete wearing a
    // timing gesture's clothes (`MIN_CAPTION_SEC`). Both are the doc lying
    // about a decision the user made against the audio, so the parse refuses
    // rather than clamping it into something they did not ask for.
    expect(
      OverrideDocSchema.safeParse({ captionLineWindows: { w2000: { srcStart: 9, srcEnd: 8 } } })
        .success,
    ).toBe(false);
    expect(
      OverrideDocSchema.safeParse({
        captionLineWindows: { w2000: { srcStart: 8, srcEnd: 8 + MIN_CAPTION_SEC / 2 } },
      }).success,
    ).toBe(false);
    // Exactly the floor is legal — the constant is the minimum, not an
    // exclusive bound (`applyCaptionLineTiming` sweeps to the same value).
    expect(
      OverrideDocSchema.safeParse({
        captionLineWindows: { w2000: { srcStart: 8, srcEnd: 8 + MIN_CAPTION_SEC } },
      }).success,
    ).toBe(true);
  });
});

describe("applyCaptionLineWindows", () => {
  it("places the line at the SOURCE window, converted through the map", () => {
    // src 8..9.5 sits in the second kept span, which starts 2s later in
    // source than in output — so the caption lands at out 6..7.5. The naive
    // "source seconds are output seconds" bug reads 8..9.5.
    const { lines, dropped } = applyCaptionLineWindows(
      makeLines(),
      { w2000: { srcStart: 8, srcEnd: 9.5 } },
      map,
    );
    expect(lines[1]!.start).toBeCloseTo(6, 10);
    expect(lines[1]!.end).toBeCloseTo(7.5, 10);
    expect(dropped).toEqual([]);
  });

  it("re-stamps the line's words into the new window (the karaoke highlight)", () => {
    // `scaleWordsIntoWindow`: the words drive the highlight INSIDE the
    // `<Sequence>`, so a window moved without them lights the wrong words.
    const { lines } = applyCaptionLineWindows(
      makeLines(),
      { w2000: { srcStart: 8, srcEnd: 9.5 } },
      map,
    );
    const [three, four] = lines[1]!.words;
    expect(three!.start).toBeCloseTo(6, 10);
    expect(three!.end).toBeCloseTo(6.75, 10);
    expect(four!.start).toBeCloseTo(6.75, 10);
    expect(four!.end).toBeCloseTo(7.5, 10);
    // Text and count are untouched — this layer only moves time.
    expect(lines[1]!.words.map((w) => w.text)).toEqual(["three", "four"]);
  });

  it("leaves untouched lines VERBATIM — same reference, same stamps", () => {
    const lines = makeLines();
    const out = applyCaptionLineWindows(lines, { w2000: { srcStart: 8, srcEnd: 9.5 } }, map);
    expect(out.lines[0]).toBe(lines[0]);
  });

  it("does NOT sweep an overlap apart — overlap is legal here", () => {
    // The difference from `applyCaptionLineTiming` in one assertion. The user
    // placed both windows against the audio; core has no business deciding
    // that two captions may not share a moment (the editor tints the conflict
    // instead), and the renderer mounts overlapping Sequences happily.
    const { lines } = applyCaptionLineWindows(
      makeLines(),
      { w0: { srcStart: 0, srcEnd: 4 }, w2000: { srcStart: 2, srcEnd: 4.5 } },
      map,
    );
    expect(lines[0]!.start).toBeCloseTo(0, 10);
    expect(lines[0]!.end).toBeCloseTo(4, 10);
    expect(lines[1]!.start).toBeCloseTo(2, 10);
    expect(lines[1]!.end).toBeCloseTo(4.5, 10);
  });

  it("does not push a window OUT of the track's bounds either — it is absolute", () => {
    // The nudge layer clamps into `[first.start, last.end]`; a window is the
    // user's own answer and may sit anywhere the map can place it, including
    // past the last derived caption.
    const { lines } = applyCaptionLineWindows(
      makeLines(),
      { w0: { srcStart: 11, srcEnd: 12 } },
      map,
    );
    expect(lines[0]!.start).toBeCloseTo(9, 10);
    expect(lines[0]!.end).toBeCloseTo(10, 10);
  });

  it("clamps to the floor in OUTPUT seconds — a cut inside the window narrows it", () => {
    // src 4.9..7.1 is 2.2s wide and passes the schema, but 5..7 was CUT: both
    // edges land within 0.1s of the seam. The floor is the layer's, not the
    // schema's, because only the map knows this.
    const { lines } = applyCaptionLineWindows(
      makeLines(),
      { w0: { srcStart: 4.99, srcEnd: 7.0 } },
      map,
    );
    expect(lines[0]!.end - lines[0]!.start).toBeCloseTo(MIN_CAPTION_SEC, 10);
  });

  it("keeps a window whose material was cut away ENTIRELY, at the seam", () => {
    // Both edges clamp onto the same kept edge. The caption is shown at the
    // floor rather than dropped: the cut is the thing the user is more likely
    // to be about to undo, and a silently vanished window is the field failure
    // mode every caption layer here reports its way out of.
    const { lines, dropped } = applyCaptionLineWindows(
      makeLines(),
      { w0: { srcStart: 5.2, srcEnd: 6.8 } },
      map,
    );
    expect(lines[0]!.start).toBeCloseTo(5, 10);
    expect(lines[0]!.end).toBeCloseTo(5 + MIN_CAPTION_SEC, 10);
    expect(dropped).toEqual([]);
  });

  it("reports an anchor no line starts on as found: null", () => {
    const { dropped } = applyCaptionLineWindows(
      makeLines(),
      { w9999: { srcStart: 8, srcEnd: 9 } },
      map,
    );
    expect(dropped).toEqual([{ key: "w9999", expected: "", found: null }]);
  });

  it("reports every stored window when there are NO lines at all", () => {
    // `applyCaptionLineTiming`'s rule: silence here let produce report
    // placements that never happened.
    const { lines, dropped } = applyCaptionLineWindows([], { w0: { srcStart: 1, srcEnd: 2 } }, map);
    expect(lines).toEqual([]);
    expect(dropped).toEqual([{ key: "w0", expected: "", found: null }]);
  });

  it("places ONE window on the FIRST claimant and reports the second", () => {
    // ms-quantised anchors CAN collide (captions.ts:44-50); one window must
    // move one line.
    const lines: CaptionLine[] = [
      { start: 0, end: 1, words: [{ text: "one", start: 0, end: 1, srcStart: 2 }] },
      { start: 1, end: 2, words: [{ text: "two", start: 1, end: 2, srcStart: 2 }] },
    ];
    const out = applyCaptionLineWindows(lines, { w2000: { srcStart: 8, srcEnd: 9 } }, map);
    expect(out.lines[0]!.start).toBeCloseTo(6, 10);
    expect(out.lines[1]).toBe(lines[1]);
    expect(out.dropped).toEqual([
      { key: "w2000", expected: "", found: "two", reason: "duplicate-anchor" },
    ]);
  });
});

describe("applyCaptionLayers — windows are the LAST layer", () => {
  it("a window OVERRIDES a nudge on the same line rather than compounding with it", () => {
    // The absolute answer wins: the nudge ran, then the window stated where
    // the caption actually goes. Compounding would have landed at 6 - 0.5.
    const doc = OverrideDocSchema.parse({
      captionLineTiming: { w2000: { lead: -0.5, tail: 0 } },
      captionLineWindows: { w2000: { srcStart: 8, srcEnd: 9.5 } },
    });
    const { lines, dropped } = applyCaptionLayers(makeLines(), doc, map);
    expect(lines[1]!.start).toBeCloseTo(6, 10);
    expect(lines[1]!.end).toBeCloseTo(7.5, 10);
    expect(dropped).toEqual([]);
  });

  it("runs on the POST-hide lines and tags its drops layer: window", () => {
    const doc = OverrideDocSchema.parse({
      // Hiding the second line's every word removes the line — the window on
      // it then has no window to move, exactly like a nudge.
      captionWordsHidden: { w2000: { was: "three" }, w3000: { was: "four" } },
      captionLineWindows: { w2000: { srcStart: 8, srcEnd: 9.5 } },
    });
    const { lines, dropped } = applyCaptionLayers(makeLines(), doc, map);
    expect(lines).toHaveLength(1);
    expect(dropped).toEqual([
      { key: "w2000", expected: "", found: null, layer: "window" },
    ]);
  });
});
