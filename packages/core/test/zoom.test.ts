import { describe, expect, it } from "vitest";
import { ZOOM_MAX_SCALE, ZOOM_RAMP_SEC, buildZoomPlan, zoomScaleAt } from "../src/zoom";

/**
 * The contract this file guards changed on 2026-07-28, on the author's report:
 * "the weird constant zooming in and zooming out".
 *
 * The old driver reversed direction at every speech-phrase boundary. On a real
 * 64s take that found 24 boundaries and produced 24 reversals — the camera
 * breathed in and out for the whole video. The replacement moves in ONE
 * direction per cut-free clip: ramp 1 → maxScale, then HOLD. A cut resets it,
 * where the existing punch-in already justifies a step.
 *
 * The tests below are therefore mostly about what must NEVER happen again
 * (a reversal inside a clip), not about where boundaries land.
 */

const DURATION = 64;

/** Sample the plan densely — a reversal narrower than this would be a twitch. */
function samples(segments: Parameters<typeof zoomScaleAt>[0], duration: number, step = 0.05) {
  const out: Array<{ t: number; s: number }> = [];
  for (let t = 0; t <= duration + 1e-9; t += step) out.push({ t, s: zoomScaleAt(segments, t) });
  return out;
}

describe("one intentional move per clip", () => {
  it("never reverses inside a clip — the whole point of the rework", () => {
    // A single cut-free take, exactly the author's case (0 cuts).
    const plan = buildZoomPlan(DURATION, { clipStarts: [0] });
    const seq = samples(plan.segments, DURATION);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!.s).toBeGreaterThanOrEqual(seq[i - 1]!.s - 1e-9);
    }
  });

  it("reaches full scale by the ramp and then holds it", () => {
    const plan = buildZoomPlan(DURATION, { clipStarts: [0] });
    expect(zoomScaleAt(plan.segments, ZOOM_RAMP_SEC)).toBeCloseTo(ZOOM_MAX_SCALE, 6);
    // Held, not drifting, for the rest of the clip.
    for (const t of [ZOOM_RAMP_SEC + 1, DURATION / 2, DURATION - 0.01]) {
      expect(zoomScaleAt(plan.segments, t)).toBeCloseTo(ZOOM_MAX_SCALE, 6);
    }
  });

  it("starts at the original perspective, not already pushed in", () => {
    const plan = buildZoomPlan(DURATION, { clipStarts: [0] });
    expect(zoomScaleAt(plan.segments, 0)).toBeCloseTo(1, 6);
  });

  it("a cut resets to 1 and the next clip ramps again", () => {
    const plan = buildZoomPlan(40, { clipStarts: [0, 20] });
    expect(zoomScaleAt(plan.segments, 20)).toBeCloseTo(1, 6);
    expect(zoomScaleAt(plan.segments, 20 + ZOOM_RAMP_SEC)).toBeCloseTo(ZOOM_MAX_SCALE, 6);
    // Each clip is independently monotonic. The clip is half-open: t === 20
    // belongs to the SECOND clip, so sampling it here would read the reset as
    // a decrease inside the first.
    for (const [a, b] of [[0, 20], [20, 40]] as const) {
      const seq: number[] = [];
      for (let t = a; t < b - 1e-9; t += 0.05) seq.push(zoomScaleAt(plan.segments, t));
      for (let i = 1; i < seq.length; i++) {
        expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]! - 1e-9);
      }
    }
  });

  it("a clip shorter than the ramp keeps the same RATE rather than rushing", () => {
    // Two clips: 2s and 20s. The short one must not complete a full push in 2s
    // — that would make short clips zoom visibly faster than long ones.
    const plan = buildZoomPlan(22, { clipStarts: [0, 2] });
    const shortEnd = zoomScaleAt(plan.segments, 2 - 1e-4);
    expect(shortEnd).toBeGreaterThan(1);
    expect(shortEnd).toBeLessThan(ZOOM_MAX_SCALE - 1e-6);
  });
});

