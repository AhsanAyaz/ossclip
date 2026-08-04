import { describe, expect, it } from "vitest";
import { guideSnap, type SafeArea } from "../src/guides";
import type { GraphicRect } from "../src/useEdits";

// Portrait-shaped safe area (matches SAFE_AREA in packages/scenes/src/stage.ts)
// — the exact numbers don't matter, only that the four edges are distinct
// from each other and from the 0.5 centre lines.
const SAFE: SafeArea = { top: 0.12, bottom: 0.22, left: 0.04, right: 0.16 };
const THRESHOLD = 0.02;

/**
 * The rect fields are float ARITHMETIC (a target minus a feature, applied to
 * an input) — `toEqual` on the whole rect is brittle against IEEE 754 noise
 * a few ULPs wide (0.34 vs 0.33999999999999997). `guides` carries no
 * arithmetic (every `at` is a `target` value passed straight through from
 * `safe`/0.5), so it's compared exactly.
 */
function expectRectCloseTo(actual: GraphicRect, expected: GraphicRect): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.w).toBeCloseTo(expected.w, 9);
  expect(actual.h).toBeCloseTo(expected.h, 9);
}

describe("guideSnap — move (each candidate, each axis)", () => {
  it("snaps the rect's centre-x to the frame's vertical centre line", () => {
    const rect: GraphicRect = { x: 0.39, y: 0.5, w: 0.2, h: 0.1 };
    const { rect: out, guides } = guideSnap(rect, "move", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.4, y: 0.5, w: 0.2, h: 0.1 });
    expect(guides).toEqual([{ axis: "x", at: 0.5 }]);
  });

  it("snaps the rect's left edge to the safe area's left edge", () => {
    const rect: GraphicRect = { x: 0.041, y: 0.5, w: 0.2, h: 0.1 };
    const { rect: out, guides } = guideSnap(rect, "move", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.04, y: 0.5, w: 0.2, h: 0.1 });
    expect(guides).toEqual([{ axis: "x", at: 0.04 }]);
  });

  it("snaps the rect's right edge to the safe area's right edge", () => {
    const rect: GraphicRect = { x: 0.639, y: 0.5, w: 0.2, h: 0.1 };
    const { rect: out, guides } = guideSnap(rect, "move", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.64, y: 0.5, w: 0.2, h: 0.1 });
    expect(guides).toEqual([{ axis: "x", at: 0.84 }]);
  });

  it("snaps the rect's centre-y to the frame's horizontal centre line", () => {
    const rect: GraphicRect = { x: 0.5, y: 0.39, w: 0.1, h: 0.2 };
    const { rect: out, guides } = guideSnap(rect, "move", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.5, y: 0.4, w: 0.1, h: 0.2 });
    expect(guides).toEqual([{ axis: "y", at: 0.5 }]);
  });

  it("snaps the rect's top edge to the safe area's top edge", () => {
    const rect: GraphicRect = { x: 0.5, y: 0.121, w: 0.1, h: 0.2 };
    const { rect: out, guides } = guideSnap(rect, "move", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.5, y: 0.12, w: 0.1, h: 0.2 });
    expect(guides).toEqual([{ axis: "y", at: 0.12 }]);
  });

  it("snaps the rect's bottom edge to the safe area's bottom edge", () => {
    const rect: GraphicRect = { x: 0.5, y: 0.579, w: 0.1, h: 0.2 };
    const { rect: out, guides } = guideSnap(rect, "move", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.5, y: 0.58, w: 0.1, h: 0.2 });
    expect(guides).toEqual([{ axis: "y", at: 0.78 }]);
  });
});

