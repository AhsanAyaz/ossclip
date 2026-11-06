import { describe, expect, it } from "vitest";
import { overlayGeometryFor, overlaysWithoutRoom, type OverlayGeometry } from "../src/overlay-room";

const frame = { width: 1080, height: 1920 };
const fps = 30;
const geometry = (top: number | null, bottom: number | null): OverlayGeometry => ({
  captionTopAt: () => top,
  captionBottomAt: () => bottom,
  graphicRectAt: () => undefined,
});
const cue = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  look: "overlay" as const,
  atSec: 1,
  endSec: 2.5,
  ...extra,
});

describe("overlaysWithoutRoom", () => {
  it("a caption at its default height leaves room above it", () => {
    expect(overlaysWithoutRoom([cue("a")], geometry(0.72, 0.8), frame, fps)).toEqual(new Set());
  });

  // Final review I3: one window spanning a caption moved high and a low one.
  // Neither band fits, so the box collapsed while the pop still played.
  it("captions both high and low over the window leave no room", () => {
    expect(overlaysWithoutRoom([cue("a")], geometry(0.1, 0.9), frame, fps)).toEqual(new Set(["a"]));
  });

  it("a caption moved high leaves the band below it", () => {
    expect(overlaysWithoutRoom([cue("a")], geometry(0.1, 0.2), frame, fps)).toEqual(new Set());
  });

  it("a hand-placed box and a card always show", () => {
    const cues = [
      cue("hand", { rect: { x: 0.3, y: 0.4, w: 0.3, h: 0.2 } }),
      cue("card", { look: "card" as const }),
    ];
    expect(overlaysWithoutRoom(cues, geometry(0.1, 0.9), frame, fps)).toEqual(new Set());
  });
});

describe("overlayGeometryFor", () => {
  it("hidden captions report no caption on screen", () => {
    const line = { start: 0, end: 5, words: [{ text: "hello", start: 0, end: 1 }] };
    const g = overlayGeometryFor({
      captionLines: [line] as never,
      sceneCues: [],
      captionsHidden: true,
      frame,
    });
    expect(g.captionTopAt(1)).toBeNull();
    expect(g.captionBottomAt(1)).toBeNull();
  });
});
