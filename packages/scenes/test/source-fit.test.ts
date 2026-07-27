import { describe, expect, it } from "vitest";
import type { SceneCue } from "@ossclip/core";
import {
  captionAnchorAvoiding,
  overlapFraction,
  placeInFreeBand,
  routeAroundSourceText,
} from "../src/source-fit";
import { CAPTION_HALF_BAND, SAFE_AREA, layoutSlots } from "../src/stage";

const cue = (
  id: string,
  layout: SceneCue["layout"],
  component: SceneCue["component"],
): SceneCue => ({ id, layout, component, props: {}, startSec: 0, endSec: 4 });

/** The observed §26 case: a burned-in title across the source's top band. */
const TITLE_BAND = [{ y: 0.1, h: 0.3 }];

describe("routing around burned-in source text (FINDINGS §26)", () => {
  it("leaves everything alone when the source is clean", () => {
    const cues = [cue("a", "video-top", "StatCard")];
    const plan = routeAroundSourceText(cues, []);
    expect(plan.cues).toEqual(cues);
    expect(plan.relayouts).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("moves a graphic to a layout whose slot is clear", () => {
    // pip-bubble's graphic sits at y 0.14-0.56, straight through a burned-in
    // title; StatCard's alternate is lower down.
    const plan = routeAroundSourceText([cue("a", "pip-bubble", "StatCard")], TITLE_BAND);
    expect(plan.skipped).toEqual([]);
    expect(plan.cues).toHaveLength(1);
    expect(plan.cues[0]!.layout).not.toBe("pip-bubble");
    expect(plan.relayouts[0]).toMatchObject({ id: "a", from: "pip-bubble" });
  });

  it("skips a scene when no layout is free, rather than stacking on the source", () => {
    // Text across the whole frame leaves nowhere legal for a graphic.
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], [{ y: 0, h: 1 }]);
    expect(plan.cues).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ id: "a" });
    expect(plan.skipped[0]!.reason).toMatch(/source already has on-screen text/);
  });

  it("never places a graphic on top of the source's text", () => {
    for (const component of ["StatCard", "RuleCard", "ChatMock", "TitleCard"] as const) {
      const plan = routeAroundSourceText([cue("a", "video-top", component)], TITLE_BAND);
      for (const c of plan.cues) {
        const slot = layoutSlots(c.layout).graphic!;
        expect(overlapFraction(slot, TITLE_BAND), `${component} overlaps`).toBeLessThanOrEqual(0.12);
      }
    }
  });
});

describe("captions around burned-in source text (FINDINGS §26)", () => {
  it("keeps the layout's own anchor when it is already clear", () => {
    for (const layout of ["full-bleed", "video-top", "graphic-only"] as const) {
      expect(captionAnchorAvoiding(layout, [])).toBe(layoutSlots(layout).captionAnchor);
    }
  });

  it("moves the caption off the source's text rather than hiding it", () => {
    // Captions are the accessibility layer — they relocate, never disappear.
    const layout = "full-bleed";
    const base = layoutSlots(layout).captionAnchor;
    const onTopOfCaptions = [{ y: base - 0.06, h: 0.12 }];
    const moved = captionAnchorAvoiding(layout, onTopOfCaptions);
    expect(moved).not.toBe(base);
    expect(overlapFraction({ y: moved - CAPTION_HALF_BAND, h: CAPTION_HALF_BAND * 2 }, onTopOfCaptions))
      .toBe(0);
  });

  it("keeps the relocated caption inside the platform safe area", () => {
    const moved = captionAnchorAvoiding("full-bleed", [{ y: 0.55, h: 0.2 }]);
    expect(moved - CAPTION_HALF_BAND).toBeGreaterThanOrEqual(SAFE_AREA.top);
    expect(moved + CAPTION_HALF_BAND).toBeLessThanOrEqual(1 - SAFE_AREA.bottom + 1e-9);
  });

  it("still returns an anchor when the whole frame is busy — captions always go in", () => {
    const anchor = captionAnchorAvoiding("full-bleed", [{ y: 0, h: 1 }]);
    expect(Number.isFinite(anchor)).toBe(true);
    expect(anchor).toBe(layoutSlots("full-bleed").captionAnchor);
  });
});

describe("routing reserves room for captions (FINDINGS §26)", () => {
  // Captions are mandatory and graphics are not, so when both want the same
  // free band the GRAPHIC yields — otherwise a routed graphic swallows the
  // band and the captions fall back on top of the source's own text.
  const EDITED = [
    { y: 0.12, h: 0.2 },
    { y: 0.66, h: 0.12 },
  ];

  it("leaves a caption-sized gap when the band can hold both", () => {
    const moved = placeInFreeBand({ x: 0.04, y: 0.14, w: 0.8, h: 0.54 }, EDITED)!;
    expect(moved).not.toBeNull();
    const anchor = captionAnchorAvoiding("graphic-only", EDITED, moved);
    const band = { y: anchor - CAPTION_HALF_BAND, h: CAPTION_HALF_BAND * 2 };
    expect(overlapFraction(band, EDITED), "caption sits on source text").toBe(0);
    const clash = Math.min(band.y + band.h, moved.y + moved.h) - Math.max(band.y, moved.y);
    expect(clash, "caption collides with the routed graphic").toBeLessThanOrEqual(0);
  });

  it("keeps the routed graphic clear of the source's text", () => {
    const moved = placeInFreeBand({ x: 0.04, y: 0.14, w: 0.8, h: 0.54 }, EDITED)!;
    expect(overlapFraction(moved, EDITED)).toBe(0);
  });

  it("refuses to route into a band too small to read", () => {
    // Text everywhere but a sliver — a graphic there would be illegible.
    expect(
      placeInFreeBand({ x: 0, y: 0.2, w: 1, h: 0.3 }, [{ y: 0.12, h: 0.5 }, { y: 0.68, h: 0.1 }]),
    ).toBeNull();
  });
});
