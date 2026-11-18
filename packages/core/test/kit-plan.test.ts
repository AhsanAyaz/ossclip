import { describe, expect, it } from "vitest";
import { frameWindow } from "../src/frames";
import {
  KIT_VERSION,
  KitReportSchema,
  kitClipPlans,
  kitFileName,
  needsRender,
  type KitClipPlan,
  type KitReport,
} from "../src/kit-plan";
import { rebaseCue } from "../src/kit-rebase";
import { defaultTheme, type SceneCue } from "../src/scene-schema";

/**
 * The pure half of `ossclip kit` (phase 3, plan Task 1): which cues become
 * clips, how a cue is moved to start at its own frame 0, what a clip is
 * called, and when an existing clip may be reused.
 */

const P = { cards: [{ text: "ONE" }, { text: "TWO" }, { text: "THREE" }] };
const SETTINGS = { width: 1920, height: 1080, fps: 30 };

function cardRow(id: string, startSec: number, endSec: number, extra: Partial<SceneCue> = {}): SceneCue {
  return { id, layout: "full-bleed", component: "CardRow", props: P, startSec, endSec, ...extra };
}

describe("rebaseCue (Review Focus 1: items stay on their words inside the clip)", () => {
  it("moves the cue to 0 and shifts every absolute output time by the old start", () => {
    const cue = cardRow("c1", 62.2255, 66.8, {
      reveal: { itemAtSec: [62.5, null, 64.1] },
      entryAtSec: 62.3,
    });
    const r = rebaseCue(cue, 30);
    expect(r.startSec).toBe(0);
    // The clip is exactly as long as the scene's window in the full render.
    expect(frameWindow(62.2255, 66.8, 30).durationInFrames).toBe(137);
    expect(r.endSec).toBe(137 / 30);
    expect(r.reveal!.itemAtSec[0]).toBeCloseTo(0.2745, 6);
    expect(r.reveal!.itemAtSec[1]).toBeNull();
    expect(r.reveal!.itemAtSec[2]).toBeCloseTo(1.8745, 6);
    expect(r.entryAtSec).toBeCloseTo(0.0745, 6);
  });

  it("an item's frame relative to the cue start is the one the full render computes", () => {
    // reveal.ts places an item at (t - cueStartSec) * fps; the rebased cue
    // must give the same number for the same item.
    const cue = cardRow("c1", 62.2255, 66.8, { reveal: { itemAtSec: [62.5, 63.9, 64.1] } });
    const r = rebaseCue(cue, 30);
    cue.reveal!.itemAtSec.forEach((t, i) => {
      expect((r.reveal!.itemAtSec[i]! - r.startSec) * 30).toBeCloseTo((t! - cue.startSec) * 30, 9);
    });
  });

  it("a word spoken before the final start stays before it (no clamp: reveal.ts interpolates from it)", () => {
    const cue = cardRow("c1", 10, 14, { reveal: { itemAtSec: [9.8, 11] } });
    const r = rebaseCue(cue, 30);
    expect(r.reveal!.itemAtSec[0]).toBeCloseTo(-0.2, 9);
  });

  it("leaves everything that is not an output time untouched", () => {
    const cue = cardRow("c1", 5, 9, {
      layout: "video-top",
      graphicRect: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
      elements: { title: { dx: 4 } },
      kept: { srcIn: 30, srcOut: 34 },
      anchor: { startWord: 3, endWord: 9 },
      pinned: true,
    });
    const r = rebaseCue(cue, 30);
    expect(r.layout).toBe("video-top");
    expect(r.props).toBe(cue.props);
    expect(r.graphicRect).toEqual(cue.graphicRect);
    expect(r.elements).toEqual(cue.elements);
    expect(r.kept).toEqual({ srcIn: 30, srcOut: 34 }); // SOURCE seconds, not output
    expect(r.anchor).toEqual({ startWord: 3, endWord: 9 });
    expect(r.pinned).toBe(true);
    expect(r.reveal).toBeUndefined();
    expect(r.entryAtSec).toBeUndefined();
    expect("reveal" in r).toBe(false);
    expect("entryAtSec" in r).toBe(false);
  });

  it("does not mutate the cue it was given", () => {
    const cue = cardRow("c1", 5, 9, { reveal: { itemAtSec: [6] }, entryAtSec: 5.5 });
    rebaseCue(cue, 30);
    expect(cue.startSec).toBe(5);
    expect(cue.reveal!.itemAtSec[0]).toBe(6);
    expect(cue.entryAtSec).toBe(5.5);
  });
});

