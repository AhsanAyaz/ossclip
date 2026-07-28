import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
  captionEditWas,
  clearGraphicRect,
  splitCues,
  dropHiddenCues,
  clearElementTransform,
  clearTiming,
  reclampPinnedTiming,
  resolveTheme,
  setElementTransform,
} from "../src/overrides";
import { defaultTheme, type SceneCue } from "../src/scene-schema";

const cue = (id: string): SceneCue => ({
  id,
  layout: "video-top",
  component: "StatCard",
  props: { label: "CODE CHURN", value: "861%", inverted: false },
  startSec: 0,
  endSec: 5,
});

describe("override document", () => {
  it("defaults to an empty doc", () => {
    const doc = OverrideDocSchema.parse({});
    expect(doc.scenes).toEqual({});
    expect(doc.theme).toEqual({});
  });

  it("applies prop overrides over the producer's props", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { props: { value: "999%" } } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.props!.value).toBe("999%");
    // Untouched props survive — this is a merge, not a replacement.
    expect(cues[0]!.props!.label).toBe("CODE CHURN");
  });

  it("reports overrides whose scene no longer exists instead of dropping them silently", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-7": { props: { value: "1%" } } },
    });
    const { cues, orphans } = applyOverrides([cue("scene-0")], doc);
    expect(orphans).toEqual(["scene-7"]);
    expect(cues[0]!.props!.value).toBe("861%");
  });

  it("carries element transforms onto the cue", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { elements: { value: { dx: 12, dy: -4, scale: 1.08 } } } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.elements).toEqual({ value: { dx: 12, dy: -4, scale: 1.08 } });
  });

  it("applies scene timing overrides, which is what pinning means", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { timing: { startSec: 2, endSec: 6 } } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.startSec).toBe(2);
    expect(cues[0]!.endSec).toBe(6);
    expect(cues[0]!.pinned).toBe(true);
  });

  it("leaves an unpinned cue's derived timing alone", () => {
    const { cues } = applyOverrides([cue("scene-0")], OverrideDocSchema.parse({}));
    expect(cues[0]!.startSec).toBe(0);
    expect(cues[0]!.pinned).toBeFalsy();
  });

  it("merges theme tokens over the defaults", () => {
    const doc = OverrideDocSchema.parse({ theme: { accent: "#FF0000" } });
    const theme = resolveTheme(defaultTheme, doc);
    expect(theme.accent).toBe("#FF0000");
    expect(theme.bg).toBe(defaultTheme.bg);
  });

  it("sets and clears an element transform, and clearing REMOVES the entry", () => {
    // "reset" and "nudged to exactly 0,0" must stay distinguishable, so a
    // reset deletes rather than writing zeros.
    let doc = OverrideDocSchema.parse({});
    doc = setElementTransform(doc, "scene-0", "value", { dx: 5 });
    expect(doc.scenes["scene-0"]!.elements!.value).toEqual({ dx: 5 });
    doc = clearElementTransform(doc, "scene-0", "value");
    expect(doc.scenes["scene-0"]?.elements?.value).toBeUndefined();
  });

  it("merges successive transform patches instead of replacing them", () => {
    let doc = OverrideDocSchema.parse({});
    doc = setElementTransform(doc, "scene-0", "value", { dx: 5 });
    doc = setElementTransform(doc, "scene-0", "value", { dy: -3 });
    expect(doc.scenes["scene-0"]!.elements!.value).toEqual({ dx: 5, dy: -3 });
  });

  it("sets and clears a timing override, and clearing REMOVES the entry", () => {
    // Same distinction as `clearElementTransform`: un-pinning must go back to
    // tracking words, not merely happen to land on the same numbers, so the
    // override has to be deleted rather than left in place.
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { timing: { startSec: 2, endSec: 6 } } },
    });
    expect(doc.scenes["scene-0"]!.timing).toEqual({ startSec: 2, endSec: 6 });
    const cleared = clearTiming(doc, "scene-0");
    expect(cleared.scenes["scene-0"]?.timing).toBeUndefined();
    // A scene with no override at all is left alone rather than throwing.
    expect(clearTiming(OverrideDocSchema.parse({}), "scene-9")).toEqual(OverrideDocSchema.parse({}));
  });

  it("swaps a scene's component and yields valid props for the NEW component", () => {
    // The base cue is a StatCard (label/value/inverted) — none of those mean
    // anything to a FlowDiagram, so a swap must not pass them through.
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { component: "FlowDiagram" } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.component).toBe("FlowDiagram");
    // Falls back to the new component's defaults rather than carrying over
    // StatCard's incompatible props.
    expect(cues[0]!.props).toEqual({ nodes: ["A", "B"], emphasizeLast: true });
  });

  it("applies a component swap's own prop overrides on top of the new defaults", () => {
    const doc = OverrideDocSchema.parse({
      scenes: {
        "scene-0": { component: "FlowDiagram", props: { nodes: ["ONE", "TWO", "THREE"] } },
      },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.props!.nodes).toEqual(["ONE", "TWO", "THREE"]);
  });

  it("swaps a scene's layout", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { layout: "full-bleed" } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.layout).toBe("full-bleed");
    // Untouched — a layout swap doesn't imply a component swap.
    expect(cues[0]!.component).toBe("StatCard");
  });

  it("never drops a scene on a component swap, even with garbage prop overrides", () => {
    const doc = OverrideDocSchema.parse({
      scenes: {
        // `nodes` requires 2-5 strings min length 1 — this satisfies neither,
        // so `resolveSceneProps` returns null and the fallback must kick in.
        "scene-0": { component: "FlowDiagram", props: { nodes: "not-an-array" } },
      },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.component).toBe("FlowDiagram");
    // Guaranteed-valid fallback: the registry's own defaults for the new component.
    expect(cues[0]!.props).toEqual({ nodes: ["A", "B"], emphasizeLast: true });
  });
});

