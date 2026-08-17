import { describe, expect, it } from "vitest";
import {
  FACE_MIN_DETECTION_RATIO,
  FACE_ONLY_MIN_FRAC,
  type FramingSegment,
  type KeptSpan,
  type WindowFace,
} from "@ossclip/core";
import {
  spanFaceCacheKey,
  spanFaceMask,
  spanFaceMaskFromFaces,
  spanFaceWindows,
} from "../src/produce";

/**
 * The ONE per-span subject mask both motion drivers share (F1, user decision
 * 2026-08-16: "Face-only. If there's anything else, then no zoom"). The
 * jump-cut punch (`punchPlanFor.allowed`) and the idle zoom
 * (`buildZoomPlan.allowedClips`) both consume this exact array — the
 * complaint behind the rule was the idle push sliding screen-recording
 * content that the punch guard already protected, i.e. the two drivers
 * disagreeing about who the subject is. The matrix here pins the verdict
 * source: the framing timeline's per-segment subject at each span's SOURCE
 * in-point when a plan exists, the whole-take `faceSubject` verdict when not.
 */

const spans: KeptSpan[] = [
  { srcIn: 1, srcOut: 6, outIn: 0, outOut: 5 },
  { srcIn: 8, srcOut: 12, outIn: 5, outOut: 9 },
  { srcIn: 20, srcOut: 24, outIn: 9, outOut: 13 },
];

const seg = (
  startSec: number,
  endSec: number,
  subject: "face" | "screen",
): FramingSegment => ({
  startSec,
  endSec,
  window: { x: 0, y: 0, w: 1920, h: 1080 },
  subject,
  bias: { x: 0.5, y: 0.5 },
});

describe("spanFaceMask", () => {
  it("no timeline: every span shares the global verdict", () => {
    expect(spanFaceMask(spans, null, "face")).toEqual([true, true, true]);
    expect(spanFaceMask(spans, null, "screen")).toEqual([false, false, false]);
  });

  it("a mixed timeline gates per span by the subject at the span's source IN-point", () => {
    // Face until 10s, screen after — span 2 STARTS at 8s (face) even though
    // most of it plays over the screen stretch: the frame at the cut is what
    // the motion drivers scale.
    const timeline = [seg(0, 10, "face"), seg(10, 30, "screen")];
    expect(spanFaceMask(spans, timeline, "screen")).toEqual([true, true, false]);
  });

  it("with a timeline the GLOBAL verdict is ignored — per-segment evidence wins", () => {
    const timeline = [seg(0, 30, "screen")];
    expect(spanFaceMask(spans, timeline, "face")).toEqual([false, false, false]);
  });

  it("an EMPTY timeline reads as screen — framingSubjectAt's no-evidence rule, no punch and no zoom", () => {
    expect(spanFaceMask(spans, [], "face")).toEqual([false, false, false]);
  });

  it("no spans, no verdicts — parallel arrays stay parallel", () => {
    expect(spanFaceMask([], null, "face")).toEqual([]);
  });
});

/**
 * The MEASURED no-plan path (2026-08-16 v2 review): a screen recording with
 * full-frame webcam stretches has uniform content rects — no framing plan —
 * and the flat global fallback above let the whole-take PiP verdict strip
 * punch concealment and idle zoom from the face-only stretches. These pin
 * the pure halves of the fix; the ffmpeg sampling itself stays out of tests.
 */
describe("spanFaceWindows", () => {
  it("maps each kept span to its SOURCE range over the full frame", () => {
    expect(spanFaceWindows(spans)).toEqual([
      { startSec: 1, endSec: 6, cropVf: "" },
      { startSec: 8, endSec: 12, cropVf: "" },
      { startSec: 20, endSec: 24, cropVf: "" },
    ]);
  });

  it("no spans, no windows", () => {
    expect(spanFaceWindows([])).toEqual([]);
  });
});

describe("spanFaceMaskFromFaces", () => {
  const face = (over: Partial<WindowFace> = {}): WindowFace => ({
    centerXFrac: 0.5,
    centerYFrac: 0.4,
    sizeFrac: 0.35,
    sizeFracMax: 0.45,
    framesDetected: 8,
    framesSampled: 8,
    ...over,
  });

  it("applies core's segmentIsFaceOnly rule per span — the same verdict a framing plan would give", () => {
    expect(
      spanFaceMaskFromFaces([
        face(), // full-frame webcam stretch: face-only
        null, // pure screen content: no face at all
        // The incident's PiP: a face, but far below the face-only floor.
        face({ sizeFrac: 0.119, sizeFracMax: 0.13 }),
      ]),
    ).toEqual([true, false, false]);
  });

  it("the floor and the detection ratio both gate, exactly at core's constants", () => {
    expect(
      spanFaceMaskFromFaces([
        face({ sizeFrac: FACE_ONLY_MIN_FRAC }), // at the floor: face-only
        face({ sizeFrac: FACE_ONLY_MIN_FRAC - 0.01 }), // under it: screen
        // Seen in too few samples to trust, however large it measured.
        face({
          framesDetected: Math.ceil(10 * FACE_MIN_DETECTION_RATIO) - 1,
          framesSampled: 10,
        }),
      ]),
    ).toEqual([true, false, false]);
  });

  it("no faces, no verdicts — parallel arrays stay parallel", () => {
    expect(spanFaceMaskFromFaces([])).toEqual([]);
  });
});

describe("spanFaceCacheKey", () => {
  it("changes when the cut changes and when the source changes — never collides across either", () => {
    const base = spanFaceCacheKey(spans, "abcd1234");
    const recut = spanFaceCacheKey(
      [{ ...spans[0]!, srcOut: 5.5 }, ...spans.slice(1)],
      "abcd1234",
    );
    const otherTake = spanFaceCacheKey(spans, "ffff0000");
    expect(recut).not.toBe(base);
    expect(otherTake).not.toBe(base);
  });

  it("ignores OUTPUT times — only the source ranges were measured", () => {
    const shifted = spans.map((sp) => ({ ...sp, outIn: sp.outIn + 3, outOut: sp.outOut + 3 }));
    expect(spanFaceCacheKey(shifted, "abcd1234")).toBe(spanFaceCacheKey(spans, "abcd1234"));
  });
});