describe("kitClipPlans", () => {
  const clipCue: SceneCue = {
    id: "clip-1",
    layout: "full-bleed",
    component: "ClipScene",
    props: { src: "clips/abc.webm", durationSec: 3 },
    startSec: 2,
    endSec: 5,
  };
  const plainCue: SceneCue = { id: "plain-0", kind: "plain", layout: "full-bleed", startSec: 0, endSec: 20 };

  it("leaves out plain cues, marks a ClipScene cue as source, and orders by start", () => {
    const plans = kitClipPlans({
      cues: [cardRow("b", 8, 12), plainCue, clipCue, cardRow("a", 0.5, 2)],
      theme: defaultTheme,
      settings: SETTINGS,
    });
    expect(plans.map((p) => p.sceneId)).toEqual(["a", "clip-1", "b"]);
    expect(plans.map((p) => p.kind)).toEqual(["render", "source", "render"]);
  });

  it("a cue with no kind is a graphic cue (absence means graphic)", () => {
    const plans = kitClipPlans({ cues: [cardRow("a", 1, 2)], theme: defaultTheme, settings: SETTINGS });
    expect(plans).toHaveLength(1);
  });

  it("carries the frame window of the ORIGINAL cue and the rebased cue", () => {
    const [plan] = kitClipPlans({
      cues: [cardRow("c1", 62.2255, 66.8, { reveal: { itemAtSec: [62.5, null, 64.1] } })],
      theme: defaultTheme,
      settings: SETTINGS,
    });
    expect(plan!.startFrame).toBe(1867);
    expect(plan!.durationInFrames).toBe(137);
    expect(plan!.cue.startSec).toBe(0);
    expect(plan!.cue.endSec).toBe(137 / 30);
    expect(plan!.fileName).toBe("c1-CardRow.mov");
    expect(plan!.component).toBe("CardRow");
    expect(plan!.reuseKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("notes what a transparent clip cannot carry over", () => {
    const plans = kitClipPlans({
      cues: [
        { ...cardRow("s1", 0, 1), layout: "split-left", component: "StatCard", props: { label: "L", value: "1" } },
        { ...cardRow("s2", 1, 2), layout: "pip-bubble", component: "TitleCard", props: { title: "T" } },
        { ...cardRow("s3", 2, 3), layout: "graphic-only", component: "FlowDiagram", props: { nodes: ["A", "B"] } },
        { ...cardRow("s4", 3, 4), layout: "blurred-behind", component: "BulletList", props: { items: ["A", "B"] } },
        { ...cardRow("s5", 4, 5), layout: "lower-third", component: "StatCard", props: { label: "L", value: "1" } },
        { ...cardRow("s6", 5, 6), layout: "video-top", component: "RuleCard", props: { kicker: "K", text: "T" } },
      ],
      theme: defaultTheme,
      settings: SETTINGS,
    });
    expect(plans.map((p) => p.notes)).toEqual([
      ["speaker not reframed (split-left)"],
      ["speaker not reframed (pip-bubble)"],
      ["backdrop replaced by a flat panel (graphic-only)"],
      ["backdrop replaced by a flat panel (blurred-behind)"],
      [],
      ["speaker not reframed (video-top)"],
    ]);
  });

  it("a full-frame scene gets no flat panel, so its notes do not claim one", () => {
    // Plan decision 2 / Task 2: only a cue that is not fullFrame (and whose
    // registry entry keeps the scrim) is drawn on the panel.
    const [plan] = kitClipPlans({
      cues: [cardRow("c1", 0, 3, { layout: "graphic-only" })],
      theme: defaultTheme,
      settings: SETTINGS,
    });
    expect(plan!.notes).toEqual([]);
  });

  describe("reuseKey", () => {
    const base = () => [cardRow("a", 1, 4), cardRow("b", 5, 9)];
    const keys = (cues: SceneCue[], theme = defaultTheme, settings = SETTINGS) =>
      kitClipPlans({ cues, theme, settings }).map((p) => p.reuseKey);

    it("is stable for the same inputs", () => {
      expect(keys(base())).toEqual(keys(base()));
    });

    it("does not depend on the order object keys were written in", () => {
      const cues = base();
      const reordered = cues.map((c) => {
        const { props, startSec, endSec, layout, component, id } = c;
        return { props, startSec, endSec, layout, component, id } as SceneCue;
      });
      expect(keys(reordered)).toEqual(keys(cues));
    });

    it("changes when a prop changes, and only for that cue", () => {
      const before = keys(base());
      const edited = base();
      edited[0] = { ...edited[0]!, props: { cards: [{ text: "ONE" }, { text: "TWO" }] } };
      const after = keys(edited);
      expect(after[0]).not.toBe(before[0]);
      expect(after[1]).toBe(before[1]);
    });

    it("does not change when the scene only moves on the timeline", () => {
      // Same length, later start: the rebased cue is the same clip.
      const before = keys([cardRow("a", 1, 4)]);
      const after = keys([cardRow("a", 11, 14)]);
      expect(after).toEqual(before);
    });

    it("changes when a full-frame cue gains a graphic box, which it now draws in (§163)", () => {
      const before = keys(base());
      const boxed = base();
      boxed[0] = { ...boxed[0]!, graphicRect: { x: 0.04, y: 0.56, w: 0.92, h: 0.4 } };
      const after = keys(boxed);
      expect(after[0]).not.toBe(before[0]);
      expect(after[1]).toBe(before[1]);
    });

    it("changes when the theme or the frame size changes", () => {
      const before = keys(base());
      expect(keys(base(), { ...defaultTheme, accent: "#FF0000" })[0]).not.toBe(before[0]);
      expect(keys(base(), defaultTheme, { ...SETTINGS, width: 1080, height: 1920 })[0]).not.toBe(before[0]);
    });
  });
});

describe("kitFileName", () => {
  it("is <sceneId>-<component>.mov", () => {
    expect(kitFileName("3-a1b2c3", "CardRow")).toBe("3-a1b2c3-CardRow.mov");
  });

  it("replaces anything outside [A-Za-z0-9_-] with -", () => {
    expect(kitFileName("a/b c", "X")).toBe("a-b-c-X.mov");
    expect(kitFileName("é.x", "Y")).toBe("--x-Y.mov");
  });

  it("never returns an empty stem", () => {
    expect(kitFileName("", "")).not.toBe(".mov");
    expect(kitFileName("", "").endsWith(".mov")).toBe(true);
    expect(kitFileName("", "").length).toBeGreaterThan(".mov".length);
  });
});

describe("needsRender", () => {
  const [plan] = kitClipPlans({ cues: [cardRow("a", 1, 4)], theme: defaultTheme, settings: SETTINGS });
  const sourcePlan: KitClipPlan = { ...plan!, kind: "source", component: "ClipScene" };
  const report = (reuseKey: string | null): KitReport => ({
    version: 1,
    createdAt: "2026-11-17T00:00:00.000Z",
    kitVersion: KIT_VERSION,
    timeline: "timeline.fcpxml",
    clips: [
      {
        sceneId: "a",
        component: "CardRow",
        kind: "render",
        file: "a-CardRow.mov",
        startSec: 1,
        lengthSec: 3,
        reuseKey,
        status: "rendered",
        notes: [],
      },
    ],
    warnings: [],
  });

  it("is false when the previous report has the same key and the file exists", () => {
    expect(needsRender(plan!, report(plan!.reuseKey), true, false)).toBe(false);
  });

  it("is true when forced", () => {
    expect(needsRender(plan!, report(plan!.reuseKey), true, true)).toBe(true);
  });

  it("is true when the file is missing", () => {
    expect(needsRender(plan!, report(plan!.reuseKey), false, false)).toBe(true);
  });

  it("is true when there is no previous report", () => {
    expect(needsRender(plan!, null, true, false)).toBe(true);
  });

  it("is true when the previous key differs or the scene is not in the report", () => {
    expect(needsRender(plan!, report("0".repeat(64)), true, false)).toBe(true);
    expect(needsRender(plan!, report(null), true, false)).toBe(true);
    expect(needsRender({ ...plan!, sceneId: "other" }, report(plan!.reuseKey), true, false)).toBe(true);
  });

  it("is never true for a source plan, which is the author's own file", () => {
    expect(needsRender(sourcePlan, null, false, true)).toBe(false);
    expect(needsRender(sourcePlan, report("x"), false, false)).toBe(false);
  });
});

describe("KitReportSchema", () => {
  const valid = {
    version: 1,
    createdAt: "2026-11-17T00:00:00.000Z",
    kitVersion: 1,
    timeline: null,
    clips: [
      {
        sceneId: "a",
        component: "ClipScene",
        kind: "source",
        file: null,
        startSec: 1,
        lengthSec: 3,
        reuseKey: null,
        status: "skipped",
        notes: ["original moved"],
      },
    ],
    warnings: ["w"],
  };

  it("parses a report", () => {
    expect(KitReportSchema.parse(valid)).toEqual(valid);
  });

  it("refuses an unknown status or kind rather than reading it as something else", () => {
    const badStatus = { ...valid, clips: [{ ...valid.clips[0]!, status: "renderd" }] };
    const badKind = { ...valid, clips: [{ ...valid.clips[0]!, kind: "sorce" }] };
    expect(KitReportSchema.safeParse(badStatus).success).toBe(false);
    expect(KitReportSchema.safeParse(badKind).success).toBe(false);
    expect(KitReportSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
  });
});
