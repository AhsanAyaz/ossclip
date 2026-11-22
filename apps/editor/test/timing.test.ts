import { describe, expect, it } from "vitest";
import {
  clampTiming,
  clampZoom,
  clipSpeedTiming,
  moveTiming,
  pinTiming,
  sourceToOutputClamped,
  timeAtX,
  zoomedScrollLeft,
} from "../src/timing";
import {
  OverrideDocSchema,
  applyOverrides,
  mapFromKeptSpans,
  resolveTimingPin,
  type KeptSpan,
  type SceneCue,
} from "@ossclip/core/browser";

const cues = [
  { id: "a", startSec: 0, endSec: 5 },
  { id: "b", startSec: 6, endSec: 11 },
] as SceneCue[];

describe("clampTiming", () => {
  it("keeps a nudge inside the clip", () => {
    expect(clampTiming(cues, "a", -3, 5, 30).startSec).toBe(0);
    expect(clampTiming(cues, "b", 6, 99, 30).endSec).toBe(30);
  });

  it("does not let a scene overlap its neighbour — cues are exclusive", () => {
    expect(clampTiming(cues, "a", 0, 9, 30).endSec).toBeLessThanOrEqual(6);
  });

  it("enforces a minimum on-screen duration", () => {
    const t = clampTiming(cues, "a", 4.9, 5, 30);
    expect(t.endSec - t.startSec).toBeGreaterThanOrEqual(1.2);
  });
});


describe("timeAtX (PLAN Tasks 3+4 — one mapping for every seek gesture)", () => {
  it("maps a track position linearly to a time", () => {
    expect(timeAtX(150, 100, 200, 30)).toBeCloseTo(7.5, 9);
  });

  it("clamps at both ends of the clip", () => {
    expect(timeAtX(50, 100, 200, 30)).toBe(0);
    expect(timeAtX(500, 100, 200, 30)).toBe(30);
  });

  it("a click INSIDE a scene block lands inside that scene's window", () => {
    // The Task 4 defect: clicking mid-block seeked to the block's start. The
    // global mapping, applied to a click over block b (6-11s of 30s on a
    // 300px track: x 60-110), must land between 6 and 11 — nowhere else.
    const t = timeAtX(85, 0, 300, 30);
    expect(t).toBeGreaterThan(6);
    expect(t).toBeLessThan(11);
    expect(t).toBeCloseTo(8.5, 9);
  });

  it("is safe on a zero-width track", () => {
    expect(timeAtX(100, 0, 0, 30)).toBe(0);
  });
});

describe("moveTiming (PLAN Task 6 — drag a block to move it)", () => {
  it("shifts both edges by the delta, preserving duration", () => {
    expect(moveTiming(cues, "a", 0.5, 30)).toEqual({ startSec: 0.5, endSec: 5.5 });
  });

  it("stops against the next scene instead of overlapping or squashing", () => {
    // Distinct from clampTiming, which would squash: the block slides until
    // it rests against b's start (minus the gap) at its FULL length.
    const t = moveTiming(cues, "a", 10, 30)!;
    expect(t.endSec - t.startSec).toBeCloseTo(5, 9);
    expect(t.endSec).toBeLessThanOrEqual(6);
  });

  it("stops against the previous scene and the clip bounds", () => {
    const back = moveTiming(cues, "b", -10, 30)!;
    expect(back.endSec - back.startSec).toBeCloseTo(5, 9);
    expect(back.startSec).toBeGreaterThanOrEqual(5);
    const fwd = moveTiming(cues, "b", 99, 30)!;
    expect(fwd.endSec).toBe(30);
    expect(fwd.endSec - fwd.startSec).toBeCloseTo(5, 9);
  });

  it("returns null for an unknown scene", () => {
    expect(moveTiming(cues, "zzz", 1, 30)).toBeNull();
  });
});

