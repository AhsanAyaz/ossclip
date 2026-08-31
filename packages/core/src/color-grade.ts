import { z } from "zod/v4";

/**
 * Color grade — the whole module is pure (no filesystem, no TTY) so every
 * curve, LUT sample and matrix can be tested against hand-computed values.
 * `node:crypto` is the one Node import, and it is deterministic.
 *
 * The user-facing shape below is shared by config.json, overrides.json and
 * the CLI, so it is parsed with zod here once rather than coerced at three
 * consumers. `preset` names a bundled parametric look; `lut` names a `.cube`
 * file (basename only — path resolution is the caller's I/O, not ours).
 */
export const ColorGradeSchema = z
  .strictObject({
    /** Bundled parametric look id — one of `Object.keys(GRADE_PRESETS)`. */
    preset: z.string().optional(),
    /** `.cube` filename in `~/.ossclip/luts`, basename only. */
    lut: z.string().optional(),
    /** 0..1 blend toward the graded image. Default: the preset's own, or 1 for a LUT. */
    intensity: z.number().min(0).max(1).optional(),
    /** Exposure in EV (stops). */
    exposure: z.number().min(-2).max(2).optional(),
    /** Warm (+) / cool (−), a deliberately small per-channel gain. */
    temperature: z.number().min(-100).max(100).optional(),
    /** 1 = unchanged. */
    saturation: z.number().min(0).max(2).optional(),
    /** 1 = unchanged. */
    contrast: z.number().min(0).max(2).optional(),
  })
  .refine((g) => (g.preset !== undefined) !== (g.lut !== undefined), {
    message: 'set exactly one of "preset" or "lut" — a grade needs one look, not zero or two',
  });
export type ColorGrade = z.infer<typeof ColorGradeSchema>;

/**
 * The internal parametric look. Tints are small additive per-channel biases
 * weighted by luma (split-toning): `shadowTint` pulls the darks, one minus
 * luma at a time, `highlightTint` the brights.
 */
export interface LookParams {
  /** -100..100, warm (+) / cool (−) — mapped to per-channel gains in `applyGrade`. */
  temperature: number;
  /** Green-magenta axis, same tiny-gain scale as temperature. */
  tint: number;
  /** EV. */
  exposure: number;
  /** Pivot-0.5 slope; 1 = unchanged. */
  contrast: number;
  /** Raised black floor, 0..~0.1 in practice. */
  lift: number;
  /** 1 = unchanged, 0 = mono. */
  saturation: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  /** What `intensity` means when the user didn't set one. */
  defaultIntensity: number;
}

/** A look that changes nothing — the base every preset and tweak builds on. */
export const IDENTITY_LOOK: LookParams = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 1,
  lift: 0,
  saturation: 1,
  shadowTint: [0, 0, 0],
  highlightTint: [0, 0, 0],
  defaultIntensity: 1,
};

export type GradePresetId = "talking-head" | "teal-orange" | "filmic-fade" | "cwa" | "punchy" | "mono";