describe("override layer survives a re-plan (BRAINSTORM §4.6)", () => {
  it("keeps hand edits when the producer re-rolls props", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { props: { value: "999%" } } },
    });
    // The producer re-plans and returns entirely new copy for the same scene.
    const replanned: SceneCue = { ...cue("scene-0"), props: { label: "NEW LABEL", value: "12%", inverted: false } };
    const { cues } = applyOverrides([replanned], doc);
    expect(cues[0]!.props!.label).toBe("NEW LABEL"); // producer's new copy lands
    expect(cues[0]!.props!.value).toBe("999%");      // the user's edit wins
  });

  // "the most likely thing to break": a pin freezes ABSOLUTE time precisely
  // so a `--cleanup` level change (which re-derives every unpinned cue's
  // timing from scratch) can't silently drag a pinned scene along with it —
  // that's the entire point of pinning. An unpinned scene has no such
  // promise: it's SUPPOSED to track wherever the new cut places its words.
  it("keeps a pinned scene at its absolute time across a --cleanup change, while an unpinned one re-anchors", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { timing: { startSec: 10, endSec: 14 } } },
    });
    // "Before": a `standard`-cleanup run assembled these two cues.
    const before = [cue("scene-0"), { ...cue("scene-1"), startSec: 5, endSec: 9 }];
    const { cues: beforeCues } = applyOverrides(before, doc);
    expect(beforeCues[0]!.startSec).toBe(10);
    expect(beforeCues[0]!.pinned).toBe(true);

    // "After": re-running with `--cleanup aggressive` cut more silence, so
    // the assembler derives an entirely different (earlier) window for the
    // UNPINNED scene — same scene ids, new timing, exactly what a re-plan
    // produces.
    const after = [cue("scene-0"), { ...cue("scene-1"), startSec: 3, endSec: 6 }];
    const { cues: afterCues } = applyOverrides(after, doc);
    // The pinned scene didn't move a millisecond...
    expect(afterCues[0]!.startSec).toBe(10);
    expect(afterCues[0]!.endSec).toBe(14);
    expect(afterCues[0]!.pinned).toBe(true);
    // ...but the unpinned one tracked the re-plan's new derived timing.
    expect(afterCues[1]!.startSec).toBe(3);
    expect(afterCues[1]!.endSec).toBe(6);
    expect(afterCues[1]!.pinned).toBeFalsy();
  });
});

