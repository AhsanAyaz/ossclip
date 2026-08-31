import { describe, expect, it } from "vitest";
import { GRADE_PRESETS, gradeToSvgFilterSpec, resolveGradeToLook } from "@ossclip/core/browser";
import {
  EMPTY_LUT_MENU,
  GRADE_PRESET_IDS,
  configGradeName,
  effectiveGrade,
  gradeForSource,
  gradeSliderState,
  gradeSourceValue,
  liveGradeSpec,
} from "../src/colorPanel";

describe("gradeSourceValue ↔ gradeForSource — the key's three states, exactly", () => {
  it("absent key reads as the config default when one exists, else as off", () => {
    expect(gradeSourceValue(undefined, { preset: "punchy" })).toBe("default");
    expect(gradeSourceValue(undefined, null)).toBe("off");
  });

  it("false is always off — an explicit decision, not a fall-through", () => {
    expect(gradeSourceValue(false, { preset: "punchy" })).toBe("off");
    expect(gradeSourceValue(false, null)).toBe("off");
  });

  it("objects read as their look, preset or lut", () => {
    expect(gradeSourceValue({ preset: "mono" }, null)).toBe("preset:mono");
    expect(gradeSourceValue({ lut: "kodak.cube" }, null)).toBe("lut:kodak.cube");
  });

  it('"default" DELETES the key and "off" stores false — never each other', () => {
    expect(gradeForSource("default", { preset: "mono" })).toBeUndefined();
    expect(gradeForSource("off", undefined)).toBe(false);
  });

  it("a look swap keeps the tweak knobs — they are relative to the look", () => {
    const current = { preset: "mono", intensity: 0.4, temperature: 12 };
    expect(gradeForSource("preset:punchy", current)).toEqual({
      preset: "punchy",
      intensity: 0.4,
      temperature: 12,
    });
    expect(gradeForSource("lut:kodak.cube", current)).toEqual({
      lut: "kodak.cube",
      intensity: 0.4,
      temperature: 12,
    });
  });

  it("a swap from off/inherit starts clean — there were no knobs to keep", () => {
    expect(gradeForSource("preset:punchy", false)).toEqual({ preset: "punchy" });
    expect(gradeForSource("preset:punchy", undefined)).toEqual({ preset: "punchy" });
  });
});

describe("effectiveGrade — what the sliders edit", () => {
  it("the doc's own object wins, the config default fills an absent key, false kills both", () => {
    const doc = { preset: "mono" };
    const cfg = { preset: "punchy" };
    expect(effectiveGrade(doc, cfg)).toBe(doc);
    expect(effectiveGrade(undefined, cfg)).toBe(cfg);
    expect(effectiveGrade(false, cfg)).toBeNull();
    expect(effectiveGrade(undefined, null)).toBeNull();
  });
});

describe("gradeSliderState — display defaults", () => {
  it("intensity defaults to the preset's own defaultIntensity, 1 for a LUT", () => {
    expect(gradeSliderState({ preset: "talking-head" }).intensity).toBe(
      GRADE_PRESETS["talking-head"].defaultIntensity,
    );
    expect(gradeSliderState({ lut: "kodak.cube" }).intensity).toBe(1);
  });

  it("tweaks default to identity and pinned values pass through", () => {
    expect(gradeSliderState({ preset: "mono" })).toMatchObject({
      exposure: 0,
      temperature: 0,
      saturation: 1,
      contrast: 1,
    });
    expect(gradeSliderState({ preset: "mono", exposure: 0.5, intensity: 0.2 })).toMatchObject({
      exposure: 0.5,
      intensity: 0.2,
    });
  });
});

describe("liveGradeSpec — the Player's recomposed colorGrade", () => {
  const baked = gradeToSvgFilterSpec({ params: GRADE_PRESETS.punchy, intensity: 0.7 });

  it("absent key keeps the LAST render's spec — the baked value already resolved the flag layer", () => {
    expect(liveGradeSpec(undefined, baked)).toBe(baked);
    expect(liveGradeSpec(undefined, undefined)).toBeUndefined();
  });

  it("false drops the baked spec — off previews as off", () => {
    expect(liveGradeSpec(false, baked)).toBeUndefined();
  });

  it("a preset computes with produce's own functions — preview IS render", () => {
    const grade = { preset: "mono", intensity: 0.5 };
    const resolved = resolveGradeToLook(grade);
    expect(resolved.kind).toBe("preset");
    expect(liveGradeSpec(grade, baked)).toEqual(
      gradeToSvgFilterSpec(resolved as Extract<typeof resolved, { kind: "preset" }>),
    );
  });

  it("a LUT previews as NO grade — it bakes at render, and a stand-in would lie", () => {
    expect(liveGradeSpec({ lut: "kodak.cube" }, baked)).toBeUndefined();
  });
});

describe("menu constants", () => {
  it("offers every bundled preset id", () => {
    expect(GRADE_PRESET_IDS).toEqual(Object.keys(GRADE_PRESETS));
  });

  it("names the config default readably for both kinds", () => {
    expect(configGradeName({ preset: "punchy" })).toBe("punchy");
    expect(configGradeName({ lut: "kodak.cube" })).toBe("LUT kodak.cube");
  });

  it("the empty menu has no items, no issues and no default", () => {
    expect(EMPTY_LUT_MENU).toEqual({ items: [], issues: [], configGrade: null });
  });
});
