import { describe, expect, it } from "vitest";
import { colorGradeFlagValue, resolveProductionColorGrade } from "../src/produce";

/**
 * The color-grade precedence matrix — override > flag > config, with the two
 * explicit disables and the invalid-layer fall-through — tested pure, the
 * `resolveWatermark`/`resolveSfxLevel` posture: no config file, no overrides
 * doc, no TTY. Warnings are asserted BY CONTENT where a layer is skipped,
 * because "warned and fell through" is the decision under test (2026-08-30:
 * an invalid layer is ignored and the NEXT layer applies — an invalid
 * override going straight to "off" would let one stale editor write silently
 * strip a channel's config grade).
 */
describe("resolveProductionColorGrade", () => {
  const preset = { preset: "punchy" };

  it("everything undefined is off, with no warnings", () => {
    const r = resolveProductionColorGrade({ override: undefined, flag: undefined, config: undefined });
    expect(r.grade).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it("override beats flag beats config", () => {
    const r = resolveProductionColorGrade({
      override: { preset: "mono" },
      flag: "punchy",
      config: { preset: "teal-orange" },
    });
    expect(r.grade).toEqual({ preset: "mono" });
    expect(r.source).toBe("override");
  });

  it("flag beats config when no override exists", () => {
    const r = resolveProductionColorGrade({ override: undefined, flag: "punchy", config: { preset: "mono" } });
    expect(r.grade).toEqual({ preset: "punchy" });
    expect(r.source).toBe("flag");
  });

  it("config supplies the default when nothing else is typed", () => {
    const r = resolveProductionColorGrade({ override: undefined, flag: undefined, config: preset });
    expect(r.grade).toEqual(preset);
    expect(r.source).toBe("config");
  });

  it("an override false is OFF — it beats a typed flag AND the config", () => {
    const r = resolveProductionColorGrade({ override: false, flag: "punchy", config: preset });
    expect(r.grade).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it("--no-color-grade (flag false) is OFF over a config grade", () => {
    const r = resolveProductionColorGrade({ override: undefined, flag: false, config: preset });
    expect(r.grade).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it("an invalid override warns by name and falls through to the flag", () => {
    // Schema-valid but unknown preset: exactly the stale-editor-write case
    // the fall-through exists for.
    const r = resolveProductionColorGrade({
      override: { preset: "vintage-90s" },
      flag: "punchy",
      config: undefined,
    });
    expect(r.grade).toEqual({ preset: "punchy" });
    expect(r.source).toBe("flag");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("overrides.json");
    expect(r.warnings[0]).toContain("vintage-90s");
  });

  it("an invalid flag warns and falls through to the config", () => {
    const r = resolveProductionColorGrade({
      override: undefined,
      flag: "punchyy",
      config: { preset: "mono" },
    });
    expect(r.grade).toEqual({ preset: "mono" });
    expect(r.source).toBe("config");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("--color-grade");
    // The unknown-preset warning lists what exists — the reason validation
    // lives in resolveColorGrade rather than a schema enum.
    expect(r.warnings[0]).toContain("punchy");
  });

  it("an invalid config warns and the run is simply ungraded", () => {
    const r = resolveProductionColorGrade({
      override: undefined,
      flag: undefined,
      config: { preset: "mono", lut: "a.cube" },
    });
    expect(r.grade).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("config");
  });

  it("two invalid layers stack two warnings, then off", () => {
    const r = resolveProductionColorGrade({
      override: { preset: "nope" },
      flag: undefined,
      config: "not-even-an-object",
    });
    expect(r.grade).toBeUndefined();
    expect(r.warnings).toHaveLength(2);
  });

  it("a .cube flag value resolves as a LUT grade", () => {
    const r = resolveProductionColorGrade({ override: undefined, flag: "kodak.cube", config: undefined });
    expect(r.grade).toEqual({ lut: "kodak.cube" });
    expect(r.source).toBe("flag");
  });
});

describe("colorGradeFlagValue", () => {
  it("classifies .cube (any case) as a LUT and everything else as a preset", () => {
    expect(colorGradeFlagValue("kodak.cube")).toEqual({ lut: "kodak.cube" });
    // Case-preserving filesystems: KODAK.CUBE is the same file, so it must
    // classify the same way — the original spelling rides through untouched.
    expect(colorGradeFlagValue("KODAK.CUBE")).toEqual({ lut: "KODAK.CUBE" });
    expect(colorGradeFlagValue("punchy")).toEqual({ preset: "punchy" });
    expect(colorGradeFlagValue("talking-head")).toEqual({ preset: "talking-head" });
  });
});
