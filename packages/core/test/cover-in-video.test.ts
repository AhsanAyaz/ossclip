import { describe, expect, it } from "vitest";
import {
  COVER_IN_VIDEO_CAP_SEC,
  COVER_IN_VIDEO_FLOOR_SEC,
  coverInVideoWindow,
} from "../src/cover-in-video";

/**
 * `--cover-in-video`'s window derivation. The matrix IS the contract: the
 * overlay ends at the first word because that is when it starts costing the
 * hook, and both bounds exist to stop it being either a glitch-length flash
 * or a title card nobody asked for.
 */
const BOUNDS = { capSec: COVER_IN_VIDEO_CAP_SEC, floorSec: COVER_IN_VIDEO_FLOOR_SEC };

describe("coverInVideoWindow", () => {
  it("ends at the first word's output start when it falls between the bounds", () => {
    expect(coverInVideoWindow([{ start: 0.35 }, { start: 0.9 }], BOUNDS)).toBeCloseTo(0.35, 6);
  });

  it("caps a late first word — the overlay never eats half a second of hook", () => {
    expect(coverInVideoWindow([{ start: 4 }], BOUNDS)).toBe(COVER_IN_VIDEO_CAP_SEC);
  });

  it("floors an immediate first word instead of flashing for two frames", () => {
    expect(coverInVideoWindow([{ start: 0.04 }], BOUNDS)).toBe(COVER_IN_VIDEO_FLOOR_SEC);
    // A word at exactly 0 is a real value, not a missing one.
    expect(coverInVideoWindow([{ start: 0 }], BOUNDS)).toBe(COVER_IN_VIDEO_FLOOR_SEC);
  });

  it("takes the cap when there are no words at all", () => {
    // A silent take, or a run with no transcript: nothing for the overlay to
    // be in the way of, so it gets its full allowance.
    expect(coverInVideoWindow([], BOUNDS)).toBe(COVER_IN_VIDEO_CAP_SEC);
  });

  // The words come off a transcript on disk; a mangled stamp must land on the
  // safe bound, never propagate a NaN into a frame count.
  it("takes the cap on a non-finite first stamp", () => {
    expect(coverInVideoWindow([{ start: Number.NaN }], BOUNDS)).toBe(COVER_IN_VIDEO_CAP_SEC);
    expect(coverInVideoWindow([{ start: Number.POSITIVE_INFINITY }], BOUNDS)).toBe(
      COVER_IN_VIDEO_CAP_SEC,
    );
  });

  it("reads the FIRST word only — a later word can never widen the window", () => {
    expect(coverInVideoWindow([{ start: 0.25 }, { start: 0.05 }], BOUNDS)).toBeCloseTo(0.25, 6);
  });

  it("honours caller-supplied bounds", () => {
    expect(coverInVideoWindow([{ start: 1.2 }], { capSec: 1, floorSec: 0.1 })).toBe(1);
    expect(coverInVideoWindow([{ start: 0.02 }], { capSec: 1, floorSec: 0.1 })).toBe(0.1);
  });

  it("keeps the shipped bounds where the comments claim they are", () => {
    expect(COVER_IN_VIDEO_CAP_SEC).toBe(0.5);
    expect(COVER_IN_VIDEO_FLOOR_SEC).toBe(0.2);
  });
});