describe("guideSnap — move vs resize semantics", () => {
  it("a resize handle ignores the centre candidate a move would have snapped to", () => {
    // w = 0.918 puts the centre EXACTLY on 0.5 (a move drag would snap
    // there, distance 0) while the left edge sits 0.001 from safe.left —
    // farther than the centre, so a move drag would pick the centre. A
    // resize drag on the "w" handle must ignore the centre candidate
    // entirely and snap only the dragged (left) edge, keeping the right
    // edge anchored in place.
    const rect: GraphicRect = { x: 0.041, y: 0.5, w: 0.918, h: 0.1 };
    const { rect: out, guides } = guideSnap(rect, "w", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.04, y: 0.5, w: 0.919, h: 0.1 });
    expect(guides).toEqual([{ axis: "x", at: 0.04 }]);
  });

  it("resize snaps only the edge(s) the handle drags — right edge only for 'e'", () => {
    const rect: GraphicRect = { x: 0.5, y: 0.3, w: 0.339, h: 0.02 };
    const { rect: out, guides } = guideSnap(rect, "e", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.5, y: 0.3, w: 0.34, h: 0.02 });
    expect(guides).toEqual([{ axis: "x", at: 0.84 }]);
  });

  it("resize snaps only the edge(s) the handle drags — top edge only for 'n'", () => {
    const rect: GraphicRect = { x: 0.5, y: 0.121, w: 0.1, h: 0.2 };
    const { rect: out, guides } = guideSnap(rect, "n", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.5, y: 0.12, w: 0.1, h: 0.201 });
    expect(guides).toEqual([{ axis: "y", at: 0.12 }]);
  });

  it("resize snaps only the edge(s) the handle drags — bottom edge only for 's'", () => {
    const rect: GraphicRect = { x: 0.5, y: 0.579, w: 0.1, h: 0.2 };
    const { rect: out, guides } = guideSnap(rect, "s", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.5, y: 0.579, w: 0.1, h: 0.201 });
    expect(guides).toEqual([{ axis: "y", at: 0.78 }]);
  });

  it("a corner handle snaps both edges it drags, one guide per axis", () => {
    const rect: GraphicRect = { x: 0.041, y: 0.121, w: 0.2, h: 0.2 };
    const { rect: out, guides } = guideSnap(rect, "nw", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.04, y: 0.12, w: 0.201, h: 0.201 });
    expect(guides).toEqual([
      { axis: "x", at: 0.04 },
      { axis: "y", at: 0.12 },
    ]);
  });
});

describe("guideSnap — threshold boundary", () => {
  it("snaps at exactly the threshold distance", () => {
    // centre-x distance is exactly THRESHOLD (0.02): 0.43 + 0.05 = 0.48,
    // |0.48 - 0.5| = 0.02. y is kept far from every candidate.
    const rect: GraphicRect = { x: 0.43, y: 0, w: 0.1, h: 0.01 };
    const { rect: out, guides } = guideSnap(rect, "move", SAFE, THRESHOLD);
    expectRectCloseTo(out, { x: 0.45, y: 0, w: 0.1, h: 0.01 });
    expect(guides).toEqual([{ axis: "x", at: 0.5 }]);
  });
});

describe("guideSnap — passthrough", () => {
  it("returns the rect unchanged and no guides when nothing is within threshold", () => {
    const rect: GraphicRect = { x: 0.3, y: 0.3, w: 0.1, h: 0.1 };
    expect(guideSnap(rect, "move", SAFE, THRESHOLD)).toEqual({
      rect: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 },
      guides: [],
    });
  });
});

describe("guideSnap — one guide per axis", () => {
  it("picks the nearer of two simultaneous hits on the same axis, never both", () => {
    // w = 0.9: centre-x sits 0.01 from 0.5, the left edge sits 0.02 from
    // safe.left — both within a widened threshold, centre nearer. Only ONE
    // guide (the winner) may come back for the x axis.
    const rect: GraphicRect = { x: 0.06, y: 0.3, w: 0.9, h: 0.02 };
    const wideThreshold = 0.1;
    const { rect: out, guides } = guideSnap(rect, "move", SAFE, wideThreshold);
    expect(guides.filter((g) => g.axis === "x")).toHaveLength(1);
    expectRectCloseTo(out, { x: 0.05, y: 0.3, w: 0.9, h: 0.02 });
    expect(guides).toEqual([{ axis: "x", at: 0.5 }]);
  });

  it("picks the edge when it's nearer than the centre", () => {
    const rect: GraphicRect = { x: 0.02, y: 0.3, w: 0.9, h: 0.02 };
    const wideThreshold = 0.1;
    const { guides } = guideSnap(rect, "move", SAFE, wideThreshold);
    expect(guides.filter((g) => g.axis === "x")).toHaveLength(1);
    expect(guides).toEqual([{ axis: "x", at: 0.04 }]);
  });
});
