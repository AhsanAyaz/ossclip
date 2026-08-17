import { describe, expect, it } from "vitest";
import type { FramingSegment, KeptSpan } from "@ossclip/core";
import {
  FACE_PUNCH_SCALE,
  framingSubjectAt,
  jumpCutsFlag,
  punchPlanFor,
  resolveJumpCuts,
} from "../src/produce";

/**
 * The `--add-jump-cuts` / `--no-jump-cuts` tri-state and the face-only punch
 * plan it feeds (plan 2026-08-16, Task 6). The one property everything here
 * pins: the face-only guard holds in EVERY mode, force included — punching a
 * screen share slides its content, which is worse than the jump the punch
 * conceals — so the force flag only exists to beat a future config-off.
 */

const span = (srcIn: number, srcOut: number): KeptSpan => ({
  srcIn,
  srcOut,
  outIn: srcIn,
  outOut: srcOut,
});

const seg = (
  startSec: number,
  endSec: number,
  subject: "face" | "screen",
): FramingSegment => ({
  startSec,
  endSec,
  // Window/bias are inert for the subject lookup — the punch gate reads
  // only who the segment says the subject is.
  window: { x: 0, y: 0, w: 1920, h: 1080 },
  subject,
  bias: { x: 0.5, y: 0.5 },
});

describe("jumpCutsFlag", () => {
  it("reunites commander's two keys into the one tri-state", () => {
    // --add-jump-cuts typed → true (force downstream).
    expect(jumpCutsFlag(true, false)).toBe(true);
    // --no-jump-cuts typed → false (off downstream).
    expect(jumpCutsFlag(undefined, true)).toBe(false);
    // Neither typed → undefined (auto) — commander's jumpCuts VALUE is true
    // here, which is exactly why the caller passes the source verdict.
    expect(jumpCutsFlag(undefined, false)).toBeUndefined();
  });

  it("typing both flags is a loud contradiction, not a precedence rule", () => {
    expect(() => jumpCutsFlag(true, true)).toThrow(/--add-jump-cuts.*--no-jump-cuts/);
  });
});

describe("resolveJumpCuts", () => {
  it("maps the tri-state flag onto the mode", () => {
    expect(resolveJumpCuts(undefined)).toBe("auto");
    expect(resolveJumpCuts(true)).toBe("force");
    expect(resolveJumpCuts(false)).toBe("off");
  });

  it("composes with jumpCutsFlag across the whole typed matrix", () => {
    expect(resolveJumpCuts(jumpCutsFlag(true, false))).toBe("force");
    expect(resolveJumpCuts(jumpCutsFlag(undefined, true))).toBe("off");
    expect(resolveJumpCuts(jumpCutsFlag(undefined, false))).toBe("auto");
  });
});

describe("punchPlanFor", () => {
  const spans = [span(0, 5), span(6, 10), span(11, 15)];

  it("auto punches face-only spans at the minimal scale and never screen spans", () => {
    const plan = punchPlanFor(spans, "auto", [true, false, true]);
    // 1.015, not the legacy 1.07 (user decision 2026-08-16, "minimal, ~1%"):
    // the 7% punch slid screen content and lurched even on faces.
    expect(plan.scale).toBe(FACE_PUNCH_SCALE);
    expect(plan.scale).toBe(1.015);
    expect(plan.allowed).toEqual([true, false, true]);
  });

  it("force KEEPS the face-only guard — a screen span is never punched", () => {
    expect(punchPlanFor(spans, "force", [false, true, false])).toEqual({
      scale: FACE_PUNCH_SCALE,
      allowed: [false, true, false],
    });
  });

  it("off zeroes the scale and emits a full all-false mask, never an absent one", () => {
    // An ABSENT punch key is the legacy 1.07-everywhere contract — the
    // opposite of off — so the off mode must still emit a complete mask.
    expect(punchPlanFor(spans, "off", [true, true, true])).toEqual({
      scale: 1,
      allowed: [false, false, false],
    });
  });

  it("a subject verdict missing for a span reads as not-face — the guard's safe side", () => {
    expect(punchPlanFor(spans, "auto", [true]).allowed).toEqual([true, false, false]);
  });
});

describe("framingSubjectAt", () => {
  const timeline = [seg(0, 10, "face"), seg(10, 25, "screen"), seg(25, 30, "face")];

  it("answers with the segment containing the source time", () => {
    expect(framingSubjectAt(timeline, 4)).toBe("face");
    expect(framingSubjectAt(timeline, 12)).toBe("screen");
    expect(framingSubjectAt(timeline, 27)).toBe("face");
  });

  it("boundaries are start-inclusive, end-exclusive — one owner per instant", () => {
    expect(framingSubjectAt(timeline, 10)).toBe("screen");
    expect(framingSubjectAt(timeline, 25)).toBe("face");
  });

  it("clamps to the nearest segment outside the timeline, like framingWindowAtOutput", () => {
    // A span in-point a hair past either edge must still get a verdict, not
    // a hole — same clamping rule as the render-time window lookup.
    expect(framingSubjectAt(timeline, -0.5)).toBe("face");
    expect(framingSubjectAt(timeline, 31)).toBe("face");
  });

  it("an empty timeline reads as screen — no evidence, no punch", () => {
    expect(framingSubjectAt([], 5)).toBe("screen");
  });

  it("gates spans by their source in-point against a mixed timeline", () => {
    // The produce-side wiring in one assertion: spans starting in the face
    // stretch punch, the one starting in the screen stretch does not.
    const spans = [span(2, 9), span(12, 20), span(26, 29)];
    const plan = punchPlanFor(
      spans,
      "auto",
      spans.map((sp) => framingSubjectAt(timeline, sp.srcIn) === "face"),
    );
    expect(plan.allowed).toEqual([true, false, true]);
  });
});
