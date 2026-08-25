import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
  remapSceneOverrides,
  splitCues,
  splitThenDropHidden,
  type SceneCue,
} from "@ossclip/core";
import { orphanEditLine } from "../src/produce";
import { writeOverrideDoc } from "../src/overrides-write";

/**
 * Produce's wiring of the scene-edit remap (handoff-edit-anchoring), tested at
 * the seam below `produce()` itself: nothing in the repo can invoke `produce()`
 * (it needs ffmpeg, a transcript, a workdir and a render — overrides-write.ts
 * says so where it lives), so these tests run the SAME calls in the SAME order
 * produce.ts runs them — remap on the ASSEMBLED cue list, before every
 * consumer of `overrideDoc.scenes` (the first `applyOverrides`,
 * `splitThenDropHidden`, `splitCues`, the final `applyOverrides` whose
 * orphans feed the warning loop) — and pin the sentences via the pure
 * `orphanEditLine`. The placement is the fix-round ruling on
 * handoff-edit-anchoring: a remap AFTER the first pass lets a `hidden` on a
 * renumbered scene hide the impostor before the keys converge.
 */

const cue = (id: string, anchor?: { startWord: number; endWord: number }): SceneCue => ({
  id,
  layout: "video-top",
  component: "StatCard",
  props: { label: "CODE CHURN", value: "861%" },
  startSec: 0,
  endSec: 5,
  ...(anchor ? { anchor } : {}),
});

describe("produce wires remapSceneOverrides before splitCues and applyOverrides", () => {
  // The 2026-08-23 field case: the user edited scene-11, a re-plan renumbered
  // that moment to scene-7, and the run printed "edit for scene-11 dropped"
  // while rendering the unedited scene.
  const renumbered = () => {
    const doc = OverrideDocSchema.parse({
      scenes: {
        "scene-11": { props: { value: "999%" }, anchor: { startWord: 20, endWord: 30 } },
      },
    });
    const filled = [cue("scene-7", { startWord: 21, endWord: 29 })];
    // Produce's exact order: remap FIRST, so the split and the id-join both
    // see converged keys.
    const remap = remapSceneOverrides(doc, filled);
    const split = splitCues(filled, remap.doc.splits);
    const applied = applyOverrides(split, remap.doc);
    return { remap, applied };
  };

  it("prints the re-key note instead of a false dropped warning", () => {
    const { remap, applied } = renumbered();
    expect(remap.notes.some((n) => n.includes("scene-11") && n.includes("scene-7"))).toBe(true);
    // No orphan ⇒ the warning loop has nothing to say about scene-11.
    expect(applied.orphans).toEqual([]);
  });

  it("the rendered scene-7 cue carries the edit made on scene-11", () => {
    const { applied } = renumbered();
    expect(applied.cues[0]!.props!.value).toBe("999%");
  });

  it("the write-back persists the remapped doc — overrides.json keys the entry scene-7", async () => {
    const { remap } = renumbered();
    const path = join(mkdtempSync(join(tmpdir(), "ossclip-remap-")), "overrides.json");
    // Same call produce.ts makes at its single sanctioned write; the remap
    // must not spend the `.bak` (only a cut re-anchoring may).
    await writeOverrideDoc(path, remap.doc, { refreshBackup: false });
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.scenes["scene-7"].props.value).toBe("999%");
    expect(onDisk.scenes["scene-11"]).toBeUndefined();
  });

  it("a hidden override on a renumbered scene hides the moved cue, not the impostor", () => {
    // The mis-hide the old (post-fill) placement allowed: the user deleted
    // the moment that WAS scene-11; a re-plan renamed it scene-7 and handed
    // scene-11 to a different moment. `splitThenDropHidden` joins by id, so
    // with stale keys it would have dropped the impostor and rendered the
    // scene the user deleted.
    const doc = OverrideDocSchema.parse({
      scenes: {
        "scene-11": { hidden: true, anchor: { startWord: 20, endWord: 30 } },
      },
    });
    const assembled = [
      cue("scene-7", { startWord: 21, endWord: 29 }),
      cue("scene-11", { startWord: 80, endWord: 90 }),
    ];
    // Produce's exact order after the fix: remap FIRST, then the first
    // override pass and the hidden drop.
    const remap = remapSceneOverrides(doc, assembled);
    const { cues: edited } = applyOverrides(assembled, remap.doc);
    const { cues: visible } = splitThenDropHidden(edited, remap.doc);
    expect(visible.map((c) => c.id)).toEqual(["scene-11"]);
  });

  it("a genuinely-gone edit still orphans and still warns dropped", () => {
    // Shrunk plan: no cue has the words, no cue has the id — remap leaves the
    // entry alone, applyOverrides orphans it, the dropped sentence fires.
    const doc = OverrideDocSchema.parse({
      scenes: {
        "scene-5": { props: { value: "1%" }, anchor: { startWord: 60, endWord: 70 } },
      },
    });
    const filled = [cue("scene-1", { startWord: 0, endWord: 10 })];
    const remap = remapSceneOverrides(doc, filled);
    expect(remap.notes).toEqual([]);
    const { orphans } = applyOverrides(splitCues(filled, remap.doc.splits), remap.doc);
    expect(orphans).toEqual(["scene-5"]);
    expect(orphanEditLine("scene-5")).toBe(
      "  ⚠ edit for scene-5 dropped — the plan no longer has that scene",
    );
  });
});

