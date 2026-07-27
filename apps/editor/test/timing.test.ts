import { describe, expect, it } from "vitest";
import { clampTiming } from "../src/timing";
import type { SceneCue } from "@ossclip/core/browser";

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