describe("reclampPinnedTiming (produce-side re-clamp after a re-plan)", () => {
  it("leaves a pinned cue alone when it still fits between its neighbours", () => {
    const cues: SceneCue[] = [
      { ...cue("scene-0"), startSec: 0, endSec: 4 },
      { ...cue("scene-1"), startSec: 5, endSec: 9, pinned: true },
      { ...cue("scene-2"), startSec: 10, endSec: 14 },
    ];
    const { cues: out, adjusted } = reclampPinnedTiming(cues);
    expect(adjusted).toEqual([]);
    expect(out[1]).toEqual(cues[1]);
  });

  it("clamps a pinned cue that now overlaps a re-planned neighbour", () => {
    // scene-1 was pinned to 5–9s against neighbours that have since moved:
    // the previous scene now runs until 7s, so 5–9 overlaps it.
    const cues: SceneCue[] = [
      { ...cue("scene-0"), startSec: 0, endSec: 7 },
      { ...cue("scene-1"), startSec: 5, endSec: 9, pinned: true },
      { ...cue("scene-2"), startSec: 9.2, endSec: 13 },
    ];
    const { cues: out, adjusted } = reclampPinnedTiming(cues);
    expect(adjusted).toEqual(["scene-1"]);
    expect(out[1]!.startSec).toBeGreaterThanOrEqual(7.05);
    expect(out[1]!.endSec).toBeLessThanOrEqual(9.2 - 0.05);
    expect(out[1]!.endSec).toBeGreaterThan(out[1]!.startSec);
    // Neighbours themselves are untouched.
    expect(out[0]).toEqual(cues[0]);
    expect(out[2]).toEqual(cues[2]);
  });
});

describe("per-scene video framing override", () => {
  const cue = {
    id: "s1",
    layout: "pip-bubble" as const,
    component: "TitleCard" as const,
    props: { title: "X" },
    startSec: 0,
    endSec: 5,
  };

  it("reaches the cue so the stage can zoom the bubble out", () => {
    // The pip case: head at ~120% of a round mask, unfixable by any constant.
    const doc = OverrideDocSchema.parse({ scenes: { s1: { video: { scale: 0.62, dy: -18 } } } });
    const { cues } = applyOverrides([cue], doc);
    expect(cues[0]!.video).toEqual({ scale: 0.62, dy: -18 });
  });

  it("is absent when untouched, so an unedited scene carries no transform", () => {
    const { cues } = applyOverrides([cue], OverrideDocSchema.parse({}));
    expect(cues[0]!.video).toBeUndefined();
  });

  it("refuses a non-positive or absurd scale rather than rendering a blank frame", () => {
    expect(() => OverrideDocSchema.parse({ scenes: { s1: { video: { scale: 0 } } } })).toThrow();
    expect(() => OverrideDocSchema.parse({ scenes: { s1: { video: { scale: 99 } } } })).toThrow();
  });
});

import { applyCaptionEdits } from "../src/overrides";

describe("applyCaptionEdits (caption retype, scope (a))", () => {
  const lines = [
    { start: 0, end: 1, words: [
      { text: "double", start: 0, end: 0.5 },
      { text: "scape", start: 0.5, end: 1 },
    ]},
    { start: 1, end: 2, words: [{ text: "quits", start: 1, end: 2 }] },
  ];

  it("replaces the word's TEXT and nothing else — timing is the contract", () => {
    const { lines: out, dropped } = applyCaptionEdits(lines, {
      "1": { text: "escape", was: "scape" },
    });
    expect(out[0]!.words[1]).toEqual({ text: "escape", start: 0.5, end: 1 });
    expect(out[0]!.words[0]).toEqual(lines[0]!.words[0]);
    expect(dropped).toEqual([]);
  });

  it("indexes across LINES — the stream, not the line, is the id space", () => {
    const { lines: out } = applyCaptionEdits(lines, { "2": { text: "exits", was: "quits" } });
    expect(out[1]!.words[0]!.text).toBe("exits");
  });

  it("drops a stale edit with a report instead of hitting the wrong word", () => {
    // The §17 heard-guard pattern: a cleanup/repair change re-derived the
    // stream, so index 1 is no longer the word this edit knew.
    const { lines: out, dropped } = applyCaptionEdits(lines, {
      "1": { text: "escape", was: "something-else" },
    });
    expect(out[0]!.words[1]!.text).toBe("scape");
    expect(dropped).toEqual([{ index: 1, expected: "something-else", found: "scape" }]);
  });

  it("no edits is the identity", () => {
    expect(applyCaptionEdits(lines, {}).lines).toEqual(lines);
  });
});

