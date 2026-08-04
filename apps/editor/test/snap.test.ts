import { describe, expect, it } from "vitest";
import { applySnap, formatTimecode, snapTargets } from "../src/timing";
import type { SceneCue } from "@ossclip/core/browser";

describe("snapTargets", () => {
  it("includes neighbour cue edges, the playhead, and the clip bounds", () => {
    const cues = [
      { id: "a", startSec: 0, endSec: 5 },
      { id: "b", startSec: 6, endSec: 11 },
      { id: "c", startSec: 12, endSec: 20 },
    ] as SceneCue[];
    // Dragging "b": its own edges (6, 11) must not appear, but a's and c's
    // (0, 5, 12, 20) must, alongside the playhead (15) and the bounds (0, 30)
    // — 0 doubles up here, which is exactly what the dedup pass below covers.
    expect(snapTargets(cues, "b", 15, 30)).toEqual([0, 5, 12, 15, 20, 30]);
  });

  it("excludes the dragged scene's own edges even when no other cue shares them", () => {
    const cues = [
      { id: "a", startSec: 2, endSec: 5 },
      { id: "b", startSec: 6, endSec: 11 },
    ] as SceneCue[];
    const targets = snapTargets(cues, "a", 1, 20);
    expect(targets).not.toContain(2);
    expect(targets).not.toContain(5);
    // ...but the neighbour it could land against is still offered.
    expect(targets).toEqual([0, 1, 6, 11, 20]);
  });

  it("ignores plain (derived filler) cues as targets — same reasoning as stored()", () => {
    const cues = [
      { id: "a", startSec: 0, endSec: 5 },
      { id: "take-0", kind: "plain", layout: "full-bleed", startSec: 5, endSec: 12 },
      { id: "b", startSec: 12, endSec: 16 },
    ] as SceneCue[];
    const targets = snapTargets(cues, "b", 1, 20);
    // The take's own edges are 5 and 12. 5 survives anyway (it's also "a"'s
    // endSec), but 12 has no other source — b's matching startSec is
    // excluded as the dragged scene's own edge. If the plain filter were
    // missing, 12 would leak in via the take's endSec.
    expect(targets).toEqual([0, 1, 5, 20]);
    expect(targets).not.toContain(12);
  });

  it("deduplicates targets within 1e-6", () => {
    const cues = [
      { id: "a", startSec: 0, endSec: 5 },
      { id: "b", startSec: 5.0000001, endSec: 10 },
    ] as SceneCue[];
    const targets = snapTargets(cues, "zzz", -1, 20);
    // 5 and 5.0000001 collapse to one entry; 0 (bound) and 0 (a.startSec)
    // also collapse. Distinct values: 0, ~5, 10, -1(playhead), 20 → sorted
    // ascending, playhead first.
    expect(targets).toHaveLength(5);
    expect(targets[0]).toBe(-1);
    expect(targets[1]).toBe(0);
    expect(targets[2]).toBeCloseTo(5, 5);
  });

  it("keeps two targets distinct when they differ by more than 1e-6", () => {
    const cues = [
      { id: "a", startSec: 0, endSec: 5 },
      { id: "b", startSec: 5.00001, endSec: 10 },
    ] as SceneCue[];
    const targets = snapTargets(cues, "zzz", -1, 20);
    expect(targets).toHaveLength(6);
  });
});

describe("applySnap", () => {
  const targets = [0, 5, 10, 20];

  it("snaps when the nearest target is exactly at the threshold", () => {
    // |6 - 5| === 1 === thresholdSec: "within threshold" is inclusive.
    expect(applySnap(6, targets, 1)).toEqual({ sec: 5, snapped: 5 });
  });

  it("snaps to the nearest target strictly inside the threshold", () => {
    expect(applySnap(9.5, targets, 1)).toEqual({ sec: 10, snapped: 10 });
  });

  it("passes through when every target is outside the threshold", () => {
    // Nearest candidates to 7 are 5 (dist 2) and 10 (dist 3); threshold 1.
    expect(applySnap(7, targets, 1)).toEqual({ sec: 7, snapped: null });
  });

  it("resolves an exact tie to the EARLIER target, deterministically", () => {
    // 10 is equidistant (5) from both 5 and 15.
    expect(applySnap(10, [5, 15], 10)).toEqual({ sec: 5, snapped: 5 });
    // Order of the input array must not change the outcome.
    expect(applySnap(10, [15, 5], 10)).toEqual({ sec: 5, snapped: 5 });
  });

  it("passes through with no targets", () => {
    expect(applySnap(5, [], 1)).toEqual({ sec: 5, snapped: null });
  });

  it("passes through when the threshold is zero or negative", () => {
    expect(applySnap(5, [0, 10], 0)).toEqual({ sec: 5, snapped: null });
    expect(applySnap(5, [0, 10], -1)).toEqual({ sec: 5, snapped: null });
  });
});

describe("formatTimecode", () => {
  it("formats zero", () => {
    expect(formatTimecode(0, 30)).toBe("0:00:00");
  });

  it("formats a sub-second offset", () => {
    expect(formatTimecode(1.5, 30)).toBe("0:01:15");
  });

  it("rolls over minutes", () => {
    expect(formatTimecode(61, 30)).toBe("1:01:00");
  });

  it("floors the frame count instead of rounding — the 29.97 trap", () => {
    // Math.round((0.9999 % 1) * 30) would give 30, i.e. frame 30 of a
    // 30fps clip — a timecode that doesn't exist. Floor keeps it at 29.
    expect(formatTimecode(0.9999, 30)).toBe("0:00:29");
  });

  it("clamps negative seconds to zero", () => {
    expect(formatTimecode(-5, 30)).toBe("0:00:00");
  });

  it("falls back to a seconds-only string when fps <= 0", () => {
    expect(formatTimecode(12.34, 0)).toBe("12.3s");
    expect(formatTimecode(12.34, -1)).toBe("12.3s");
  });

  it("clamps negative seconds even under the fps guard", () => {
    expect(formatTimecode(-5, 0)).toBe("0.0s");
  });

  it("pads the frame field to the fps' own digit width, not a hardcoded 2", () => {
    // 120fps: max legal frame index is 119 (3 digits). floor(0.5 * 120) = 60,
    // which must render "060" — padded to match 119, not "60".
    expect(formatTimecode(1.5, 120)).toBe("0:01:060");
  });

  it("leaves the common 30fps width (2 digits) unchanged", () => {
    expect(formatTimecode(1.5, 30)).toBe("0:01:15");
  });
});
