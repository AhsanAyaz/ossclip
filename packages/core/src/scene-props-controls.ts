import { z } from "zod/v4";
import { REVEAL_SPEED_DEFAULT, SCENE_REGISTRY } from "./scene-registry";
import type { SceneComponentId } from "./scene-schema";
// Type-only: added-scenes imports assemble and scene-registry at runtime, and
// this module needs nothing from it but the offered-type union.
import type { AddedOffered } from "./added-scenes";

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
      /**
       * Unset is NONE of the values, not a default standing in for one: an
       * absent CardRow `highlight` highlights no card, an absent BugCard
       * `mockWrong` marks nothing (§161). Set only for an optional prop with
       * neither a schema default nor a `NUMBER_FALLBACKS` entry, so the
       * Inspector says "not set" rather than "default (0)" — which would
       * read as card 0 chosen. `fallback` is then only where the slider rests.
       */
      unsetIsNone?: true;
    };

type JsonSchemaProp = {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
};

/**
 * A bounded number or integer prop's slider step. `z.number().int()` writes
 * JSON Schema type "integer" — a slider stepping 0.01 there would write
 * 1.37 into a prop the schema rejects at the next parse (§161: CardRow's
 * `highlight`, BugCard's `number` and `mockWrong` had no control at all
 * while the derivation read type "number" only).
 */
