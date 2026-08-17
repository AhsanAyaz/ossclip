import { describe, expect, it } from "vitest";
import type { FaceBox } from "@ossclip/core";
import { FACE_MIN_DETECTION_RATIO, FACE_ONLY_MIN_FRAC } from "@ossclip/core";
import { faceSubject } from "../src/produce";

/**
 * The global subject classification behind `face.subject` in render-props.
 * The matrix is the 2026-08-16 incident's fix: the whole-take 9-sample
 * median landed on a camera PiP (sizeFrac 0.119, bottom-right of a screen
 * recording) and pinned the stage's objectPosY to 1.0, so the top of the
 * picture — the speaker's head in full-frame stretches — was never shown.
 * Whether a measured face may steer the cover has to be decided by the same
 * rule the per-segment framing plan uses (`segmentIsFaceOnly`), or the two
 * would disagree about who the subject is.
 */
const box = (
  sizeFrac: number,
  framesDetected = 9,
  framesSampled = 9,
): FaceBox => ({
  // The incident PiP's measured position — the values themselves are inert
  // here, classification reads only size and detection confidence.
  centerXFrac: 0.88,
  centerYFrac: 0.76,
  sizeFrac,
  framesDetected,
  framesSampled,
});

describe("faceSubject", () => {
  it("the incident PiP (sizeFrac 0.119) is not the subject", () => {
    expect(faceSubject(box(0.119))).toBe("screen");
  });

  it("a real talking head (sizeFrac 0.28) is", () => {
    expect(faceSubject(box(0.28))).toBe("face");
  });

  it("no face at all means the picture is the subject", () => {
    expect(faceSubject(null)).toBe("screen");
  });

  it("a face the detector barely ever saw does not steer the cover", () => {
    // Head-sized but found in 3 of 9 looks — as likely a false positive or a
    // glance at a webcam as a subject.
    expect(faceSubject(box(0.28, 3, 9))).toBe("screen");
  });

  it("zero sampled frames cannot claim confidence", () => {
    expect(faceSubject(box(0.28, 0, 0))).toBe("screen");
  });

  it("the thresholds are inclusive on the face side, mirroring segmentIsFaceOnly", () => {
    // Exactly AT the size floor and the detection ratio is a face; a hair
    // under either is not — same comparisons as the per-segment rule, so the
    // global and per-segment classifications can never disagree at the edge.
    expect(faceSubject(box(FACE_ONLY_MIN_FRAC))).toBe("face");
    expect(faceSubject(box(FACE_ONLY_MIN_FRAC - 0.001))).toBe("screen");
    const atRatio = Math.round(FACE_MIN_DETECTION_RATIO * 10);
    expect(faceSubject(box(0.28, atRatio, 10))).toBe("face");
    expect(faceSubject(box(0.28, atRatio - 1, 10))).toBe("screen");
  });
});
