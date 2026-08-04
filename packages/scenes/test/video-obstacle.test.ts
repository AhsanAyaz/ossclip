import { describe, expect, it } from "vitest";
import type { Layout } from "@ossclip/core";
import { videoObstacleFor } from "../src/source-fit";
import { LANDSCAPE_FRAME, PORTRAIT_FRAME } from "../src/stage";

describe("videoObstacleFor (R27 §120)", () => {
  // Clause 2: the layout authored the graphic clear of the picture, and that
  // separation is the reason the layout exists — routing may not spend it.
  it("reports the video for a layout that authored them apart, in portrait", () => {
    expect(videoObstacleFor("video-top", PORTRAIT_FRAME)).toEqual({ y: 0, h: 0.42 });
    expect(videoObstacleFor("split-left", PORTRAIT_FRAME)).toEqual({ y: 0, h: 0.5 });
    expect(videoObstacleFor("split-right", PORTRAIT_FRAME)).toEqual({ y: 0, h: 0.5 });
  });

  // §120's own list was ["video-top", "split-left", "split-right"] and missed
  // this one: the bubble is fully visible and sits 0.1 below the graphic.
  // Deriving the rule from the slot table catches it for free.
  it("reports the video for pip-bubble, which the finding's list missed", () => {
    const obstacle = videoObstacleFor("pip-bubble", PORTRAIT_FRAME);
    expect(obstacle).not.toBeNull();
    expect(obstacle!.y).toBeCloseTo(0.66, 5);
    expect(obstacle!.h).toBeCloseTo(0.169, 3);
  });

  // Clause 3, and the reason the rule reads the frame rather than a list of
  // layout names: in 16:9 the splits separate by X with a full-height video,
  // so a Y-obstacle there would skip every scene in those layouts.
  it("reports nothing for the splits in landscape, where they separate by X", () => {
    expect(videoObstacleFor("split-left", LANDSCAPE_FRAME)).toBeNull();
    expect(videoObstacleFor("split-right", LANDSCAPE_FRAME)).toBeNull();
  });

  // Clause 3: these layouts exist to put a graphic over the picture.
  it("reports nothing for layouts that intend the overlap", () => {
    for (const frame of [PORTRAIT_FRAME, LANDSCAPE_FRAME]) {
      expect(videoObstacleFor("blurred-behind", frame)).toBeNull();
      expect(videoObstacleFor("lower-third", frame)).toBeNull();
    }
  });

  // Clause 1: an invisible video cannot be collided with.
  it("reports nothing for graphic-only, whose video is at zero opacity", () => {
    expect(videoObstacleFor("graphic-only", PORTRAIT_FRAME)).toBeNull();
    expect(videoObstacleFor("graphic-only", LANDSCAPE_FRAME)).toBeNull();
  });

  it("reports nothing for a layout with no graphic slot", () => {
    expect(videoObstacleFor("full-bleed", PORTRAIT_FRAME)).toBeNull();
  });

  it("defaults to portrait, so existing callers keep their answer", () => {
    expect(videoObstacleFor("split-left")).toEqual(videoObstacleFor("split-left", PORTRAIT_FRAME));
  });

  // Total over the enum: a new layout must get an answer, not a crash.
  it("answers for every layout in both frames", () => {
    const ALL: Layout[] = [
      "full-bleed", "video-top", "pip-bubble", "graphic-only",
      "blurred-behind", "lower-third", "split-left", "split-right",
    ];
    for (const layout of ALL) {
      for (const frame of [PORTRAIT_FRAME, LANDSCAPE_FRAME]) {
        expect(() => videoObstacleFor(layout, frame)).not.toThrow();
      }
    }
  });
});
