import { describe, expect, it } from "vitest";
import { frameWindow } from "../src/frames";
import {
  CLIP_BACKGROUND_NOTE,
  KIT_VERSION,
  KitReportSchema,
  SPEAKER_PICTURE_NOTE,
  kitClipPlans,
  kitFileName,
  needsRender,
  sourceClipPlacement,
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
      // The clip carries the background, not the picture (§163, design 6).
      [SPEAKER_PICTURE_NOTE],
      // The clip carries the background: complete, nothing to note.
      [],
      ["backdrop replaced by a flat panel (blurred-behind)"],
      [],
      ["speaker not reframed (video-top)"],
    ]);
  });

  it("the speaker-picture note is the design's sentence, with no numbers (the CLI adds the rectangle)", () => {
    expect(SPEAKER_PICTURE_NOTE).toBe(
      "speaker picture not included: scale and move the footage on track 1 for this stretch",
    );
  });

  it("a full-frame scene in graphic-only is complete: the background is in the clip", () => {
    const [plan] = kitClipPlans({
      cues: [cardRow("c1", 0, 3, { layout: "graphic-only" })],
      theme: defaultTheme,
      settings: SETTINGS,
    });
    expect(plan!.notes).toEqual([]);
  });

  it("a full-frame scene in pip-bubble notes only the missing picture", () => {
    const [plan] = kitClipPlans({
      cues: [cardRow("c1", 0, 3, { layout: "pip-bubble" })],
      theme: defaultTheme,
      settings: SETTINGS,
    });
    expect(plan!.notes).toEqual([SPEAKER_PICTURE_NOTE]);
  });

  it("a clip: scene stays a source in every backdrop, and notes the background it does not carry", () => {
    const clip = (layout: SceneCue["layout"]): SceneCue => ({
      id: "clip-1",
      layout,
      component: "ClipScene",
      props: { src: "clips/abc.webm", durationSec: 3 },
      startSec: 2,
      endSec: 5,
    });
    const plans = kitClipPlans({
      cues: [clip("full-bleed"), { ...clip("graphic-only"), startSec: 6, endSec: 9 }, { ...clip("pip-bubble"), startSec: 10, endSec: 13 }],
      theme: defaultTheme,
      settings: SETTINGS,
    });
    expect(plans.map((p) => p.kind)).toEqual(["source", "source", "source"]);
    expect(plans.map((p) => p.notes)).toEqual([
      [],
      [CLIP_BACKGROUND_NOTE],
      [CLIP_BACKGROUND_NOTE, SPEAKER_PICTURE_NOTE],
    ]);
    expect(CLIP_BACKGROUND_NOTE).toBe("background not included (clip: scenes are referenced, not rendered)");
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

    it("includes the layout: full-bleed and graphic-only keys differ for the same cue", () => {
      const [fb] = keys([cardRow("a", 1, 4)]);
      const [go] = keys([cardRow("a", 1, 4, { layout: "graphic-only" })]);
      expect(go).not.toBe(fb);
    });

    it("changes when only backdropColor changes on a graphic-only cue (backdrop-color §3)", () => {
      const [plain] = keys([cardRow("a", 1, 4, { layout: "graphic-only" })]);
      const [red] = keys([cardRow("a", 1, 4, { layout: "graphic-only", backdropColor: "#ff0000" })]);
      const [green] = keys([cardRow("a", 1, 4, { layout: "graphic-only", backdropColor: "#00ff00" })]);
      expect(red).not.toBe(green);
      expect(red).not.toBe(plain);
    });

    // Literal keys computed by the kit BEFORE clips carried the background
    // (§163; commit 76dd5c7). KIT_VERSION was not bumped, so a cue whose clip
    // did not change must keep its key exactly (it is reused, not rendered
    // again), and a graphic-only or pip-bubble cue, whose clip gained the
    // background, must not (an old clip without it must not be reused). A
    // change to `defaultTheme` legitimately moves all three.
    const OLD = {
      "full-bleed": "2052f2a3746564b1d5120490e0f4c7f520603dc19faf7de91cf6df21d43315c2",
      "graphic-only": "c19baf4492995e96334bc8381cdcc3743b162dbf6409239230405d45bf226e75",
      "pip-bubble": "372d6352b4b00da1040bf7768dd89ea857acfd89ce74988b29c2242213ce9254",
    } as const;

    it("is unchanged for a full-bleed cue, whose clip is byte-identical", () => {
      expect(keys([cardRow("a", 1, 4)])).toEqual([OLD["full-bleed"]]);
    });

    it("moves for graphic-only and pip-bubble, whose clips now carry the background", () => {
      for (const layout of ["graphic-only", "pip-bubble"] as const) {
        const [key] = keys([cardRow("a", 1, 4, { layout })]);
        expect(key, layout).toMatch(/^[0-9a-f]{64}$/);
        expect(key, layout).not.toBe(OLD[layout]);
      }
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

  it("carries the captions.srt summary, and a report written before it existed still parses", () => {
    const withCaptions = { ...valid, captions: { srt: "captions.srt", lines: 12, skipped: 1 } };
    expect(KitReportSchema.parse(withCaptions)).toEqual(withCaptions);
    const none = { ...valid, captions: { srt: null, lines: 0, skipped: 0 } };
    expect(KitReportSchema.parse(none)).toEqual(none);
    // The shape every kit made before captions.srt wrote, as a literal: it
    // must parse, or every existing kit re-renders all its clips once.
    const old = JSON.parse(
      '{"version":1,"createdAt":"2026-11-17T00:00:00.000Z","kitVersion":1,"timeline":"timeline.fcpxml",' +
        '"clips":[{"sceneId":"scene-0","component":"CardRow","kind":"render","file":"clips/scene-0-CardRow.mov",' +
        '"startSec":0.5,"lengthSec":2,"reuseKey":"abc","status":"rendered","notes":[]}],"warnings":[]}',
    );
    expect(KitReportSchema.safeParse(old).success).toBe(true);
    expect(KitReportSchema.parse(old).captions).toBeUndefined();
  });

  it("refuses a captions summary that is not one", () => {
    expect(KitReportSchema.safeParse({ ...valid, captions: { srt: "captions.srt", lines: -1, skipped: 0 } }).success).toBe(false);
    expect(KitReportSchema.safeParse({ ...valid, captions: { srt: "captions.srt", lines: 1.5, skipped: 0 } }).success).toBe(false);
    expect(KitReportSchema.safeParse({ ...valid, captions: { lines: 1, skipped: 0 } }).success).toBe(false);
  });
});

describe("sourceClipPlacement: a clip: original is placed at 1x", () => {
  const plan = (props: Record<string, unknown>): Pick<KitClipPlan, "sceneId" | "cue"> => ({
    sceneId: "shot-a",
    cue: {
      id: "shot-a",
      layout: "full-bleed",
      component: "ClipScene",
      props: { src: "clips/a.webm", durationSec: 4, ...props },
      startSec: 0,
      endSec: 2,
    },
  });

  it("at 1x it is trimmed to the slot and never past the file's end, with no warning", () => {
    expect(sourceClipPlacement(plan({ speed: 1 }), 4.0333, 4)).toEqual({ lengthSec: 4, warning: null });
    expect(sourceClipPlacement(plan({ speed: 1 }), 3, 4)).toEqual({ lengthSec: 3, warning: null });
    // A cue saved before `speed` existed is 1x.
    expect(sourceClipPlacement(plan({}), 3, 4)).toEqual({ lengthSec: 3, warning: null });
  });

  it("at another speed it stays inside its slot (no overlap with the next kit clip), and the warning names the scene and the speed", () => {
    const fast = sourceClipPlacement(plan({ speed: 2 }), 2, 4);
    expect(fast.lengthSec).toBe(2);
    expect(fast.warning).toContain("shot-a");
    expect(fast.warning).toContain("2x");
    expect(fast.warning).toContain("normal speed");
    expect(fast.warning).toContain("finishing app");
    const slow = sourceClipPlacement(plan({ speed: 0.5 }), 8, 4);
    expect(slow).toMatchObject({ lengthSec: 4 });
    expect(slow.warning).toContain("0.5x");
  });
});
