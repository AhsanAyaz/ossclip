import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Where App.tsx's live memo resolves take looks (take-looks-by-source L2,
 * B8), guarded by reading the source — `edits-keys.test.ts`'s crude shape and
 * its justification: the memo is not under test (mounting `<App>` means jsdom
 * plus `<Player>`, which `scene-layer-structure.test.ts` ruled out), and
 * "the pass runs at the right POINT, in BOTH paths, gated on the marker" are
 * claims about App.tsx itself. A pass dropped from one path, or moved after
 * the stage previews, typechecks and previews a look the render will not
 * show.
 */
describe("App.tsx take-look wiring (source-text guard)", () => {
  const src = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  it("runs the look pass in the old-clock path: after the hidden drop, before the stage previews", () => {
    const dropAt = src.indexOf("dropHiddenCues(mergedCues, edits.doc)");
    const lookAt = src.indexOf("applyTakeLooks(", dropAt);
    // Each pass previews on its own clock (take-looks-by-source R7-1): a
    // look-mode preview names its piece by source extent.
    const stageAt = src.indexOf("withStagePreviews(cues, oldClockMap)");
    expect(dropAt).toBeGreaterThan(-1);
    expect(lookAt).toBeGreaterThan(dropAt);
    expect(stageAt).toBeGreaterThan(lookAt);
    // On the last render's clock — the clock these cues are on.
    expect(src.slice(lookAt, stageAt)).toMatch(/^applyTakeLooks\(shownTakes, edits\.doc\.takeLooks, oldClockMap\)/);
  });

  it("runs it in finishOnClock's main path: after its override pass, before the item times and previews", () => {
    const applyAt = src.indexOf("applyOverrides(splitted2, pinned.doc)");
    const lookAt = src.indexOf("applyTakeLooks(", applyAt);
    const itemsAt = src.indexOf("previewItemTimings({ sceneCues: merged }");
    // The stage previews read the post-drop list (split-positions-by-source
    // R8-5), the drop's own guard below.
    const stageAt = src.indexOf("withStagePreviews(shownFinal, clockMap)");
    expect(applyAt).toBeGreaterThan(-1);
    expect(lookAt).toBeGreaterThan(applyAt);
    expect(itemsAt).toBeGreaterThan(lookAt);
    expect(stageAt).toBeGreaterThan(itemsAt);
    // On this branch's clock, which the carve and src-only splits used too.
    expect(src.slice(lookAt, itemsAt)).toMatch(/^applyTakeLooks\(overridden, edits\.doc\.takeLooks, clockMap\)/);
  });

  it("gates both passes on the migrated marker, so a legacy doc previews as before (N1)", () => {
    const gated = src.match(/edits\.doc\.takeLooks !== undefined[^;]*?\?\s*applyTakeLooks\(/g) ?? [];
    expect(gated).toHaveLength(2);
    expect(src.match(/applyTakeLooks\(/g)).toHaveLength(2);
  });
});

/**
 * Where App.tsx's live memo cuts each split (split-positions-by-source D3,
 * R7-6, R8-2, R8-5) — the same source-text guard, for the same reason: the
 * parity harness (item-timing-parity.test.ts) models this memo, and these
 * pin the memo to the model. Each failure mode typechecks: the default
 * points in the graphic pass (an inert split cuts a graphic produce leaves
 * whole), a take pass at `at` or over the graphic landings (the split
 * produce skipped shows, FE Loop 20752), or the post-carve drop missing or
 * before the item times.
 */
describe("App.tsx split wiring (source-text guard)", () => {
  const src = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  it("the graphic pass cuts at pass1SplitPoints on the old clock and keeps its landings", () => {
    expect(src).toMatch(
      /landedHost: graphicLandedHost \} = splitThenDropHidden\(\s*graphicCues,\s*edits\.doc,\s*pass1SplitPoints\(edits\.doc\.splits, oldClockMap\),?\s*\)/,
    );
    const coveredAt = src.indexOf("previewDropCovered(shownCues)");
    const survAt = src.indexOf("survivingLandings(graphicLandedHost, visibleCues)");
    expect(coveredAt).toBeGreaterThan(-1);
    expect(survAt).toBeGreaterThan(coveredAt);
  });

  it("the take pass resolves the splits that did not land, outside the carved ranges, on the old clock", () => {
    expect(src).toMatch(/s\.at !== undefined && !graphicLanded\.has\(s\.id\) && \(s\.src === undefined \|\| !inCarvedRange\(s\.src\)\)/);
    expect(src).toMatch(/resolveSplitPoints\(takePassSplits, oldClockMap\)\.points/);
    const takeAt = src.indexOf("resolveSplitPoints(takePassSplits, oldClockMap)");
    const fillAt = src.indexOf("fillPlainCues(visibleCues");
    expect(takeAt).toBeGreaterThan(fillAt);
    // No take pass at the bare `at` points with a clock in hand.
    expect(src).not.toContain("splitCues(filled, atSplitPoints(edits.doc.splits))");
  });

  it("finishOnClock cuts the post-carve set, exits early on it, and drops hidden halves after the item times", () => {
    expect(src).toMatch(/!graphicLanded\.has\(s\.id\) &&\s*\(s\.at === undefined \|\| \(oldClockMap !== null && inCarvedRange\(s\.src\)\)\)/);
    expect(src).toContain("ranges.length === 0 && postCarveSplits.length === 0 && !rebuildCaptions");
    const resolveAt = src.indexOf("resolveSplitPoints(postCarveSplits, clockMap)");
    const itemsAt = src.indexOf("previewItemTimings({ sceneCues: merged }");
    const dropAt = src.indexOf("dropHiddenCues(items.props.sceneCues, edits.doc)");
    const stageAt = src.indexOf("withStagePreviews(shownFinal, clockMap)");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(itemsAt).toBeGreaterThan(resolveAt);
    expect(dropAt).toBeGreaterThan(itemsAt);
    expect(stageAt).toBeGreaterThan(dropAt);
  });

  it("the ghosts are cut on the last render's clock (R8-2)", () => {
    expect(src).toContain("computeGhostCues(baseCues, edits.doc, clock.toLive, liveRetimed.oldClock)");
  });
});