export const GRADE_PRESETS: Record<GradePresetId, LookParams> = {
  // The flagship for YouTube talking-head footage: skin-safe, so hue shifts
  // stay mild — warmth and a gentle S-curve, nothing that moves skin tones.
  // Tuned on real channel footage (2026-08-30): the source is already warm
  // tungsten light, so temperature stays small; and because contrast runs
  // before lift in applyGrade, a 1.08 slope at pivot 0.5 pulls black down
  // 0.04 — more than a 0.03 lift puts back. 1.06/0.045 keeps the fade.
  "talking-head": {
    ...IDENTITY_LOOK,
    temperature: 10,
    contrast: 1.06,
    lift: 0.045,
    saturation: 1.05,
    defaultIntensity: 0.6,
  },
  // The blockbuster split-tone: teal shadows against warm highlights.
  "teal-orange": {
    ...IDENTITY_LOOK,
    shadowTint: [-0.03, 0.01, 0.04],
    highlightTint: [0.04, 0.01, -0.03],
    contrast: 1.15,
    saturation: 1.05,
    defaultIntensity: 0.7,
  },
  // Faded film stock: lifted blacks, softened contrast, muted color.
  "filmic-fade": {
    ...IDENTITY_LOOK,
    lift: 0.06,
    contrast: 0.95,
    saturation: 0.9,
    temperature: 8,
    defaultIntensity: 0.8,
  },
  // Thumbnail-bright: more contrast and more color, for footage shot flat.
  punchy: {
    ...IDENTITY_LOOK,
    contrast: 1.2,
    saturation: 1.15,
    defaultIntensity: 0.7,
  },
  // Ahsan's channel look (2026-08-30), designed against his published footage:
  // camera runs ~0.1 EV under, the room's tungsten already supplies warmth, so
  // exposure does the lifting and temperature barely moves. Teal in the
  // shadows / warm highlights for depth that doesn't announce itself; params
  // are at final strength, hence defaultIntensity 1.
  cwa: {
    ...IDENTITY_LOOK,
    temperature: 6,
    exposure: 0.1,
    contrast: 1.09,
    lift: 0.05,
    saturation: 1.06,
    shadowTint: [-0.015, 0.0, 0.02],
    highlightTint: [0.02, 0.005, -0.01],
    defaultIntensity: 1,
  },
  // Black and white with a touch of contrast to keep it from going gray mush.
  mono: {
    ...IDENTITY_LOOK,
    saturation: 0,
    contrast: 1.1,
    defaultIntensity: 1,
  },
};

/** Rec.709 luma weights — the footage this pipeline grades is Rec.709. */
const LUMA: [number, number, number] = [0.2126, 0.7152, 0.0722];

const clamp01 = (c: number): number => Math.min(1, Math.max(0, c));
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Steps 1–4 of the pipeline — the channel-INDEPENDENT portion (exposure,
 * temperature/tint gains, contrast, lift). Split out so `applyGrade` and the
 * SVG filter's per-channel transfer tables are the same math by construction:
 * a curve sampled here IS the curve the evaluator ran.
 *
 * Unclamped on purpose: `applyGrade` clamps once at the end, and clamping
 * here would bake a different (earlier) clip point into the tables.
 */
function channelCurve(params: LookParams, channel: 0 | 1 | 2, value: number): number {
  // 1. exposure, in stops.
  let c = value * 2 ** params.exposure;
  // 2. temperature/tint as per-channel gains. 0.0015/unit keeps the full
  //    ±100 range at a ±15% gain — a grade, not a gel.
  const gain =
    channel === 0
      ? 1 + params.temperature * 0.0015
      : channel === 1
        ? 1 + params.tint * 0.0015
        : 1 - params.temperature * 0.0015;
  c *= gain;
  // 3. contrast about a 0.5 pivot. A linear pivot, not a filmic S — fine for
  //    v1 in gamma-encoded space, where 0.5 is already perceptual mid-gray.
  c = 0.5 + (c - 0.5) * params.contrast;
  // 4. lift: raise the black floor without touching white.
  c = c * (1 - params.lift) + params.lift;
  return c;
}

/**
 * The single source of truth for what a look DOES to a pixel. Everything
 * else — the SVG filter spec, the baked .cube — is an encoding of this
 * function, and the tests hold them to it.
 *
 * Operates in gamma-encoded space (pragmatic: the footage is Rec.709, and a
 * linearize/delinearize round-trip buys little for these mild looks).
 * Input and output are 0..1 per channel; output is clamped.
 */
