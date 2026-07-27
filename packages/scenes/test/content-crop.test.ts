import { describe, expect, it } from "vitest";
import {
  contentCoverBox,
  contentRectAtOutput,
  sourceTimeAt,
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
