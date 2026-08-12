import { describe, expect, it } from "vitest";
import { MIN_KEPT_PAUSE_SEC, keptPauses } from "../src/export-markers";
import type { Production } from "../src/schema";

/**
 * Kept-pause derivation (§142 round 2): the field editor pointed at real
 * pauses in her waveform with no marker on them — pauses the analysis
 * DETECTED but the cut rules kept. `analysis.cuttable` is exactly that pool
 * (no-speech regions after transcript veto); a kept pause is a cuttable
 * region no remove segment overlaps.
 */

function production(overrides: Partial<Production> = {}): Production {
  return {
    version: 1,
    source: {
      path: "/takes/demo.mp4",
      probe: { duration: 60, width: 1080, height: 1920, fps: 30, hasAudio: true },
    },
    cleanup: "standard",
    analysis: {
      silences: [],
      gaps: [],
      breaths: [],
      fillers: [],
      cuttable: [
        { start: 0, end: 1.77 }, // becomes a cut below — excluded
        { start: 10.2, end: 10.6 }, // kept pause, 0.4s — included
        { start: 20, end: 20.1 }, // 0.1s — below the floor
        { start: 30, end: 30.3 }, // exactly 0.3s — included
      ],
    } as Production["analysis"],
    cutlist: [
      { srcIn: 0, srcOut: 1.77, kind: "remove", reason: "silence", confidence: 0.95 },
      { srcIn: 1.77, srcOut: 60, kind: "keep" },
    ],
    render: { width: 1080, height: 1920, fps: 30 },
    ...overrides,
  };
}

describe("keptPauses", () => {
  it("returns detected pauses no remove segment overlaps, at or above the floor", () => {
    expect(keptPauses(production())).toEqual([
      { start: 10.2, end: 10.6 },
      { start: 30, end: 30.3 },
    ]);
  });

  it("a pause PARTIALLY overlapped by a cut is excluded — the cut already marks that region", () => {
    const p = production();
    p.cutlist = [
      { srcIn: 10.4, srcOut: 12, kind: "remove", reason: "silence", confidence: 0.9 },
      { srcIn: 12, srcOut: 60, kind: "keep" },
    ];
    expect(keptPauses(p).find((s) => s.start === 10.2)).toBeUndefined();
  });

  it("floor is 0.25s — sub-frame noise on a 30-minute take would be marker spam", () => {
    expect(MIN_KEPT_PAUSE_SEC).toBe(0.25);
    expect(keptPauses(production()).find((s) => s.start === 20)).toBeUndefined();
  });

  it("absent analysis (or absent cutlist) yields no pauses, not a crash", () => {
    expect(keptPauses(production({ analysis: undefined }))).toEqual([]);
    expect(keptPauses(production({ cutlist: undefined }))).toEqual([
      { start: 0, end: 1.77 },
      { start: 10.2, end: 10.6 },
      { start: 30, end: 30.3 },
    ]);
  });
});
