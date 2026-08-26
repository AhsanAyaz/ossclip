import { describe, expect, it } from "vitest";
import {
  COVER_IN_VIDEO_FADE_FRAMES,
  coverInVideoFrames,
  coverInVideoOpacity,
  coverInVideoPropsFor,
} from "../src/cover-in-video";
import { frameWindow } from "../src/frames";

/**
 * The cover overlay's gate, frame math and fade. Pure by design (the package
 * carries no jsdom — CoverInVideo.tsx renders inside Remotion's frame
 * context), so what is asserted here is what decides whether the layer mounts
 * at all and which frames it covers.
 */
describe("coverInVideoPropsFor", () => {
  it("accepts a well-formed overlay", () => {
    expect(coverInVideoPropsFor({ fileName: "cover-in-video/cover.jpg", durationSec: 0.4 })).toEqual(
      { fileName: "cover-in-video/cover.jpg", durationSec: 0.4 },
    );
  });

  // ABSENT MEANS OFF: every pre-feature render-props.json has no key, and
  // those renders must come out byte-identical to what they always were.
  it("mounts nothing when the field is absent", () => {
    expect(coverInVideoPropsFor(undefined)).toBeNull();
    expect(coverInVideoPropsFor(null)).toBeNull();
  });

  // Parse, never coerce (CLAUDE.md): render-props.json is hand-editable, and
  // a mangled entry must fall back to no overlay rather than mount an
  // undefined src or a NaN-frame Sequence over the hook.
  it("refuses a malformed entry instead of coercing one", () => {
    expect(coverInVideoPropsFor({ durationSec: 0.4 })).toBeNull();
    expect(coverInVideoPropsFor({ fileName: "", durationSec: 0.4 })).toBeNull();
    expect(coverInVideoPropsFor({ fileName: 42, durationSec: 0.4 })).toBeNull();
    expect(coverInVideoPropsFor({ fileName: "c.jpg" })).toBeNull();
    expect(coverInVideoPropsFor({ fileName: "c.jpg", durationSec: "0.4" })).toBeNull();
    expect(coverInVideoPropsFor({ fileName: "c.jpg", durationSec: Number.NaN })).toBeNull();
    expect(coverInVideoPropsFor({ fileName: "c.jpg", durationSec: 0 })).toBeNull();
    expect(coverInVideoPropsFor({ fileName: "c.jpg", durationSec: -1 })).toBeNull();
    expect(coverInVideoPropsFor("cover.jpg")).toBeNull();
  });
});

describe("coverInVideoFrames", () => {
  it("always starts at frame 0 — the whole point is frame 1", () => {
    expect(coverInVideoFrames(0.5, 30).from).toBe(0);
  });

  // FINDINGS §115: the end frame comes from the end TIME through frameWindow,
  // so the overlay's last frame and the first uncovered frame are never the
  // same one. Pinned against frameWindow itself, the shared rounding rule.
  it("rounds the end from the end time (§115)", () => {
    for (const [durationSec, fps] of [
      [0.5, 30],
      [0.2, 30],
      [0.37, 60],
      [0.25, 24],
    ] as const) {
      expect(coverInVideoFrames(durationSec, fps)).toEqual(frameWindow(0, durationSec, fps));
    }
    // 0.5s at 30fps is 15 frames: 0–14 covered, 15 is the first clean frame.
    expect(coverInVideoFrames(0.5, 30)).toEqual({ from: 0, durationInFrames: 15 });
    // 0.2s at 24fps rounds to 5, not 4.8 truncated.
    expect(coverInVideoFrames(0.2, 24)).toEqual({ from: 0, durationInFrames: 5 });
  });

  it("never renders a zero-length window", () => {
    expect(coverInVideoFrames(0.001, 30).durationInFrames).toBe(1);
  });
});

describe("coverInVideoOpacity", () => {
  it("holds solid until the fade starts", () => {
    const d = 15;
    for (let f = 0; f <= d - COVER_IN_VIDEO_FADE_FRAMES; f++) {
      expect(coverInVideoOpacity(f, d)).toBe(1);
    }
  });

  it("ramps down over the last frames so the cut does not pop", () => {
    const d = 15;
    expect(coverInVideoOpacity(12, d)).toBeCloseTo(0.75, 6);
    expect(coverInVideoOpacity(13, d)).toBeCloseTo(0.5, 6);
    expect(coverInVideoOpacity(14, d)).toBeCloseTo(0.25, 6);
  });

  // A window shorter than the fade must still start fully opaque: a cover
  // that is never solid reads as a rendering fault, not a transition.
  it("fades across what it has when the window is shorter than the fade", () => {
    expect(coverInVideoOpacity(0, 2)).toBe(1);
    expect(coverInVideoOpacity(1, 2)).toBeCloseTo(0.5, 6);
    expect(coverInVideoOpacity(0, 1)).toBe(1);
  });

  it("clamps outside the window instead of going negative", () => {
    expect(coverInVideoOpacity(20, 15)).toBe(0);
  });
});
