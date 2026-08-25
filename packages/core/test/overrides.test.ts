import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
  captionEditWas,
  clearGraphicRect,
  legacySplitId,
  mintSplitId,
  remapSceneOverrides,
  splitCues,
  splitThenDropHidden,
  stampSceneAnchors,
  dropHiddenCues,
  clearElementTransform,
  clearTiming,
  reclampPinnedTiming,
  resolveTheme,
  restoreElement,
  setElementTransform,
  type OverrideDoc,
} from "../src/overrides";
import { fillPlainCues } from "../src/fill";
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

  it("carries a hidden element flag onto the cue (PLAN Task 2)", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { elements: { value: { hidden: true } } } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.elements).toEqual({ value: { hidden: true } });
  });

  it("hides an element via setElementTransform, and restoreElement deletes ONLY the hidden key — nudges survive", () => {
    let doc = OverrideDocSchema.parse({});
    doc = setElementTransform(doc, "scene-0", "value", { dx: 5, scale: 1.2 });
    doc = setElementTransform(doc, "scene-0", "value", { hidden: true });
    expect(doc.scenes["scene-0"]!.elements!.value).toEqual({ dx: 5, scale: 1.2, hidden: true });
    doc = restoreElement(doc, "scene-0", "value");
    // The hidden key is gone; the nudge/scale made before the delete is not.
    expect(doc.scenes["scene-0"]!.elements!.value).toEqual({ dx: 5, scale: 1.2 });
  });

  it("restoreElement on an element that isn't hidden is a no-op", () => {
    let doc = OverrideDocSchema.parse({});
    doc = setElementTransform(doc, "scene-0", "value", { dx: 5 });
    expect(restoreElement(doc, "scene-0", "value")).toBe(doc);
    // Also a no-op on a scene/element that doesn't exist at all.
    expect(restoreElement(OverrideDocSchema.parse({}), "scene-9", "value")).toEqual(
      OverrideDocSchema.parse({}),
    );
  });

  it("restoring an entry that was ONLY hidden deletes the key entirely, not just the hidden field (review fix wave)", () => {
    // `elements` merges per ID, not per FIELD (see effectiveOverride) — an
    // empty `{}` leftover would still win that whole-entry merge and
    // permanently shadow an inherited nudge, so the key itself must go.
    let doc = OverrideDocSchema.parse({});
    doc = setElementTransform(doc, "scene-0", "value", { hidden: true });
    doc = restoreElement(doc, "scene-0", "value");
    expect("value" in doc.scenes["scene-0"]!.elements).toBe(false);
  });

  it("hiding an element on the ROOT (review fix wave, Important 1) suppresses it on EVERY resulting half, and restoring the root un-suppresses all of them", () => {
    // The literal review scenario: hide lands on the root BEFORE any split
    // exists, so `elements` (unlike `timing`/`hidden`, which
    // `effectiveOverride` explicitly excludes from inheritance) reaches
    // both halves through the per-id merge. Restore has to target the
    // ROOT's own doc entry — this proves the mechanism that Inspector.tsx's
    // per-row owning-id resolution now dispatches against.
    const take = (): SceneCue => ({
      id: "take-0", kind: "plain", layout: "full-bleed", startSec: 0, endSec: 10,
    });
    let doc = OverrideDocSchema.parse({
      scenes: { "take-0": { elements: { title: { hidden: true } } } },
    });
    let { cues } = applyOverrides(splitCues([take()], [{ at: 4, id: "4000" }]), doc);
    for (const half of cues) {
      expect(half.elements, half.id).toEqual({ title: { hidden: true } });
    }
    doc = restoreElement(doc, "take-0", "title");
    expect("title" in doc.scenes["take-0"]!.elements).toBe(false);
    ({ cues } = applyOverrides(splitCues([take()], [{ at: 4, id: "4000" }]), doc));
    for (const half of cues) {
      expect(half.elements, half.id).toBeUndefined();
    }
  });

  it("a split half's own hide-only entry, once restored, stops shadowing the root's nudge (review fix wave)", () => {
    // The scenario the review named for bundled minor (a): the ROOT carries
    // a nudge, a SPLIT HALF hides the same element (its own entry is only
    // `{hidden:true}`), and restoring that half must let the root's nudge
    // show through again rather than leaving an empty `{}` in its way.
    let doc = OverrideDocSchema.parse({
      scenes: { "take-0": { elements: { title: { dx: 12 } } } },
    });
    doc = setElementTransform(doc, "take-0@4000", "title", { hidden: true });
    expect(doc.scenes["take-0@4000"]!.elements.title).toEqual({ hidden: true });
    doc = restoreElement(doc, "take-0@4000", "title");
    // The half's own entry is gone entirely, not left as `{}`.
    expect("title" in doc.scenes["take-0@4000"]!.elements).toBe(false);
    const halves = splitCues(
      [{ id: "take-0", kind: "plain", layout: "full-bleed", startSec: 0, endSec: 10 } as SceneCue],
      [{ at: 4, id: "4000" }],
    );
    const { cues } = applyOverrides(halves, doc);
    // Both halves now show the ROOT's nudge — nothing left hiding it.
    for (const half of cues) {
      expect(half.elements, half.id).toEqual({ title: { dx: 12 } });
    }
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

describe("scene override anchor (handoff-edit-anchoring)", () => {
  it("round-trips a scene entry's anchor through the doc schema", () => {
    const doc = OverrideDocSchema.parse({
      scenes: {
        "scene-3": { props: {}, elements: {}, anchor: { startWord: 4, endWord: 9 } },
      },
    });
    expect(doc.scenes["scene-3"]!.anchor).toEqual({ startWord: 4, endWord: 9 });
  });

  it("a doc written before the field still parses, anchor-less", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-3": { props: {}, elements: {} } },
    });
    expect(doc.scenes["scene-3"]!.anchor).toBeUndefined();
  });
});

const docWith = (scenes: Record<string, unknown>): OverrideDoc =>
  OverrideDocSchema.parse({ scenes });
const cueFixture = (patch: Partial<SceneCue> & { id: string }): SceneCue => ({
  ...cue(patch.id),
  ...patch,
});

describe("stampSceneAnchors", () => {
  it("stamps a scene entry with its cue's anchor", () => {
    const doc = docWith({ "scene-3": { props: { title: "x" }, elements: {} } });
    const cues = [cueFixture({ id: "scene-3", anchor: { startWord: 4, endWord: 9 } })];
    expect(stampSceneAnchors(doc, cues).scenes["scene-3"]!.anchor).toEqual({
      startWord: 4,
      endWord: 9,
    });
  });

  it("resolves a split half's root for the anchor", () => {
    const doc = docWith({ "scene-3@abc": { props: {}, elements: {} } });
    const cues = [cueFixture({ id: "scene-3@abc", anchor: { startWord: 4, endWord: 9 } })];
    expect(stampSceneAnchors(doc, cues).scenes["scene-3@abc"]!.anchor).toEqual({
      startWord: 4,
      endWord: 9,
    });
  });

  it("re-stamps an entry whose cue anchor changed, and leaves anchor-less cues (takes) unstamped", () => {
    const doc = docWith({
      "scene-3": { props: {}, elements: {}, anchor: { startWord: 0, endWord: 1 } },
      "take-clip0": { props: {}, elements: {} },
    });
    const cues = [
      cueFixture({ id: "scene-3", anchor: { startWord: 4, endWord: 9 } }),
      cueFixture({ id: "take-clip0", kind: "plain" }),
    ];
    const out = stampSceneAnchors(doc, cues);
    expect(out.scenes["scene-3"]!.anchor).toEqual({ startWord: 4, endWord: 9 });
    expect(out.scenes["take-clip0"]!.anchor).toBeUndefined();
  });
});

