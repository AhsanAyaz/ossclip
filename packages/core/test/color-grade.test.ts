import { describe, expect, it } from "vitest";
import {
  ColorGradeSchema,
  GRADE_PRESETS,
  IDENTITY_LOOK,
  applyGrade,
  applyGradeWithIntensity,
  bakeCube,
  gradeToSvgFilterSpec,
  lutHash,
  parseCubeLut,
  resolveColorGrade,
  resolveGradeToLook,
  sampleCubeLut,
  type LookParams,
} from "../src/color-grade";

/** Rec.709 luma weights — duplicated here so the test is its own oracle. */
const LUMA = [0.2126, 0.7152, 0.0722] as const;

const look = (over: Partial<LookParams> = {}): LookParams => ({ ...IDENTITY_LOOK, ...over });

describe("ColorGradeSchema", () => {
  it("accepts the minimal preset shape", () => {
    expect(ColorGradeSchema.safeParse({ preset: "talking-head" }).success).toBe(true);
  });

  it("rejects preset AND lut together", () => {
    const r = ColorGradeSchema.safeParse({ preset: "mono", lut: "kodak.cube" });
    expect(r.success).toBe(false);
  });

  it("rejects neither preset nor lut", () => {
    expect(ColorGradeSchema.safeParse({ intensity: 0.5 }).success).toBe(false);
  });

  it("rejects out-of-range values", () => {
    expect(ColorGradeSchema.safeParse({ preset: "mono", intensity: 1.5 }).success).toBe(false);
    expect(ColorGradeSchema.safeParse({ preset: "mono", exposure: 3 }).success).toBe(false);
    expect(ColorGradeSchema.safeParse({ preset: "mono", temperature: -101 }).success).toBe(false);
    expect(ColorGradeSchema.safeParse({ preset: "mono", saturation: 2.1 }).success).toBe(false);
    expect(ColorGradeSchema.safeParse({ preset: "mono", contrast: -0.1 }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(ColorGradeSchema.safeParse({ preset: "mono", vibrance: 1 }).success).toBe(false);
  });
});

describe("applyGrade", () => {
  it("identity params return the input untouched", () => {
    const rgb: [number, number, number] = [0.13, 0.42, 0.87];
    const out = applyGrade(look(), rgb);
    for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(rgb[i]!, 10);
  });

  it("mono preset yields R=G=B", () => {
    const out = applyGrade(GRADE_PRESETS.mono, [0.2, 0.5, 0.8]);
    expect(out[0]).toBeCloseTo(out[1], 10);
    expect(out[1]).toBeCloseTo(out[2], 10);
  });

  it("exposure +1 EV doubles mid-gray before the clamp", () => {
    const out = applyGrade(look({ exposure: 1 }), [0.25, 0.25, 0.25]);
    for (const c of out) expect(c).toBeCloseTo(0.5, 10);
  });

  it("lift raises black to the lift value", () => {
    const out = applyGrade(look({ lift: 0.06 }), [0, 0, 0]);
    for (const c of out) expect(c).toBeCloseTo(0.06, 10);
  });

  it("clamps output to 0..1", () => {
    const out = applyGrade(look({ exposure: 2 }), [0.9, 0.9, 0.9]);
    for (const c of out) expect(c).toBe(1);
  });

  it("intensity 0 is a no-op, intensity 1 is the full grade", () => {
    const rgb: [number, number, number] = [0.3, 0.6, 0.1];
    const params = GRADE_PRESETS["teal-orange"];
    expect(applyGradeWithIntensity(params, 0, rgb)).toEqual(rgb);
    const full = applyGradeWithIntensity(params, 1, rgb);
    const direct = applyGrade(params, rgb);
    for (let i = 0; i < 3; i++) expect(full[i]).toBeCloseTo(direct[i]!, 10);
  });
});

describe("parseCubeLut", () => {
  const identity2 = [
    "LUT_3D_SIZE 2",
    "0 0 0",
    "1 0 0",
    "0 1 0",
    "1 1 0",
    "0 0 1",
    "1 0 1",
    "0 1 1",
    "1 1 1",
  ].join("\n");

  it("parses a minimal N=2 LUT", () => {
    const lut = parseCubeLut(identity2);
    expect(lut.size).toBe(2);
    expect(lut.data).toHaveLength(24);
    expect(lut.domainMin).toEqual([0, 0, 0]);
    expect(lut.domainMax).toEqual([1, 1, 1]);
  });

  it("tolerates BOM, CRLF, tabs, comments between data lines, TITLE with spaces, DOMAIN lines", () => {
    const text =
      "\uFEFF" +
      [
        'TITLE "My Cool LUT"',
        "# an exporter comment",
        "DOMAIN_MIN 0 0 0",
        "DOMAIN_MAX 1 1 2",
        "LUT_3D_SIZE 2",
        "0\t0\t0",
        "1 0 0",
        "# comment right in the data",
        "0 1 0",
        "1 1 0",
        "0 0 1",
        "1 0 1",
        "0 1 1",
        "1 1 1",
      ].join("\r\n");
    const lut = parseCubeLut(text);
    expect(lut.title).toBe("My Cool LUT");
    expect(lut.size).toBe(2);
    expect(lut.domainMax).toEqual([1, 1, 2]);
  });

  it("preserves values above 1 at parse time (log/HDR LUTs)", () => {
    const text = identity2.replace("1 1 1", "1.5 1.5 1.5");
    const lut = parseCubeLut(text);
    expect(lut.data[23]).toBeCloseTo(1.5, 5);
  });

  it("throws on the wrong data line count", () => {
    const short = identity2.split("\n").slice(0, -1).join("\n");
    expect(() => parseCubeLut(short)).toThrow(/expected 2/);
  });

  it("throws on non-numeric data (and never locale-parses)", () => {
    expect(() => parseCubeLut(identity2.replace("1 1 1", "1 one 1"))).toThrow(/non-numeric/);
    expect(() => parseCubeLut(identity2.replace("1 1 1", "1 1,0 1"))).toThrow(/non-numeric/);
  });

  it("rejects 1D LUTs with a clear error", () => {
    expect(() => parseCubeLut("LUT_1D_SIZE 4\n0\n0.3\n0.6\n1")).toThrow(/1D LUTs not supported/);
  });

  it("throws when LUT_3D_SIZE is missing or out of range", () => {
    expect(() => parseCubeLut("0 0 0")).toThrow(/missing LUT_3D_SIZE/);
    expect(() => parseCubeLut("LUT_3D_SIZE 1\n0 0 0")).toThrow(/2\.\.256/);
  });
});

describe("sampleCubeLut", () => {
  const identity = parseCubeLut(bakeCube({ params: look(), intensity: 0, size: 3 }));

  it("identity LUT returns the input", () => {
    const out = sampleCubeLut(identity, [0.2, 0.55, 0.9]);
    expect(out[0]).toBeCloseTo(0.2, 5);
    expect(out[1]).toBeCloseTo(0.55, 5);
    expect(out[2]).toBeCloseTo(0.9, 5);
  });

  it("lattice points are exact", () => {
    const out = sampleCubeLut(identity, [0.5, 0, 1]);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(1, 6);
  });
});

describe("bakeCube", () => {
  it("round-trips through parseCubeLut", () => {
    const text = bakeCube({ params: GRADE_PRESETS.punchy, intensity: 0.7, size: 5 });
    const lut = parseCubeLut(text);
    expect(lut.size).toBe(5);
    expect(lut.title).toBe("ossclip");
    expect(lut.data).toHaveLength(3 * 125);
  });

  it("intensity 0 yields the identity lattice", () => {
    const lut = parseCubeLut(bakeCube({ params: GRADE_PRESETS.punchy, intensity: 0, size: 3 }));
    // r fastest: entry (r=2, g=1, b=0) is index 3*(2 + 3*1) = 15 → [1, 0.5, 0].
    expect(lut.data[15]).toBeCloseTo(1, 6);
    expect(lut.data[16]).toBeCloseTo(0.5, 6);
    expect(lut.data[17]).toBeCloseTo(0, 6);
  });

  it("a lattice point maps to the hand-computed applyGrade value", () => {
    const params = GRADE_PRESETS["teal-orange"];
    const lut = parseCubeLut(bakeCube({ params, intensity: 1, size: 3 }));
    const expected = applyGrade(params, [0.5, 0.5, 0.5]);
    // Center of the 3³ lattice: r=1, g=1, b=1 → index 3*(1 + 3 + 9) = 39.
    for (let i = 0; i < 3; i++) expect(lut.data[39 + i]).toBeCloseTo(expected[i]!, 5);
  });

  it("is deterministic, so lutHash is a stable cache key", () => {
    const a = bakeCube({ params: GRADE_PRESETS.mono, intensity: 1, size: 3 });
    const b = bakeCube({ params: GRADE_PRESETS.mono, intensity: 1, size: 3 });
    expect(lutHash(a)).toBe(lutHash(b));
    expect(lutHash(a)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("composes params ON TOP of a base LUT: identity base + params == pure params bake", () => {
    // The compose contract (2026-08-30): sample the base first, then run
    // applyGrade(params) on the sample — so against an IDENTITY base the
    // result must equal a params-only bake. Size-5 lattice points (0, .25,
    // .5, .75, 1) are exact in float32 AND in 6-decimal text, so the
    // identity base round-trips losslessly and the two bakes must agree
    // byte-for-byte, not merely closely.
    const identityBase = parseCubeLut(bakeCube({ intensity: 0, size: 5 }));
    const composed = bakeCube({
      base: identityBase,
      params: GRADE_PRESETS["teal-orange"],
      intensity: 0.7,
      size: 5,
    });
    expect(composed).toBe(
      bakeCube({ params: GRADE_PRESETS["teal-orange"], intensity: 0.7, size: 5 }),
    );
  });

  it("bakes a base LUT through mix, defaulting size to the base's", () => {
    const base = parseCubeLut(bakeCube({ params: GRADE_PRESETS.punchy, intensity: 1, size: 5 }));
    const text = bakeCube({ base, intensity: 0.5 });
    const lut = parseCubeLut(text);
    expect(lut.size).toBe(5);
    // Half-intensity at a lattice point = midpoint of identity and the base.
    const p: [number, number, number] = [0.5, 0.5, 0.5];
    const full = sampleCubeLut(base, p);
    const out = sampleCubeLut(lut, p);
    for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo((p[i]! + full[i]!) / 2, 4);
  });
});

describe("gradeToSvgFilterSpec", () => {
  it("emits 33-sample tables with sane 0..1 endpoints", () => {
    const spec = gradeToSvgFilterSpec({ params: GRADE_PRESETS["talking-head"], intensity: 1 });
    for (const t of [spec.tableR, spec.tableG, spec.tableB]) {
      expect(t).toHaveLength(33);
      for (const v of t) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(spec.colorMatrix).toHaveLength(20);
  });

  it("intensity 0 is identity tables and the identity matrix", () => {
    const spec = gradeToSvgFilterSpec({ params: GRADE_PRESETS["teal-orange"], intensity: 0 });
    for (let i = 0; i < 33; i++) expect(spec.tableR[i]).toBeCloseTo(i / 32, 10);
    const identity = [1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,1,0];
    for (let i = 0; i < 20; i++) expect(spec.colorMatrix[i]).toBeCloseTo(identity[i]!, 10);
  });

  it("mono at full intensity puts the luma weights on every color row", () => {
    const spec = gradeToSvgFilterSpec({ params: GRADE_PRESETS.mono, intensity: 1 });
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        expect(spec.colorMatrix[row * 5 + col]).toBeCloseTo(LUMA[col]!, 10);
      }
      expect(spec.colorMatrix[row * 5 + 3]).toBeCloseTo(0, 10); // alpha in
      expect(spec.colorMatrix[row * 5 + 4]).toBeCloseTo(0, 10); // constant
    }
  });

  it("the matrix stage matches applyGrade's split-tone + saturation exactly", () => {
    // Stage B is claimed exact (both ops are affine): run steps 5–6 by hand
    // via applyGrade with a curve-free look and compare to the matrix product.
    const params = look({
      shadowTint: [-0.03, 0.01, 0.04],
      highlightTint: [0.04, 0.01, -0.03],
      saturation: 1.2,
    });
    const spec = gradeToSvgFilterSpec({ params, intensity: 1 });
    const rgb: [number, number, number] = [0.3, 0.5, 0.7];
    const viaMatrix = ([0, 1, 2] as const).map((r) =>
      spec.colorMatrix[r * 5]! * rgb[0] +
      spec.colorMatrix[r * 5 + 1]! * rgb[1] +
      spec.colorMatrix[r * 5 + 2]! * rgb[2] +
      spec.colorMatrix[r * 5 + 4]!,
    );
    const viaEval = applyGrade(params, rgb);
    for (let i = 0; i < 3; i++) expect(viaMatrix[i]).toBeCloseTo(viaEval[i]!, 10);
  });
});

describe("resolveColorGrade", () => {
  it("absent value is no grade and no warning", () => {
    expect(resolveColorGrade(undefined, "config")).toEqual({});
  });

  it("bad shapes warn and yield no grade, never a throw", () => {
    for (const bad of [
      "punchy",
      42,
      { preset: "mono", lut: "x.cube" },
      {},
      { preset: "mono", intensity: 2 },
    ]) {
      const r = resolveColorGrade(bad, "config");
      expect(r.grade).toBeUndefined();
      expect(r.warning).toMatch(/colorGrade ignored/);
      expect(r.warning).toContain("config");
    }
  });

  it("names the known presets when the id is unknown", () => {
    const r = resolveColorGrade({ preset: "vhs" }, "overrides.json");
    expect(r.grade).toBeUndefined();
    expect(r.warning).toContain('"vhs"');
    expect(r.warning).toContain("talking-head");
  });

  it("good shapes pass through", () => {
    const r = resolveColorGrade({ preset: "filmic-fade", intensity: 0.4 }, "config");
    expect(r.warning).toBeUndefined();
    expect(r.grade).toEqual({ preset: "filmic-fade", intensity: 0.4 });
  });
});

describe("resolveGradeToLook", () => {
  it("preset alone takes the preset's defaultIntensity", () => {
    const r = resolveGradeToLook({ preset: "talking-head" });
    expect(r.kind).toBe("preset");
    if (r.kind !== "preset") throw new Error("unreachable");
    expect(r.intensity).toBe(GRADE_PRESETS["talking-head"].defaultIntensity);
    // Pin against the preset table, not a literal — preset values are tuned
    // on real footage and move; this test is about pass-through, not taste.
    expect(r.params.temperature).toBe(GRADE_PRESETS["talking-head"].temperature);
  });

  it("tweaks compose on top: exposure/temperature add, saturation/contrast multiply", () => {
    const r = resolveGradeToLook({
      preset: "talking-head",
      exposure: 0.5,
      temperature: -10,
      saturation: 1.2,
      contrast: 0.9,
      intensity: 0.3,
    });
    if (r.kind !== "preset") throw new Error("unreachable");
    const base = GRADE_PRESETS["talking-head"];
    expect(r.params.exposure).toBeCloseTo(base.exposure + 0.5, 10);
    expect(r.params.temperature).toBeCloseTo(base.temperature - 10, 10);
    expect(r.params.saturation).toBeCloseTo(base.saturation * 1.2, 10);
    expect(r.params.contrast).toBeCloseTo(base.contrast * 0.9, 10);
    expect(r.intensity).toBe(0.3);
  });

  it("lut yields a lut reference with tweaks as their own look, intensity default 1", () => {
    const r = resolveGradeToLook({ lut: "kodak.cube", exposure: 0.25 });
    expect(r.kind).toBe("lut");
    if (r.kind !== "lut") throw new Error("unreachable");
    expect(r.lutRef).toBe("kodak.cube");
    expect(r.intensity).toBe(1);
    expect(r.tweaks.exposure).toBe(0.25);
    expect(r.tweaks.saturation).toBe(1);
  });
});