export function applyGrade(
  params: LookParams,
  rgb: [number, number, number],
): [number, number, number] {
  const c: [number, number, number] = [
    channelCurve(params, 0, rgb[0]),
    channelCurve(params, 1, rgb[1]),
    channelCurve(params, 2, rgb[2]),
  ];
  // 5. split-tone: tint shadows and highlights by luma weight.
  const luma = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
  for (let i = 0; i < 3; i++) {
    c[i] = c[i]! + params.shadowTint[i]! * (1 - luma) + params.highlightTint[i]! * luma;
  }
  // 6. saturation: pull toward (or push away from) the pixel's luma.
  const luma2 = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
  return [
    clamp01(mix(luma2, c[0], params.saturation)),
    clamp01(mix(luma2, c[1], params.saturation)),
    clamp01(mix(luma2, c[2], params.saturation)),
  ];
}

/** `mix(rgb, applyGrade(rgb), intensity)` — the user's blend knob. */
export function applyGradeWithIntensity(
  params: LookParams,
  intensity: number,
  rgb: [number, number, number],
): [number, number, number] {
  const graded = applyGrade(params, rgb);
  return [
    mix(rgb[0], graded[0], intensity),
    mix(rgb[1], graded[1], intensity),
    mix(rgb[2], graded[2], intensity),
  ];
}

export interface ResolvedGrade {
  params: LookParams;
  intensity: number;
}

/** The two-stage SVG filter: feComponentTransfer tables, then feColorMatrix. */
export interface SvgGradeFilterSpec {
  /** 33 samples each, for `<feFuncR type="table">` etc. */
  tableR: number[];
  tableG: number[];
  tableB: number[];
  /** 20 values row-major, for `<feColorMatrix type="matrix">`. */
  colorMatrix: number[];
}

/** Samples per transfer-table channel — 33 matches the default .cube lattice. */
const SVG_TABLE_SAMPLES = 33;

/** 4x5 affine identity in feColorMatrix's 20-value row-major layout. */
const IDENTITY_MATRIX: number[] = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

/** `a ∘ b` for 4x5 affine color matrices (apply `b` first, then `a`). */
function composeColorMatrix(a: number[], b: number[]): number[] {
  const out = new Array<number>(20).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[r * 5 + k]! * b[k * 5 + c]!;
      out[r * 5 + c] = v;
    }
    let konst = a[r * 5 + 4]!;
    for (let k = 0; k < 4; k++) konst += a[r * 5 + k]! * b[k * 5 + 4]!;
    out[r * 5 + 4] = konst;
  }
  return out;
}

/**
 * Encode a resolved grade as an SVG filter. Per-channel curves cannot carry
 * cross-channel ops, so the pipeline decomposes into:
 *
 *  - Stage A (feComponentTransfer tables): the channel-independent steps 1–4,
 *    sampled at 33 points per channel via the same `channelCurve` the
 *    evaluator runs.
 *  - Stage B (feColorMatrix): split-tone + saturation. Both are affine in
 *    rgb — luma is a dot product — so the stage is EXACT: the split-tone
 *    matrix (row c gains `(highlight_c − shadow_c)·L`, constant `shadow_c`)
 *    composed with the standard Rec.709 saturation matrix.
 *
 * Intensity blends Stage A toward identity tables and Stage B toward the
 * identity matrix, each by `k`. That is an approximation of blending the
 * COMPOSED pipeline (blend-then-compose ≠ compose-then-blend), accepted
 * because it is exact at k=0 and k=1 and visually indistinguishable between,
 * and the alternative — a third filter input carrying the ungraded image —
 * costs an feImage round-trip per frame.
 */
