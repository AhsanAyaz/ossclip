import { describe, expect, it } from "vitest";
import { laplacianVariance, scoreCandidate } from "../src/cover";

/** A flat grey frame — no edges at all. */
const flat = (w: number, h: number) => new Uint8Array(w * h).fill(128);
/** Hard vertical stripes — maximum edge energy. */
const stripes = (w: number, h: number) =>
  Uint8Array.from({ length: w * h }, (_, i) => ((i % w) % 2 === 0 ? 0 : 255));
/** The same stripes blurred — what a frame caught mid-motion looks like. */
const blurred = (w: number, h: number) =>
  Uint8Array.from({ length: w * h }, (_, i) => 128 + 40 * Math.sin(((i % w) / w) * Math.PI * 4));

describe("cover frame scoring (FINDINGS §31)", () => {
  it("ranks sharp frames above blurred ones, and blurred above flat", () => {
    const sharp = laplacianVariance(stripes(64, 64), 64, 64);
    const soft = laplacianVariance(blurred(64, 64), 64, 64);
    const none = laplacianVariance(flat(64, 64), 64, 64);
    expect(sharp).toBeGreaterThan(soft);
    expect(soft).toBeGreaterThan(none);
    expect(none).toBeCloseTo(0, 6);
  });

  it("a face outranks sharpness — a cover without the speaker is the wrong cover", () => {
    const withFace = scoreCandidate({
      timeSec: 5, durationSec: 10, sharpness: 10, hasFace: true, maxSharpness: 100,
    });
    const sharperNoFace = scoreCandidate({
      timeSec: 5, durationSec: 10, sharpness: 100, hasFace: false, maxSharpness: 100,
    });
    expect(withFace).toBeGreaterThan(sharperNoFace);
  });

  it("among faces, the sharper frame wins", () => {
    const base = { timeSec: 5, durationSec: 10, hasFace: true, maxSharpness: 100 };
    expect(scoreCandidate({ ...base, sharpness: 90 })).toBeGreaterThan(
      scoreCandidate({ ...base, sharpness: 20 }),
    );
  });

  it("earlier frames break ties, so the cover matches the opening", () => {
    const base = { durationSec: 10, sharpness: 50, hasFace: true, maxSharpness: 100 };
    expect(scoreCandidate({ ...base, timeSec: 1 })).toBeGreaterThan(
      scoreCandidate({ ...base, timeSec: 9 }),
    );
  });
});