describe("remapSceneOverrides (handoff-edit-anchoring — the produce-side misapplication guard)", () => {
  it("an edit whose id survives but whose anchor moved does NOT stay on the impostor cue", () => {
    // Old plan: scene-3 was words 40..50. New plan renumbered: words 40..50
    // are now scene-1, and scene-3 is a different moment (words 80..90) —
    // the field case (scene-4: TerminalMock 85..116 in one plan, FlowDiagram
    // 47..57 in the next) that motivated this whole pass.
    const doc = docWith({
      "scene-3": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 50 } },
    });
    const cues = [
      cueFixture({ id: "scene-1", anchor: { startWord: 41, endWord: 49 } }),
      cueFixture({ id: "scene-3", anchor: { startWord: 80, endWord: 90 } }),
    ];
    const { doc: out, notes } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-3"]).toBeUndefined(); // never left on the impostor
    expect(out.scenes["scene-1"]!.props.title).toBe("edited");
    // The entry moves verbatim — re-stamping to the new cue's anchor is the
    // editor's job at next save, not produce's.
    expect(out.scenes["scene-1"]!.anchor).toEqual({ startWord: 40, endWord: 50 });
    expect(notes.some((n) => n.includes("scene-3") && n.includes("scene-1"))).toBe(true);
  });

  it("renumbered plan: the edit follows its anchor to the new id", () => {
    // The old id is simply gone — no impostor, just fewer/renumbered scenes.
    const doc = docWith({
      "scene-11": { props: { title: "edited" }, elements: {}, anchor: { startWord: 20, endWord: 30 } },
    });
    const cues = [cueFixture({ id: "scene-7", anchor: { startWord: 21, endWord: 29 } })];
    const { doc: out, notes } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-11"]).toBeUndefined();
    expect(out.scenes["scene-7"]!.props.title).toBe("edited");
    expect(notes.some((n) => n.includes("scene-11") && n.includes("scene-7"))).toBe(true);
  });

  it("shrunk plan, id also gone: entry survives untouched so applyOverrides orphans and warns as today", () => {
    const entry = { props: { title: "edited" }, elements: {}, anchor: { startWord: 60, endWord: 70 } };
    const doc = docWith({ "scene-5": entry });
    // No cue has these words, and no cue is named scene-5: nothing can
    // misapply, so today's orphan reporting is the right (and only) outcome.
    const cues = [cueFixture({ id: "scene-1", anchor: { startWord: 0, endWord: 10 } })];
    const { doc: out, notes } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-5"]).toEqual(doc.scenes["scene-5"]);
    expect(notes).toEqual([]);
  });

  it("words gone but the id now belongs to a DIFFERENT moment: the entry is PARKED, never left to join the impostor", () => {
    // scene-3's stored anchor (40..50) overlaps nothing in the new plan, but
    // a cue named scene-3 exists with anchor 80..90. Leaving the entry keyed
    // scene-3 would silently misapply — the exact bug. Park it instead.
    const doc = docWith({
      "scene-3": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 50 } },
    });
    const cues = [cueFixture({ id: "scene-3", anchor: { startWord: 80, endWord: 90 } })];
    const { doc: out, notes } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-3"]).toBeUndefined();
    expect(out.scenes["scene-3#orphaned"]!.props.title).toBe("edited"); // data preserved, inert key
    expect(out.scenes["scene-3#orphaned"]!.anchor).toEqual({ startWord: 40, endWord: 50 });
    expect(notes.some((n) => n.includes("parked"))).toBe(true);
  });

  it("a parked entry is rescued when a later plan has its words again", () => {
    // Round-trip of the case above: the anchor is still on the parked entry,
    // so a plan that brings words 40..50 back re-keys it onto that cue.
    const doc = docWith({
      "scene-3#orphaned": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 50 } },
    });
    const cues = [cueFixture({ id: "scene-1", anchor: { startWord: 42, endWord: 48 } })];
    const { doc: out } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-1"]!.props.title).toBe("edited");
    expect(out.scenes["scene-3#orphaned"]).toBeUndefined();
  });

  it("a parked entry matches purely by anchor — a cue reusing its historical id does not capture it", () => {
    // The parked entry's root id (scene-3) is historical, not a claim: a new
    // cue named scene-3 over DIFFERENT words must not shortcut the anchor
    // match and swallow the edit.
    const doc = docWith({
      "scene-3#orphaned": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 50 } },
    });
    const cues = [cueFixture({ id: "scene-3", anchor: { startWord: 80, endWord: 90 } })];
    const { doc: out, notes } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-3#orphaned"]).toEqual(doc.scenes["scene-3#orphaned"]); // still parked
    expect(out.scenes["scene-3"]).toBeUndefined();
    expect(notes).toEqual([]); // parked-and-still-parked is not news on every produce
  });

  it("anchor-less (pre-migration) entries behave exactly as today", () => {
    // Id present but pointing somewhere new — with no anchor there is no
    // identity to check, so: untouched, no note, no new behaviour (§137's
    // no-retroactive-protection posture).
    const doc = docWith({ "scene-3": { props: { title: "edited" }, elements: {} } });
    const cues = [
      cueFixture({ id: "scene-1", anchor: { startWord: 41, endWord: 49 } }),
      cueFixture({ id: "scene-3", anchor: { startWord: 80, endWord: 90 } }),
    ];
    const { doc: out, notes } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-3"]).toEqual(doc.scenes["scene-3"]);
    expect(notes).toEqual([]);
  });

  it("split halves re-key with their root", () => {
    // The cue list is PRE-splitCues, so `scene-1@abc` does not exist yet —
    // the half's entry re-keys by its ROOT id and keeps the split suffix,
    // then matches the half once splitCues runs.
    const doc = docWith({
      "scene-3@abc": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 50 } },
    });
    const cues = [cueFixture({ id: "scene-1", anchor: { startWord: 40, endWord: 50 } })];
    const { doc: out } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-3@abc"]).toBeUndefined();
    expect(out.scenes["scene-1@abc"]!.props.title).toBe("edited");
  });

  it("id match with agreeing anchor is a no-op", () => {
    // PARTIAL overlap on purpose: any shared word means the id still names
    // the same moment (measured plans re-anchored at 100% overlap; partial
    // covers a trimmed/extended scene).
    const doc = docWith({
      "scene-3": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 50 } },
    });
    const cues = [cueFixture({ id: "scene-3", anchor: { startWord: 45, endWord: 60 } })];
    const { doc: out, notes } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-3"]).toEqual(doc.scenes["scene-3"]);
    expect(notes).toEqual([]);
  });

  it("two cues overlap the stored anchor: the larger overlap wins", () => {
    const doc = docWith({
      "scene-9": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 50 } },
    });
    const cues = [
      cueFixture({ id: "scene-1", anchor: { startWord: 48, endWord: 60 } }), // 3 shared words
      cueFixture({ id: "scene-2", anchor: { startWord: 38, endWord: 46 } }), // 7 shared words
    ];
    const { doc: out } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-2"]!.props.title).toBe("edited");
    expect(out.scenes["scene-1"]).toBeUndefined();
    expect(out.scenes["scene-9"]).toBeUndefined();
  });

  it("equal overlap: the cue reusing the stored root id wins for a parked entry, else the earlier cue", () => {
    // The id-preference leg is only reachable for parked entries — an
    // unparked entry whose id overlaps was already kept by the shortcut.
    const parked = docWith({
      "scene-3#orphaned": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 49 } },
    });
    const tie = [
      cueFixture({ id: "scene-2", anchor: { startWord: 40, endWord: 44 }, startSec: 0, endSec: 5 }),
      cueFixture({ id: "scene-3", anchor: { startWord: 45, endWord: 49 }, startSec: 10, endSec: 15 }),
    ];
    expect(remapSceneOverrides(parked, tie).doc.scenes["scene-3"]!.props.title).toBe("edited");

    const noIdMatch = docWith({
      "scene-99": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 49 } },
    });
    const byTime = [
      cueFixture({ id: "scene-8", anchor: { startWord: 45, endWord: 49 }, startSec: 20, endSec: 25 }),
      cueFixture({ id: "scene-5", anchor: { startWord: 40, endWord: 44 }, startSec: 10, endSec: 15 }),
    ];
    expect(remapSceneOverrides(noIdMatch, byTime).doc.scenes["scene-5"]!.props.title).toBe("edited");
  });

  it("two entries re-keying onto one cue: the larger overlap keeps the key, the loser is parked, both are noted", () => {
    const doc = docWith({
      "scene-4": { props: { title: "winner" }, elements: {}, anchor: { startWord: 40, endWord: 50 } }, // 11 shared
      "scene-9": { props: { title: "loser" }, elements: {}, anchor: { startWord: 42, endWord: 46 } }, // 5 shared
    });
    const cues = [cueFixture({ id: "scene-1", anchor: { startWord: 40, endWord: 50 } })];
    const { doc: out, notes } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-1"]!.props.title).toBe("winner");
    expect(out.scenes["scene-9#orphaned"]!.props.title).toBe("loser"); // parked, not dropped
    expect(notes.some((n) => n.includes("scene-4") && n.includes("scene-1"))).toBe(true);
    expect(notes.some((n) => n.includes("scene-9") && n.includes("parked"))).toBe(true);
  });

  it("a re-keyer never evicts a kept entry — an anchor-less incumbent is immovable", () => {
    // scene-1's entry has no anchor, so it must behave EXACTLY as today
    // (stay put, untouched). The re-keyer that wants scene-1 parks instead.
    const doc = docWith({
      "scene-1": { props: { title: "incumbent" }, elements: {} },
      "scene-9": { props: { title: "mover" }, elements: {}, anchor: { startWord: 40, endWord: 50 } },
    });
    const cues = [cueFixture({ id: "scene-1", anchor: { startWord: 40, endWord: 50 } })];
    const { doc: out, notes } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-1"]).toEqual(doc.scenes["scene-1"]);
    expect(out.scenes["scene-9#orphaned"]!.props.title).toBe("mover");
    expect(notes.some((n) => n.includes("scene-9") && n.includes("parked"))).toBe(true);
  });

  it("a park slot already held by a still-parked edit keeps its incumbent; the newcomer is dropped out loud", () => {
    // edit → re-plan parks it → edit again → re-plan again: one inert slot,
    // two edits. The incumbent stays (holds are immovable) and the loss is a
    // note, never a silent overwrite.
    const doc = docWith({
      "scene-3": { props: { title: "newer" }, elements: {}, anchor: { startWord: 60, endWord: 70 } },
      "scene-3#orphaned": { props: { title: "older" }, elements: {}, anchor: { startWord: 40, endWord: 50 } },
    });
    const cues = [cueFixture({ id: "scene-3", anchor: { startWord: 80, endWord: 90 } })];
    const { doc: out, notes } = remapSceneOverrides(doc, cues);
    expect(out.scenes["scene-3#orphaned"]!.props.title).toBe("older");
    expect(out.scenes["scene-3"]).toBeUndefined(); // still never left on the impostor
    expect(notes.some((n) => n.includes("dropped"))).toBe(true);
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

  it("does not carve a PINNED_GAP_SEC gap between two split halves of the same pinned scene (PLAN 2026-08-04 Task 1 follow-up)", () => {
    // What `splitCues` actually produces for a pinned [30,40] scene split at
    // 36.4: both halves keep `pinned: true` and share an EXACT boundary.
    const cues: SceneCue[] = [
      { ...cue("scene-5"), startSec: 0, endSec: 30 },
      { ...cue("scene-6"), startSec: 30, endSec: 36.4, pinned: true },
      { ...cue("scene-6@36400"), startSec: 36.4, endSec: 40, pinned: true },
    ];
    const { cues: out, adjusted } = reclampPinnedTiming(cues);
    // The left half still gets its buffer against the REAL (non-sibling)
    // neighbour before it…
    expect(out[1]!.startSec).toBe(30.05);
    // …but the seam between the two halves stays exactly on the split
    // point — no PINNED_GAP_SEC sliver, and so nothing for `fillPlainCues`
    // to later fill with a spurious plain take between them.
    expect(out[1]!.endSec).toBe(36.4);
    expect(out[2]!.startSec).toBe(36.4);
    expect(out[2]!.endSec).toBe(40);
    expect(adjusted).toEqual(["scene-6"]);
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
  // This fixture has no cutlist and no `TimeMap`, so nothing here relates
  // source time to output time at all. `srcStart` is set equal to `start` as
  // an inert stand-in — NOT because the two coincide (§137). Anything that
  // needs a source time that genuinely differs must build a map.
  const lines = [
    { start: 0, end: 1, words: [
      { text: "double", start: 0, end: 0.5, srcStart: 0 },
      { text: "scape", start: 0.5, end: 1, srcStart: 0.5 },
    ]},
    { start: 1, end: 2, words: [{ text: "quits", start: 1, end: 2, srcStart: 1 }] },
  ];

  it("replaces the word's TEXT and nothing else — timing is the contract", () => {
    const { lines: out, dropped } = applyCaptionEdits(lines, {
      w500: { text: "escape", was: "scape" },
    });
    expect(out[0]!.words[1]).toEqual({ text: "escape", start: 0.5, end: 1, srcStart: 0.5 });
    expect(out[0]!.words[0]).toEqual(lines[0]!.words[0]);
    expect(dropped).toEqual([]);
  });

  it("addresses across LINES — the stream, not the line, is the id space", () => {
    const { lines: out } = applyCaptionEdits(lines, { w1000: { text: "exits", was: "quits" } });
    expect(out[1]!.words[0]!.text).toBe("exits");
  });

  it("drops a stale edit with a report instead of hitting the wrong word", () => {
    // The §17 heard-guard pattern: a cleanup/repair change re-derived the
    // stream, so the word carrying that source anchor is no longer the one
    // this edit knew.
    const { lines: out, dropped } = applyCaptionEdits(lines, {
      w500: { text: "escape", was: "something-else" },
    });
    expect(out[0]!.words[1]!.text).toBe("scape");
    expect(dropped).toEqual([{ key: "w500", expected: "something-else", found: "scape" }]);
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

  it("cuts a cue into two halves; the second is named by the split's id", () => {
    const out = splitCues([cue("scene-0")], [{ at: 2, id: "2000" }]);
    expect(out.map((c) => [c.id, c.startSec, c.endSec])).toEqual([
      ["scene-0", 0, 2],
      ["scene-0@2000", 2, 5],
    ]);
    // Everything but the window carries over — the halves stay the scene.
    expect(out[1]!.component).toBe("StatCard");
  });

  it("splits takes exactly like scenes — the feature's real use", () => {
    const out = splitCues([take("take-0", 0, 10)], [{ at: 4, id: "4000" }]);
    expect(out.map((c) => c.id)).toEqual(["take-0", "take-0@4000"]);
    expect(out.every((c) => c.kind === "plain")).toBe(true);
  });

  it("a second split of the same cue keeps the first half's ids stable", () => {
    const twice = splitCues(
      [take("take-0", 0, 10)],
      [{ at: 6, id: "6000" }, { at: 3, id: "3000" }],
    );
    expect(twice.map((c) => [c.id, c.startSec, c.endSec])).toEqual([
      ["take-0", 0, 3],
      ["take-0@3000", 3, 6],
      ["take-0@6000", 6, 10],
    ]);
  });

  it("both halves of a split graphic cue carry the root's anchor", () => {
    // remapSceneOverrides matches split-half entries by their ROOT id against
    // the pre-split cue list, and stampSceneAnchors stamps halves through the
    // cue's own anchor — both rely on `splitCues` spreading the root cue, so
    // the anchor must ride along verbatim (handoff-edit-anchoring).
    const anchor = { startWord: 4, endWord: 9 };
    const out = splitCues([{ ...cue("scene-0"), anchor }], [{ at: 2, id: "2000" }]);
    expect(out.map((c) => c.anchor)).toEqual([anchor, anchor]);
  });

  it("refuses a cut that would mint an unusably thin half", () => {
    expect(splitCues([cue("scene-0")], [{ at: 0.1, id: "100" }])).toHaveLength(1);
    expect(splitCues([cue("scene-0")], [{ at: 5 - 0.1, id: "4900" }])).toHaveLength(1);
    // …and one that lands on no cue at all (a re-plan moved the material).
    expect(splitCues([cue("scene-0")], [{ at: 99, id: "99000" }])).toHaveLength(1);
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
    // pass — the right half's `id@<split id>` had no entry there, so it
    // rendered at the defaults while the left half kept the user's style.
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

describe("the produce.ts / editor pipeline order (PLAN 2026-08-04 Task 1, bug 3)", () => {
  // Mirrors `produce.ts`'s exact call sequence (App.tsx's live-preview memo
  // duplicates the same order): applyOverrides → splitThenDropHidden →
  // reclampPinnedTiming → fillPlainCues → splitCues → applyOverrides →
  // dropHiddenCues. A unit test on `splitCues`/`dropHiddenCues` alone can't
  // see this bug — it only shows up in the ORDER two correct-in-isolation
  // passes run in.
  function pipeline(routedCues: SceneCue[], doc: OverrideDoc): SceneCue[] {
    const { cues: editedCues } = applyOverrides(routedCues, doc);
    const { cues: visibleCues } = splitThenDropHidden(editedCues, doc);
    const { cues: reclamped } = reclampPinnedTiming(visibleCues);
    const filled = fillPlainCues(reclamped, { outputDurationSec: 40 });
    const split = splitCues(filled, doc.splits);
    const { cues: mergedCues } = applyOverrides(split, doc);
    return dropHiddenCues(mergedCues, doc).cues;
  }

  // Scene before the split scene, so the split scene's window doesn't happen
  // to start the timeline — matching the field case (scene-6 among others).
  const before = (): SceneCue => ({ ...cue("scene-5"), startSec: 0, endSec: 30 });
  const splitScene = (): SceneCue => ({ ...cue("scene-6"), startSec: 30, endSec: 40 });

  it("deleting the split ROOT (the field case: scene-6 + scene-6@36400) leaves the split-off half's graphic intact", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-6": { hidden: true } },
      splits: [36.4],
    });
    const cues = pipeline([before(), splitScene()], doc);
    // The root id is gone — it was deleted.
    expect(cues.find((c) => c.id === "scene-6")).toBeUndefined();
    // The split-off half must SURVIVE as its own graphic cue, not dissolve
    // into the plain fill alongside the root (today: both halves die).
    const right = cues.find((c) => c.id === "scene-6@36400");
    expect(right).toBeDefined();
    expect(right!.kind).not.toBe("plain");
    expect(right!.component).toBe("StatCard");
    expect(right!.startSec).toBe(36.4);
    expect(right!.endSec).toBe(40);
  });

  it("deleting the split-off RIGHT half keeps the left half intact", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-6@36400": { hidden: true } },
      splits: [36.4],
    });
    const cues = pipeline([before(), splitScene()], doc);
    expect(cues.find((c) => c.id === "scene-6@36400")).toBeUndefined();
    const left = cues.find((c) => c.id === "scene-6");
    expect(left).toBeDefined();
    expect(left!.kind).not.toBe("plain");
    expect(left!.component).toBe("StatCard");
    expect(left!.startSec).toBe(30);
    expect(left!.endSec).toBe(36.4);
  });

  it("deleting an UNSPLIT scene still turns its whole window into a plain take, as today", () => {
    const doc = OverrideDocSchema.parse({ scenes: { "scene-6": { hidden: true } } });
    const cues = pipeline([before(), splitScene()], doc);
    expect(cues.find((c) => c.id === "scene-6")).toBeUndefined();
    expect(cues.find((c) => c.id === "scene-6@36400")).toBeUndefined();
    const plain = cues.find((c) => c.startSec === 30 && c.endSec === 40);
    expect(plain).toBeDefined();
    expect(plain!.kind).toBe("plain");
  });

  it("a PINNED scene that is also split leaves no gap between the halves (review finding: splitThenDropHidden's split used to run before reclampPinnedTiming saw the whole cue)", () => {
    // Reviewer's own trace: a scene pinned to [30,40], split at 36.4. Both
    // halves inherit `pinned: true` from `splitCues`, and the ORIGINAL
    // pipeline order (reclamp on the single unsplit cue, split afterward)
    // produced touching halves [30.05, 36.4] / [36.4, 40]. Running
    // `splitCues` before `reclampPinnedTiming` (this task's Step-2 fix)
    // instead saw two separate pinned entries and carved a spurious
    // PINNED_GAP_SEC (0.05s) sliver between them, which `fillPlainCues`
    // would then fill with an unintended plain take — no test in the suite
    // exercised pin+split together, which is how this slipped through.
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-6": { timing: { startSec: 30, endSec: 40 } } },
      splits: [36.4],
    });
    const cues = pipeline([before(), { ...cue("scene-6"), startSec: 30, endSec: 40 }], doc);
    const left = cues.find((c) => c.id === "scene-6");
    const right = cues.find((c) => c.id === "scene-6@36400");
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(left!.pinned).toBe(true);
    expect(right!.pinned).toBe(true);
    // The seam: no gap, and so nothing for fillPlainCues to splice a plain
    // take into between the two halves.
    expect(left!.endSec).toBe(right!.startSec);
    expect(cues.some((c) => c.kind === "plain" && c.startSec >= 30 && c.endSec <= 40)).toBe(
      false,
    );
  });
});