describe("dropHiddenCues (PLAN 2026-07-30 Task C)", () => {
  it("drops exactly the hidden cue and reports it — applyOverrides stays 1:1", () => {
    const doc = OverrideDocSchema.parse({ scenes: { "scene-1": { hidden: true } } });
    const input = [cue("scene-0"), { ...cue("scene-1"), startSec: 6, endSec: 10 }];
    // The 1:1 contract this function exists to protect:
    expect(applyOverrides(input, doc).cues).toHaveLength(2);
    const { cues, hidden } = dropHiddenCues(input, doc);
    expect(cues.map((c) => c.id)).toEqual(["scene-0"]);
    expect(hidden).toEqual(["scene-1"]);
  });

  it("is a no-op without hidden overrides, and ignores hidden on unknown ids", () => {
    const doc = OverrideDocSchema.parse({ scenes: { "scene-9": { hidden: true } } });
    const input = [cue("scene-0")];
    const { cues, hidden } = dropHiddenCues(input, doc);
    expect(cues).toEqual(input);
    expect(hidden).toEqual([]);
  });

  it("hidden round-trips through the override schema", () => {
    const doc = OverrideDocSchema.parse({ scenes: { "scene-3": { hidden: true } } });
    expect(doc.scenes["scene-3"]!.hidden).toBe(true);
    // An orphaned edit on a hidden id still reports as an orphan elsewhere —
    // hiding never silently eats the entry.
    const { orphans } = applyOverrides([], doc);
    expect(orphans).toEqual(["scene-3"]);
  });
});

describe("graphicRect override (PLAN 2026-07-31 Task 2)", () => {
  it("round-trips through the schema and lands on the cue", () => {
    const rect = { x: 0.1, y: 0.2, w: 0.5, h: 0.3 };
    const doc = OverrideDocSchema.parse({ scenes: { "scene-0": { graphicRect: rect } } });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.graphicRect).toEqual(rect);
  });

  it("WINS over a rect routing baked into the base cue", () => {
    const routed = { ...cue("scene-0"), graphicRect: { x: 0.05, y: 0.6, w: 0.7, h: 0.2 } };
    const hand = { x: 0.1, y: 0.15, w: 0.6, h: 0.4 };
    const doc = OverrideDocSchema.parse({ scenes: { "scene-0": { graphicRect: hand } } });
    const { cues } = applyOverrides([routed], doc);
    expect(cues[0]!.graphicRect).toEqual(hand);
  });

  it("rejects an off-frame or sub-minimum rect — hand-editable data is validated", () => {
    expect(
      OverrideDocSchema.safeParse({ scenes: { s: { graphicRect: { x: -0.1, y: 0, w: 0.5, h: 0.3 } } } })
        .success,
    ).toBe(false);
    expect(
      OverrideDocSchema.safeParse({ scenes: { s: { graphicRect: { x: 0, y: 0, w: 0.01, h: 0.3 } } } })
        .success,
    ).toBe(false);
  });

  it("clearGraphicRect DELETES the key", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { graphicRect: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 } } },
    });
    const cleared = clearGraphicRect(doc, "scene-0");
    expect("graphicRect" in cleared.scenes["scene-0"]!).toBe(false);
    // Idempotent on a scene without one.
    expect(clearGraphicRect(cleared, "scene-0")).toBe(cleared);
  });

  it("a LAYOUT override drops a baked routed rect — it was computed for the old layout (R13)", () => {
    const routed = { ...cue("scene-0"), graphicRect: { x: 0.05, y: 0.6, w: 0.7, h: 0.2 } };
    const doc = OverrideDocSchema.parse({ scenes: { "scene-0": { layout: "blurred-behind" } } });
    const { cues } = applyOverrides([routed], doc);
    expect(cues[0]!.layout).toBe("blurred-behind");
    expect(cues[0]!.graphicRect).toBeUndefined();
    // Idempotent under the editor's second pass: the cue now carries the new
    // layout, so re-applying the same doc changes nothing further.
    expect(applyOverrides(cues, doc).cues[0]).toEqual(cues[0]);
  });

  it("a hand-set rect still wins even when the layout swaps in the same override", () => {
    const routed = { ...cue("scene-0"), graphicRect: { x: 0.05, y: 0.6, w: 0.7, h: 0.2 } };
    const hand = { x: 0.1, y: 0.15, w: 0.6, h: 0.4 };
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { layout: "blurred-behind", graphicRect: hand } },
    });
    const { cues } = applyOverrides([routed], doc);
    expect(cues[0]!.graphicRect).toEqual(hand);
  });

  it("an override restating the cue's OWN layout keeps the routed rect", () => {
    // The rect was computed for exactly this layout — nothing invalidated it.
    const routed = { ...cue("scene-0"), graphicRect: { x: 0.05, y: 0.6, w: 0.7, h: 0.2 } };
    const doc = OverrideDocSchema.parse({ scenes: { "scene-0": { layout: "video-top" } } });
    const { cues } = applyOverrides([routed], doc);
    expect(cues[0]!.graphicRect).toEqual(routed.graphicRect);
  });
});

