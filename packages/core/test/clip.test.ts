import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/producer/mock";
import { produceScenes } from "../src/producer/index";
import { TimeMap } from "../src/timemap";
import type { Segment, Transcript } from "../src/schema";
import type { Moment } from "../src/producer/beats";
import {
  boundCutlistToWindow,
  parseClipWindowPin,
  resolveClipWindow,
  sliceMoments,
  sliceRawTranscript,
  sliceRepairs,
  sliceTranscript,
  type ClipWindow,
} from "../src/clip";

/**
 * 600 words at 2 words/sec (0.4s word + 0.1s gap) = a 300s take, with a
 * sentence boundary every 10 words — word 9, 19, 29… carry a full stop, so
 * sentence STARTS are the multiples of 10.
 */
const mkLongTranscript = (n = 600, punctuate = true): Transcript => ({
  language: "en",
  words: Array.from({ length: n }, (_, i) => ({
    text: `w${i}${punctuate && i % 10 === 9 ? "." : ""}`,
    start: i * 0.5,
    end: i * 0.5 + 0.4,
  })),
});

const highlight = (startWord: number, endWord: number) => ({
  startWord,
  endWord,
  reason: "test window",
});

describe("resolveClipWindow (§93e + sentence snapping)", () => {
  const t = mkLongTranscript();

  it("refuses a missing highlight — never a silent fall back to the full take", () => {
    expect(() => resolveClipWindow(t, undefined, 60)).toThrow(/no highlight window/);
  });

  it("refuses a start beyond the transcript and an inverted window", () => {
    expect(() => resolveClipWindow(t, highlight(900, 950), 60)).toThrow(/beyond the transcript/);
    expect(() => resolveClipWindow(t, highlight(200, 100), 60)).toThrow(/empty or inverted/);
  });

  it("clamps an endWord past the transcript instead of failing", () => {
    const { window, notes } = resolveClipWindow(t, highlight(480, 9999), 60);
    expect(window.endWord).toBeLessThanOrEqual(599);
    expect(notes.some((n) => n.includes("clamped"))).toBe(true);
  });

  it("snaps both boundaries to the nearest sentence within ±20% of the target", () => {
    // 103 is mid-sentence (starts are multiples of 10); 223 is mid-sentence too.
    const { window, notes } = resolveClipWindow(t, highlight(103, 223), 60);
    expect(window.startWord).toBe(100);
    expect(window.endWord).toBe(219);
    expect(window.startSec).toBe(50);
    expect(window.endSec).toBeCloseTo(109.9, 5);
    expect(notes.filter((n) => n.includes("snapped")).length).toBe(2);
  });

  it("trims an over-long window at the sentence end nearest the target — from the tail, keeping the hook", () => {
    const { window, notes } = resolveClipWindow(t, highlight(100, 400), 60);
    expect(window.startWord).toBe(100);
    // dur(100..219) = 59.9s — the closest sentence end to the 60s target under the +20% cap.
    expect(window.endWord).toBe(219);
    expect(notes.some((n) => n.includes("trimmed"))).toBe(true);
  });

  it("refuses a window under half the target, with the reason in the message", () => {
    expect(() => resolveClipWindow(t, highlight(100, 140), 60)).toThrow(/under half/);
  });

  it("a transcript with no punctuation still resolves — word-boundary trim, no snap", () => {
    const bare = mkLongTranscript(600, false);
    const { window } = resolveClipWindow(bare, highlight(103, 400), 60);
    expect(window.startWord).toBe(103); // nothing to snap to
    const dur = bare.words[window.endWord]!.end - bare.words[window.startWord]!.start;
    expect(dur).toBeLessThanOrEqual(60 * 1.2 + 1e-9);
    expect(dur).toBeGreaterThanOrEqual(30);
  });

  it("carries the model's reason through", () => {
    const { window } = resolveClipWindow(t, highlight(100, 219), 60);
    expect(window.reason).toBe("test window");
  });
});

describe("clip window pin (§93g replay)", () => {
  const t = mkLongTranscript();

  it("reproduces the identical window from the recorded word range — no LLM anywhere", () => {
    const { window } = resolveClipWindow(t, highlight(103, 223), 60);
    const pinned = parseClipWindowPin(t, `${window.startWord}:${window.endWord}`);
    expect(pinned.startWord).toBe(window.startWord);
    expect(pinned.endWord).toBe(window.endWord);
    expect(pinned.startSec).toBe(window.startSec);
    expect(pinned.endSec).toBe(window.endSec);
  });

  it("rejects malformed and out-of-range pins loudly", () => {
    expect(() => parseClipWindowPin(t, "abc")).toThrow(/expected "startWord:endWord"/);
    expect(() => parseClipWindowPin(t, "100:9000")).toThrow(/does not fit this transcript/);
    expect(() => parseClipWindowPin(t, "200:100")).toThrow(/does not fit this transcript/);
  });
});