describe("captionEditWas (R15 §59 — re-edit keeps the base guard)", () => {
  it("first edit stores what the caller saw; a re-edit keeps the ORIGINAL was", () => {
    expect(captionEditWas({}, "w4000", "helo")).toBe("helo");
    // The second editor session sees the LIVE (already-edited) text — storing
    // it as `was` would trip applyCaptionEdits' stale-guard against the base.
    expect(captionEditWas({ w4000: { text: "hello", was: "helo" } }, "w4000", "hello")).toBe(
      "helo",
    );
  });

  it("a re-edit round-trips through applyCaptionEdits instead of being dropped", () => {
    const base = [
      // No map in this fixture either: `srcStart` is an inert stand-in, not a
      // claim that source and output time coincide (§137).
      { start: 0, end: 1, words: [{ text: "helo", start: 0, end: 1, srcStart: 0 }] },
    ];
    const first = { w0: { text: "hello", was: captionEditWas({}, "w0", "helo") } };
    const second = {
      w0: { text: "hullo", was: captionEditWas(first, "w0", "hello") },
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

describe("captionsHidden (doc-global captions OFF switch)", () => {
  // Back-compat is the schema's contract: every overrides.json written
  // before this key existed must parse EXACTLY as it always did — no new
  // key defaulted in, so a round-trip through the schema can't grow the
  // user's file.
  it("an old overrides.json parses unchanged, with no captionsHidden defaulted in", () => {
    const doc = OverrideDocSchema.parse({
      theme: { accent: "#FFE14D" },
      scenes: { "scene-0": { props: { value: "1%" } } },
    });
    expect(doc.captionsHidden).toBeUndefined();
    expect("captionsHidden" in doc).toBe(false);
  });

  it("accepts a boolean and nothing else — hand-editable data is validated", () => {
    expect(OverrideDocSchema.parse({ captionsHidden: true }).captionsHidden).toBe(true);
    expect(OverrideDocSchema.parse({ captionsHidden: false }).captionsHidden).toBe(false);
    // parse-don't-coerce: a typo'd "yes" must refuse loudly, never coerce.
    expect(OverrideDocSchema.safeParse({ captionsHidden: "yes" }).success).toBe(false);
  });
});

import {
  captionAnchorOf,
  captionEditsToKeep,
  captionKeyFor,
  migrateCaptionKeys,
  MIGRATION_SEARCH_RADIUS,
} from "../src/overrides";
import type { CaptionLine, CaptionWord } from "../src/captions";

describe("source-anchored caption keys (§137)", () => {
  const line = (...ws: Array<[string, number]>): CaptionLine => ({
    words: ws.map(([text, srcStart], i) => ({ text, start: i, end: i + 1, srcStart })),
    start: 0,
    end: ws.length,
  });

  it("captionKeyFor is millisecond-quantised source time", () => {
    expect(captionKeyFor(2.5)).toBe("w2500");
    expect(captionKeyFor(1.7675)).toBe("w1768");
    expect(captionKeyFor(0)).toBe("w0");
  });

  it("applies an edit by source key, wherever the word has moved to", () => {
    const lines = [line(["status", 5.0], ["edge,", 6.0])];
    const { lines: out, dropped } = applyCaptionEdits(lines, {
      w6000: { text: "Zsh,", was: "edge," },
    });
    expect(out[0]!.words.map((w) => w.text)).toEqual(["status", "Zsh,"]);
    expect(dropped).toEqual([]);
  });

  it("still guards on `was` — a re-plan that changed the word drops the edit", () => {
    const lines = [line(["something-else", 6.0])];
    const { lines: out, dropped } = applyCaptionEdits(lines, {
      w6000: { text: "Zsh,", was: "edge," },
    });
    expect(out[0]!.words[0]!.text).toBe("something-else");
    expect(dropped).toEqual([{ key: "w6000", expected: "edge,", found: "something-else" }]);
  });

  it("an edit whose word the cut removed is reported, not applied", () => {
    const lines = [line(["status", 5.0])];
    const { dropped } = applyCaptionEdits(lines, { w1768: { text: "Bash,", was: "batch," } });
    expect(dropped).toEqual([{ key: "w1768", expected: "batch,", found: null }]);
  });

  it("migrates legacy positional keys by position when `was` still matches", () => {
    const lines = [line(["batch,", 1.7675], ["status", 5.0], ["edge,", 6.0])];
    const { edits, unresolved } = migrateCaptionKeys(
      { "0": { text: "Bash,", was: "batch," }, "2": { text: "Zsh,", was: "edge," } },
      lines,
    );
    expect(edits).toEqual({
      w1768: { text: "Bash,", was: "batch," },
      w6000: { text: "Zsh,", was: "edge," },
    });
    expect(unresolved).toEqual([]);
  });

  it("RECOVERS a legacy key whose position drifted, by finding its `was` nearby", () => {
    // The field case: the cut removed "batch,", so every stored index is off
    // by one. Position 1 now holds "edge,", but the edit's `was` is "status".
    const lines = [line(["status", 5.0], ["edge,", 6.0], ["power", 7.0])];
    const { edits, unresolved } = migrateCaptionKeys(
      { "1": { text: "Zsh", was: "status" } },
      lines,
    );
    expect(edits).toEqual({ w5000: { text: "Zsh", was: "status" } });
    expect(unresolved).toEqual([]);
  });

  it("refuses to guess when `was` is ambiguous nearby", () => {
    // The position must be PROVEN wrong before the search runs: key "3" holds
    // "cat", not the edit's "the", so the outward walk starts — and finds two
    // "the"s it cannot tell apart.
    const lines = [line(["the", 1.0], ["the", 2.0], ["the", 3.0], ["cat", 4.0])];
    const { edits, unresolved } = migrateCaptionKeys({ "3": { text: "a", was: "the" } }, lines);
    expect(edits).toEqual({});
    expect(unresolved).toEqual([{ key: "3", was: "the", reason: "ambiguous" }]);
  });

  it("an exact position hit WINS over an identical word nearby — it is a record, not a guess", () => {
    // Do not "fix" this back into the ambiguity rule (ruling on §137 task 2):
    // the stored index is what the editor recorded when the user made the
    // edit, and the word there BEING `was` is that record confirming itself.
    // Two more "the"s beside it are coincidence and weaken neither fact —
    // gating this on them would stop a never-drifted doc from migrating just
    // because the user edited a common word.
    const lines = [line(["the", 1.0], ["the", 2.0], ["the", 3.0])];
    const { edits, unresolved } = migrateCaptionKeys({ "1": { text: "a", was: "the" } }, lines);
    expect(edits).toEqual({ w2000: { text: "a", was: "the" } });
    expect(unresolved).toEqual([]);
  });

  it("leaves already-migrated source keys alone", () => {
    const lines = [line(["edge,", 6.0])];
    const already = { w6000: { text: "Zsh,", was: "edge," } };
    const { edits, unresolved } = migrateCaptionKeys(already, lines);
    expect(edits).toEqual(already);
    // Asserted too, or a spurious "unresolved" push would pass this test while
    // telling the user their untouched edit could not be migrated.
    expect(unresolved).toEqual([]);
  });

  it("refuses BOTH edits when two of them resolve to the same word", () => {
    // `edits` is a Record, so a migration that wrote as it went would have the
    // second edit silently overwrite the first — one of two retypes gone with
    // an EMPTY report, the exact bug this task exists to fix. "0" exact-hits
    // "the" at index 0; "5" finds "mat" at its own position, searches outward,
    // and lands on that same lone "the".
    const lines = [
      line(["the", 1.0], ["cat", 2.0], ["sat", 3.0], ["on", 4.0], ["a", 5.0], ["mat", 6.0]),
    ];
    const { edits, unresolved } = migrateCaptionKeys(
      { "0": { text: "THE", was: "the" }, "5": { text: "A-THE", was: "the" } },
      lines,
    );
    expect(edits).toEqual({});
    expect(unresolved).toEqual([
      { key: "0", was: "the", reason: "collision" },
      { key: "5", was: "the", reason: "collision" },
    ]);
  });

  it("the SOURCE-KEYED edit wins a collision with a legacy one — this plan's own halfway state", () => {
    // A doc saved before AND after this change holds both key spaces at once,
    // over the same word. Refusing both (the first cut of this function) threw
    // away the newer, current-format edit whose anchor was never in doubt —
    // §137 Task 6 review, Important 3. The legacy claim is the one retired,
    // and it is reported rather than silently dropped.
    const lines = [line(["edge,", 6.0])];
    const { edits, unresolved } = migrateCaptionKeys(
      { "0": { text: "Zsh,", was: "edge," }, w6000: { text: "Fish,", was: "edge," } },
      lines,
    );
    expect(edits).toEqual({ w6000: { text: "Fish,", was: "edge," } });
    expect(unresolved).toEqual([{ key: "0", was: "edge,", reason: "superseded" }]);
  });

  it("a source-keyed edit wins even when the legacy claim comes from the SEARCH", () => {
    // Both routes into the same anchor have to lose to the current format, not
    // just the exact-position one: position 3 holds "cat", so "3" searches
    // outward, finds the lone "edge," and lands on w6000 — which w6000 owns.
    const lines = [line(["cat", 1.0], ["dog", 2.0], ["cow", 3.0], ["cat", 4.0], ["edge,", 6.0])];
    const { edits, unresolved } = migrateCaptionKeys(
      { "3": { text: "Zsh,", was: "edge," }, w6000: { text: "Fish,", was: "edge," } },
      lines,
    );
    expect(edits).toEqual({ w6000: { text: "Fish,", was: "edge," } });
    expect(unresolved).toEqual([{ key: "3", was: "edge,", reason: "superseded" }]);
  });

  /**
   * The bound the whole upgrade's yield hangs off (final review, Important 2).
   * Written against the constant rather than against `8`, so changing the
   * value re-runs the same two questions instead of failing an arithmetic
   * assertion — what these pin is that there IS a boundary, that it sits
   * exactly there, and that the far side reports rather than loses.
   *
   * The fixture puts the `was` at index 0 and stores the edit at index
   * `0 + drift`, i.e. a doc whose positions are `drift` words too HIGH —
   * exactly what a cut removing `drift` caption words leaves behind.
   */
  describe(`MIGRATION_SEARCH_RADIUS (${MIGRATION_SEARCH_RADIUS})`, () => {
    /** `was` at 0, then `n` distinct filler words, all anchorable. */
    const driftLines = (n: number): CaptionLine[] => [
      line(["batch,", 1], ...Array.from({ length: n }, (_, i): [string, number] => [`w${i}`, i + 2])),
    ];
    const migrateAtDrift = (drift: number) =>
      migrateCaptionKeys(
        { [String(drift)]: { text: "bash,", was: "batch," } },
        driftLines(drift + 1),
      );

    it("recovers an edit that drifted EXACTLY the radius", () => {
      const { edits, unresolved } = migrateAtDrift(MIGRATION_SEARCH_RADIUS);
      expect(edits).toEqual({ w1000: { text: "bash,", was: "batch," } });
      expect(unresolved).toEqual([]);
    });

    it("REPORTS one word further as out-of-range — it never says the cut removed it", () => {
      // Past the radius the word is sitting on screen untouched, so the
      // `not-found` sentence ("the cut removed it") would send the user to
      // redo visible work. And `captionEditsToKeep` keeps it, so a later run
      // with less drift can still place it.
      const migration = migrateAtDrift(MIGRATION_SEARCH_RADIUS + 1);
      expect(migration.edits).toEqual({});
      expect(migration.unresolved).toEqual([
        { key: String(MIGRATION_SEARCH_RADIUS + 1), was: "batch,", reason: "out-of-range" },
      ]);
      expect(captionEditsToKeep({ [String(MIGRATION_SEARCH_RADIUS + 1)]: { text: "bash,", was: "batch," } }, migration)).toEqual({
        [String(MIGRATION_SEARCH_RADIUS + 1)]: { text: "bash,", was: "batch," },
      });
    });

    it("still says `not-found` when the word really is gone, at any distance", () => {
      // The distinction has to survive the new full scan: `out-of-range` means
      // the word EXISTS somewhere, and the field case's "batch," genuinely
      // does not.
      const { unresolved } = migrateCaptionKeys(
        { "20": { text: "bash,", was: "batch," } },
        [line(["status", 1], ["edge,", 2])],
      );
      expect(unresolved).toEqual([{ key: "20", was: "batch,", reason: "not-found" }]);
    });
  });

  it("names the cause: a word that is simply gone is `not-found`, not a collision", () => {
    // Minor 7 — the four causes need four different things from the user, and
    // one message blaming the cut sends them looking for a word that is still
    // on screen.
    const lines = [line(["status", 5.0])];
    const { edits, unresolved } = migrateCaptionKeys({ "0": { text: "Zsh", was: "gone" } }, lines);
    expect(edits).toEqual({});
    expect(unresolved).toEqual([{ key: "0", was: "gone", reason: "not-found" }]);
  });

  it("refuses two edits on words that SHARE a source instant", () => {
    // Not float trivia: `backfillSrcStart` (captions.ts:44-50) maps a seam
    // preimage and a cut-clamped word onto the same source instant by design,
    // so the recovery path manufactures duplicate keys.
    const lines = [line(["hello", 2.5], ["hello", 2.5])];
    const { edits, unresolved } = migrateCaptionKeys(
      { "0": { text: "HI", was: "hello" }, "1": { text: "YO", was: "hello" } },
      lines,
    );
    expect(edits).toEqual({});
    expect(unresolved).toEqual([
      { key: "0", was: "hello", reason: "collision" },
      { key: "1", was: "hello", reason: "collision" },
    ]);
  });

  it("applies to AT MOST ONE word when two share a key — no fan-out", () => {
    // Both round to w2500. A plain .map() rewrote both, so a word the user
    // never touched changed silently.
    const lines = [line(["hello", 2.4996], ["hello", 2.5004])];
    const { lines: out, dropped } = applyCaptionEdits(lines, {
      w2500: { text: "HI", was: "hello" },
    });
    expect(out[0]!.words.map((w) => w.text)).toEqual(["HI", "hello"]);
    expect(dropped).toEqual([
      { key: "w2500", expected: "hello", found: "hello", reason: "duplicate-anchor" },
    ]);
  });

  it("a shared key whose second word differs is reported, never applied twice", () => {
    // The mixed case: without the seen-check the edit was BOTH applied (to the
    // first word) and reported dropped (against the second) for one key.
    const lines = [line(["hello", 2.4996], ["goodbye", 2.5004])];
    const { lines: out, dropped } = applyCaptionEdits(lines, {
      w2500: { text: "HI", was: "hello" },
    });
    expect(out[0]!.words.map((w) => w.text)).toEqual(["HI", "goodbye"]);
    expect(dropped).toEqual([
      { key: "w2500", expected: "hello", found: "goodbye", reason: "duplicate-anchor" },
    ]);
  });

  /**
   * A pre-§137 line as the editor really loads one: NO `srcStart` at all. The
   * render-props boundary is an unvalidated cast (captions.ts:33-39), so this
   * shape typechecks as a `CaptionLine` in production too — the editor's own
   * e2e fixture (apps/editor/e2e/fixtures/workdir/render-props.json) is
   * exactly this, kept on purpose as the only checked-in legacy artefact.
   */
  const legacyLine = (...ws: Array<[string, number]>): CaptionLine => ({
    words: ws.map(([text, start]) => ({ text, start, end: start + 0.5 }) as CaptionWord),
    start: 0,
    end: ws.length,
  });

  it("a word with NO srcStart carries no edit — reported, never a white screen", () => {
    // The §137 review's field case: `captionKeyFor` throwing is right for a
    // programmer error, but the editor applies edits inside a render-time
    // useMemo with no error boundary, so throwing on a legacy FILE takes the
    // whole editor down over data that merely predates the field.
    const lines = [legacyLine(["hello", 0], ["world", 0.5])];
    const edits = { w0: { text: "HI", was: "hello" }, w500: { text: "YO", was: "world" } };
    expect(() => applyCaptionEdits(lines, edits)).not.toThrow();
    const { lines: out, dropped } = applyCaptionEdits(lines, edits);
    expect(out).toEqual(lines);
    expect(dropped).toEqual([
      { key: "w0", expected: "hello", found: null },
      { key: "w500", expected: "world", found: null },
    ]);
  });

  it("migrates nothing off unanchorable words — every edit comes back unresolved", () => {
    const lines = [legacyLine(["hello", 0], ["world", 0.5])];
    const call = () =>
      migrateCaptionKeys(
        { "0": { text: "HI", was: "hello" }, "1": { text: "YO", was: "world" } },
        lines,
      );
    expect(call).not.toThrow();
    const { edits, unresolved } = call();
    expect(edits).toEqual({});
    expect(unresolved).toEqual([
      { key: "0", was: "hello", reason: "unanchorable" },
      { key: "1", was: "world", reason: "unanchorable" },
    ]);
  });

  it("an unanchorable word found by the SEARCH is unresolved too, not a crash", () => {
    // The other way into `captionAnchorOf`: position 1 holds "cat", so the
    // exact hit misses and the outward walk runs — and the lone "hello" it
    // finds has no srcStart to key on either. Covered separately because the
    // test above only exercises the exact-hit path, which left this one
    // silently unguarded (§137 review mutation N9).
    const lines = [legacyLine(["hello", 0], ["cat", 0.5])];
    const call = () => migrateCaptionKeys({ "1": { text: "HI", was: "hello" } }, lines);
    expect(call).not.toThrow();
    expect(call().edits).toEqual({});
    expect(call().unresolved).toEqual([{ key: "1", was: "hello", reason: "unanchorable" }]);
  });

  it("REFUSES a non-finite srcStart instead of minting one `wNaN` for the whole video", () => {
    // The render-props boundary is an unvalidated cast (captions.ts:33-39), so
    // a pre-§137 file yields words with no srcStart at all. Coerced, every one
    // of them keys to "wNaN" and a single edit rewrites the entire video.
    expect(() => captionKeyFor(Number.NaN)).toThrow(/finite srcStart/);
    expect(() => captionKeyFor(undefined as unknown as number)).toThrow(/finite srcStart/);
    expect(() => captionKeyFor(Number.POSITIVE_INFINITY)).toThrow(/finite srcStart/);
  });
});

describe("captionAnchorOf — the tolerant form callers outside core must use (§137)", () => {
  const word = (srcStart: unknown): CaptionWord =>
    ({ text: "batch,", start: 1.2, end: 1.5, srcStart }) as CaptionWord;

  it("returns the same key captionKeyFor would, for an anchorable word", () => {
    expect(captionAnchorOf(word(1.7675))).toBe("w1768");
    expect(captionAnchorOf(word(1.7675))).toBe(captionKeyFor(1.7675));
  });

  it("returns null instead of throwing for every shape a pre-§137 file can hold", () => {
    // The whole reason this is exported (§137 Task 5): the editor calls it
    // from a React event handler with no error boundary above it, so the
    // throw `captionKeyFor` owes a programmer error would be a crash on any
    // workdir produced before the field existed.
    expect(captionAnchorOf(undefined)).toBeNull();
    expect(captionAnchorOf(word(undefined))).toBeNull();
    expect(captionAnchorOf(word(Number.NaN))).toBeNull();
    expect(captionAnchorOf(word(Number.POSITIVE_INFINITY))).toBeNull();
  });

  it("treats 0 as a real anchor, not as absent", () => {
    // A word at the very start of the source is anchorable; a falsy-check
    // instead of a finite-check would silently make the first word of every
    // video un-retypable.
    expect(captionAnchorOf(word(0))).toBe("w0");
  });
});

/**
 * The rule both write-backs share (final review, Critical 1). It used to be
 * `migration.edits` at each call site, which is a DELETE of every edit the
 * migration could not place — on a run the user only asked to render.
 */
describe("captionEditsToKeep — what survives a migration (§137)", () => {
  const edit = (was: string) => ({ text: was.toUpperCase(), was });

  it("keeps everything the migration placed", () => {
    const m = { edits: { w1768: edit("batch,") }, unresolved: [] };
    expect(captionEditsToKeep({ "0": edit("batch,") }, m)).toEqual({ w1768: edit("batch,") });
  });

  it("KEEPS an unresolved edit under its original key — a repair it cannot do is not a delete", () => {
    // The whole finding: next run, against a different cut, this may place.
    // Deleting it forecloses that permanently and nobody asked for a delete.
    for (const reason of ["not-found", "out-of-range", "ambiguous", "unanchorable", "collision"] as const) {
      const before = { "3": edit("batch,") };
      const m = { edits: {}, unresolved: [{ key: "3", was: "batch,", reason }] };
      expect(captionEditsToKeep(before, m)).toEqual(before);
    }
  });

  it("retires ONLY `superseded` — the one case that is not a loss", () => {
    // A newer source-keyed edit already covers that word, so keeping the older
    // legacy duplicate would re-report the same collision forever.
    const before = { "0": edit("edge,"), w6000: { text: "Fish,", was: "edge," } };
    const m = {
      edits: { w6000: { text: "Fish,", was: "edge," } },
      unresolved: [{ key: "0", was: "edge,", reason: "superseded" as const }],
    };
    expect(captionEditsToKeep(before, m)).toEqual({ w6000: { text: "Fish,", was: "edge," } });
  });

  it("never lets a preserved key overwrite a placed one", () => {
    // Structural: a preserved key is legacy (a source key always resolves to
    // itself and wins its anchor), a placed key is always `w<ms>`. Pinned so a
    // future reason that CAN carry a source key does not silently clobber.
    const before = { "0": edit("the"), "5": edit("the") };
    const m = {
      edits: { w1000: edit("the") },
      unresolved: [{ key: "5", was: "the", reason: "collision" as const }],
    };
    expect(captionEditsToKeep(before, m)).toEqual({ w1000: edit("the"), "5": edit("the") });
  });

  it("is a no-op for the ordinary already-source-keyed doc", () => {
    const before = { w6000: edit("edge,") };
    expect(captionEditsToKeep(before, { edits: before, unresolved: [] })).toEqual(before);
  });
});

describe("stable split ids (§137)", () => {
  const cue = (id: string, startSec: number, endSec: number): SceneCue =>
    ({ id, startSec, endSec }) as SceneCue;

  it("a legacy numeric split parses into {at, id} with the id derived from its ORIGINAL ms", () => {
    // Load-bearing: an existing overrides.json has `scene-0@600` hidden, and
    // that key must still match after the upgrade.
    const doc = OverrideDocSchema.parse({ splits: [0.6] });
    expect(doc.splits).toEqual([{ at: 0.6, id: "600" }]);
  });

  it("names the second half from the id, not from the split time", () => {
    const out = splitCues([cue("scene-0", 0, 6)], [{ at: 0.6, id: "600" }]);
    expect(out.map((c) => c.id)).toEqual(["scene-0", "scene-0@600"]);
  });

  it("re-anchoring the split time does NOT rename the half — the field-case fix", () => {
    // Same id, moved earlier by a re-cut. The half keeps its name, so a
    // `hidden` override on it survives.
    const out = splitCues([cue("scene-0", 0, 6)], [{ at: 1.2, id: "600" }]);
    expect(out.map((c) => c.id)).toEqual(["scene-0", "scene-0@600"]);
    expect(out[1]!.startSec).toBeCloseTo(1.2, 3);
  });

  it("derives a half id from the ROOT id, never chaining", () => {
    const out = splitCues(
      [cue("take-0", 0, 10)],
      [{ at: 3, id: "3000" }, { at: 6, id: "6000" }],
    );
    expect(out.map((c) => c.id)).toEqual(["take-0", "take-0@3000", "take-0@6000"]);
  });

  it("still hides the half the user deleted, matched by the stable id", () => {
    const doc = OverrideDocSchema.parse({
      splits: [{ at: 1.2, id: "600" }],
      scenes: { "scene-0@600": { hidden: true } },
    });
    const { cues, hidden } = splitThenDropHidden([cue("scene-0", 0, 6)], doc);
    expect(cues.map((c) => c.id)).toEqual(["scene-0"]);
    expect(hidden).toEqual(["scene-0@600"]);
  });
});

describe("minting a split id (§137)", () => {
  it("mints exactly the legacy id when nothing holds it — a first split is unchanged", () => {
    expect(mintSplitId(1.2, [])).toBe("1200");
    expect(mintSplitId(1.2, [{ at: 4, id: "4000" }])).toBe("1200");
    // Same derivation `legacySplitId` guarantees for the migration, so a
    // split made today and one upgraded from disk are named alike.
    expect(mintSplitId(0.6, [])).toBe(legacySplitId(0.6));
  });

  it("disambiguates against a RE-ANCHORED split that still holds that id", () => {
    // The whole point of §137 is that `id` does NOT move with `at`, so the
    // time a split was minted from can come round again.
    expect(mintSplitId(1.2, [{ at: 0.6, id: "1200" }])).toBe("1200-2");
    expect(mintSplitId(1.2, [{ at: 0.6, id: "1200" }, { at: 0.9, id: "1200-2" }])).toBe("1200-3");
  });

  it("is deterministic — the same doc mints the same id every time", () => {
    // Persisted data: a random or clock-derived suffix would make a half's
    // name unreproducible, which is the property this whole task restored.
    const existing = [{ at: 0.6, id: "1200" }];
    expect(mintSplitId(1.2, existing)).toBe(mintSplitId(1.2, existing));
  });
});

describe("split times are parsed, never coerced (§137)", () => {
  it("REFUSES a non-finite split time instead of deriving `id: \"Infinity\"`", () => {
    // `1e400` is how a non-finite number actually reaches us: JSON has no
    // Infinity literal, but an overflowing one parses to it. `nonnegative()`
    // alone admits it, and the derived id would be the string "Infinity" —
    // one shared name for every such split, the same garbage-key failure
    // `captionKeyFor` refuses for caption words.
    expect(() => OverrideDocSchema.parse(JSON.parse('{"splits":[1e400]}'))).toThrow();
    expect(() =>
      OverrideDocSchema.parse({ splits: [{ at: Number.POSITIVE_INFINITY, id: "1200" }] }),
    ).toThrow();
    expect(() => OverrideDocSchema.parse({ splits: [{ at: Number.NaN, id: "1200" }] })).toThrow();
  });
});

import { backfillSrcStart } from "../src/captions";
import type { KeptSpan } from "../src/timemap";

/**
 * The bug this whole section exists for, replayed on the data it happened to.
 *
 * Everything above tests the machinery a piece at a time; this is the field
 * case itself — the user's own `overrides.json.bak` and the `spans` and word
 * timings from the same workdir's `render-props.json`, so a regression shows
 * up as THIS user's edits vanishing again rather than as an abstract failure.
 */
describe("§137 field case: Starship V2-e89a046b, 2026-08-12", () => {
  /**
   * The caption words as they stood AFTER the user's 0.6s cut, from the
   * workdir's render-props.json — `[text, outputStart]`, in order, starts
   * rounded to 0.1ms (keys are millisecond-quantised, so the rounding cannot
   * reach an assertion). The real file splits these across 28 lines; the
   * migration and the apply both flatten (`lines.flatMap`), so the grouping is
   * not what this test is about and one line keeps the fixture readable.
   *
   * Two facts do the work: the cut removed the word "batch," that used to sit
   * at index 0, so EVERY stored index is one too high, and no word carries a
   * `srcStart` at all — the file predates the field.
   */
  const WORDS: Array<[string, number]> = [
    ["status", 0], ["edge,", 1.1225], ["power", 2.4725], ["shell", 2.5025], ["and", 2.6325],
    ["fish.", 3.4025], ["This", 3.6325], ["Starship", 3.7369], ["59,000", 3.8565],
    ["stars", 5.3665], ["on", 5.7265], ["GitHub.", 6.3265], ["And", 6.7265], ["this", 6.9765],
    ["is", 7.3065], ["what", 7.4665], ["it", 7.8565], ["looks", 7.9565], ["like", 8.3665],
    ["when", 8.7265], ["I'm", 8.9665], ["running", 9.3665], ["it", 9.5865], ["on", 9.7265],
    ["my", 10.2265], ["terminals.", 10.7265], ["So", 10.7765], ["whether", 10.8965],
    ["it's", 11.5065], ["Windows,", 11.8565], ["Mac,", 12.6965], ["Linux,", 13.2065],
    ["it", 13.7265], ["looks", 13.9565], ["the", 14.5365], ["same.", 14.9965],
    ["you", 15.6188], ["the", 15.6696], ["grid", 16.0096], ["branch,", 16.2296],
    ["node", 16.8796], ["version,", 17.4196], ["Python", 17.8796], ["version", 18.1496],
    ["at", 18.4596], ["a", 18.5496], ["glance.", 18.5896], ["And", 18.8796],
    ["every", 19.1796], ["prompt", 19.6996], ["has", 20.3196], ["the", 20.7196],
    ["same", 20.9396], ["shell.", 21.5196], ["Comment", 21.8796], ["Starship", 22.2696],
    ["to", 22.7196], ["get", 22.8396], ["the", 23.0096], ["link", 23.1696], ["in", 23.3896],
    ["your", 23.4996], ["DM.", 23.7196],
  ];

  /** The same file's `spans` — three kept ranges, i.e. two earlier cuts plus this one. */
  const SPANS: KeptSpan[] = [
    { srcIn: 2.3675, srcOut: 6.104438, outIn: 0, outOut: 3.736938 },
    { srcIn: 7.010437, srcOut: 18.89225, outIn: 3.736938, outOut: 15.618751 },
    { srcIn: 19.739188, srcOut: 28.604, outIn: 15.618751, outOut: 24.483563 },
  ];

  /** `overrides.json.bak`'s `captions`, verbatim — the four retypes that vanished. */
  const SAVED = {
    "0": { text: "The same prompt for bash,", was: "batch," },
    "1": { text: "zsh", was: "status" },
    "2": { text: ",", was: "edge," },
    "39": { text: "git", was: "grid" },
  };

  /** As the editor loads them: no `srcStart` on any word, past the cast. */
  const legacyLines = [
    {
      start: WORDS[0]![1],
      end: 24.4836,
      words: WORDS.map(([text, start], i) => ({ text, start, end: WORDS[i + 1]?.[1] ?? 24.4836 })),
    },
  ] as unknown as CaptionLine[];

  it("recovers three of the four retypes a 0.6s cut orphaned, and NAMES the fourth", () => {
    const lines = backfillSrcStart(legacyLines, SPANS);

    const { edits, unresolved } = migrateCaptionKeys(SAVED, lines);

    // Every stored index is one too high, and every one of these was proven
    // wrong at its own position and then found one word earlier.
    expect(edits).toEqual({
      w2368: { text: "zsh", was: "status" },
      w3490: { text: ",", was: "edge," },
      w20130: { text: "git", was: "grid" },
    });
    // "batch," is the word the cut actually removed, so there is nothing to
    // re-anchor it to. Reported by name and reason — silence here is what let
    // the original bug reach a rendered video.
    expect(unresolved).toEqual([{ key: "0", was: "batch,", reason: "not-found" }]);

    const { lines: out, dropped } = applyCaptionEdits(lines, edits);
    const words = out.flatMap((l) => l.words).map((w) => w.text);
    expect(words[0]).toBe("zsh");
    expect(words[1]).toBe(",");
    expect(words[38]).toBe("git");
    // The migration already refused everything it could not place, so nothing
    // may fall out on the apply side too.
    expect(dropped).toEqual([]);
  });

  it("still matches the deleted half the user saved — `scene-0@600` after the upgrade", () => {
    // The other key space. The doc names its hidden half `scene-0@600`, and
    // the split it was named after is a bare `0.6`; the upgrade has to derive
    // exactly "600" or the deletion silently stops applying — this file is why
    // `legacySplitId` reproduces the ORIGINAL output milliseconds. Where the
    // re-anchor then MOVES that split is recut.test.ts's half of the case.
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0@600": { hidden: true } },
      splits: [0.6],
    });

    expect(doc.splits).toEqual([{ at: 0.6, id: "600" }]);
    expect(Object.keys(doc.scenes)).toContain(`scene-0@${doc.splits[0]!.id}`);
  });
});

describe("cleanup (the veto layer over the automatic cutlist, cut review step 3)", () => {
  it("absent defaults to empty choices — the splits/cuts optional-with-default shape", () => {
    const doc = OverrideDocSchema.parse({});
    expect(doc.cleanup).toEqual({ reasons: {}, kept: [] });
  });

  it("a written veto round-trips: only false is ever written, true is tolerated and means default", () => {
    const doc = OverrideDocSchema.parse({
      cleanup: { reasons: { pause: false, retake: true }, kept: [{ srcIn: 12.4, srcOut: 13.1 }] },
    });
    expect(doc.cleanup.reasons.pause).toBe(false);
    // Tolerated on disk (a hand edit, or an older writer) — parsed, kept,
    // and inert: vetoedRemovals only ever tests `=== false`.
    expect(doc.cleanup.reasons.retake).toBe(true);
    expect(doc.cleanup.kept).toEqual([{ srcIn: 12.4, srcOut: 13.1 }]);
  });

  it("a typo'd reason key refuses loudly — parse, never coerce (the --source-fit containn rule)", () => {
    expect(
      OverrideDocSchema.safeParse({ cleanup: { reasons: { pauses: false } } }).success,
    ).toBe(false);
  });

  it("kept ranges are validated numbers — a string srcIn must refuse, not NaN its way into a veto", () => {
    expect(
      OverrideDocSchema.safeParse({ cleanup: { kept: [{ srcIn: "12.4", srcOut: 13.1 }] } }).success,
    ).toBe(false);
    expect(
      OverrideDocSchema.safeParse({ cleanup: { kept: [{ srcIn: -1, srcOut: 2 }] } }).success,
    ).toBe(false);
  });

  it("a partial cleanup object fills the missing half — reasons alone, kept alone", () => {
    expect(OverrideDocSchema.parse({ cleanup: { reasons: { filler: false } } }).cleanup.kept).toEqual([]);
    expect(
      OverrideDocSchema.parse({ cleanup: { kept: [{ srcIn: 1, srcOut: 2 }] } }).cleanup.reasons,
    ).toEqual({});
  });
});