export function gradeToSvgFilterSpec(grade: ResolvedGrade): SvgGradeFilterSpec {
  const { params, intensity } = grade;
  const table = (channel: 0 | 1 | 2): number[] => {
    const out: number[] = [];
    for (let i = 0; i < SVG_TABLE_SAMPLES; i++) {
      const x = i / (SVG_TABLE_SAMPLES - 1);
      // Clamp before blending: feComponentTransfer table values live in 0..1,
      // and blending toward x keeps the result there.
      out.push(mix(x, clamp01(channelCurve(params, channel, x)), intensity));
    }
    return out;
  };

  const d: [number, number, number] = [
    params.highlightTint[0] - params.shadowTint[0],
    params.highlightTint[1] - params.shadowTint[1],
    params.highlightTint[2] - params.shadowTint[2],
  ];
  const split: number[] = [
    1 + d[0] * LUMA[0], d[0] * LUMA[1], d[0] * LUMA[2], 0, params.shadowTint[0],
    d[1] * LUMA[0], 1 + d[1] * LUMA[1], d[1] * LUMA[2], 0, params.shadowTint[1],
    d[2] * LUMA[0], d[2] * LUMA[1], 1 + d[2] * LUMA[2], 0, params.shadowTint[2],
    0, 0, 0, 1, 0,
  ];
  const s = params.saturation;
  const sat: number[] = [
    (1 - s) * LUMA[0] + s, (1 - s) * LUMA[1], (1 - s) * LUMA[2], 0, 0,
    (1 - s) * LUMA[0], (1 - s) * LUMA[1] + s, (1 - s) * LUMA[2], 0, 0,
    (1 - s) * LUMA[0], (1 - s) * LUMA[1], (1 - s) * LUMA[2] + s, 0, 0,
    0, 0, 0, 1, 0,
  ];
  const composed = composeColorMatrix(sat, split);
  const colorMatrix = composed.map((v, i) => mix(IDENTITY_MATRIX[i]!, v, intensity));

  return { tableR: table(0), tableG: table(1), tableB: table(2), colorMatrix };
}

/** A parsed .cube 3D LUT — `data` is r-fastest, length `3 * size³`. */
export interface CubeLut {
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  data: Float32Array;
  title?: string;
}

/**
 * Parse Adobe/Resolve `.cube` text. Lenient about FORM — BOM, CRLF, tabs,
 * comments anywhere, keywords in any position — because .cube files come
 * from a dozen exporters that each format differently. Strict about
 * CONTENT — size range, exact line count, finite floats — because a
 * half-parsed LUT is a wrong grade on every frame, and the file is user
 * input the caller will report, not swallow.
 *
 * Values outside 0..1 are PRESERVED here: log/HDR LUTs legitimately exceed
 * the domain, and clamping belongs at apply time (`sampleCubeLut`), not
 * parse time. `Number`, never `parseFloat` with a locale — a comma decimal
 * must fail loudly, not truncate silently.
 */
export function parseCubeLut(text: string): CubeLut {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let size: number | undefined;
  let title: string | undefined;
  const domainMin: [number, number, number] = [0, 0, 0];
  const domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  const parseTriple = (fields: string[], line: string): [number, number, number] => {
    if (fields.length !== 3) throw new Error(`.cube: expected 3 values per line, got "${line}"`);
    const nums = fields.map(Number) as [number, number, number];
    if (nums.some((n) => !Number.isFinite(n))) {
      throw new Error(`.cube: non-numeric value in line "${line}"`);
    }
    return nums;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    const first = fields[0]!; // a trimmed non-empty line always has a first field
    const keyword = first.toUpperCase();
    if (keyword === "TITLE") {
      // Everything after the keyword, quotes stripped — titles contain spaces.
      title = line.slice(first.length).trim().replace(/^"(.*)"$/, "$1");
      continue;
    }
    if (keyword === "LUT_1D_SIZE") throw new Error(".cube: 1D LUTs not supported");
    if (keyword === "LUT_3D_SIZE") {
      const n = Number(fields[1]);
      if (!Number.isInteger(n) || n < 2 || n > 256) {
        throw new Error(`.cube: LUT_3D_SIZE must be an integer in 2..256, got "${fields[1]}"`);
      }
      size = n;
      continue;
    }
    if (keyword === "DOMAIN_MIN" || keyword === "DOMAIN_MAX") {
      const nums = parseTriple(fields.slice(1), line);
      const target = keyword === "DOMAIN_MIN" ? domainMin : domainMax;
      for (let i = 0; i < 3; i++) target[i] = nums[i]!;
      continue;
    }
    if (/^[A-Za-z_]/.test(first)) {
      throw new Error(`.cube: unrecognized keyword "${first}"`);
    }
    values.push(...parseTriple(fields, line));
  }

  if (size === undefined) throw new Error(".cube: missing LUT_3D_SIZE");
  const expected = 3 * size ** 3;
  if (values.length !== expected) {
    throw new Error(
      `.cube: expected ${size}³ = ${expected / 3} data lines, got ${values.length / 3}`,
    );
  }
  return { size, domainMin, domainMax, data: Float32Array.from(values), title };
}