describe("timeline zoom (R14 §53)", () => {
  it("clampZoom bounds the factor to [1, 16]", () => {
    expect(clampZoom(0.3)).toBe(1);
    expect(clampZoom(4)).toBe(4);
    expect(clampZoom(64)).toBe(16);
  });

  it("keeps the content under the anchor stationary through a zoom-in", () => {
    // Viewport 1000px, zoom 1→2, cursor at x=400: the content point at 400
    // maps to 800 in the doubled track, so scrollLeft must become 400 for it
    // to stay under the cursor.
    expect(zoomedScrollLeft(1, 2, 1000, 0, 400)).toBe(400);
  });

  it("inverts cleanly: zooming back out returns to the original scroll", () => {
    const inScroll = zoomedScrollLeft(1, 4, 1000, 0, 600);
    expect(zoomedScrollLeft(4, 1, 1000, inScroll, 600)).toBe(0);
  });

  it("clamps to the scrollable range at the NEW zoom", () => {
    // Fully scrolled right at 4×, zooming out to 2× must not leave scrollLeft
    // beyond the 2× track's maximum (1000px viewport → max 1000).
    expect(zoomedScrollLeft(4, 2, 1000, 3000, 500)).toBe(1000);
    // …and never negative.
    expect(zoomedScrollLeft(2, 1, 1000, 0, 0)).toBe(0);
  });

  it("is safe on a zero-width viewport", () => {
    expect(zoomedScrollLeft(1, 2, 0, 0, 0)).toBe(0);
  });
});

describe("plain takes never clamp a drag (PLAN 2026-07-30 Task A)", () => {
  // The fill butts a derived take flush against every graphic block; if the
  // clamp saw it as a neighbour, lo === the cue's own start and no drag
  // could ever move a scene again. Takes re-derive around wherever the
  // graphic lands, so only STORED (graphic) windows constrain it.
  const withTakes = [
    { id: "a", startSec: 0, endSec: 5 },
    { id: "take-0", kind: "plain", layout: "full-bleed", startSec: 5, endSec: 12 },
    { id: "b", startSec: 12, endSec: 16 },
  ] as SceneCue[];

  it("moveTiming slides through a flush plain neighbour", () => {
    const t = moveTiming(withTakes, "b", -4, 30)!;
    expect(t.startSec).toBeCloseTo(8, 9); // straight through take-0's window
    expect(t.endSec - t.startSec).toBeCloseTo(4, 9);
    // …and still stops against the GRAPHIC neighbour beyond it.
    const far = moveTiming(withTakes, "b", -8, 30)!;
    expect(far.startSec).toBeCloseTo(5.05, 9);
  });

  it("clampTiming likewise ignores the take", () => {
    const t = clampTiming(withTakes, "b", 8, 16, 30);
    expect(t.startSec).toBeCloseTo(8, 9);
  });
});

describe("sourceToOutputClamped (PLAN 2026-08-04 Task 4c fix wave, review finding 1)", () => {
  // Two kept spans with a 3s GAP between them (5-8 in source time) — the
  // shape produced by an automatic cut or an already-applied user cut sitting
  // between them, same fixture shape TimeMap's own tests use.
  const spans: KeptSpan[] = [
    { srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 },
    { srcIn: 8, srcOut: 12, outIn: 5, outOut: 9 },
  ];

  it("maps a source instant inside a kept span directly", () => {
    expect(sourceToOutputClamped(spans, 2)).toBeCloseTo(2, 9);
    expect(sourceToOutputClamped(spans, 10)).toBeCloseTo(7, 9); // 5 + (10-8)
  });

  it("clamps a source instant inside the GAP to the seam between the two spans", () => {
    // ANY point strictly between two adjacent kept spans lands on the SAME
    // output instant, not "whichever edge it's numerically nearer to" — kept
    // output time has no gap (TimeMap's own invariant, "contiguous in output
    // time"), so the first span's outOut and the second span's outIn are
    // literally the same number (5 here). 5.5 (near the first span) and 7.9
    // (near the second) both prove that, not two different clamp outcomes.
    expect(sourceToOutputClamped(spans, 5.5)).toBeCloseTo(5, 9);
    expect(sourceToOutputClamped(spans, 7.9)).toBeCloseTo(5, 9);
  });

  it("clamps before the first span and after the last", () => {
    expect(sourceToOutputClamped(spans, -3)).toBeCloseTo(0, 9); // first span's outIn
    expect(sourceToOutputClamped(spans, 99)).toBeCloseTo(9, 9); // last span's outOut
  });

  it("is 0 on an empty spans array — no crash, no NaN", () => {
    expect(sourceToOutputClamped([], 5)).toBe(0);
  });
});