describe("caption position override (R15 §56)", () => {
  it("captionY lands on the cue, like every other scene override", () => {
    const doc = OverrideDocSchema.parse({ scenes: { "scene-0": { captionY: 0.3 } } });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.captionY).toBe(0.3);
  });

  it("rejects an off-frame anchor — hand-editable data is validated", () => {
    expect(OverrideDocSchema.safeParse({ scenes: { s: { captionY: 1.5 } } }).success).toBe(false);
    expect(OverrideDocSchema.safeParse({ scenes: { s: { captionY: -0.1 } } }).success).toBe(false);
  });
});

describe("caption scale override (R16 §64)", () => {
  it("captionScale lands on the cue and is bounds-validated", () => {
    const doc = OverrideDocSchema.parse({ scenes: { "scene-0": { captionScale: 1.5 } } });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.captionScale).toBe(1.5);
    expect(OverrideDocSchema.safeParse({ scenes: { s: { captionScale: 5 } } }).success).toBe(false);
    expect(OverrideDocSchema.safeParse({ scenes: { s: { captionScale: 0.05 } } }).success).toBe(
      false,
    );
  });
});

describe("splitCues (R16 §61 — cut a scene at the playhead)", () => {
  const take = (id: string, startSec: number, endSec: number): SceneCue => ({
    id,
    kind: "plain",
    layout: "full-bleed",
    startSec,
    endSec,
  });

  it("cuts a cue into two halves; the second is named by its start time", () => {
    const out = splitCues([cue("scene-0")], [2]);
    expect(out.map((c) => [c.id, c.startSec, c.endSec])).toEqual([
      ["scene-0", 0, 2],
      ["scene-0@2000", 2, 5],
    ]);
    // Everything but the window carries over — the halves stay the scene.
    expect(out[1]!.component).toBe("StatCard");
  });

  it("splits takes exactly like scenes — the feature's real use", () => {
    const out = splitCues([take("take-0", 0, 10)], [4]);
    expect(out.map((c) => c.id)).toEqual(["take-0", "take-0@4000"]);
    expect(out.every((c) => c.kind === "plain")).toBe(true);
  });

  it("a second split of the same cue keeps the first half's ids stable", () => {
    const twice = splitCues([take("take-0", 0, 10)], [6, 3]);
    expect(twice.map((c) => [c.id, c.startSec, c.endSec])).toEqual([
      ["take-0", 0, 3],
      ["take-0@3000", 3, 6],
      ["take-0@6000", 6, 10],
    ]);
  });

  it("refuses a cut that would mint an unusably thin half", () => {
    expect(splitCues([cue("scene-0")], [0.1])).toHaveLength(1);
    expect(splitCues([cue("scene-0")], [5 - 0.1])).toHaveLength(1);
    // …and one that lands on no cue at all (a re-plan moved the material).
    expect(splitCues([cue("scene-0")], [99])).toHaveLength(1);
  });

  it("overrides land on the half ids through the normal pass", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0@2000": { video: { scale: 0.8 } } },
      splits: [2],
    });
    const halves = splitCues([cue("scene-0")], doc.splits);
    const { cues } = applyOverrides(halves, doc);
    expect(cues[1]!.video?.scale).toBe(0.8);
    // The first half is untouched — the halves are independent scenes now.
    expect(cues[0]!.video).toBeUndefined();
  });
});

