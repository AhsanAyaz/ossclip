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
    const stageAt = src.indexOf("withStagePreviews(cues)");
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
    const stageAt = src.indexOf("withStagePreviews(items.props.sceneCues)");
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
