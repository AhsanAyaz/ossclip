import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { SCENE_REGISTRY } from "@ossclip/core";
import type { SceneComponentId } from "@ossclip/core";

/**
 * Every `data-edit-id` a component renders must name something the editor can
 * actually edit (§153).
 *
 * The Inspector resolves a selected element with `elementTextOf`, which is
 * `props[elementId]` for a plain id — so an id that matches no prop silently
 * yields `null`, the Text field never renders, and that element is
 * uneditable. Nothing fails; the control is simply absent, which is
 * indistinguishable from "this element has nothing to edit".
 *
 * ScreenshotFrame shipped exactly that: it renders `data-edit-id="image"`
 * while the prop is `src`, so you could select the screenshot and never change
 * it. One rename is all it takes, and the only thing that noticed was a user
 * asking why they couldn't swap the image.
 *
 * The dynamic ids are exempt by pattern: `line-0`, `window-2` and friends are
 * array indices resolved through the backing prop (`lines`, `windows`, …),
 * which `elementTextOf` handles separately.
 */
const DYNAMIC = /^(line|node|message|item|window)-(\d+|N|\$)/;
/** Backing arrays the dynamic ids index into — the prop that must exist. */
const BACKING: Record<string, string> = {
  line: "lines",
  node: "nodes",
  message: "messages",
  item: "items",
  window: "windows",
};

const componentSource = (id: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../src/components/${id}.tsx`, import.meta.url)),
    "utf8",
  );

/**
 * Two shapes, because the components use two. A leaf either hardcodes its id
 * (`data-edit-id="title"`) or takes one as a prop and passes it straight
 * through (`data-edit-id={editId}`) — and in the second case the real id is
 * built at the CALL site as a template (`editId={`node-${i}`}`). Scanning only
 * the attribute would collect the literal string "editId", which is a
 * pass-through variable and not an id at all.
 */
const editIdsIn = (src: string): string[] => [
  ...new Set([
    ...[...src.matchAll(/data-edit-id="([^"]+)"/g)].map((m) => m[1]!),
    ...[...src.matchAll(/editId=\{`([a-z]+)-\$\{/g)].map((m) => `${m[1]!}-N`),
  ]),
];

const propsOf = (id: SceneComponentId): string[] => {
  const schema = z.toJSONSchema(
    SCENE_REGISTRY[id].propsSchema as unknown as z.ZodType,
  ) as { properties?: Record<string, unknown> };
  return Object.keys(schema.properties ?? {});
};

describe("every data-edit-id resolves to a real prop", () => {
  const ids = Object.keys(SCENE_REGISTRY) as SceneComponentId[];

  it("covers every component in the registry — a new one cannot opt out", () => {
    expect(ids.length).toBeGreaterThanOrEqual(9);
  });

  it.each(ids)("%s", (id) => {
    const props = propsOf(id);
    for (const editId of editIdsIn(componentSource(id))) {
      const dyn = DYNAMIC.exec(editId);
      if (dyn) {
        // `window-${i}` must have `windows` to index into.
        expect(props, `${id}: dynamic id "${editId}" needs its backing array`).toContain(
          BACKING[dyn[1]!],
        );
        continue;
      }
      expect(props, `${id}: data-edit-id "${editId}" matches no prop`).toContain(editId);
    }
  });
});