describe("split halves inherit the original scene's edits (R16 §68)", () => {
  const take = (id: string, startSec: number, endSec: number): SceneCue => ({
    id,
    kind: "plain",
    layout: "full-bleed",
    startSec,
    endSec,
  });

  it("the reported case: a take's caption style reaches the RIGHT half", () => {
    // Caption scale/position on a take only land in the post-split override
    // pass — the right half's `id@ms` had no entry there, so it rendered at
    // the defaults while the left half kept the user's style.
    const doc = OverrideDocSchema.parse({
      scenes: { "take-0": { captionScale: 0.5, captionY: 0.2, video: { scale: 0.8 } } },
      splits: [4],
    });
    const halves = splitCues([take("take-0", 0, 10)], doc.splits);
    const { cues } = applyOverrides(halves, doc);
    for (const half of cues) {
      expect(half.captionScale, half.id).toBe(0.5);
      expect(half.captionY, half.id).toBe(0.2);
      expect(half.video?.scale, half.id).toBe(0.8);
    }
  });

  it("a half's OWN edits win key by key; the rest keeps inheriting", () => {
    const doc = OverrideDocSchema.parse({
      scenes: {
        "take-0": { captionScale: 0.5, captionY: 0.2, video: { scale: 0.8 } },
        "take-0@4000": { captionY: 0.85, video: { dy: 12 } },
      },
      splits: [4],
    });
    const { cues } = applyOverrides(splitCues([take("take-0", 0, 10)], doc.splits), doc);
    const right = cues[1]!;
    expect(right.captionY).toBe(0.85); // own
    expect(right.captionScale).toBe(0.5); // inherited
    // Record-shaped keys merge FIELD-wise: nudging dy must not drop the
    // inherited zoom.
    expect(right.video).toEqual({ scale: 0.8, dy: 12 });
  });

  it("timing and hidden are NOT inherited — they describe the whole scene", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "take-0": { timing: { startSec: 0, endSec: 10 }, hidden: true } },
      splits: [4],
    });
    const { cues } = applyOverrides(splitCues([take("take-0", 0, 10)], doc.splits), doc);
    const right = cues[1]!;
    expect(right.startSec).toBe(4);
    expect(right.pinned).toBeFalsy();
    expect(dropHiddenCues([right], doc).hidden).toEqual([]);
  });

  it("splitting a PINNED scene: the second pass must not restore the full window", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { timing: { startSec: 0, endSec: 5 } } },
      splits: [2],
    });
    // First pass pins, split cuts, second pass re-applies — and used to put
    // the original endSec back on the first half, overlapping the second.
    const { cues: pinned } = applyOverrides([cue("scene-0")], doc);
    const halves = splitCues(pinned, doc.splits);
    const { cues } = applyOverrides(halves, doc);
    expect(cues[0]!.endSec).toBe(2);
    expect(cues[1]!.startSec).toBe(2);
    expect(cues[0]!.pinned).toBe(true);
  });
});

describe("captionEditWas (R15 §59 — re-edit keeps the base guard)", () => {
  it("first edit stores what the caller saw; a re-edit keeps the ORIGINAL was", () => {
    expect(captionEditWas({}, 4, "helo")).toBe("helo");
    // The second editor session sees the LIVE (already-edited) text — storing
    // it as `was` would trip applyCaptionEdits' stale-guard against the base.
    expect(captionEditWas({ "4": { text: "hello", was: "helo" } }, 4, "hello")).toBe("helo");
  });

  it("a re-edit round-trips through applyCaptionEdits instead of being dropped", () => {
    const base = [
      { start: 0, end: 1, words: [{ text: "helo", start: 0, end: 1 }] },
    ];
    const first = { "0": { text: "hello", was: captionEditWas({}, 0, "helo") } };
    const second = {
      "0": { text: "hullo", was: captionEditWas(first, 0, "hello") },
    };
    const { lines, dropped } = applyCaptionEdits(base, second);
    expect(dropped).toEqual([]);
    expect(lines[0]!.words[0]!.text).toBe("hullo");
  });
});

describe("pip override (R14 §52)", () => {
  it("lands on the cue like the video override does", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { layout: "pip-bubble", pip: { cornerRadius: 0.4, x: 0.1, y: 0.6 } } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.pip).toEqual({ cornerRadius: 0.4, x: 0.1, y: 0.6 });
  });

  it("rejects out-of-range values — hand-editable data is validated", () => {
    expect(
      OverrideDocSchema.safeParse({ scenes: { s: { pip: { cornerRadius: 1.5 } } } }).success,
    ).toBe(false);
    expect(OverrideDocSchema.safeParse({ scenes: { s: { pip: { x: -0.2 } } } }).success).toBe(
      false,
    );
  });
});
