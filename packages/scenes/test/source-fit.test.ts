import { describe, expect, it } from "vitest";
import type { SceneCue } from "@ossclip/core";
import {
  captionAnchorAvoiding,
  overlapFraction,
  placeInFreeBand,
  routeAroundSourceText,
  videoObstacleFor,
} from "../src/source-fit";
import { CAPTION_HALF_BAND, LANDSCAPE_FRAME, SAFE_AREA, layoutSlots } from "../src/stage";

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

  it("searches the frame's own safe area, not portrait's (R15)", () => {
    // The band search is the other frame-dependent geometry in routing, and it
    // was hardcoded to portrait while every layoutSlots call took the frame.
    // Text spanning [0.12, 0.72] leaves [0.72, 0.88] — 0.16, comfortably over
    // the 0.14 floor, and legal in 16:9, which has no action rail or username
    // ticker to dodge. Portrait's 0.22 bottom inset ends the search at 0.78 and
    // sees only 0.06 of it, so the same regions must skip there.
    const rect = { x: 0.05, y: 0.2, w: 0.5, h: 0.3 };
    const regions = [{ y: 0.12, h: 0.6 }];
    const landscape = placeInFreeBand(rect, regions, null, LANDSCAPE_FRAME);
    expect(landscape, "landscape refused a band its safe area allows").not.toBeNull();
    expect(landscape!.y).toBeGreaterThanOrEqual(0.72 - 1e-9);
    expect(landscape!.y + landscape!.h).toBeLessThanOrEqual(0.88 + 1e-9);
    expect(placeInFreeBand(rect, regions, null)).toBeNull();
  });
});

/**
 * R27 §120. Routing negotiates only with burned-in source text — it never
 * reads `layoutSlots(...).video`. Some layouts INTEND the graphic to sit over
 * the picture (`blurred-behind` blurs and dims it; `full-bleed` and
 * `lower-third` overlay a band), so overlap is not wrong everywhere.
 *
 * These three are different: their graphic slot is authored clear of the video
 * slot, which is the whole reason the layout exists. Routing should preserve
 * that separation, and today it does not — it slides the graphic up into the
 * picture, and the graphic wins because SceneLayer renders after VideoStage.
 * On the motivating take that put a ScreenshotFrame across the speaker's face.
 */
describe("a routed graphic and the video it was authored clear of", () => {
  // pip-bubble joins §120's original three: the rule is derived from the slot
  // table, and it qualifies — a visible bubble 0.1 below the graphic.
  const SEPARATED = ["video-top", "split-left", "split-right", "pip-bubble"] as const;

  const overlap = (layout: (typeof SEPARATED)[number], rect: { y: number; h: number }): number => {
    const v = layoutSlots(layout).video.rect;
    return Math.min(rect.y + rect.h, v.y + v.h) - Math.max(rect.y, v.y);
  };

  it.each(SEPARATED)("%s: the authored slot is clear of the video to begin with", (layout) => {
    expect(overlap(layout, layoutSlots(layout).graphic!)).toBeLessThanOrEqual(0);
  });

  // Was `it.fails` until routing became video-aware (R27 §120). Promoted:
  // the placer now takes the video as an obstacle, so the separation these
  // layouts are built around survives routing.
  it.each(SEPARATED)("%s: routing keeps it clear", (layout) => {
    const moved = placeInFreeBand(
      layoutSlots(layout).graphic!,
      TITLE_BAND,
      videoObstacleFor(layout),
    );
    expect(moved).not.toBeNull();
    expect(overlap(layout, moved!)).toBeLessThanOrEqual(0);
  });
});