const sliderStep = (type: string): number => (type === "integer" ? 1 : 0.01);

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
    // A bounded number or integer gets a slider. Unbounded ones are
    // skipped: a slider needs ends, and inventing them would let the UI
    // write values the schema never promised to accept.
    if (
      (prop.type === "number" || prop.type === "integer") &&
      typeof prop.minimum === "number" &&
      typeof prop.maximum === "number"
    ) {
      const known = typeof prop.default === "number" ? prop.default : NUMBER_FALLBACKS[key];
      controls.push({
        key,
        kind: "number",
        min: prop.minimum,
        max: prop.maximum,
        // 0.01 for a number: fine enough that the slider can rest exactly on
        // a two-decimal fallback (0.66) — at 0.05 from a 0.1 minimum the
        // browser snapped an unset slider to 0.65 while the readout said 0.66.
        step: sliderStep(prop.type),
        fallback: known ?? prop.minimum,
        ...optional,
        ...(known === undefined && !required.has(key) ? { unsetIsNone: true as const } : {}),
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

/**
 * One field of the add gesture's short form (editor-added-graphics §5, step
 * 2). The add form is the one place strings and arrays DO get a control:
 * there is no element to select yet, so the Text field cannot own them —
 * which is why this is a function of its own and `scalarPropControls` keeps
 * its skip above.
 *
 * - `list` is an array of short texts. `item: "text-object"` means each entry
 *   is stored as `{ text }` (StrikethroughReveal's lines, CardRow's cards,
 *   PhoneDemo's caption words) and the schema's `.default()`s fill the rest;
 *   the form itself deals only in strings.
 * - `messages` is ChatMock's alone: each entry is a text AND who sends it.
 */
export type AddFormField =
  | { kind: "text"; key: string; label: string; max: number }
  | {
      kind: "list";
      key: string;
      label: string;
      min: number;
      max: number;
      itemMax: number;
      item: "string" | "text-object";
    }
  | { kind: "messages"; key: "messages"; min: number; max: number; itemMax: number; from: readonly string[] }
  | { kind: "choice"; key: string; label: string; options: readonly string[] }
  | { kind: "number"; key: string; label: string; min: number; max: number };

/** A field as the table states it: which prop, what to call it, what shape.
 * Bounds and options are deliberately absent — they are read from the schema. */
type AddFieldSpec =
  | { kind: "text" | "choice" | "number"; key: string; label: string }
  | { kind: "list"; key: string; label: string; item: "string" | "text-object" }
  | { kind: "messages"; key: "messages" };

/**
 * The spec §5 table as data, in its order. Keyed by `AddedOffered` so a type
 * joining the menu without a row here fails the typecheck. Only the keys and
 * labels live here: every cap, item count and option list is read from the
 * schema in `addFormFields`, because a hand-copied `max: 48` is the
 * UI/schema drift §153 derives controls to avoid — a form that allowed 50
 * characters would let Add store props that conversion then skips.
 *
 * Each row covers its schema's every required field with no `.default()`:
 * conversion parses the stored props RAW (`addedSceneToScene`, §2), with no
 * registry `defaultProps` merged in, so a field missing from the form could
 * never be filled at all.
 */
const ADD_FORM: Record<AddedOffered, readonly AddFieldSpec[]> = {
  TitleCard: [{ kind: "text", key: "title", label: "Title" }],
  StatCard: [
    { kind: "text", key: "value", label: "Value" },
    { kind: "text", key: "label", label: "Label" },
  ],
  RuleCard: [
    { kind: "text", key: "kicker", label: "Kicker" },
    { kind: "text", key: "text", label: "Text" },
  ],
  StrikethroughReveal: [{ kind: "list", key: "lines", label: "Lines", item: "text-object" }],
  BulletList: [{ kind: "list", key: "items", label: "Items", item: "string" }],
  FlowDiagram: [{ kind: "list", key: "nodes", label: "Steps", item: "string" }],
  ChatMock: [{ kind: "messages", key: "messages" }],
  CardRow: [{ kind: "list", key: "cards", label: "Cards", item: "text-object" }],
  CtaCard: [
    { kind: "choice", key: "action", label: "Action" },
    { kind: "text", key: "text", label: "Text" },
  ],
  BugCard: [
    { kind: "number", key: "number", label: "Number" },
    { kind: "text", key: "headline", label: "Headline" },
  ],
  PhoneDemo: [{ kind: "list", key: "caption", label: "Caption words", item: "text-object" }],
};

type JsonSchemaNode = {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
};

/**
 * A bound the table relies on, or a throw. Loud on purpose: a schema that
 * lost a cap (or a renamed key) would otherwise hand the editor a form with
 * no limit, and the per-type test runs this for every offered type, so the
 * throw fails the suite long before it could reach an author.
 */
function bound<T>(value: T | undefined, where: string): T {
  if (value === undefined) throw new Error(`add form: ${where} has no bound in its schema`);
  return value;
}

/** The fields of the add form for one offered type, in the §5 table's order. */
export function addFormFields(component: AddedOffered): AddFormField[] {
  const schema = z.toJSONSchema(SCENE_REGISTRY[component].propsSchema as unknown as z.ZodType) as {
    properties?: Record<string, JsonSchemaNode>;
  };
  const props = schema.properties ?? {};
  return ADD_FORM[component].map((spec): AddFormField => {
    const at = `${component}.${spec.key}`;
    const prop = bound(props[spec.key], at);
    switch (spec.kind) {
      case "text":
        return { kind: "text", key: spec.key, label: spec.label, max: bound(prop.maxLength, at) };
      case "choice": {
        const options = bound(prop.enum, at);
        if (!options.every((o) => typeof o === "string")) throw new Error(`add form: ${at} is not a string enum`);
        return { kind: "choice", key: spec.key, label: spec.label, options: options as string[] };
      }
      case "number":
        return {
          kind: "number",
          key: spec.key,
          label: spec.label,
          min: bound(prop.minimum, at),
          max: bound(prop.maximum, at),
        };
      case "list": {
        const item = bound(prop.items, at);
        const text = spec.item === "text-object" ? bound(item.properties?.text, `${at}[].text`) : item;
        return {
          kind: "list",
          key: spec.key,
          label: spec.label,
          min: bound(prop.minItems, at),
          max: bound(prop.maxItems, at),
          itemMax: bound(text.maxLength, `${at}[]`),
          item: spec.item,
        };
      }
      case "messages": {
        const item = bound(prop.items, at);
        const from = bound(item.properties?.from?.enum, `${at}[].from`);
        return {
          kind: "messages",
          key: "messages",
          min: bound(prop.minItems, at),
          max: bound(prop.maxItems, at),
          itemMax: bound(item.properties?.text?.maxLength, `${at}[].text`),
          from: from as string[],
        };
      }
    }
  });
}

/**
 * The form's values as the props object `addScene` stores (§5, step 2):
 * `values` is keyed by field key, a `text-object` list holding plain strings.
 *
 * Shaping only, never repair. Nothing is trimmed, clamped or defaulted, and a
 * value of the wrong shape passes through as it is: the Add button is enabled
 * by the schema parsing this output, so a malformed value must reach that
 * parse and keep the button off rather than be coerced into props the author
 * never wrote (the zod-not-coerce rule). Only the form's own keys are
 * written, and only those given — a value left from another type, when the
 * author switched type mid-form, must not ride into the stored entry.
 */
export function addFormProps(component: AddedOffered, values: Record<string, unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const spec of ADD_FORM[component]) {
    const value = values[spec.key];
    if (value === undefined) continue;
    props[spec.key] =
      spec.kind === "list" && spec.item === "text-object" && Array.isArray(value)
        ? value.map((v) => (typeof v === "string" ? { text: v } : v))
        : value;
  }
  return props;
}