describe("slicing (§93.1: slice, then run the pipeline unchanged)", () => {
  const t = mkLongTranscript();
  const window: ClipWindow = {
    startWord: 100,
    endWord: 219,
    startSec: 50,
    endSec: 109.9,
    reason: "test",
  };

  it("sliceTranscript keeps source-time stamps untouched", () => {
    const sliced = sliceTranscript(t, window);
    expect(sliced.words.length).toBe(120);
    expect(sliced.words[0]!.start).toBe(50);
    expect(sliced.words.at(-1)!.end).toBeCloseTo(109.9, 5);
  });

  it("sliceMoments drops outside, clamps partials, shifts survivors", () => {
    const m = (startWord: number, endWord: number): Moment => ({
      startWord,
      endWord,
      purpose: "p",
      onScreenCopy: "C",
      sceneKind: "none",
    });
    const out = sliceMoments([m(0, 50), m(90, 110), m(150, 160), m(210, 260), m(300, 400)], window);
    expect(out.map((x) => [x.startWord, x.endWord])).toEqual([
      [0, 10], // 90–110 clamped to 100–110, shifted
      [50, 60], // 150–160 shifted
      [110, 119], // 210–260 clamped to 210–219, shifted
    ]);
  });

  it("sliceRawTranscript slices by TIME, so a raw/repaired index drift cannot misalign it", () => {
    const { transcript: sliced, offset } = sliceRawTranscript(t, window);
    expect(offset).toBe(100);
    expect(sliced.words.length).toBe(120);
    // A word ending exactly at the boundary (whisper stretches ends to the
    // next start) stays OUT; the first word of the window stays in.
    const stretched: Transcript = {
      language: "en",
      words: [
        { text: "before", start: 49, end: 50 },
        { text: "first", start: 50, end: 50.4 },
      ],
    };
    const s2 = sliceRawTranscript(stretched, window);
    expect(s2.transcript.words.map((w) => w.text)).toEqual(["first"]);
    expect(s2.offset).toBe(1);
  });

  it("sliceRepairs keeps only in-window repairs, re-anchored", () => {
    const repairs = [
      { startWord: 5, endWord: 6, heard: "a", correction: "b", applied: true },
      { startWord: 110, endWord: 111, heard: "c", correction: "d", applied: true },
      { startWord: 219, endWord: 220, heard: "e", correction: "f", applied: true }, // straddles the end
    ];
    const out = sliceRepairs(repairs, 100, 120);
    expect(out).toEqual([{ startWord: 10, endWord: 11, heard: "c", correction: "d", applied: true }]);
  });
});

describe("boundCutlistToWindow (§93.1: the cut is bounded, the map is untouched)", () => {
  const window: ClipWindow = {
    startWord: 100,
    endWord: 219,
    startSec: 50,
    endSec: 109.9,
    reason: "test",
  };
  const duration = 300;
  const inner: Segment[] = [
    { srcIn: 0, srcOut: 80, kind: "keep" },
    { srcIn: 80, srcOut: 81, kind: "remove", reason: "silence", confidence: 0.9 },
    { srcIn: 81, srcOut: 300, kind: "keep" },
  ];

  it("everything outside the (padded) window becomes a clip removal; inside is preserved", () => {
    const out = boundCutlistToWindow(inner, window, duration);
    expect(out[0]).toMatchObject({ srcIn: 0, kind: "remove", reason: "clip" });
    expect(out.at(-1)).toMatchObject({ srcOut: 300, kind: "remove", reason: "clip" });
    const silence = out.find((s) => s.reason === "silence");
    expect(silence).toMatchObject({ srcIn: 80, srcOut: 81 });
  });

  it("stays a full partition of [0, duration] — the TimeMap invariant holds by construction", () => {
    const out = boundCutlistToWindow(inner, window, duration);
    let cursor = 0;
    for (const s of out) {
      expect(s.srcIn).toBeCloseTo(cursor, 9);
      cursor = s.srcOut;
    }
    expect(cursor).toBeCloseTo(duration, 9);
    const map = new TimeMap(out);
    const kept = out
      .filter((s) => s.kind === "keep")
      .reduce((acc, s) => acc + (s.srcOut - s.srcIn), 0);
    expect(map.outputDuration).toBeCloseTo(kept, 9);
    // The output is (window + lead/tail pads) minus the inner silence.
    expect(kept).toBeCloseTo(110.25 - 49.75 - 1, 9);
  });
});

describe("produceScenes with clip (§93d: one editorial call)", () => {
  it("mock provider selects a window, and every scene/moment lands inside the slice", async () => {
    const t = mkLongTranscript();
    const result = await produceScenes(new MockProvider(), {
      transcript: t,
      outputDuration: 60,
      clip: { targetSec: 60 },
    });
    expect(result.clip).toBeDefined();
    const { window, transcript: sliced } = result.clip!;
    const dur = window.endSec - window.startSec;
    expect(dur).toBeGreaterThanOrEqual(30);
    expect(dur).toBeLessThanOrEqual(72 + 1e-9);
    expect(sliced.words.length).toBe(window.endWord - window.startWord + 1);
    for (const m of result.beatSheet.moments) {
      expect(m.startWord).toBeGreaterThanOrEqual(0);
      expect(m.endWord).toBeLessThan(sliced.words.length);
    }
    // Deterministic: the same input resolves the same window (the mock never
    // varies, and resolution is pure) — the §93g property in unit form.
    const again = await produceScenes(new MockProvider(), {
      transcript: t,
      outputDuration: 60,
      clip: { targetSec: 60 },
    });
    expect(again.clip!.window).toEqual(result.clip!.window);
  });

  it("different targets select different windows — the §93f cache-key inputs really differ", async () => {
    const t = mkLongTranscript();
    const w60 = (
      await produceScenes(new MockProvider(), {
        transcript: t,
        outputDuration: 60,
        clip: { targetSec: 60 },
      })
    ).clip!.window;
    const w30 = (
      await produceScenes(new MockProvider(), {
        transcript: t,
        outputDuration: 30,
        clip: { targetSec: 30 },
      })
    ).clip!.window;
    expect(`${w60.startWord}:${w60.endWord}`).not.toBe(`${w30.startWord}:${w30.endWord}`);
  });

  it("without clip, produceScenes is unchanged — no clip field, full-take moments", async () => {
    const t = mkLongTranscript(60);
    const result = await produceScenes(new MockProvider(), {
      transcript: t,
      outputDuration: 30,
    });
    expect(result.clip).toBeUndefined();
    expect(result.scenes.length).toBeGreaterThan(0);
  });
});
