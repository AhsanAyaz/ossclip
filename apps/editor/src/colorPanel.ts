import {
  GRADE_PRESETS,
  gradeToSvgFilterSpec,
  resolveGradeToLook,
  type ColorGrade,
  type SvgGradeFilterSpec,
} from "@ossclip/core/browser";

/**
 * The Color panel's pure half (the `sfxLane.ts` split): everything about the
 * doc-global `colorGrade` override that is assertable without a DOM — the
 * source dropdown's value mapping, the slider state, and the live-preview
 * spec — lives here so the state semantics (`OverrideDocSchema.colorGrade`'s
 * three-way key: absent = inherit, `false` = off, object = the editor's own
 * grade) are tested as functions rather than through mounted selects.
 */

/** `/api/luts` — one .cube the dropdown can offer. `file` is the basename the
 * override carries (`ColorGrade.lut`), extension as the exporter spelled it. */
export interface LutMenuItem {
  id: string;
  title: string;
  file: string;
}

/** `/api/luts` verbatim: the menu plus the config-level default grade (null =
 * no valid config grade, so the panel offers no "Default" entry — produce
 * would ignore that config value too). */
export interface LutMenu {
  items: LutMenuItem[];
  issues: Array<{ file: string; message: string }>;
  configGrade: ColorGrade | null;
}

/** An empty menu — the fetch-failed fallback, the `setSfxLibrary([])` shape. */
export const EMPTY_LUT_MENU: LutMenu = { items: [], issues: [], configGrade: null };

/** The bundled preset ids, in the GRADE_PRESETS declaration order. */
export const GRADE_PRESET_IDS: string[] = Object.keys(GRADE_PRESETS);

/**
 * The `<select>` value for the doc's current state. `preset:`/`lut:` prefixes
 * because both halves are open vocabularies — a bare id could not say which
 * kind it names, and `ColorGradeSchema` insists on exactly one.
 *
 * An ABSENT key reads as "default" only when a config default exists to
 * inherit; with none, it displays as "off" — the two states render the same
 * frame, and a "Default (nothing)" entry would be a menu item about an absence.
 * (The reverse mapping in `gradeForSource` keeps the write exact: picking
 * "off" always stores `false`, never deletes the key.)
 */
export function gradeSourceValue(
  docGrade: ColorGrade | false | undefined,
  configGrade: ColorGrade | null,
): string {
  if (docGrade === false) return "off";
  if (docGrade === undefined) return configGrade !== null ? "default" : "off";
  if (docGrade.lut !== undefined) return `lut:${docGrade.lut}`;
  return `preset:${docGrade.preset ?? ""}`;
}

/**
 * The override value a dropdown change writes — the exact three-way mapping:
 * "default" DELETES the key (undefined), "off" stores `false`, a look stores
 * an object. The tweak knobs (intensity/exposure/…) survive a look swap when
 * the doc already holds them: they are relative to the look
 * (`resolveGradeToLook` composes, not replaces), so "try punchy instead"
 * should not also reset a warmth the user just dialed in.
 */
export function gradeForSource(
  value: string,
  current: ColorGrade | false | undefined,
): ColorGrade | false | undefined {
  if (value === "default") return undefined;
  if (value === "off") return false;
  const tweaks =
    current !== false && current !== undefined
      ? {
          ...(current.intensity !== undefined ? { intensity: current.intensity } : {}),
          ...(current.exposure !== undefined ? { exposure: current.exposure } : {}),
          ...(current.temperature !== undefined ? { temperature: current.temperature } : {}),
          ...(current.saturation !== undefined ? { saturation: current.saturation } : {}),
          ...(current.contrast !== undefined ? { contrast: current.contrast } : {}),
        }
      : {};
  if (value.startsWith("lut:")) return { lut: value.slice("lut:".length), ...tweaks };
  return { preset: value.slice("preset:".length), ...tweaks };
}

/**
 * The grade the sliders edit: the doc's own object, else the inherited config
 * default, else null (off / nothing to grade — the sliders hide). A slider
 * commit always writes the WHOLE effective grade with one field changed, so
 * nudging intensity on an inherited default promotes it to an editor override
 * of the same look — the only way a tweak can outlive the next produce run
 * (override > flag > config).
 */
export function effectiveGrade(
  docGrade: ColorGrade | false | undefined,
  configGrade: ColorGrade | null,
): ColorGrade | null {
  if (docGrade === false) return null;
  if (docGrade !== undefined) return docGrade;
  return configGrade;
}

/** What each slider shows when the grade doesn't pin it — the schema's own
 * documented defaults: the preset's `defaultIntensity` (1 for a LUT), and the
 * identity value for every tweak. */
export function gradeSliderState(grade: ColorGrade): {
  intensity: number;
  exposure: number;
  temperature: number;
  saturation: number;
  contrast: number;
} {
  const defaultIntensity =
    grade.preset !== undefined
      ? (GRADE_PRESETS as Partial<Record<string, { defaultIntensity: number }>>)[grade.preset]
          ?.defaultIntensity ?? 1
      : 1;
  return {
    intensity: grade.intensity ?? defaultIntensity,
    exposure: grade.exposure ?? 0,
    temperature: grade.temperature ?? 0,
    saturation: grade.saturation ?? 1,
    contrast: grade.contrast ?? 1,
  };
}

/** A human label for the config default's dropdown entry. */
export function configGradeName(configGrade: ColorGrade): string {
  return configGrade.lut !== undefined ? `LUT ${configGrade.lut}` : (configGrade.preset ?? "grade");
}

/**
 * The `colorGrade` the Player's live props carry — the recomposed field, the
 * `captionsHidden` posture (never inherit the baked value when the doc has a
 * say):
 *
 *  - key ABSENT → the LAST RENDER's spec, untouched. Recomputing from the
 *    config here would be WRONG, not just redundant: produce's precedence is
 *    override > flag > config, and the baked spec already resolved a
 *    `--color-grade` flag this panel cannot see.
 *  - `false` → no grade, whatever the last render baked.
 *  - a PRESET object → computed here with produce's own functions, so the
 *    preview is the render, by construction.
 *  - a LUT object → NO spec: a .cube bakes into the mezzanine at render time
 *    (produce.ts's grade block), and faking it with some parametric stand-in
 *    would show a grade no render produces. The panel's "applies on next
 *    render" note is the honest surface for this.
 */
export function liveGradeSpec(
  docGrade: ColorGrade | false | undefined,
  bakedSpec: SvgGradeFilterSpec | undefined,
): SvgGradeFilterSpec | undefined {
  if (docGrade === false) return undefined;
  if (docGrade === undefined) return bakedSpec;
  if (docGrade.lut !== undefined) return undefined;
  const resolved = resolveGradeToLook(docGrade);
  return resolved.kind === "preset" ? gradeToSvgFilterSpec(resolved) : undefined;
}