describe("pinTiming (source-anchored scene timing, 2026-08-26)", () => {
  // The live clock the field bug is about: a kept (revived) range put 2s
  // back at the head of the timeline, so live second 5 is source second 3.
  const toSource = (sec: number): number => sec - 2;

  it("converts the preview window to SOURCE seconds when a mapper exists", () => {
    expect(pinTiming(5, 9, toSource)).toEqual({ srcStart: 3, srcEnd: 7 });
  });

  it("rounds to milliseconds — clock arithmetic noise is not user intent", () => {
    expect(pinTiming(5.00004, 9.00051, (sec) => sec)).toEqual({
      srcStart: 5,
      srcEnd: 9.001,
    });
  });

  it("falls back to today's legacy write with no mapper", () => {
    expect(pinTiming(5, 9, null)).toEqual({ startSec: 5, endSec: 9 });
    expect(pinTiming(5, 9, undefined)).toEqual({ startSec: 5, endSec: 9 });
  });

  it("falls back to legacy rather than writing a window the schema refuses", () => {
    // A clock that collapses both edges onto one source second (the whole
    // window inside removed material) would otherwise mint `srcEnd ===
    // srcStart`, which `SceneTimingSchema` rejects on the next load.
    expect(pinTiming(5, 9, () => 4)).toEqual({ startSec: 5, endSec: 9 });
  });
});

describe("pinTiming never rounds an edge into removed material (EGM short, 2026-11-22)", () => {
  // The author's project: the first kept span starts at source 1.69919 s,
  // so output 0 IS source 1.69919, and 1.699 (its nearest ms) was cut.
  const egm = mapFromKeptSpans([
    { srcIn: 1.69919, srcOut: 5.999, outIn: 0, outOut: 4.29981 },
    { srcIn: 8.14719, srcOut: 19.6976, outIn: 4.29981, outOut: 15.85022 },
  ]);
  const kept = (src: number): boolean => egm.toOutput(src) !== null;
  const toSource = (sec: number): number => egm.toSource(sec);

  it("a block at output 0: the start rounds onto the kept side, and the pin resolves", () => {
    // What a right-edge drag from 0–3 to 0–5.77 wrote: 1.699, inert.
    const plain = pinTiming(0, 5.77, toSource) as { srcStart: number; srcEnd: number };
    expect(plain.srcStart).toBe(1.699);
    expect(resolveTimingPin(plain, egm)).toBeNull();
    const pin = pinTiming(0, 5.77, toSource, kept) as { srcStart: number; srcEnd: number };
    expect(pin.srcStart).toBe(1.7);
    const at = resolveTimingPin(pin, egm)!;
    // Within a millisecond of the drag, on the kept side.
    expect(at.startSec).toBeGreaterThanOrEqual(0);
    expect(at.startSec).toBeLessThan(0.001);
    expect(Math.abs(at.endSec - 5.77)).toBeLessThan(0.001);
  });

  it("an edge on a seam: toSource's earlier preimage rounds back into its span", () => {
    // Output 4.29981 is the seam; toSource answers 5.999 (the earlier
    // span's end, an exact ms) — kept. Its neighbour seam on the other
    // span starts at 8.14719, which rounds DOWN into the cut.
    const pin = pinTiming(4.29981, 6, toSource, kept) as { srcStart: number; srcEnd: number };
    expect(resolveTimingPin(pin, egm)).not.toBeNull();
    const second = mapFromKeptSpans([
      { srcIn: 0, srcOut: 2.0004, outIn: 0, outOut: 2.0004 },
      { srcIn: 3, srcOut: 9, outIn: 2.0004, outOut: 8.0004 },
    ]);
    const end = pinTiming(1, 2.0004, (t) => second.toSource(t), (src) => second.toOutput(src) !== null) as {
      srcStart: number;
      srcEnd: number;
    };
    // 2.0004 rounds to 2.0 (kept); 2.0006 would round up past the span.
    expect(resolveTimingPin(end, second)).not.toBeNull();
    const up = mapFromKeptSpans([
      { srcIn: 0, srcOut: 2.0006, outIn: 0, outOut: 2.0006 },
      { srcIn: 3, srcOut: 9, outIn: 2.0006, outOut: 8.0006 },
    ]);
    const upPin = pinTiming(1, 2.0006, (t) => up.toSource(t), (src) => up.toOutput(src) !== null) as {
      srcStart: number;
      srcEnd: number;
    };
    expect(upPin.srcEnd).toBe(2);
    expect(resolveTimingPin(upPin, up)).not.toBeNull();
  });

  it("keeps the exact source second when neither millisecond is kept (a span under 1 ms)", () => {
    const sliver = mapFromKeptSpans([{ srcIn: 4.0002, srcOut: 4.0008, outIn: 0, outOut: 0.0006 }]);
    const keptSliver = (src: number): boolean => sliver.toOutput(src) !== null;
    const pin = pinTiming(0, 0.0006, (t) => sliver.toSource(t), keptSliver) as { srcStart: number; srcEnd: number };
    expect(pin.srcStart).toBeCloseTo(4.0002, 9);
    expect(pin.srcEnd).toBeCloseTo(4.0008, 9);
    expect(resolveTimingPin(pin, sliver)).not.toBeNull();
  });

  it("an interior edge rounds to the nearest ms as before", () => {
    expect(pinTiming(1.00004, 3.00051, toSource, kept)).toEqual({
      srcStart: Math.round((1.69919 + 1.00004) * 1000) / 1000,
      srcEnd: Math.round((1.69919 + 3.00051) * 1000) / 1000,
    });
  });
});