describe("zoom plan invariants", () => {
  const plan = buildZoomPlan(DURATION, { clipStarts: [0, 25, 41] });

  it("covers the whole output contiguously with strictly increasing times", () => {
    expect(plan.segments[0]!.startSec).toBe(0);
    expect(plan.segments[plan.segments.length - 1]!.endSec).toBeCloseTo(DURATION, 6);
    for (const seg of plan.segments) expect(seg.endSec).toBeGreaterThan(seg.startSec);
    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i]!.startSec).toBeCloseTo(plan.segments[i - 1]!.endSec, 6);
    }
  });

  it("scale stays within [1, maxScale]", () => {
    for (const { s } of samples(plan.segments, DURATION)) {
      expect(s).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(s).toBeLessThanOrEqual(ZOOM_MAX_SCALE + 1e-9);
    }
  });

  it("is continuous everywhere except at a cut, where the reset is deliberate", () => {
    const cuts = new Set([25, 41]);
    for (const seg of plan.segments) {
      if (cuts.has(seg.startSec)) continue;
      const before = zoomScaleAt(plan.segments, Math.max(0, seg.startSec - 1e-4));
      const after = zoomScaleAt(plan.segments, Math.min(DURATION, seg.startSec + 1e-4));
      expect(Math.abs(after - before)).toBeLessThan(0.002);
    }
  });

  it("reports the clips it planned, so the CLI log can't claim something else", () => {
    expect(plan.clips).toBe(3);
    expect(plan.rampSec).toBe(ZOOM_RAMP_SEC);
  });

  it("outside the plan the scale is exactly 1", () => {
    expect(zoomScaleAt(plan.segments, DURATION + 5)).toBe(1);
    expect(zoomScaleAt([], 3)).toBe(1);
  });

  it("a zero-length output produces no plan at all", () => {
    expect(buildZoomPlan(0, { clipStarts: [0] }).segments).toEqual([]);
  });

  it("no clip starts are given — the take is still treated as one clip", () => {
    const p = buildZoomPlan(30, {});
    expect(p.clips).toBe(1);
    expect(zoomScaleAt(p.segments, 0)).toBeCloseTo(1, 6);
    expect(zoomScaleAt(p.segments, ZOOM_RAMP_SEC)).toBeCloseTo(ZOOM_MAX_SCALE, 6);
  });

  it("clip starts out of order or out of range don't corrupt the plan", () => {
    const p = buildZoomPlan(30, { clipStarts: [20, -5, 0, 99, 10] });
    expect(p.clips).toBe(3); // 0, 10, 20
    expect(p.segments[0]!.startSec).toBe(0);
    expect(p.segments[p.segments.length - 1]!.endSec).toBeCloseTo(30, 6);
  });

  it("zoom can be disabled outright — the author's 'no zoom' option", () => {
    const p = buildZoomPlan(30, { clipStarts: [0], maxScale: 1 });
    for (const { s } of samples(p.segments, 30)) expect(s).toBeCloseTo(1, 9);
  });
});

/**
 * Face-only gating (user decision 2026-08-16: "Face-only. If there's
 * anything else, then no zoom"). The complaint was the idle push visibly
 * SLIDING screen-recording content — so a clip whose subject is not a face
 * emits NO segments, and `zoomScaleAt`'s "1 outside the plan" contract makes
 * the hole render as a static camera with zero downstream changes.
 */
