import { describe, expect, it } from "vitest";
import {
  contentCoverBox,
  contentRectAtOutput,
  sourceTimeAt,
  sourceFitBox,
} from "../src/content-crop";

const SOURCE = { width: 1440, height: 2560 };
/** The author's clip: a landscape strip inside a portrait can. */
const STRIP = { x: 0, y: 876, w: 1440, h: 808 };
const FULL = { x: 0, y: 0, w: 1440, h: 2560 };

/** What the returned box makes visible in the slot, back in source pixels. */
function visibleRect(box: ReturnType<typeof contentCoverBox>, slot: { width: number; height: number }) {
  const k = box.width / SOURCE.width;
  return {
    x: -box.left / k,
    y: -box.top / k,
    w: slot.width / k,
    h: slot.height / k,
  };
}

describe("contentCoverBox", () => {
  const slot = { width: 1080, height: 806 }; // a `video-top` slot

  it("a full-frame rect behaves exactly like plain object-fit: cover", () => {
    const box = contentCoverBox(SOURCE, FULL, slot);
    const k = Math.max(slot.width / SOURCE.width, slot.height / SOURCE.height);
    expect(box.width).toBeCloseTo(SOURCE.width * k, 6);
    expect(box.height).toBeCloseTo(SOURCE.height * k, 6);
    // Centred overflow, which is what object-position: 50% 50% does.
    expect(box.left).toBeCloseTo((slot.width - SOURCE.width * k) / 2, 6);
  });

  it("never leaves a gap — the rect always covers the slot", () => {
    for (const s of [
      { width: 1080, height: 806 },
      { width: 1080, height: 1920 },
      { width: 500, height: 1200 },
    ]) {
      const box = contentCoverBox(SOURCE, STRIP, s);
      const vis = visibleRect(box, s);
      // Everything the slot shows lies inside the content rect.
      expect(vis.x).toBeGreaterThanOrEqual(STRIP.x - 1e-6);
      expect(vis.y).toBeGreaterThanOrEqual(STRIP.y - 1e-6);
      expect(vis.x + vis.w).toBeLessThanOrEqual(STRIP.x + STRIP.w + 1e-6);
      expect(vis.y + vis.h).toBeLessThanOrEqual(STRIP.y + STRIP.h + 1e-6);
    }
  });

  it("shows NO bar for the letterboxed strip — the whole point", () => {
    const box = contentCoverBox(SOURCE, STRIP, slot);
    const vis = visibleRect(box, slot);
    // The bars live above y=876 and below y=1684; neither is on screen.
    expect(vis.y).toBeGreaterThanOrEqual(876 - 1e-6);
    expect(vis.y + vis.h).toBeLessThanOrEqual(1684 + 1e-6);
  });

  it("does not distort — the box keeps the source's aspect ratio", () => {
    const box = contentCoverBox(SOURCE, STRIP, slot);
    expect(box.width / box.height).toBeCloseTo(SOURCE.width / SOURCE.height, 9);
  });

  it("spends the overflow according to the bias, like object-position", () => {
    const top = contentCoverBox(SOURCE, STRIP, { width: 1080, height: 1920 }, 0, 0);
    const bottom = contentCoverBox(SOURCE, STRIP, { width: 1080, height: 1920 }, 1, 1);
    // A landscape strip in a tall slot overflows horizontally, so the bias
    // moves the window across the strip.
    expect(top.left).toBeGreaterThan(bottom.left);
  });

  it("a degenerate rect cannot produce a NaN box", () => {
    const box = contentCoverBox(SOURCE, { x: 0, y: 0, w: 0, h: 0 }, slot, NaN, NaN);
    for (const v of [box.width, box.height, box.left, box.top]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("sourceTimeAt", () => {
  const spans = [
    { outIn: 0, outOut: 5, srcIn: 0, srcOut: 5 },
    { outIn: 5, outOut: 9, srcIn: 12, srcOut: 16 },
  ];

  it("maps through the kept spans, not 1:1", () => {
    expect(sourceTimeAt(spans, 2)).toBe(2);
    expect(sourceTimeAt(spans, 6)).toBe(13);
  });

  it("with no cuts output time IS source time", () => {
    expect(sourceTimeAt([{ outIn: 0, outOut: 60, srcIn: 0, srcOut: 60 }], 33)).toBe(33);
    expect(sourceTimeAt([], 33)).toBe(33);
  });

  it("clamps past the end rather than falling off", () => {
    expect(sourceTimeAt(spans, 99)).toBe(16);
    expect(sourceTimeAt(spans, -1)).toBe(0);
  });
});

describe("contentRectAtOutput", () => {
  const timeline = [
    { startSec: 0, endSec: 2.5, rect: { ...STRIP, full: false } },
    { startSec: 2.5, endSec: 14.5, rect: { ...FULL, full: true } },
  ];
  const spans = [{ outIn: 0, outOut: 14.5, srcIn: 0, srcOut: 14.5 }];

  it("picks the rect active at that moment of the take", () => {
    expect(contentRectAtOutput(timeline, spans, 1, SOURCE).full).toBe(false);
    expect(contentRectAtOutput(timeline, spans, 8, SOURCE).full).toBe(true);
  });

  it("an empty timeline is the full frame — never a crash", () => {
    expect(contentRectAtOutput([], spans, 8, SOURCE)).toMatchObject({ full: true, w: 1440 });
  });
});

import { contentBox, contentFitBox } from "../src/content-crop";

describe("contentFitBox (option (b) — the inset fallback)", () => {
  const source = { width: 1440, height: 2560 };
  const strip = { x: 0, y: 1100, w: 1440, h: 300 };
  const slot = { width: 1080, height: 1920 };

  it("insets the rect whole — nothing cropped, nothing fake-zoomed", () => {
    const box = contentFitBox(source, strip, slot);
    const k = box.width / source.width;
    // The strip fits inside the slot on both axes…
    expect(strip.w * k).toBeLessThanOrEqual(slot.width + 1e-6);
    expect(strip.h * k).toBeLessThanOrEqual(slot.height + 1e-6);
    // …and binds on one of them (largest fit, not arbitrary shrink).
    expect(Math.max(strip.w * k - slot.width, strip.h * k - slot.height)).toBeCloseTo(0, 6);
  });

  it("centres the rect in the slot", () => {
    const box = contentFitBox(source, strip, slot);
    const k = box.width / source.width;
    const left = box.left + strip.x * k;
    const top = box.top + strip.y * k;
    expect(left).toBeCloseTo((slot.width - strip.w * k) / 2, 6);
    expect(top).toBeCloseTo((slot.height - strip.h * k) / 2, 6);
  });

  it("contentBox dispatches: fit ignores the face bias, cover spends it", () => {
    const fit = contentBox("fit", source, strip, slot, 0.1, 0.9);
    expect(fit).toEqual(contentFitBox(source, strip, slot));
    const cover = contentBox("cover", source, strip, slot, 0.1, 0.9);
    expect(cover).not.toEqual(fit);
  });
});

describe("sourceFitBox (--source-fit contain)", () => {
  const slot = { width: 1080, height: 1920 };

  it("shows a 16:9 source whole: full width, centred, nothing cropped", () => {
    const box = sourceFitBox({ width: 1920, height: 1080 }, slot);
    // Width-bound against a portrait slot: the picture spans the full width…
    expect(box.width).toBeCloseTo(1080, 6);
    expect(box.height).toBeCloseTo(607.5, 6);
    // …and is centred, so the inset margins are equal.
    expect(box.left).toBeCloseTo(0, 6);
    expect(box.top).toBeCloseTo((1920 - 607.5) / 2, 6);
    // Every pixel of the source is inside the slot — that IS "don't crop it".
    expect(box.width).toBeLessThanOrEqual(slot.width + 1e-6);
    expect(box.height).toBeLessThanOrEqual(slot.height + 1e-6);
  });

  it("keeps the source's aspect, so the video's own cover has nothing left to crop", () => {
    for (const source of [
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { width: 1440, height: 1080 },
    ]) {
      const box = sourceFitBox(source, slot);
      expect(box.width / box.height).toBeCloseTo(source.width / source.height, 6);
    }
  });

  it("is a no-op shape for a source already the slot's aspect", () => {
    const box = sourceFitBox({ width: 1080, height: 1920 }, slot);
    expect(box).toEqual({ width: 1080, height: 1920, left: 0, top: 0 });
  });

  it("agrees with contentFitBox given a full-frame rect — one geometry, two names", () => {
    const source = { width: 1920, height: 1080 };
    expect(sourceFitBox(source, slot)).toEqual(
      contentFitBox(source, { x: 0, y: 0, w: source.width, h: source.height }, slot),
    );
  });
});

import { activeCropBox, framingWindowAtOutput } from "../src/content-crop";
import type { FramingSegment } from "@ossclip/core";

describe("framingWindowAtOutput + activeCropBox (2026-08-16 non-destructive framing)", () => {
  const slot = { width: 1080, height: 1920 };
  const noCuts = [{ outIn: 0, outOut: 20, srcIn: 0, srcOut: 20 }];
  /** A "screen" plan whose window IS the frame — the plan that changes nothing. */
  const screenSeg: FramingSegment = {
    startSec: 0,
    endSec: 20,
    window: { x: 0, y: 0, w: SOURCE.width, h: SOURCE.height },
    subject: "screen",
    bias: { x: 0.5, y: 0.5 },
  };

  it("a screen full-rect window renders identical to plain centred cover", () => {
    // The props-based successor to the destructive normalization bake must
    // reduce to the untouched path when the plan asks for nothing: a full
    // window, centred. The 0.2/0.9 stage face bias below is deliberately NOT
    // 0.5 — the plan's own bias wins, so it must not leak into the box.
    const viaFraming = activeCropBox(
      [screenSeg], undefined, noCuts, 3, SOURCE, "cover", slot, 0.2, 0.9,
    );
    expect(viaFraming).toEqual(contentCoverBox(SOURCE, FULL, slot));
  });

  it("a face window covers the slot with the head at its bias point", () => {
    const window = { x: 200, y: 300, w: 900, h: 1280 };
    const seg: FramingSegment = {
      startSec: 0, endSec: 20, window, subject: "face", bias: { x: 0.4, y: 0.3 },
    };
    const box = activeCropBox([seg], undefined, noCuts, 1, SOURCE, "cover", slot, 0.5, 0.5)!;
    // Same math as handing the window straight to contentCoverBox with the
    // segment's bias as the anchor fractions…
    expect(box).toEqual(contentCoverBox(SOURCE, window, slot, 0.4, 0.3));
    // …and concretely: cover scale k = max(1080/900, 1920/1280) = 1.5, so the
    // slot shows a 720px-wide window of the 900px rect. The 180px of leftover
    // window width is spent at bias.x = 0.4:
    const k = box.width / SOURCE.width;
    expect(k).toBeCloseTo(1.5, 9);
    const visibleX = -box.left / k;
    expect(visibleX).toBeCloseTo(window.x + (window.w - slot.width / k) * 0.4, 6);
    // Vertically the window fits exactly, so nothing depends on bias.y here.
    expect(-box.top / k).toBeCloseTo(window.y, 6);
  });

  it("framingTimeline wins over contentTimeline when both are present", () => {
    const contentTimeline = [
      { startSec: 0, endSec: 2.5, rect: { ...STRIP, full: false } },
      { startSec: 2.5, endSec: 14.5, rect: { ...FULL, full: true } },
    ];
    const window = { x: 100, y: 900, w: 1200, h: 700 };
    const framing: FramingSegment[] = [
      { startSec: 0, endSec: 20, window, subject: "face", bias: { x: 0.5, y: 0.5 } },
    ];
    // At t=1 the content timeline says STRIP; the plan's window wins anyway —
    // it was computed FROM that timeline and already accounts for the bars.
    const both = activeCropBox(framing, contentTimeline, noCuts, 1, SOURCE, "cover", slot, 0.5, 0.5);
    expect(both).toEqual(contentCoverBox(SOURCE, window, slot, 0.5, 0.5));
    expect(both).not.toEqual(contentBox("cover", SOURCE, STRIP, slot, 0.5, 0.5));
    // At t=8 the content rect is FULL (the legacy passthrough) — the plan
    // still applies rather than falling back to null.
    expect(
      activeCropBox(framing, contentTimeline, noCuts, 8, SOURCE, "cover", slot, 0.5, 0.5),
    ).toEqual(contentCoverBox(SOURCE, window, slot, 0.5, 0.5));
    // Without the plan the same call is the pre-existing content-crop path.
    expect(
      activeCropBox(undefined, contentTimeline, noCuts, 1, SOURCE, "cover", slot, 0.5, 0.5),
    ).toEqual(contentBox("cover", SOURCE, STRIP, slot, 0.5, 0.5));
  });

  it("no plan, a uniform timeline, or a missing sourceSize is the legacy passthrough", () => {
    // null = the byte-identical inset:0 box every existing render-props takes.
    expect(activeCropBox(undefined, undefined, noCuts, 1, SOURCE, "cover", slot, 0.5, 0.5)).toBeNull();
    // A single-segment content timeline means uniform framing — ffmpeg already
    // cropped it into the mezzanine, and cropping again would trim twice.
    const uniform = [{ startSec: 0, endSec: 20, rect: { ...STRIP, full: false } }];
    expect(activeCropBox(undefined, uniform, noCuts, 1, SOURCE, "cover", slot, 0.5, 0.5)).toBeNull();
    // Both paths window the SOURCE frame; without its size there is nothing
    // to window, plan or not.
    expect(activeCropBox([screenSeg], undefined, noCuts, 1, undefined, "cover", slot, 0.5, 0.5)).toBeNull();
    expect(activeCropBox([], [], noCuts, 1, SOURCE, "cover", slot, 0.5, 0.5)).toBeNull();
  });

  it("maps through the kept spans and clamps at the timeline's edges, like contentRectAtOutput", () => {
    const a: FramingSegment = {
      startSec: 5, endSec: 10,
      window: { x: 0, y: 0, w: 720, h: 1280 }, subject: "face", bias: { x: 0.5, y: 0.5 },
    };
    const b: FramingSegment = {
      startSec: 10, endSec: 15,
      window: { x: 700, y: 0, w: 720, h: 1280 }, subject: "face", bias: { x: 0.5, y: 0.5 },
    };
    const spans = [
      { outIn: 0, outOut: 3, srcIn: 6, srcOut: 9 },
      { outIn: 3, outOut: 6, srcIn: 11, srcOut: 14 },
    ];
    // Output 1 → source 7 (segment a); output 4 → source 12 (segment b).
    expect(framingWindowAtOutput([a, b], spans, 1)).toBe(a);
    expect(framingWindowAtOutput([a, b], spans, 4)).toBe(b);
    // Outside the timeline: clamp to the nearest segment, never flash the
    // unframed picture for a boundary rounding error.
    expect(framingWindowAtOutput([a, b], [], 0)).toBe(a);
    expect(framingWindowAtOutput([a, b], [], 99)).toBe(b);
    // No plan at all is null — the legacy passthrough, not a synthetic window.
    expect(framingWindowAtOutput([], spans, 1)).toBeNull();
  });
});
