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
 * the seam below `produce()` itself. A behavioural harness for `produce()`
 * does exist — produce-timing.test.ts (§140) invokes it hermetically
 * (ffmpeg-gated, injected transcript, no render) — but it cannot reach
 * graphic scenes without an LLM or a `--scenes` injection plus an
 * overrides.json seeded into the hash-derived workdir. So these tests run
 * the SAME calls in the SAME order
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

  it("a parked take half says its split moved, not that its words left (take-framing-identity P2)", () => {
    // `rekeyTakeHalves` parks a half whose split landed in a piece that
    // already had an edit; its words are still in the plan.
    expect(orphanEditLine("take-2@66055#orphaned")).toBe(
      "  ⚠ edit for take-2@66055 is parked — its split moved to a piece that already has an edit",
    );
    expect(orphanEditLine("scene-3#orphaned")).toBe(
      "  ⚠ edit for scene-3 is parked — its words are not in this plan",
    );
    // A parked whole take (no `@`) and a parked kept-block half are not
    // `rekeyTakeHalves`' parks, so they keep the remap's sentence.
    expect(orphanEditLine("take-2#orphaned")).toContain("its words are not in this plan");
    expect(orphanEditLine("take-kept-1@s#orphaned")).toContain("its words are not in this plan");
    // Never parked: still the dropped sentence.
    expect(orphanEditLine("take-2@66055")).toBe(
      "  ⚠ edit for take-2@66055 dropped — the plan no longer has that scene",
    );
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

// Source-text guard, the caption-report.test.ts precedent: the §140 harness
// can run `produce()` but not reach graphic scenes (the header comment has
// the why), and "the remap runs at the right POINT in the pipeline, and its
// doc is the one written back" are claims about produce.ts itself that the
// composition tests above cannot make.
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
    const splitAt = src.indexOf("splitCuesWithLanding(filled");
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

  it("re-keys take halves on the split's landing and adopts the doc before the final join (take-framing-identity P2)", () => {
    // Three ways to compute the re-key and still render the stale keys: drop
    // `takeRekey.doc`, keep the pre-rekey `pinnedDoc` the final pass reads,
    // or run either after `applyOverrides(split`. Each typechecks and prints
    // truthful notes. `splitLanded` is the landing map (`landed` was taken).
    const splitAt = src.indexOf("splitCuesWithLanding(filled");
    // Two arguments since split-positions-by-source D4 (step 7's `points`
    // and `graphicWindows` went), so the trailing comma is optional.
    const rekeyAt = src.search(/rekeyTakeHalves\(\s*overrideDoc,\s*splitLanded\s*,?\s*\)/);
    const adoptAt = src.indexOf("overrideDoc = takeRekey.doc");
    const pinAt = src.indexOf("pinnedDoc = resolveSrcTimingPins(overrideDoc", adoptAt);
    const applyAt = src.indexOf("applyOverrides(split");
    expect(splitAt).toBeGreaterThan(-1);
    expect(rekeyAt).toBeGreaterThan(splitAt);
    expect(adoptAt).toBeGreaterThan(rekeyAt);
    expect(pinAt).toBeGreaterThan(adoptAt);
    expect(applyAt).toBeGreaterThan(pinAt);
  });

  it("pass 1 cuts graphics at the live `at` points and pass 2 takes only the splits that did not land (split-positions-by-source D2, R8-2)", () => {
    // Each claim typechecks wrong: the default points (inert splits cut a
    // graphic), the root-checking `landed` (a chained split's hidden halves
    // still count), the unfiltered set in pass 2 (a drifted split cuts
    // twice, the bug), or the filter computed and left unused.
    expect(src).toMatch(/splitThenDropHidden\(editedCues, overrideDoc, pass1SplitPoints\(overrideDoc\.splits, map\)\)/);
    const dropAt = src.indexOf("dropOverlappingAdded(shownCues)");
    const survAt = src.search(/const pass1Surviving = survivingLandings\(pass1LandedHost, visibleCues\)/);
    const filterAt = src.search(/const notLandedInPass1 = overrideDoc\.splits\.filter\(\(s\) => !pass1Surviving\.has\(s\.id\)\)/);
    const resolveAt = src.indexOf("resolveSplitPoints(notLandedInPass1, map)");
    const splitAt = src.indexOf("splitCuesWithLanding(filled, resolvedSplits.points)");
    expect(dropAt).toBeGreaterThan(-1);
    expect(survAt).toBeGreaterThan(dropAt);
    expect(filterAt).toBeGreaterThan(survAt);
    expect(resolveAt).toBeGreaterThan(filterAt);
    expect(splitAt).toBeGreaterThan(resolveAt);
    // The only `resolveSplitPoints(` call: no second, unfiltered pass.
    expect(src.match(/resolveSplitPoints\(/g)).toHaveLength(1);
  });

  it("names the one-time double cut, and reconciles the anchors after the re-key and before the migration, adopting the doc (R7-1, R7-4)", () => {
    const splitAt = src.indexOf("splitCuesWithLanding(filled, resolvedSplits.points)");
    const notesAt = src.search(/doubleCutNotes\(overrideDoc\.splits, pass1Surviving, pass1LandedHost, filled, map\)/);
    const rekeyAt = src.search(/rekeyTakeHalves\(\s*overrideDoc,\s*splitLanded\s*,?\s*\)/);
    const reconcileAt = src.search(
      /reconcileSplitAnchors\(\s*overrideDoc,\s*pass1Surviving,\s*splitLanded,\s*resolvedSplits\.points,\s*editedCues\.map\(/,
    );
    const adoptAt = src.indexOf("overrideDoc = splitReconcile.doc");
    const pinAt = src.indexOf("pinnedDoc = resolveSrcTimingPins(overrideDoc", adoptAt);
    const migrateAt = src.indexOf("migrateTakeLooks(");
    expect(notesAt).toBeGreaterThan(splitAt);
    expect(rekeyAt).toBeGreaterThan(notesAt);
    expect(reconcileAt).toBeGreaterThan(rekeyAt);
    expect(adoptAt).toBeGreaterThan(reconcileAt);
    expect(pinAt).toBeGreaterThan(adoptAt);
    expect(migrateAt).toBeGreaterThan(pinAt);
    expect(src).toMatch(/const splitsReconciled = splitReconcile\.changed/);
  });

  it("a split reconcile earns the sanctioned write without spending the `.bak`, and the line says so (R8-3)", () => {
    const gate = /if \(([^{]*)\)\s*\{\s*await writeOverrideDoc\(overridesPath, overrideDoc, \{ refreshBackup: cutResult\.changed \}\)/.exec(src);
    expect(gate).not.toBeNull();
    expect(gate![1]).toMatch(/\|\|\s*splitsReconciled\b/);
    const line = /console\.log\(\s*overridesWriteLine\(\{([^}]*)\}\)/.exec(src);
    expect(line![1]).toMatch(/\bsplitsReconciled\b/);
  });

  it("resolves take looks after the final join, gated on the marker, and feeds the item times (take-looks-by-source L2, R7-6)", () => {
    // Three ways to compute the looks and still render the id-keyed ones:
    // run the pass before `applyOverrides(split` (the merge then writes the
    // stale fields back over it), hand `resolveItemTimings` the unlooked
    // cues, or run it ungated, which strips every legacy doc's framing.
    const applyAt = src.indexOf("applyOverrides(split");
    const lookAt = src.indexOf("applyTakeLooks(");
    const itemsAt = src.indexOf("resolveItemTimings(lookedCues,");
    expect(applyAt).toBeGreaterThan(-1);
    expect(lookAt).toBeGreaterThan(applyAt);
    expect(itemsAt).toBeGreaterThan(lookAt);
    expect(src).toMatch(
      /const lookedCues =\s*overrideDoc\.takeLooks !== undefined\s*\?\s*applyTakeLooks\(overriddenCues, overrideDoc\.takeLooks, map\)\s*:\s*overriddenCues;/,
    );
  });

  it("migrates take looks after the final join and before the look pass, and adopts the doc (take-looks-by-source L3, R7-6)", () => {
    // Three ways to compute the migration and still render or write the
    // legacy doc: run it before `applyOverrides(split` (its pieces are not
    // this run's yet — N3), after `applyTakeLooks(` (the marker this run
    // sets never reaches the gate, so the first run renders the id-keyed
    // fields and the next one SETs them from source time), or drop
    // `migration.doc`, which typechecks and prints a truthful note.
    const applyAt = src.indexOf("applyOverrides(split");
    const migrateAt = src.search(/migrateTakeLooks\(\s*overrideDoc,\s*overriddenCues,\s*map,\s*ownFramingSplitIds\(overrideDoc\.splits\),?\s*\)/);
    const adoptAt = src.indexOf("overrideDoc = migration.doc");
    const lookAt = src.indexOf("applyTakeLooks(");
    expect(applyAt).toBeGreaterThan(-1);
    expect(migrateAt).toBeGreaterThan(applyAt);
    expect(adoptAt).toBeGreaterThan(migrateAt);
    expect(lookAt).toBeGreaterThan(adoptAt);
    expect(src).toMatch(/const takeLooksMigrated = migration\.changed/);
  });

  it("a take-look migration earns the sanctioned write without spending the `.bak` (L3 rule 7)", () => {
    const gate = /if \(([^{]*)\)\s*\{\s*await writeOverrideDoc\(overridesPath, overrideDoc, \{ refreshBackup: cutResult\.changed \}\)/.exec(src);
    expect(gate).not.toBeNull();
    expect(gate![1]).toMatch(/\|\|\s*takeLooksMigrated\b/);
  });

  it("the write line is told about the take-look migration (take-looks-by-source final review)", () => {
    // Without the flag the line falls back to whatever else fired — on a
    // migration-only run that was a false "caption keys" claim (`looks1.log`).
    const line = /console\.log\(\s*overridesWriteLine\(\{([^}]*)\}\)/.exec(src);
    expect(line).not.toBeNull();
    expect(line![1]).toMatch(/\btakeLooksMigrated\b/);
    expect(line![1]).toMatch(/cutChanged:\s*cutResult\.changed/);
  });

  it("a take-half re-key earns the sanctioned write without spending the `.bak`", () => {
    expect(src).toMatch(/const splitHalvesChanged = takeRekey\.changed/);
    const gate = /if \(([^{]*)\)\s*\{\s*await writeOverrideDoc\(overridesPath, overrideDoc, \{ refreshBackup: cutResult\.changed \}\)/.exec(src);
    expect(gate).not.toBeNull();
    expect(gate![1]).toContain("splitHalvesChanged");
  });

  it("the sanctioned write persists the `overrideDoc` binding the remap reassigned, not a snapshot", () => {
    expect(src).toMatch(/writeOverrideDoc\(overridesPath,\s*overrideDoc,/);
  });

  it("the take fill's clip starts are the ones written to render-props (take-framing-identity P0, R5-S5)", () => {
    // Two halves of one claim: the fill numbers takes from `takeClipStarts`,
    // and the editor reads that same binding back. An inlined list at either
    // site typechecks and lets the editor's `take-N` drift from the render's.
    expect(src).toContain("clipStarts: takeClipStarts");
    const propsAt = src.indexOf("const props = {");
    const spansAt = src.indexOf("spans: [...map.spans]", propsAt);
    const propsEnd = src.indexOf("\n  };", spansAt);
    const keyAt = src.indexOf("takeClipStarts,", spansAt);
    expect(propsAt).toBeGreaterThan(-1);
    expect(spansAt).toBeGreaterThan(propsAt);
    expect(keyAt).toBeGreaterThan(spansAt);
    expect(keyAt).toBeLessThan(propsEnd);
  });
});