describe("clipSpeedTiming (a clip's speed resizes its pinned block)", () => {
  // A dragged (pinned) 4 s clip at 10..14, a card well after it at 30.
  const clip = (over: Partial<SceneCue> = {}): SceneCue => ({
    id: "clip-1",
    kind: "graphic",
    layout: "full-bleed",
    component: "ClipScene",
    props: { src: "clips/a.webm", durationSec: 4, speed: 1 },
    startSec: 10,
    endSec: 14,
    ...over,
  });
  const card = (startSec: number): SceneCue =>
    ({ id: "card", kind: "graphic", layout: "video-top", component: "TitleCard", startSec, endSec: startSec + 3 }) as SceneCue;

  it("speed 2 on a pinned 4 s clip: the block runs start..start+2", () => {
    expect(clipSpeedTiming([clip(), card(30)], "clip-1", 2, 60, true)).toEqual({ startSec: 10, endSec: 12 });
  });

  it("speed 0.5 that reaches the neighbour is cut at the neighbour less the gap", () => {
    // 8 s wanted, the card starts 5 s after the clip.
    const t = clipSpeedTiming([clip(), card(15)], "clip-1", 0.5, 60, true)!;
    expect(t.startSec).toBe(10);
    expect(t.endSec).toBeCloseTo(14.95, 9);
  });

  it("caps at MAX_SCENE_SEC (15 s) from the start", () => {
    // 10 s at 0.5x is 20 s played.
    const long = clip({ props: { src: "clips/a.webm", durationSec: 10, speed: 1 }, endSec: 20 });
    expect(clipSpeedTiming([long], "clip-1", 0.5, 60, true)).toEqual({ startSec: 10, endSec: 25 });
  });

  it("stops at the video's end, like an edge drag", () => {
    expect(clipSpeedTiming([clip()], "clip-1", 0.5, 16, true)).toEqual({ startSec: 10, endSec: 16 });
  });

  it("a plain take after the clip is not a neighbour — takes re-derive around it", () => {
    const take = { id: "take-1", kind: "plain", layout: "full-bleed", startSec: 14, endSec: 30 } as SceneCue;
    expect(clipSpeedTiming([clip(), take], "clip-1", 0.5, 60, true)).toEqual({ startSec: 10, endSec: 18 });
  });

  it("4 s at 4x plays 1 s: the clip's length wins over the 1.2 s floor, pinned or not", () => {
    // The floor used to stretch a pinned one to 1.2 s (a held last frame)
    // while an unpinned one played 1 s; a block is never longer than its clip.
    const pinned = clipSpeedTiming([clip(), card(30)], "clip-1", 4, 60, true)!;
    const doc = OverrideDocSchema.parse({ scenes: { "clip-1": { props: { speed: 4 } } } });
    const unpinned = applyOverrides([clip(), card(30)], doc).cues[0]!;
    expect(pinned).toEqual({ startSec: 10, endSec: 11 });
    expect(unpinned.startSec).toBe(10);
    expect(unpinned.endSec).toBeCloseTo(11, 9);
  });

  it("unpinned is null: applyOverrides re-derives that window from the speed prop", () => {
    expect(clipSpeedTiming([clip()], "clip-1", 2, 60, false)).toBeNull();
  });

  it("is null for a card, a split half, a scene it cannot find, and no video length", () => {
    const tc = { ...card(10), id: "clip-1" } as SceneCue;
    expect(clipSpeedTiming([tc], "clip-1", 2, 60, true)).toBeNull();
    expect(clipSpeedTiming([clip({ id: "clip-1@s1" })], "clip-1@s1", 2, 60, true)).toBeNull();
    expect(clipSpeedTiming([clip()], "nope", 2, 60, true)).toBeNull();
    expect(clipSpeedTiming([clip()], "clip-1", 2, 0, true)).toBeNull();
  });

  it("gives the window applyOverrides gives the same clip unpinned (cap and neighbour gap)", () => {
    // The two paths a speed edit can take must not give one clip two
    // lengths where both apply: the neighbour cut and the 15 s cap.
    for (const [durationSec, speed, next] of [
      [4, 0.5, 15],
      [10, 0.5, 60],
      [4, 2, 60],
    ] as const) {
      const base = clip({ props: { src: "clips/a.webm", durationSec, speed: 1 }, endSec: 10 + durationSec });
      const cues = [base, card(next)];
      const doc = OverrideDocSchema.parse({ scenes: { "clip-1": { props: { speed } } } });
      const unpinned = applyOverrides(cues, doc).cues[0]!;
      const pinned = clipSpeedTiming(cues, "clip-1", speed, 120, true)!;
      expect(pinned.startSec).toBe(unpinned.startSec);
      expect(pinned.endSec).toBeCloseTo(unpinned.endSec, 9);
    }
  });
});