describe("orphanEditLine", () => {
  it("a parked key gets the parked sentence, not the dropped one", () => {
    // A parked entry surfaces in the orphan list on EVERY run by design —
    // its key matches no cue. "Dropped" would claim the edit is gone while
    // the doc still holds it, ready to be rescued.
    const line = orphanEditLine("scene-3#orphaned");
    expect(line).toBe("  ⚠ edit for scene-3 is parked — its words are not in this plan");
    expect(line).not.toContain("dropped");
  });

  it("a parked entry in the doc reaches the warning loop as its parked key", () => {
    // End-to-end through applyOverrides: the parked key IS what the loop
    // receives, so the special case above is reachable, not decorative.
    const doc = OverrideDocSchema.parse({
      scenes: {
        "scene-3#orphaned": { props: { value: "1%" }, anchor: { startWord: 40, endWord: 50 } },
      },
    });
    const filled = [cue("scene-1", { startWord: 0, endWord: 10 })];
    const remap = remapSceneOverrides(doc, filled);
    const { orphans } = applyOverrides(splitCues(filled, remap.doc.splits), remap.doc);
    expect(orphans).toEqual(["scene-3#orphaned"]);
    expect(orphanEditLine(orphans[0]!)).toContain("is parked");
  });
});

// Source-text guard, the caption-report.test.ts precedent: nothing in the repo
// can run `produce()`, and "the remap runs at the right POINT in the pipeline,
// and its doc is the one written back" are claims about produce.ts itself that
// the composition tests above cannot make.
describe("produce's remap wiring (source-text guard)", () => {
  const src = readFileSync(new URL("../src/produce.ts", import.meta.url), "utf8");

  it("calls remapSceneOverrides on the assembled list AND adopts the doc", () => {
    // The two-part shape from the §137 guards: computing the remap and
    // dropping `sceneRemap.doc` typechecks, prints truthful notes, and
    // applies edits under the stale keys anyway.
    expect(src).toMatch(/=\s*remapSceneOverrides\(overrideDoc,\s*assembled\)/);
    expect(src).toMatch(/overrideDoc\s*=\s*sceneRemap\.doc/);
  });

  it("remaps BEFORE every scenes consumer — first pass, hidden drop, splits, final join", () => {
    // The fix-round ruling: the FIRST `applyOverrides` and
    // `splitThenDropHidden` join by id too, and a remap after them lets a
    // hidden/renumbered edit land on the impostor before the keys converge.
    const remapAt = src.indexOf("remapSceneOverrides(overrideDoc, assembled)");
    const firstApplyAt = src.indexOf("applyOverrides(routed.cues");
    const dropHiddenAt = src.indexOf("splitThenDropHidden(editedCues");
    const splitAt = src.indexOf("splitCues(filled");
    const applyAt = src.indexOf("applyOverrides(split");
    expect(remapAt).toBeGreaterThan(-1);
    expect(remapAt).toBeLessThan(firstApplyAt);
    expect(remapAt).toBeLessThan(dropHiddenAt);
    expect(remapAt).toBeLessThan(splitAt);
    expect(remapAt).toBeLessThan(applyAt);
  });

  it("the orphan loop speaks through orphanEditLine — parked keys must not read as dropped", () => {
    expect(src).toMatch(/console\.log\(orphanEditLine\(id\)\)/);
  });

  it("the sanctioned write persists the `overrideDoc` binding the remap reassigned, not a snapshot", () => {
    expect(src).toMatch(/writeOverrideDoc\(overridesPath,\s*overrideDoc,/);
  });
});
