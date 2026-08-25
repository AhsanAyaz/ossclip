import { z } from "zod/v4";
import { SCENE_REGISTRY } from "./scene-registry";
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
export type PropControl = {
  key: string;
  kind: "boolean" | "enum";
  /** The schema's own default — what the scene renders as when unset. */
  fallback?: boolean;
  options?: string[];
};

type JsonSchemaProp = {
  type?: string;
  enum?: unknown[];
  default?: unknown;
};

export function scalarPropControls(component: SceneComponentId): PropControl[] {
  const meta = SCENE_REGISTRY[component];
  if (!meta) return [];
  const schema = z.toJSONSchema(meta.propsSchema as unknown as z.ZodType) as {
    properties?: Record<string, JsonSchemaProp>;
  };
  const controls: PropControl[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    // Enums first: a string prop with an enum is a CHOICE, not free text, and
    // the Text field would let you type a value the component cannot render.
    if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "string")) {
      controls.push({ key, kind: "enum", options: prop.enum as string[] });
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
