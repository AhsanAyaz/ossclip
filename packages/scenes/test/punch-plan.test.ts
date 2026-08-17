import { describe, expect, it } from "vitest";
import { punchPropsFor, punchScalesFor } from "../src/punch-plan";

/**
 * The face-only jump-cut punch (2026-08-16, Task 6), scenes side: how
 * EdlVideo's per-span scales come out of a render-props `punch` plan — and,
 * just as load-bearing, how they come out WITHOUT one. Absent/malformed must
 * reproduce the legacy 1.07-everywhere behavior exactly, or every
 * pre-feature workdir re-renders differently. Span fixture mirrors
 * export-premiere-project.test.ts's punchScales case (the two loops are
 * documented lockstep): gaps 0.1 (below threshold — no toggle), 0.2
 * (toggle), 0.15 (inclusive >= — toggle), 0.3 (toggle).
 */

const SPANS = [
  { srcIn: 0, srcOut: 2 },
  { srcIn: 2.1, srcOut: 4 },
  { srcIn: 4.2, srcOut: 6 },
  { srcIn: 6.15, srcOut: 8 },
  { srcIn: 8.3, srcOut: 10 },
];

describe("punchScalesFor", () => {
  it("no plan is the legacy contract: punchInScale on every alternating span", () => {
    expect(punchScalesFor(SPANS, null, 1.07, 0.15)).toEqual([1, 1, 1.07, 1, 1.07]);
  });

  it("a masked span renders 1 on its punched turn without re-phasing its neighbours", () => {
    // Span 2 is masked, span 4 still punches: the toggle flipped across
    // span 2's gap regardless of the mask (stable indexing), so masking one
    // span can never change WHICH other spans punch.
    expect(
      punchScalesFor(SPANS, { scale: 1.015, allowed: [true, true, false, true, true] }, 1.07, 0.15),
    ).toEqual([1, 1, 1, 1, 1.015]);
  });

  it("a mask shorter than the spans reads as allowed — matching the plan-less default", () => {
    expect(
      punchScalesFor(SPANS, { scale: 1.015, allowed: [true, true] }, 1.07, 0.15),
    ).toEqual([1, 1, 1.015, 1, 1.015]);
  });

  it("an all-false mask (produce's off mode) holds every span at 1", () => {
    expect(
      punchScalesFor(SPANS, { scale: 1, allowed: SPANS.map(() => false) }, 1.07, 0.15),
    ).toEqual([1, 1, 1, 1, 1]);
  });

  it("the plan's scale replaces punchInScale entirely, not multiplies it", () => {
    const scales = punchScalesFor(
      SPANS,
      { scale: 1.015, allowed: SPANS.map(() => true) },
      1.07,
      0.15,
    );
    expect(scales[2]).toBe(1.015);
  });
});

describe("punchPropsFor", () => {
  it("passes a well-formed plan through", () => {
    expect(punchPropsFor({ scale: 1.015, allowed: [true, false] })).toEqual({
      scale: 1.015,
      allowed: [true, false],
    });
  });

  it("absent means legacy — every pre-feature render-props has no punch key", () => {
    expect(punchPropsFor(undefined)).toBeNull();
  });

  it("a hand-mangled plan falls back to legacy rather than scaling by garbage", () => {
    // showWatermark's posture: render-props is user-visible and
    // hand-editable, and values from outside are parsed, never coerced.
    expect(punchPropsFor(null)).toBeNull();
    expect(punchPropsFor("1.015")).toBeNull();
    expect(punchPropsFor({ scale: "1.015", allowed: [true] })).toBeNull();
    expect(punchPropsFor({ scale: Number.NaN, allowed: [true] })).toBeNull();
    expect(punchPropsFor({ scale: 0, allowed: [true] })).toBeNull();
    expect(punchPropsFor({ scale: -1.015, allowed: [true] })).toBeNull();
    expect(punchPropsFor({ scale: 1.015 })).toBeNull();
    expect(punchPropsFor({ scale: 1.015, allowed: "all" })).toBeNull();
    expect(punchPropsFor({ scale: 1.015, allowed: [true, "no"] })).toBeNull();
  });
});
