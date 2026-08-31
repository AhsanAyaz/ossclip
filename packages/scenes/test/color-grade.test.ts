import { describe, expect, it } from "vitest";
import { colorGradeFilterId, colorGradePropsFor, stageFilterFor } from "../src/color-grade";

/**
 * The `--grade` filter's props gate, id derivation and `filter:` composition.
 * Pure, so the matrix runs without a DOM — VideoStage just serializes these
 * values into `<feFuncR tableValues>` and a `<feColorMatrix values>`.
 */

const identity20 = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

const wellFormed = {
  tableR: [0, 0.5, 1],
  tableG: [0, 0.4, 1],
  tableB: [0, 0.6, 1],
  colorMatrix: identity20,
};

describe("colorGradePropsFor", () => {
  it("accepts a well-formed spec", () => {
    expect(colorGradePropsFor(wellFormed)).toEqual(wellFormed);
  });

  it("reads an absent key as no grade, not as an identity filter", () => {
    // Every pre-feature render-props.json — the compatibility claim.
    expect(colorGradePropsFor(undefined)).toBeNull();
    expect(colorGradePropsFor(null)).toBeNull();
    expect(colorGradePropsFor("teal-orange")).toBeNull();
  });

  it("refuses a matrix that is not exactly 20 values", () => {
    // feColorMatrix renders TRANSPARENT on a malformed values list — the
    // video vanishing is the failure this gate exists to catch.
    expect(colorGradePropsFor({ ...wellFormed, colorMatrix: identity20.slice(0, 19) })).toBeNull();
    expect(colorGradePropsFor({ ...wellFormed, colorMatrix: [...identity20, 0] })).toBeNull();
  });

  it("refuses a missing or non-numeric table", () => {
    const { tableG: _dropped, ...missingG } = wellFormed;
    expect(colorGradePropsFor(missingG)).toBeNull();
    expect(colorGradePropsFor({ ...wellFormed, tableR: [0, "0.5", 1] })).toBeNull();
    expect(colorGradePropsFor({ ...wellFormed, tableB: [0, Number.NaN, 1] })).toBeNull();
  });
});

describe("colorGradeFilterId", () => {
  it("derives a stable id from the values", () => {
    // Equal specs get equal ids on purpose: SVG filter ids are
    // document-global, and a value-derived collision means an identical
    // <filter> definition — harmless, unlike a counter collision.
    expect(colorGradeFilterId(wellFormed)).toBe(colorGradeFilterId({ ...wellFormed }));
  });

  it("differs when any value differs", () => {
    const other = { ...wellFormed, tableR: [0, 0.51, 1] };
    expect(colorGradeFilterId(other)).not.toBe(colorGradeFilterId(wellFormed));
  });

  it("is a legal CSS/SVG id", () => {
    expect(colorGradeFilterId(wellFormed)).toMatch(/^ossclip-grade-[0-9a-f]+$/);
  });
});

describe("stageFilterFor", () => {
  it("emits nothing with no grade and no blur", () => {
    expect(stageFilterFor(null, 0)).toBeUndefined();
  });

  it("keeps the sub-pixel blur floor the stage always had", () => {
    // 0.5px predates the grade; a grade-less render must emit the exact
    // string it always did.
    expect(stageFilterFor(null, 0.5)).toBeUndefined();
    expect(stageFilterFor(null, 8)).toBe("blur(8px)");
  });

  it("puts the grade BEFORE the blur", () => {
    // Blur-then-grade would average raw pixels and re-map the averages,
    // haloing hard edges — the ordering is the contract, not a style choice.
    expect(stageFilterFor("ossclip-grade-abc", 8)).toBe("url(#ossclip-grade-abc) blur(8px)");
  });

  it("emits the grade alone when the blur is sub-pixel", () => {
    expect(stageFilterFor("ossclip-grade-abc", 0)).toBe("url(#ossclip-grade-abc)");
  });
});