/** Trilinear sample. Input mapped through the LUT's domain; output clamped 0..1. */
export function sampleCubeLut(
  lut: CubeLut,
  rgb: [number, number, number],
): [number, number, number] {
  const n = lut.size;
  const axis = (i: 0 | 1 | 2): number => {
    const span = lut.domainMax[i] - lut.domainMin[i];
    const t = span === 0 ? 0 : (rgb[i] - lut.domainMin[i]) / span;
    return clamp01(t) * (n - 1);
  };
  const coord: [number, number, number] = [axis(0), axis(1), axis(2)];
  const lo = coord.map(Math.floor) as [number, number, number];
  const hi = lo.map((v) => Math.min(v + 1, n - 1)) as [number, number, number];
  const f = coord.map((v, i) => v - lo[i]!) as [number, number, number];
  // r fastest in the data layout: index = 3 * (r + n*g + n²*b).
  const at = (r: number, g: number, b: number, ch: number): number =>
    lut.data[3 * (r + n * g + n * n * b) + ch]!;
  const out: [number, number, number] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const c00 = mix(at(lo[0], lo[1], lo[2], ch), at(hi[0], lo[1], lo[2], ch), f[0]);
    const c10 = mix(at(lo[0], hi[1], lo[2], ch), at(hi[0], hi[1], lo[2], ch), f[0]);
    const c01 = mix(at(lo[0], lo[1], hi[2], ch), at(hi[0], lo[1], hi[2], ch), f[0]);
    const c11 = mix(at(lo[0], hi[1], hi[2], ch), at(hi[0], hi[1], hi[2], ch), f[0]);
    out[ch] = clamp01(mix(mix(c00, c10, f[1]), mix(c01, c11, f[1]), f[2]));
  }
  return out;
}

/**
 * Emit .cube text for a look — the renderer-agnostic encoding. Each lattice
 * point p (r fastest) becomes `mix(p, pipeline(p), intensity)` where the
 * pipeline is the base LUT sample (when one is given) with
 * `applyGrade(params)` composed ON TOP of it (when given): sample first, then
 * tweak. Composition, not either/or — `resolveGradeToLook` hands a LUT grade
 * back as `lutRef` + `tweaks`, and a bake that ignored `params` next to a
 * `base` would silently drop the user's exposure/saturation knobs exactly
 * when a LUT is in play (the pre-2026-08-30 behavior, once a documented
 * deviation). Deterministic on purpose — fixed 6-decimal formatting, stable
 * key order — so `lutHash` of the output is a valid cache key.
 */
