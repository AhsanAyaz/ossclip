import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
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
