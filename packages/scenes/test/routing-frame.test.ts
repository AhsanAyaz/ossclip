import { describe, expect, it } from "vitest";
import type { SceneCue } from "@ossclip/core";
import { routeAroundSourceText } from "../src/source-fit";
import { LANDSCAPE_FRAME, PORTRAIT_FRAME, layoutSlots } from "../src/stage";

const cue = (
  id: string,
  layout: SceneCue["layout"],
  component: SceneCue["component"],
): SceneCue => ({ id, layout, component, props: {}, startSec: 0, endSec: 4 });

/** A burned-in title across the source's top band, as in §26. */
const TITLE_BAND = [{ y: 0.1, h: 0.3 }];

describe("routing reads the frame it is placing into (R27 §120)", () => {
  // The regression pin for the second defect §120's spec surfaced: produce
  // called routeAroundSourceText with no frame, and layoutSlots defaults to
  // portrait — so a 16:9 run routed against geometry that is not what
  // renders. If the argument is ever dropped at the call site again, the two
  // frames stop disagreeing and this fails.
  it("places a split-layout graphic differently in 16:9 than in 9:16", () => {
    const cues = [cue("a", "split-left", "StatCard")];
    const portrait = routeAroundSourceText(cues, TITLE_BAND, PORTRAIT_FRAME);
    const landscape = routeAroundSourceText(cues, TITLE_BAND, LANDSCAPE_FRAME);
    expect(portrait).not.toEqual(landscape);
  });

  it("defaults to portrait, so existing callers keep their behaviour", () => {
    const cues = [cue("a", "video-top", "StatCard")];
    expect(routeAroundSourceText(cues, TITLE_BAND)).toEqual(
      routeAroundSourceText(cues, TITLE_BAND, PORTRAIT_FRAME),
    );
  });

  // Clause 3 in the large: a Y-obstacle applied to a landscape split would
  // find the video covering the whole frame and skip every scene there.
  it("still places a landscape split scene rather than skipping it", () => {
    const plan = routeAroundSourceText([cue("a", "split-left", "StatCard")], TITLE_BAND, LANDSCAPE_FRAME);
    expect(plan.skipped).toEqual([]);
    expect(plan.cues).toHaveLength(1);
  });

  it("keeps a routed portrait graphic clear of the video slot", () => {
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], TITLE_BAND, PORTRAIT_FRAME);
    const placed = plan.cues[0];
    expect(placed).toBeDefined();
    const rect = placed!.graphicRect ?? layoutSlots(placed!.layout, undefined, [], PORTRAIT_FRAME).graphic!;
    const v = layoutSlots(placed!.layout, undefined, [], PORTRAIT_FRAME).video.rect;
    const overlap = Math.min(rect.y + rect.h, v.y + v.h) - Math.max(rect.y, v.y);
    expect(overlap).toBeLessThanOrEqual(0);
  });
});
