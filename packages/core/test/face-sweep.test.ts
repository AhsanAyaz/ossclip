import { describe, expect, it } from "vitest";
import {
  ROTATION_SWEEP_DEG,
  bestDetectionWithSweep,
  rotateGray,
  rotatePointBack,
} from "../src/face";

const W = 200;
const H = 200;

/** A mid-grey frame with a bright T-shaped marker: a square with a dark bar
 * across its top. Orientation-sensitive by construction — the toy classifier
 * below only fires when the bar is ABOVE the square. */
function frameWithMarker(cy: number, cx: number, size = 100): Uint8Array {
  const px = new Uint8Array(W * H).fill(128);
  const half = size / 2;
  for (let y = Math.round(cy - half); y < cy + half; y++) {
    for (let x = Math.round(cx - half); x < cx + half; x++) {
      if (y < 0 || y >= H || x < 0 || x >= W) continue;
      const dy = y - cy;
      // Dark bar across the top edge of an otherwise bright square.
      px[y * W + x] = dy < -0.25 * size && dy > -0.35 * size ? 20 : 230;
    }
  }
  return px;
}

/**
 * Toy classifier, same signature as the cascade: fires only when the dark bar
 * sits ABOVE a bright centre with bright flanks — i.e. only on an UPRIGHT
 * marker. This lets the sweep machinery be tested for real (rotation, scale
 * walk, mapping back) without needing face imagery.
 */
function classifyUprightMarker(
  r: number,
  c: number,
  s: number,
  pixels: Uint8Array,
  ldim: number,
): number {
  const at = (rr: number, cc: number): number => {
    const y = Math.round(rr);
    const x = Math.round(cc);
    return y >= 0 && y < H && x >= 0 && x < W ? pixels[y * ldim + x]! : 0;
  };
  // Three collinear samples along the bar: only a HORIZONTAL bar darkens all
  // three, so a tilted marker cannot satisfy this — the point of the toy.
  const top = at(r - 0.3 * s, c);
  const topL = at(r - 0.3 * s, c - 0.3 * s);
  const topR = at(r - 0.3 * s, c + 0.3 * s);
  const bottom = at(r + 0.3 * s, c);
  const left = at(r, c - 0.3 * s);
  const right = at(r, c + 0.3 * s);
  return top < 60 && topL < 60 && topR < 60 && bottom > 200 && left > 200 && right > 200
    ? 10
    : -1;
}

const PARAMS = { shiftfactor: 0.1, minsize: 60, maxsize: 160, scalefactor: 1.1 };

describe("rotateGray / rotatePointBack", () => {
  it("rotating by 0° is the identity", () => {
    const px = frameWithMarker(100, 100);
    expect(rotateGray(px, W, H, 0)).toEqual(px);
  });

  it("a detection in the rotated frame maps back to the source position", () => {
    // Property: rotateGray samples source at rotatePointBack(output) — so the
    // brightest pixel of a rotated single-dot frame must map back to the dot.
    const px = new Uint8Array(W * H).fill(0);
    px[60 * W + 140] = 255;
    for (const deg of [-40, -20, 20, 40, 90]) {
      const rot = rotateGray(px, W, H, deg);
      const i = rot.indexOf(255);
      expect(i, `dot lost at ${deg}°`).toBeGreaterThanOrEqual(0);
      const { r, c } = rotatePointBack(Math.floor(i / W), i % W, W, H, deg);
      expect(Math.abs(r - 60), `row at ${deg}°`).toBeLessThanOrEqual(1.5);
      expect(Math.abs(c - 140), `col at ${deg}°`).toBeLessThanOrEqual(1.5);
    }
  });
});

describe("rotation sweep (PLAN Task 8)", () => {
  it("finds an upright marker without touching the sweep", () => {
    const hit = bestDetectionWithSweep(frameWithMarker(100, 100), H, W, classifyUprightMarker, PARAMS);
    expect(hit).not.toBeNull();
    expect(hit!.angleDeg).toBe(0);
    expect(Math.abs(hit!.det[0] - 100)).toBeLessThan(12);
    expect(Math.abs(hit!.det[1] - 100)).toBeLessThan(12);
  });

  it("recovers a tilted marker the upright pass misses — the Task 8 case", () => {
    // The source has the marker tilted 40°: the upright classifier cannot see
    // it, exactly like a tilted head and the frontal cascade.
    const tilted = rotateGray(frameWithMarker(100, 100), W, H, 40);
    expect(bestDetectionWithSweep(tilted, H, W, classifyUprightMarker, PARAMS, [])).toBeNull();

    const hit = bestDetectionWithSweep(tilted, H, W, classifyUprightMarker, PARAMS);
    expect(hit).not.toBeNull();
    expect(Math.abs(hit!.angleDeg)).toBe(40);
    // …and the centre is reported in the ORIGINAL frame's coordinates.
    expect(Math.abs(hit!.det[0] - 100)).toBeLessThan(12);
    expect(Math.abs(hit!.det[1] - 100)).toBeLessThan(12);
  });

  it("maps an off-centre tilted marker back through the rotation", () => {
    const tilted = rotateGray(frameWithMarker(70, 120, 90), W, H, -20);
    const hit = bestDetectionWithSweep(tilted, H, W, classifyUprightMarker, PARAMS);
    expect(hit).not.toBeNull();
    // Where did the marker centre LAND in the tilted frame? Same transform.
    const moved = (() => {
      // rotateGray(src, deg) places source point p at the output position o
      // with rotatePointBack(o) = p — invert by rotating the point the other way.
      const { r, c } = rotatePointBack(70, 120, W, H, 20);
      return { r, c };
    })();
    expect(Math.abs(hit!.det[0] - moved.r)).toBeLessThan(12);
    expect(Math.abs(hit!.det[1] - moved.c)).toBeLessThan(12);
  });

  it("the sweep stays a fallback — never overrides an upright hit", () => {
    // Upright marker AND the sweep enabled: angle must still be 0, so a clean
    // frontal take never pays the sweep cost or risks a worse rotated match.
    const hit = bestDetectionWithSweep(frameWithMarker(100, 100), H, W, classifyUprightMarker, PARAMS);
    expect(hit!.angleDeg).toBe(0);
  });

  it("covers tilt in both directions out to ±40°", () => {
    expect(ROTATION_SWEEP_DEG).toContain(-40);
    expect(ROTATION_SWEEP_DEG).toContain(40);
    expect(ROTATION_SWEEP_DEG.some((d) => d < 0 && d > -25)).toBe(true);
    expect(ROTATION_SWEEP_DEG.some((d) => d > 0 && d < 25)).toBe(true);
  });
});