describe("allowedClips gating", () => {
  it("an allowed clip still ramps and holds; a disallowed one emits nothing", () => {
    const plan = buildZoomPlan(40, { clipStarts: [0, 20], allowedClips: [true, false] });
    expect(zoomScaleAt(plan.segments, ZOOM_RAMP_SEC)).toBeCloseTo(ZOOM_MAX_SCALE, 6);
    expect(zoomScaleAt(plan.segments, 19.99)).toBeCloseTo(ZOOM_MAX_SCALE, 6);
    // No segment claims the disallowed clip's range at all.
    expect(plan.segments.every((s) => s.endSec <= 20 + 1e-9)).toBe(true);
    for (const t of [20.01, 24, 28, 39.99]) {
      expect(zoomScaleAt(plan.segments, t)).toBe(1);
    }
  });

  it("an INTERIOR disallowed clip is 1 from its very first instant — the reset must not arrive a frame late", () => {
    const plan = buildZoomPlan(60, {
      clipStarts: [0, 20, 40],
      allowedClips: [true, false, true],
    });
    // Half-open matching: t=20 belongs to the (segment-free) static clip.
    expect(zoomScaleAt(plan.segments, 20)).toBe(1);
    expect(zoomScaleAt(plan.segments, 30)).toBe(1);
    // The clip after the hole ramps independently.
    expect(zoomScaleAt(plan.segments, 40)).toBeCloseTo(1, 6);
    expect(zoomScaleAt(plan.segments, 40 + ZOOM_RAMP_SEC)).toBeCloseTo(ZOOM_MAX_SCALE, 6);
  });

  it("every clip disallowed emits an empty plan and the scale is 1 everywhere", () => {
    const plan = buildZoomPlan(30, { clipStarts: [0, 10], allowedClips: [false, false] });
    expect(plan.segments).toEqual([]);
    for (const { s } of samples(plan.segments, 30)) expect(s).toBe(1);
    expect(plan.zoomedClips).toBe(0);
    expect(plan.staticClips).toBe(2);
  });

  it("reports the zoomed/static split so the CLI log can't claim something else", () => {
    const plan = buildZoomPlan(60, {
      clipStarts: [0, 20, 40],
      allowedClips: [true, false, true],
    });
    expect(plan.clips).toBe(3);
    expect(plan.zoomedClips).toBe(2);
    expect(plan.staticClips).toBe(1);
  });

  it("an ABSENT mask is byte-identical to an all-true one — pre-mask callers unchanged", () => {
    const bare = buildZoomPlan(DURATION, { clipStarts: [0, 25, 41] });
    const allTrue = buildZoomPlan(DURATION, {
      clipStarts: [0, 25, 41],
      allowedClips: [true, true, true],
    });
    expect(allTrue).toEqual(bare);
    expect(bare.zoomedClips).toBe(3);
    expect(bare.staticClips).toBe(0);
  });

  it("a mask SHORTER than clipStarts reads missing entries as allowed — pinned", () => {
    const plan = buildZoomPlan(30, { clipStarts: [0, 10, 20], allowedClips: [false] });
    expect(plan.staticClips).toBe(1);
    expect(plan.zoomedClips).toBe(2);
    expect(zoomScaleAt(plan.segments, 5)).toBe(1);
    expect(zoomScaleAt(plan.segments, 10 + ZOOM_RAMP_SEC)).toBeCloseTo(ZOOM_MAX_SCALE, 6);
  });

  it("verdicts pair with their start BEFORE cleaning: duplicated starts OR their verdicts", () => {
    // The dedupe collapses the two 10s into one clip; either pairing vouching
    // "face" keeps the push — losing it on a face clip is the regression.
    const plan = buildZoomPlan(30, {
      clipStarts: [0, 10, 10],
      allowedClips: [true, false, true],
    });
    expect(plan.clips).toBe(2);
    expect(plan.staticClips).toBe(0);
    expect(zoomScaleAt(plan.segments, 10 + ZOOM_RAMP_SEC)).toBeCloseTo(ZOOM_MAX_SCALE, 6);
    // Both pairings disallow → the clip is static.
    const both = buildZoomPlan(30, {
      clipStarts: [0, 10, 10],
      allowedClips: [true, false, false],
    });
    expect(both.staticClips).toBe(1);
    expect(zoomScaleAt(both.segments, 15)).toBe(1);
  });

  it("the t=0 clip takes the verdict of the pair whose start IS 0, else allowed", () => {
    // clipStarts carries an explicit 0 saying "screen" — the first clip
    // holds still.
    const explicit = buildZoomPlan(30, { clipStarts: [0, 15], allowedClips: [false, true] });
    expect(zoomScaleAt(explicit.segments, 5)).toBe(1);
    expect(explicit.staticClips).toBe(1);
    // No pair claims 0 (the boundary is synthetic) — the lead-in clip is
    // allowed, missing-means-allowed applied to a start nobody listed.
    const synthetic = buildZoomPlan(30, { clipStarts: [15], allowedClips: [false] });
    expect(zoomScaleAt(synthetic.segments, ZOOM_RAMP_SEC)).toBeCloseTo(ZOOM_MAX_SCALE, 6);
    expect(zoomScaleAt(synthetic.segments, 20)).toBe(1);
    expect(synthetic.zoomedClips).toBe(1);
    expect(synthetic.staticClips).toBe(1);
  });
});
