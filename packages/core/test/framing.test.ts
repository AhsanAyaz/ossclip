import { describe, expect, it } from "vitest";
import {
  buildFramingBrief,
  infeasibleLayouts,
  layoutFeasible,
  momentSourceWindow,
  repairMomentLayouts,
  worstFaceFrac,
  type FramingContext,
} from "../src/framing";
import { headFracInSlot } from "../src/normalize";
import type { Moment } from "../src/producer/beats";
import type { Transcript } from "../src/schema";

/**
 * The measured case throughout (PLAN "Why this exists"): the author's clip
 * normalizes to a PORTRAIT canvas (450×800); `video-top` is a 1080×806 band.
 * A face at 44% of the canvas becomes ~105% of the band — crown trimmed.
 */
const LAYOUTS: FramingContext["layouts"] = [
  { layout: "full-bleed", slotAspect: 1080 / 1920, primary: true },
  { layout: "video-top", slotAspect: 1080 / 806, primary: true },
  { layout: "pip-bubble", slotAspect: 1, primary: false },
  { layout: "graphic-only", slotAspect: 1, primary: false },
  { layout: "blurred-behind", slotAspect: 1080 / 1920, primary: true },
];

const ctx = (windows: FramingContext["windows"]): FramingContext => ({
  windows,
  canvasAspect: 450 / 800,
  layouts: LAYOUTS,
  zoom: 1.05,
});

/** Words at one per second, so word index ≈ source second. */
const transcript = (n: number): Transcript => ({
  language: "en",
  words: Array.from({ length: n }, (_, i) => ({
    text: `w${i}`,
    start: i,
    end: i + 0.9,
    confidence: 1,
  })),
});

const CLOSE = 0.44;
const WIDE = 0.2;

describe("headFracInSlot — the measured video-top defect", () => {
  it("reproduces the 105%-of-band face from the plan", () => {
    // visible = canvasAspect/slotAspect = 0.5625/1.34 → face 0.44 → ~1.05.
    const face = 0.44 / (0.5625 / (1080 / 806));
    expect(face).toBeCloseTo(1.048, 2);
    expect(headFracInSlot(0.44, 0.5625, 1080 / 806, 1.05)).toBeGreaterThan(1.6);
  });

  it("a slot no wider than the canvas leaves the face fraction alone", () => {
    expect(headFracInSlot(0.44, 0.5625, 0.5625, 1)).toBeCloseTo(1.55 * 0.44, 6);
  });
});

describe("layout feasibility", () => {
  it("rules out video-top on a close shot, keeps full-bleed", () => {
    const c = ctx([]);
    expect(layoutFeasible(c, "video-top", CLOSE)).toBe(false);
    expect(layoutFeasible(c, "full-bleed", CLOSE)).toBe(true);
  });

  it("never rules out non-primary slots — a pip bubble is MEANT to be tight", () => {
    expect(layoutFeasible(ctx([]), "pip-bubble", 0.9)).toBe(true);
    expect(layoutFeasible(ctx([]), "graphic-only", 0.9)).toBe(true);
  });

  it("everything is feasible on a wide shot, and with no measurement", () => {
    const c = ctx([]);
    for (const l of LAYOUTS) {
      expect(layoutFeasible(c, l.layout, WIDE)).toBe(true);
      expect(layoutFeasible(c, l.layout, 0)).toBe(true);
    }
  });

  it("infeasibleLayouts names only the offenders", () => {
    expect(infeasibleLayouts(ctx([]), CLOSE)).toEqual(["video-top"]);
    expect(infeasibleLayouts(ctx([]), WIDE)).toEqual([]);
  });
});

describe("worstFaceFrac / momentSourceWindow", () => {
  it("a span is judged by its tightest overlapping window", () => {
    const windows = [
      { startSec: 0, endSec: 10, faceFracOfCanvas: 0.2 },
      { startSec: 10, endSec: 20, faceFracOfCanvas: 0.5 },
    ];
    expect(worstFaceFrac(windows, 5, 15)).toBe(0.5);
    expect(worstFaceFrac(windows, 0, 9)).toBe(0.2);
    expect(worstFaceFrac(windows, 25, 30)).toBe(0);
  });

  it("maps a moment's words to source seconds off the transcript stamps", () => {
    const w = momentSourceWindow(transcript(30), 5, 9)!;
    expect(w.startSec).toBe(5);
    expect(w.endSec).toBeCloseTo(9.9, 6);
    expect(momentSourceWindow(transcript(3), 0, 99)).toBeNull();
  });
});