describe("falling back to a layout that intends the overlap (R27 §120)", () => {
  // Text across the band a video-top graphic would route into. Its own slot
  // is blocked, and the band left over collides with the video — so before
  // §120 this scene placed on the picture, and after the obstacle landed it
  // would have been skipped. blurred-behind blurs 22px and dims 0.55 for
  // exactly this case, and StatCard already declares it as an alternate.
  const BLOCKING = [
    { y: 0.06, h: 0.16 },
    { y: 0.46, h: 0.34 },
  ];

  it("moves the scene to an overlay layout rather than dropping it", () => {
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], BLOCKING);
    expect(plan.skipped).toEqual([]);
    expect(plan.cues).toHaveLength(1);
    expect(plan.overlaid[0]).toMatchObject({ id: "a", from: "video-top" });
    const to = plan.overlaid[0]!.to;
    expect(videoObstacleFor(to)).toBeNull();
  });

  it("emits the cue in the new layout, with the rect that was placed there", () => {
    // The bookkeeping entry and the emitted cue are two separate writes, and
    // only the second one renders. An implementation that recorded `overlaid`
    // correctly while pushing the OLD layout's rect satisfies every other
    // assertion in this block — so assert the payload, not just the receipt.
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], BLOCKING);
    const to = plan.overlaid[0]!.to;
    const emitted = plan.cues[0]!;
    expect(emitted.layout).toBe(to);
    expect(emitted.graphicRect, "cue kept the authored slot").toBeTruthy();
    expect(overlapFraction(emitted.graphicRect!, BLOCKING)).toBe(0);
    // And it is the OVERLAY layout's slot that moved, not video-top's.
    expect(emitted.graphicRect).not.toEqual(layoutSlots("video-top").graphic);
  });

  it("reports the move separately from a source-text relayout", () => {
    // The reason differs: this graphic moved because of the PICTURE, and
    // saying "source text in the way" would be a false explanation.
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], BLOCKING);
    expect(plan.relayouts).toEqual([]);
    expect(plan.overlaid).toHaveLength(1);
  });

  it("still skips when even the overlay layouts are covered in text", () => {
    // The floor must hold: the fallback may not resurrect a scene that has
    // genuinely nowhere legal to go.
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], [{ y: 0, h: 1 }]);
    expect(plan.cues).toEqual([]);
    expect(plan.overlaid).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ id: "a" });
  });

  it("skips a component that declares no overlay alternate", () => {
    // TitleCard defaults to pip-bubble — itself a separated layout under
    // clause 2 — and its altLayouts is []. Nowhere blessed to fall back to,
    // and routing must not invent a placement the registry has not approved.
    const plan = routeAroundSourceText([cue("a", "pip-bubble", "TitleCard")], [{ y: 0, h: 1 }]);
    expect(plan.overlaid).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });

  it("leaves overlaid empty on a clean source", () => {
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], []);
    expect(plan.overlaid).toEqual([]);
  });

  it("says the video was the blocker when the text alone left room", () => {
    const plan = routeAroundSourceText([cue("a", "pip-bubble", "TitleCard")], [{ y: 0.12, h: 0.5 }]);
    expect(plan.cues).toEqual([]);
    expect(plan.skipped[0]!.reason).toMatch(/clear of both/);
  });

  it("still blames the text when the text really did cover everything", () => {
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], [{ y: 0, h: 1 }]);
    expect(plan.skipped[0]!.reason).toMatch(/source already has on-screen text/);
  });

  it("asks the RENDERED layout for the obstacle, not the layout that lent the slot", () => {
    // `full-bleed` has no graphic slot, so the moved-rect path borrows
    // pip-bubble's geometry from TitleCard's default — but the cue still
    // RENDERS full-bleed, whose obstacle is null. Reading the donor's instead
    // makes the placer dodge pip-bubble's bubble at [0.66, 0.829], leaving a
    // 0.06 band under the 0.14 floor; TitleCard declares no alternates, so the
    // scene was dropped and blamed on a video the layout means to sit on.
    const plan = routeAroundSourceText([cue("a", "full-bleed", "TitleCard")], [{ y: 0.12, h: 0.48 }]);
    expect(plan.skipped).toEqual([]);
    expect(plan.cues).toHaveLength(1);
    expect(plan.moved[0]).toMatchObject({ id: "a" });
    const emitted = plan.cues[0]!;
    expect(emitted.layout, "the moved path must not change the layout").toBe("full-bleed");
    expect(overlapFraction(emitted.graphicRect!, [{ y: 0.12, h: 0.48 }])).toBe(0);
  });
});