describe("clampTiming: a clip block is never longer than its clip", () => {
  // A 4 s clip at 2x (2 s played) at 10..12, a card at 20, a 60 s video.
  const clip: SceneCue = {
    id: "clip-1",
    kind: "graphic",
    layout: "full-bleed",
    component: "ClipScene",
    props: { src: "clips/a.webm", durationSec: 4, speed: 2 },
    startSec: 10,
    endSec: 12,
  };
  const before = { id: "card-0", kind: "graphic", layout: "video-top", component: "TitleCard", startSec: 2, endSec: 5 } as SceneCue;
  const after = { id: "card-1", kind: "graphic", layout: "video-top", component: "TitleCard", startSec: 20, endSec: 23 } as SceneCue;
  const cues = [before, clip, after];

  it("an end-edge drag past the played length stops there", () => {
    expect(clampTiming(cues, "clip-1", 10, 18, 60)).toEqual({ startSec: 10, endSec: 12 });
  });

  it("a start-edge drag earlier stops where the block would outgrow the clip; the end stays", () => {
    // Trimmed to 10.5..12 first, then the start dragged to 7.
    const trimmed = [before, { ...clip, startSec: 10.5 }, after];
    expect(clampTiming(trimmed, "clip-1", 7, 12, 60)).toEqual({ startSec: 10, endSec: 12 });
  });

  it("a drag shorter than the played length is allowed", () => {
    expect(clampTiming(cues, "clip-1", 10, 11.5, 60)).toEqual({ startSec: 10, endSec: 11.5 });
    expect(clampTiming(cues, "clip-1", 10.4, 12, 60)).toEqual({ startSec: 10.4, endSec: 12 });
  });

  it("a card is unaffected", () => {
    const card = { ...clip, component: "TitleCard", props: { title: "HI" } } as SceneCue;
    expect(clampTiming([before, card, after], "clip-1", 10, 18, 60)).toEqual({ startSec: 10, endSec: 18 });
  });

  it("the floor never pushes a clip past its played length", () => {
    // 4 s at 4x plays 1 s: a drag to 0.6 s is floored at 1 s, not 1.2.
    const fast = { ...clip, props: { ...clip.props, speed: 4 }, endSec: 11 } as SceneCue;
    expect(clampTiming([before, fast, after], "clip-1", 10, 10.6, 60)).toEqual({ startSec: 10, endSec: 11 });
    expect(clampTiming([before, fast, after], "clip-1", 10, 14, 60)).toEqual({ startSec: 10, endSec: 11 });
  });
});