describe("buildFramingBrief (Task A)", () => {
  it("writes word-indexed lines and names the unavailable layouts", () => {
    const brief = buildFramingBrief(
      ctx([
        { startSec: 0, endSec: 10, faceFracOfCanvas: CLOSE },
        { startSec: 10, endSec: 20, faceFracOfCanvas: WIDE },
      ]),
      transcript(20),
    );
    expect(brief).toContain("words 0-9: CLOSE shot");
    expect(brief).toContain("video-top");
    expect(brief).toContain("UNAVAILABLE");
    expect(brief).toContain("words 10-19");
    expect(brief).toContain("any layout works");
    // Qualitative only — the model gets consequences, not slot pixels.
    expect(brief).not.toMatch(/1080|806|slot/);
  });

  it("merges contiguous windows with the same constraint", () => {
    const brief = buildFramingBrief(
      ctx([
        { startSec: 0, endSec: 10, faceFracOfCanvas: 0.42 },
        { startSec: 10, endSec: 20, faceFracOfCanvas: 0.46 },
      ]),
      transcript(20),
    );
    expect(brief.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
    expect(brief).toContain("words 0-19");
    // The merged line keeps the WORST framing, same as span judgement.
    expect(brief).toContain("~46%");
  });

  it("is empty when nothing was measured — the prompt stays unchanged", () => {
    expect(buildFramingBrief(ctx([]), transcript(10))).toBe("");
    expect(
      buildFramingBrief(ctx([{ startSec: 0, endSec: 10, faceFracOfCanvas: 0 }]), transcript(10)),
    ).toBe("");
  });
});

describe("repairMomentLayouts (Task B — the safety net)", () => {
  const moment = (over: Partial<Moment>): Moment => ({
    startWord: 0,
    endWord: 9,
    purpose: "p",
    onScreenCopy: "COPY",
    sceneKind: "StatCard",
    ...over,
  });
  const closeCtx = ctx([{ startSec: 0, endSec: 30, faceFracOfCanvas: CLOSE }]);

  it("rewrites an infeasible explicit choice and records why (B1)", () => {
    // StatCard's default IS video-top; the producer also asked for it.
    const { moments, issues } = repairMomentLayouts(
      [moment({ layout: "video-top" })],
      transcript(30),
      closeCtx,
    );
    expect(moments[0]!.layout).toBe("blurred-behind"); // StatCard's alternate
    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toContain("video-top");
  });

  it("repairs the registry default too when the producer said nothing", () => {
    const { moments, issues } = repairMomentLayouts([moment({})], transcript(30), closeCtx);
    expect(moments[0]!.layout).toBe("blurred-behind");
    expect(issues).toHaveLength(1);
  });

  it("keeps a feasible explicit choice untouched", () => {
    const { moments, issues } = repairMomentLayouts(
      [moment({ layout: "blurred-behind" })],
      transcript(30),
      closeCtx,
    );
    expect(moments[0]!.layout).toBe("blurred-behind");
    expect(issues).toHaveLength(0);
  });

  it("leaves everything alone on a wide shot and on 'none' moments", () => {
    const wideCtx = ctx([{ startSec: 0, endSec: 30, faceFracOfCanvas: WIDE }]);
    const { moments, issues } = repairMomentLayouts(
      [moment({ layout: "video-top" }), moment({ sceneKind: "none" })],
      transcript(30),
      wideCtx,
    );
    expect(moments[0]!.layout).toBe("video-top");
    expect(issues).toHaveLength(0);
  });

  it("with nothing feasible, takes the least-bad candidate and says so", () => {
    // A context where even full-frame slots trim: face at 70% of canvas.
    const extreme = ctx([{ startSec: 0, endSec: 30, faceFracOfCanvas: 0.7 }]);
    const { moments, issues } = repairMomentLayouts(
      [moment({ layout: "video-top" })],
      transcript(30),
      extreme,
    );
    // blurred-behind (full-frame) trims less than video-top (wide band).
    expect(moments[0]!.layout).toBe("blurred-behind");
    expect(issues[0]!.issue).toContain("no StatCard layout fully fits");
  });
});
