import { describe, expect, it } from "vitest";
import { coverKeepFraction } from "../src/produce";

/**
 * The cover-crop loss warning's arithmetic. The matrix under test is the
 * whole point of the 2026-08-16 fix: the old warning was gated on
 * `!landscape` and only ever measured width loss, so a 1.547:1 screen
 * recording cover-cropped into a 16:9 frame lost 13% of its height (28%
 * post-normalization) without a word. Orientation must be an input to the
 * math, never a gate in front of it.
 */
describe("coverKeepFraction", () => {
  it("landscape source in a portrait frame loses width (the original warning's case)", () => {
    const r = coverKeepFraction({ width: 1920, height: 1080 }, { width: 1080, height: 1920 });
    expect(r?.axis).toBe("width");
    // frameAspect / contentAspect = 0.5625 / 1.7778 — a talking-head crop
    // keeps under a third of the recorded picture.
    expect(r?.kept).toBeCloseTo(0.316, 3);
  });

  it("the 2026-08-16 incident: 3456x2234 in a 16:9 frame loses height, and says so", () => {
    const r = coverKeepFraction({ width: 3456, height: 2234 }, { width: 1920, height: 1080 });
    expect(r?.axis).toBe("height");
    // contentAspect / frameAspect = 1.547 / 1.778 ≈ 87% kept — under the
    // 0.95 warning threshold, so the run now announces the trim out loud.
    expect(r?.kept).toBeCloseTo(0.87, 2);
    expect(r!.kept).toBeLessThan(0.95);
  });

  it("matching aspects trim nothing and stay silent", () => {
    expect(
      coverKeepFraction({ width: 3840, height: 2160 }, { width: 1920, height: 1080 }),
    ).toBeNull();
    expect(
      coverKeepFraction({ width: 1080, height: 1920 }, { width: 1080, height: 1920 }),
    ).toBeNull();
  });

  it("degenerate dimensions make no claim", () => {
    expect(coverKeepFraction({ width: 0, height: 1080 }, { width: 1080, height: 1920 })).toBeNull();
    expect(coverKeepFraction({ width: 1920, height: 0 }, { width: 1080, height: 1920 })).toBeNull();
    expect(coverKeepFraction({ width: 1920, height: 1080 }, { width: 0, height: 0 })).toBeNull();
    expect(
      coverKeepFraction({ width: -1920, height: 1080 }, { width: 1080, height: 1920 }),
    ).toBeNull();
  });

  it("near-matching aspects fall inside the 0.95 threshold the call site applies", () => {
    // A 1.7:1 phone recording in a 16:9 frame: kept ≈ 0.956 — a trim nobody
    // would notice, and the warning would only be noise.
    const r = coverKeepFraction({ width: 1700, height: 1000 }, { width: 1920, height: 1080 });
    expect(r?.axis).toBe("height");
    expect(r!.kept).toBeGreaterThan(0.95);
  });
});