export function bakeCube(opts: {
  base?: CubeLut;
  params?: LookParams;
  intensity: number;
  size?: number;
}): string {
  const size = opts.size ?? opts.base?.size ?? 33;
  const pipeline = (p: [number, number, number]): [number, number, number] => {
    const sampled = opts.base ? sampleCubeLut(opts.base, p) : p;
    return opts.params ? applyGrade(opts.params, sampled) : sampled;
  };
  const lines: string[] = ['TITLE "ossclip"', `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const p: [number, number, number] = [r / (size - 1), g / (size - 1), b / (size - 1)];
        const out = pipeline(p);
        lines.push(
          ([0, 1, 2] as const).map((i) => mix(p[i], out[i], opts.intensity).toFixed(6)).join(" "),
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Short fingerprint of baked .cube text, for cache filenames. FNV-1a 64-bit,
 * not sha256: this module is in `@ossclip/core/browser`'s graph (overrides.ts
 * imports the schema), so a top-level `node:crypto` import broke the editor's
 * Vite build outright. A cache key needs determinism, not cryptography, and
 * 64 bits is collision-safe at the scale of one user's LUT directory.
 */
export function lutHash(cubeText: string): string {
  const PRIME = 0x100000001b3n;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < cubeText.length; i++) {
    h ^= BigInt(cubeText.charCodeAt(i));
    h = (h * PRIME) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0").slice(0, 12);
}

/**
 * Validate a grade value from config/overrides/CLI. Never throws and never
 * coerces (CLAUDE.md's parse-don't-coerce): a malformed grade is one warning
 * naming the source and no grade at all — a typo must cost the look, not the
 * run. The warning is RETURNED rather than printed so this stays pure, the
 * `resolveSfxBundledPack` shape.
 *
 * An unknown preset id is caught HERE, not in the schema, so the warning can
 * list what exists — a schema enum would reject with zod's generic message.
 */
export function resolveColorGrade(
  value: unknown,
  source: string,
): { grade?: ColorGrade; warning?: string } {
  if (value === undefined) return {};
  const parsed = ColorGradeSchema.safeParse(value);
  if (!parsed.success) {
    return { warning: `⚠ ${source} colorGrade ignored — ${parsed.error.issues[0]?.message}` };
  }
  const preset = parsed.data.preset;
  if (preset !== undefined && !(preset in GRADE_PRESETS)) {
    return {
      warning:
        `⚠ ${source} colorGrade ignored — unknown preset "${preset}" ` +
        `(have: ${Object.keys(GRADE_PRESETS).join(", ")})`,
    };
  }
  return { grade: parsed.data };
}

export interface ResolvedLutGrade {
  kind: "lut";
  /** The `.cube` basename — the caller resolves it under `~/.ossclip/luts`. */
  lutRef: string;
  /** User tweaks as a look, applied ON TOP of the LUT sample. */
  tweaks: LookParams;
  intensity: number;
}
export interface ResolvedPresetGrade extends ResolvedGrade {
  kind: "preset";
}

/**
 * Merge a validated grade into something the renderer can run: preset params
 * with the user's tweaks composed on top (exposure/temperature ADD,
 * saturation/contrast MULTIPLY — a tweak is relative to the look, not a
 * replacement for it), or a LUT reference with the tweaks as their own look.
 * Intensity falls back to the preset's `defaultIntensity`, or 1 for a LUT.
 */
export function resolveGradeToLook(grade: ColorGrade): ResolvedPresetGrade | ResolvedLutGrade {
  if (grade.lut !== undefined) {
    return {
      kind: "lut",
      lutRef: grade.lut,
      tweaks: {
        ...IDENTITY_LOOK,
        exposure: grade.exposure ?? 0,
        temperature: grade.temperature ?? 0,
        saturation: grade.saturation ?? 1,
        contrast: grade.contrast ?? 1,
      },
      intensity: grade.intensity ?? 1,
    };
  }
  // `resolveColorGrade` guarantees the id exists; a caller who skipped it and
  // passed an unknown preset gets the identity look rather than a crash.
  const base =
    (GRADE_PRESETS as Partial<Record<string, LookParams>>)[grade.preset ?? ""] ?? IDENTITY_LOOK;
  return {
    kind: "preset",
    params: {
      ...base,
      exposure: base.exposure + (grade.exposure ?? 0),
      temperature: base.temperature + (grade.temperature ?? 0),
      saturation: base.saturation * (grade.saturation ?? 1),
      contrast: base.contrast * (grade.contrast ?? 1),
    },
    intensity: grade.intensity ?? base.defaultIntensity,
  };
}
