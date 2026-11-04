import { z } from "zod/v4";
import { REVEAL_SPEED_DEFAULT, SCENE_REGISTRY } from "./scene-registry";
import type { SceneComponentId } from "./scene-schema";

/**
 * The Inspector's controls for a scene's non-text props, derived from the
 * component's own schema (§153).
 *
 * Every string prop already has an editor: select the element and type in the
 * Text field. Nothing else did. `inverted`, `kenBurns`, `emphasizeLast` and
 * `fanOut` were reachable only by hand-editing overrides.json, because
 * `elementTextOf` returns null for anything that is not a string and the Text
 * field never renders.
 *
 * Derived rather than hand-listed on purpose. Hand-wiring per component is
 * exactly how ScreenshotFrame shipped a `data-edit-id` naming no prop at all —
 * the UI and the schema drifted and nothing connected them. Reading the schema
 * means a component that gains a boolean gets a control the day it lands.
 *
 * Lives in core, not the editor, and ships through the `browser` entry: zod
 * is already in that module graph (scene-schema + scene-registry), so the
 * editor gets the derivation without pulling a schema library into its own
 * bundle — the same reason `browser.ts` exists at all.
 */
export type PropControl =
  | {
      key: string;
      kind: "boolean" | "enum";
      /** The schema's own default — what the scene renders as when unset. */
      fallback?: boolean;
      options?: string[];
      /**
       * The prop may be ABSENT, and absent means something none of the
       * options does: an unset `pacing` keeps a legacy scene on its legacy
       * stagger, while `pacing: "even"` switches it to the paced reveal
       * (reveal-timing plan, Review Focus 5). So the dropdown must offer an
       * "unset" entry rather than showing `options[0]`, or an author who
       * touched the control could never get back to auto.
       */
      optional?: true;
    }
  | {
      key: string;
      kind: "number";
      min: number;
      max: number;
      step: number;
      /** What the scene renders as when unset — shown, never written. */
      fallback: number;
      /** As for enums: unset is a state of its own, not `fallback`. */
      optional?: true;
    };

type JsonSchemaProp = {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
};

/**
 * The unset value a numeric control displays. Only `revealSpeed` is numeric
 * today (reveal-timing spec, "revealSpeed slider"), so a numeric prop with no
 * schema default and no entry here falls back to its minimum — a sane slider
 * position, and loud enough in review that the next one gets an entry.
 */
const NUMBER_FALLBACKS: Record<string, number> = { revealSpeed: REVEAL_SPEED_DEFAULT };

export function scalarPropControls(component: SceneComponentId): PropControl[] {
  const meta = SCENE_REGISTRY[component];
  if (!meta) return [];
  const schema = z.toJSONSchema(meta.propsSchema as unknown as z.ZodType) as {
    properties?: Record<string, JsonSchemaProp>;
    required?: string[];
  };
  // Output-mode JSON Schema lists defaulted props as required, so "not
  // required" is exactly "may be absent with no default standing in".
  const required = new Set(schema.required ?? []);
  const controls: PropControl[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const optional = required.has(key) ? {} : { optional: true as const };
    // Enums first: a string prop with an enum is a CHOICE, not free text, and
    // the Text field would let you type a value the component cannot render.
    if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "string")) {
      controls.push({ key, kind: "enum", options: prop.enum as string[], ...optional });
      continue;
    }
    // A bounded number gets a slider. Unbounded ones are skipped: a slider
    // needs ends, and inventing them would let the UI write values the
    // schema never promised to accept.
    if (
      prop.type === "number" &&
      typeof prop.minimum === "number" &&
      typeof prop.maximum === "number"
    ) {
      const fallback =
        typeof prop.default === "number" ? prop.default : (NUMBER_FALLBACKS[key] ?? prop.minimum);
      controls.push({
        key,
        kind: "number",
        min: prop.minimum,
        max: prop.maximum,
        // Fine enough that the slider can rest exactly on a two-decimal
        // fallback (0.66): at 0.05 from a 0.1 minimum the browser snapped an
        // unset slider to 0.65 while the readout said 0.66.
        step: 0.01,
        fallback,
        ...optional,
      });
      continue;
    }
    if (prop.type === "boolean") {
      // The default matters: kenBurns is true when unset, so a checkbox that
      // assumed false would describe the scene wrongly before you touched it.
      controls.push({ key, kind: "boolean", fallback: prop.default === true });
    }
    // Strings and arrays fall through by design — the per-element Text field
    // and element selection already own them, and a second control writing the
    // same prop is how two sources of truth start disagreeing.
  }
  return controls;
}
