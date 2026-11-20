import { describe, expect, it } from "vitest";
import { STAT_COUNT_SEC, statCountText } from "../src/components/StatCard";

/**
 * StatCard's count-up (§161, plan Task 8): the explainer look's motion
 * only, for values `parseCount` reproduces exactly, starting once the
 * card's entrance has settled (15 frames at 30 fps = 0.5 s).
 */
const FPS = 30;
const START = 0.5;

describe("statCountText", () => {
  it("is null under the classic look, whatever the value", () => {
    for (const t of [0, 0.7, 5]) expect(statCountText("4,494", t, FPS, false)).toBeNull();
  });

  it("is null for a value it could not end on exactly", () => {
    for (const v of ["×3", "5 min", "007", "1,23"]) expect(statCountText(v, 1, FPS, true)).toBeNull();
  });

  it("holds at zero through the entrance, counts for one second, then rests on the source", () => {
    expect(statCountText("4,494", 0, FPS, true)).toBe("0");
    expect(statCountText("4,494", START, FPS, true)).toBe("0");
    // easeOutQuad(0.5) = 0.75: 4494 × 0.75 = 3370.5, floored.
    expect(statCountText("4,494", START + 0.5, FPS, true)).toBe("3,370");
    expect(statCountText("4,494", START + STAT_COUNT_SEC, FPS, true)).toBe("4,494");
    expect(statCountText("4,494", 9, FPS, true)).toBe("4,494");
  });

  it("keeps the sign and suffix on every frame", () => {
    expect(statCountText("+242%", START + 0.5, FPS, true)).toBe("+181%");
    expect(statCountText("+242%", START + STAT_COUNT_SEC, FPS, true)).toBe("+242%");
  });
});
