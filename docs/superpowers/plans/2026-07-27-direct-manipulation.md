# Direct Manipulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local page where the user clicks any element in a produced video, edits its text, drags it, retimes its scene, and saves — with edits surviving the next `produce` run.

**Architecture:** Edits live in a user-owned `workdir/overrides.json`, never in the producer-written `production.json`. The edit model (patch → resolved props/transforms) is pure TypeScript in `packages/core`, unit-tested without a browser. Hit-testing uses `data-edit-id` attributes plus `getBoundingClientRect`, so the DOM is the only source of truth for geometry.

**Tech Stack:** TypeScript, zod/v4, React 18, Remotion `<Player>`, Vite, vitest, Playwright (one smoke test), Node `http` (no server framework).

## Global Constraints

- Node ≥ 22, pnpm workspaces, TypeScript strict everywhere.
- **zod/v4 import specifier** — `import { z } from "zod/v4"`, never `"zod"`.
- **Anything imported by a browser bundle must come from a `/browser`-style subpath.** `@ossclip/core` and `@ossclip/renderer` barrels pull in `node:fs`, `node:path` and `@remotion/bundler`; importing them from `apps/editor` breaks the Vite build.
- `packages/core` stays framework-free: no React, no DOM types.
- The CLI remains the only thing that renders video. The editor never invokes ffmpeg or Remotion's renderer.
- Existing tests must stay green: `pnpm test` (276 tests at plan time) and `pnpm typecheck`.
- Commit after every task.

---

### Task 1: The override model (pure, in core)

**Files:**
- Create: `packages/core/src/overrides.ts`
- Create: `packages/core/test/overrides.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./overrides";`)

**Interfaces:**
- Consumes: `Theme`, `defaultTheme`, `ThemeSchema` from `./scene-schema`; `SceneCue` from `./scene-schema`.
- Produces:
  - `OverrideDocSchema` (zod), `type OverrideDoc`
  - `type ElementTransform = { dx?: number; dy?: number; scale?: number }`
  - `applyOverrides(cues: SceneCue[], doc: OverrideDoc): { cues: SceneCue[]; orphans: string[] }`
  - `resolveTheme(base: Theme, doc: OverrideDoc): Theme`
  - `setElementTransform(doc, sceneId, elementId, patch): OverrideDoc`
  - `clearElementTransform(doc, sceneId, elementId): OverrideDoc`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/overrides.test.ts
import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
  clearElementTransform,
  resolveTheme,
  setElementTransform,
} from "../src/overrides";
import { defaultTheme, type SceneCue } from "../src/scene-schema";

const cue = (id: string): SceneCue => ({
  id,
  layout: "video-top",
  component: "StatCard",
  props: { label: "CODE CHURN", value: "861%", inverted: false },
  startSec: 0,
  endSec: 5,
});

describe("override document", () => {
  it("defaults to an empty doc", () => {
    const doc = OverrideDocSchema.parse({});
    expect(doc.scenes).toEqual({});
    expect(doc.theme).toEqual({});
  });

  it("applies prop overrides over the producer's props", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { props: { value: "999%" } } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.props.value).toBe("999%");
    // Untouched props survive — this is a merge, not a replacement.
    expect(cues[0]!.props.label).toBe("CODE CHURN");
  });

  it("reports overrides whose scene no longer exists instead of dropping them silently", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-7": { props: { value: "1%" } } },
    });
    const { cues, orphans } = applyOverrides([cue("scene-0")], doc);
    expect(orphans).toEqual(["scene-7"]);
    expect(cues[0]!.props.value).toBe("861%");
  });

  it("carries element transforms onto the cue", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { elements: { value: { dx: 12, dy: -4, scale: 1.08 } } } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.elements).toEqual({ value: { dx: 12, dy: -4, scale: 1.08 } });
  });

  it("applies scene timing overrides, which is what pinning means", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { timing: { startSec: 2, endSec: 6 } } },
    });
    const { cues } = applyOverrides([cue("scene-0")], doc);
    expect(cues[0]!.startSec).toBe(2);
    expect(cues[0]!.endSec).toBe(6);
    expect(cues[0]!.pinned).toBe(true);
  });

  it("leaves an unpinned cue's derived timing alone", () => {
    const { cues } = applyOverrides([cue("scene-0")], OverrideDocSchema.parse({}));
    expect(cues[0]!.startSec).toBe(0);
    expect(cues[0]!.pinned).toBeFalsy();
  });

  it("merges theme tokens over the defaults", () => {
    const doc = OverrideDocSchema.parse({ theme: { accent: "#FF0000" } });
    const theme = resolveTheme(defaultTheme, doc);
    expect(theme.accent).toBe("#FF0000");
    expect(theme.bg).toBe(defaultTheme.bg);
  });

  it("sets and clears an element transform, and clearing REMOVES the entry", () => {
    // "reset" and "nudged to exactly 0,0" must stay distinguishable, so a
    // reset deletes rather than writing zeros.
    let doc = OverrideDocSchema.parse({});
    doc = setElementTransform(doc, "scene-0", "value", { dx: 5 });
    expect(doc.scenes["scene-0"]!.elements!.value).toEqual({ dx: 5 });
    doc = clearElementTransform(doc, "scene-0", "value");
    expect(doc.scenes["scene-0"]?.elements?.value).toBeUndefined();
  });

  it("merges successive transform patches instead of replacing them", () => {
    let doc = OverrideDocSchema.parse({});
    doc = setElementTransform(doc, "scene-0", "value", { dx: 5 });
    doc = setElementTransform(doc, "scene-0", "value", { dy: -3 });
    expect(doc.scenes["scene-0"]!.elements!.value).toEqual({ dx: 5, dy: -3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/overrides.test.ts`
Expected: FAIL — `Failed to resolve import "../src/overrides"`

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/overrides.ts
import { z } from "zod/v4";
import { ThemeSchema, type SceneCue, type Theme } from "./scene-schema";

/**
 * The user's edit layer (SPEC: direct manipulation).
 *
 * Kept in its OWN file, never in production.json: that document is derived and
 * every `produce` run overwrites it, so a user layer stored there would
 * evaporate on the next run. Separation is what lets the producer re-roll
 * `props` while hand edits survive — the merge rule from BRAINSTORM §4.6.
 */

export const ElementTransformSchema = z.object({
  dx: z.number().optional(),
  dy: z.number().optional(),
  scale: z.number().positive().optional(),
});
export type ElementTransform = z.infer<typeof ElementTransformSchema>;

export const SceneOverrideSchema = z.object({
  /** Merged over the producer's props, key by key. */
  props: z.record(z.string(), z.unknown()).default({}),
  /** Per-element nudges, keyed by the component's `data-edit-id`. */
  elements: z.record(z.string(), ElementTransformSchema).default({}),
  /**
   * Absolute output time. Setting this PINS the scene: it stops tracking the
   * words it was anchored to, which is why the UI has to say so out loud.
   */
  timing: z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() }).optional(),
});
export type SceneOverride = z.infer<typeof SceneOverrideSchema>;

export const OverrideDocSchema = z.object({
  /** Global style tokens — the look is a system, so these are not per-element. */
  theme: ThemeSchema.partial().default({}),
  scenes: z.record(z.string(), SceneOverrideSchema).default({}),
});
export type OverrideDoc = z.infer<typeof OverrideDocSchema>;

export const emptyOverrideDoc = (): OverrideDoc => OverrideDocSchema.parse({});

export interface AppliedOverrides {
  cues: SceneCue[];
  /** Scene ids the document mentions that the current plan no longer has. */
  orphans: string[];
}

/**
 * Merge the user's layer onto assembled cues.
 *
 * Orphans are REPORTED rather than dropped quietly: after a re-plan, edits
 * pointing at scenes that no longer exist are the user's lost work, and
 * silence would make it look like the editor forgot them.
 */
export function applyOverrides(cues: readonly SceneCue[], doc: OverrideDoc): AppliedOverrides {
  const ids = new Set(cues.map((c) => c.id));
  const orphans = Object.keys(doc.scenes).filter((id) => !ids.has(id));
  const out = cues.map((cue) => {
    const o = doc.scenes[cue.id];
    if (!o) return cue;
    return {
      ...cue,
      props: { ...cue.props, ...o.props },
      ...(Object.keys(o.elements).length > 0 ? { elements: o.elements } : {}),
      ...(o.timing ? { startSec: o.timing.startSec, endSec: o.timing.endSec, pinned: true } : {}),
    };
  });
  return { cues: out, orphans };
}

/** Theme tokens the user set, over whatever the production already had. */
export function resolveTheme(base: Theme, doc: OverrideDoc): Theme {
  return ThemeSchema.parse({ ...base, ...doc.theme });
}

export function setElementTransform(
  doc: OverrideDoc,
  sceneId: string,
  elementId: string,
  patch: ElementTransform,
): OverrideDoc {
  const scene = doc.scenes[sceneId] ?? SceneOverrideSchema.parse({});
  return {
    ...doc,
    scenes: {
      ...doc.scenes,
      [sceneId]: {
        ...scene,
        elements: { ...scene.elements, [elementId]: { ...scene.elements[elementId], ...patch } },
      },
    },
  };
}

/** Reset: DELETE the entry, so "reset" stays distinct from "nudged to 0,0". */
export function clearElementTransform(
  doc: OverrideDoc,
  sceneId: string,
  elementId: string,
): OverrideDoc {
  const scene = doc.scenes[sceneId];
  if (!scene) return doc;
  const { [elementId]: _removed, ...rest } = scene.elements;
  return { ...doc, scenes: { ...doc.scenes, [sceneId]: { ...scene, elements: rest } } };
}
```

Then extend `SceneCueSchema` in `packages/core/src/scene-schema.ts` with the two fields cues now carry:

```ts
  /** Per-element nudges from the user's edit layer, by `data-edit-id`. */
  elements: z.record(z.string(), z.object({
    dx: z.number().optional(),
    dy: z.number().optional(),
    scale: z.number().positive().optional(),
  })).optional(),
  /** True when the user set an absolute time, detaching this cue from its words. */
  pinned: z.boolean().optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/overrides.test.ts && pnpm typecheck`
Expected: 9 passed, typecheck clean

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overrides.ts packages/core/test/overrides.test.ts \
        packages/core/src/scene-schema.ts packages/core/src/index.ts
git commit -m "Add the override model: a user edit layer that survives re-planning"
```

---

### Task 2: `produce` reads the override layer

**Files:**
- Modify: `apps/cli/src/produce.ts` (after `assembleScenes`, before `checkGrounding`)
- Test: `packages/core/test/overrides.test.ts` (append)

**Interfaces:**
- Consumes: `applyOverrides`, `resolveTheme`, `OverrideDocSchema`, `emptyOverrideDoc` from Task 1.
- Produces: `workdir/overrides.json` is read on every produce run; `render-props.json` carries merged props, `elements`, and the resolved theme.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/core/test/overrides.test.ts
describe("override layer survives a re-plan (BRAINSTORM §4.6)", () => {
  it("keeps hand edits when the producer re-rolls props", () => {
    const doc = OverrideDocSchema.parse({
      scenes: { "scene-0": { props: { value: "999%" } } },
    });
    // The producer re-plans and returns entirely new copy for the same scene.
    const replanned: SceneCue = { ...cue("scene-0"), props: { label: "NEW LABEL", value: "12%", inverted: false } };
    const { cues } = applyOverrides([replanned], doc);
    expect(cues[0]!.props.label).toBe("NEW LABEL"); // producer's new copy lands
    expect(cues[0]!.props.value).toBe("999%");      // the user's edit wins
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/overrides.test.ts -t "re-plan"`
Expected: PASS already (Task 1 built the merge). This test documents the rule rather than driving new code — if it FAILS, Task 1's merge is wrong and must be fixed before continuing.

- [ ] **Step 3: Wire it into produce**

In `apps/cli/src/produce.ts`, immediately after the `routeAroundSourceText` block that produces `routed.cues`:

```ts
  // ---- The user's edit layer (SPEC: direct manipulation) -------------------
  // Read AFTER assembly so hand edits sit on top of whatever the producer just
  // planned, and never in production.json — that file is ours to overwrite.
  const overridesPath = join(work, "overrides.json");
  let overrideDoc = emptyOverrideDoc();
  if (existsSync(overridesPath)) {
    const parsed = OverrideDocSchema.safeParse(
      JSON.parse(await readFile(overridesPath, "utf8")),
    );
    if (!parsed.success) {
      // Hand-editable user data: refuse rather than silently resetting it.
      throw new Error(`${overridesPath} is not valid: ${parsed.error.message}`);
    }
    overrideDoc = parsed.data;
  }
  const { cues: editedCues, orphans } = applyOverrides(routed.cues, overrideDoc);
  const editedCount = Object.keys(overrideDoc.scenes).length;
  if (editedCount > 0) {
    console.log(`▸ applied your edits to ${editedCount - orphans.length} scene(s)`);
  }
  for (const id of orphans) {
    console.log(`  ⚠ edit for ${id} dropped — the plan no longer has that scene`);
  }
```

Then use `editedCues` wherever `routed.cues` was used downstream, and replace the theme line:

```ts
  const theme = resolveTheme(defaultTheme, overrideDoc);
```

Add to the `@ossclip/core` import block: `applyOverrides`, `resolveTheme`, `OverrideDocSchema`, `emptyOverrideDoc`.

- [ ] **Step 4: Verify end to end**

```bash
pnpm test && pnpm typecheck
# Against a real workdir that already has a production in it:
cat > /tmp/ov.json <<'JSON'
{ "theme": { "accent": "#FF0000" }, "scenes": { "scene-0": { "props": { "value": "999%" } } } }
JSON
cp /tmp/ov.json <WORKDIR>/<clip-dir>/overrides.json
pnpm ossclip produce <clip> --produce --no-render --workdir <WORKDIR>
```
Expected: logs `▸ applied your edits to 1 scene(s)`, and `render-props.json` shows `sceneCues[0].props.value === "999%"` with `theme.accent === "#FF0000"`.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/produce.ts packages/core/test/overrides.test.ts
git commit -m "produce: apply the user's override layer after assembly"
```

---

### Task 3: `data-edit-id` and per-element transforms in the scene library

**Files:**
- Create: `packages/scenes/src/editable.ts`
- Create: `packages/scenes/test/editable.test.ts`
- Modify: all eight of `packages/scenes/src/components/*.tsx`
- Modify: `packages/scenes/src/SceneLayer.tsx` (pass `cue.elements` down)

**Interfaces:**
- Consumes: `SceneCue["elements"]` from Task 1.
- Produces:
  - `type ElementEdits = Record<string, { dx?: number; dy?: number; scale?: number }> | undefined`
  - `editStyle(edits: ElementEdits, id: string): React.CSSProperties`
  - Every editable leaf carries `data-edit-id="<stable-id>"`.
  - Ids per component (the editor and the overrides file both key on these, so they are a contract):
    `TitleCard` → `eyebrow`, `emphasis`, `title`, `sub`
    `StatCard` → `label`, `value`, `caption`
    `RuleCard` → `kicker`, `text`, `struck`
    `StrikethroughReveal` → `line-0`…`line-3`
    `FlowDiagram` → `node-0`…`node-4`
    `TerminalMock` → `window-0`…`window-3`
    `ChatMock` → `message-0`…`message-3`
    `ScreenshotFrame` → `image`, `label`

- [ ] **Step 1: Write the failing test**

```ts
// packages/scenes/test/editable.test.ts
import { describe, expect, it } from "vitest";
import { editStyle } from "../src/editable";

describe("editStyle", () => {
  it("is empty when nothing was edited, so untouched elements keep their own styles", () => {
    expect(editStyle(undefined, "value")).toEqual({});
    expect(editStyle({}, "value")).toEqual({});
    expect(editStyle({ label: { dx: 4 } }, "value")).toEqual({});
  });

  it("translates by the nudge", () => {
    expect(editStyle({ value: { dx: 12, dy: -4 } }, "value").transform).toBe(
      "translate(12px, -4px)",
    );
  });

  it("appends scale, and defaults the missing axis to zero", () => {
    expect(editStyle({ value: { scale: 1.08 } }, "value").transform).toBe(
      "translate(0px, 0px) scale(1.08)",
    );
  });

  it("ignores a scale of exactly 1 rather than emitting a no-op transform", () => {
    expect(editStyle({ value: { dx: 2, scale: 1 } }, "value").transform).toBe(
      "translate(2px, 0px)",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/scenes/test/editable.test.ts`
Expected: FAIL — cannot resolve `../src/editable`

- [ ] **Step 3: Write the helper**

```ts
// packages/scenes/src/editable.ts
import type React from "react";

/** Per-element nudges from the user's edit layer, keyed by `data-edit-id`. */
export type ElementEdits =
  | Record<string, { dx?: number; dy?: number; scale?: number }>
  | undefined;

/**
 * The style half of an editable leaf; the other half is the `data-edit-id`
 * attribute the editor hit-tests against.
 *
 * Spread LAST in a component's style object so a user nudge wins over the
 * component's own transform. Returns an empty object when untouched, so an
 * unedited element keeps whatever transform its entrance animation set.
 */
export function editStyle(edits: ElementEdits, id: string): React.CSSProperties {
  const e = edits?.[id];
  if (!e) return {};
  const parts = [`translate(${e.dx ?? 0}px, ${e.dy ?? 0}px)`];
  if (e.scale !== undefined && e.scale !== 1) parts.push(`scale(${e.scale})`);
  return { transform: parts.join(" ") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/scenes/test/editable.test.ts`
Expected: 4 passed

- [ ] **Step 5: Tag the components**

Each component gains an `edits` prop and tags its leaves. `StatCard` in full, as the pattern for the other seven:

```tsx
export const StatCard: React.FC<{
  props: z.infer<typeof StatCardProps>;
  theme: Theme;
  edits?: ElementEdits;
}> = ({ props, theme, edits }) => {
```

and on each leaf, the attribute plus the style spread last:

```tsx
        <div
          data-edit-id="label"
          style={{
            fontSize: 42,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            lineHeight: 1.15,
            maxWidth: "55%",
            ...editStyle(edits, "label"),
          }}
        >
          {props.label}
        </div>
        <div
          data-edit-id="value"
          style={{ fontSize: 110, fontWeight: 900, whiteSpace: "nowrap", ...editStyle(edits, "value") }}
        >
          {props.value}
        </div>
```

Do the same for the remaining seven components using the id table in **Interfaces** above. For list components the id carries the index (`line-0`, `node-2`) and is applied to the element the user would expect to grab — the chip, the bubble, the terminal window.

In `SceneLayer.tsx`, widen the component map's prop type and pass the edits through:

```tsx
const COMPONENTS: Record<
  SceneCue["component"],
  React.FC<{ props: any; theme: Theme; widthPx?: number; heightPx?: number; edits?: ElementEdits }>
> = { /* unchanged */ };
```

and at the render site add `edits={cue.elements}`.

- [ ] **Step 6: Verify nothing regressed visually**

```bash
pnpm test && pnpm typecheck
pnpm ossclip produce <fixture> --scenes fixtures/scenes.json --workdir /tmp/edtest -o /tmp/edtest.mp4
```
Expected: all tests green; the render looks identical to before (no edits exist yet, so every `editStyle` returns `{}`).

- [ ] **Step 7: Commit**

```bash
git add packages/scenes/src/editable.ts packages/scenes/test/editable.test.ts \
        packages/scenes/src/components packages/scenes/src/SceneLayer.tsx
git commit -m "Tag scene leaves with data-edit-id and apply per-element nudges"
```

---

### Task 4: The editor server (`ossclip edit`)

**Files:**
- Create: `apps/cli/src/edit.ts`
- Modify: `apps/cli/src/index.ts` (register the command)
- Modify: `packages/renderer/package.json` (add a browser-safe subpath export)
- Modify: `packages/renderer/src/index.ts` (no change to node imports; see below)

**Interfaces:**
- Consumes: `OverrideDocSchema`, `emptyOverrideDoc` from Task 1.
- Produces: `startEditServer(workdir: string, opts: { port?: number }): Promise<{ url: string; close(): void }>`
  - `GET /api/production` → `{ renderProps, overrides, videoFileName }`
  - `PUT /api/overrides` → validates, atomically writes `overrides.json`, returns `{ ok: true }`
  - `GET /media/<file>` → the workdir's mezzanine/source, with range support
  - `GET /*` → the built editor page

- [ ] **Step 1: Write the failing test**

```ts
// apps/cli/test/edit-server.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditServer } from "../src/edit";

let close: (() => void) | undefined;
afterEach(() => close?.());

async function fixtureWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ossclip-edit-"));
  await writeFile(
    join(dir, "render-props.json"),
    JSON.stringify({ videoFileName: "clip.mp4", sceneCues: [], captionLines: [], spans: [] }),
  );
  await writeFile(join(dir, "clip.mp4"), "not-a-real-video");
  return dir;
}

describe("edit server", () => {
  it("serves the production document", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0 });
    close = server.close;
    const res = await fetch(`${server.url}/api/production`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.renderProps.videoFileName).toBe("clip.mp4");
    expect(body.overrides).toEqual({ theme: {}, scenes: {} });
  });

  it("saves overrides to disk", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0 });
    close = server.close;
    const doc = { theme: {}, scenes: { "scene-0": { props: { value: "999%" }, elements: {} } } };
    const res = await fetch(`${server.url}/api/overrides`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await readFile(join(dir, "overrides.json"), "utf8"));
    expect(onDisk.scenes["scene-0"].props.value).toBe("999%");
  });

  it("rejects a malformed override document rather than writing it", async () => {
    const dir = await fixtureWorkdir();
    const server = await startEditServer(dir, { port: 0 });
    close = server.close;
    const res = await fetch(`${server.url}/api/overrides`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenes: { "scene-0": { elements: { v: { scale: -3 } } } } }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a workdir with no production in it, naming the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-empty-"));
    await expect(startEditServer(dir, { port: 0 })).rejects.toThrow(dir);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/cli/test/edit-server.test.ts`
Expected: FAIL — cannot resolve `../src/edit`

- [ ] **Step 3: Write the server**

```ts
// apps/cli/src/edit.ts
import { createReadStream, existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { OverrideDocSchema, emptyOverrideDoc } from "@ossclip/core";

/**
 * The editor's backend: three endpoints and a static file server, deliberately
 * dependency-free. It reads the workdir a `produce` run left behind and owns
 * exactly one file — `overrides.json`.
 */
export interface EditServer {
  url: string;
  close: () => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".mp4": "video/mp4",
};

export async function startEditServer(
  workdirArg: string,
  opts: { port?: number; pageDir?: string } = {},
): Promise<EditServer> {
  const workdir = resolve(workdirArg);
  const propsPath = join(workdir, "render-props.json");
  if (!existsSync(propsPath)) {
    throw new Error(`no render-props.json in ${workdir} — run \`ossclip produce\` there first`);
  }
  const overridesPath = join(workdir, "overrides.json");

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    void (async () => {
      try {
        if (url.pathname === "/api/production" && req.method === "GET") {
          const renderProps = JSON.parse(await readFile(propsPath, "utf8"));
          const overrides = existsSync(overridesPath)
            ? OverrideDocSchema.parse(JSON.parse(await readFile(overridesPath, "utf8")))
            : emptyOverrideDoc();
          return send(200, { renderProps, overrides });
        }

        if (url.pathname === "/api/overrides" && req.method === "PUT") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const parsed = OverrideDocSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()));
          if (!parsed.success) return send(400, { error: parsed.error.message });
          // Atomic: the producer may read this file at any moment, and a
          // half-written document would be worse than a stale one.
          const tmp = `${overridesPath}.tmp`;
          await writeFile(tmp, JSON.stringify(parsed.data, null, 2));
          await rename(tmp, overridesPath);
          return send(200, { ok: true });
        }

        if (url.pathname.startsWith("/media/")) {
          const file = join(workdir, decodeURIComponent(url.pathname.slice("/media/".length)));
          // Never serve outside the workdir, whatever the path claims.
          if (!file.startsWith(workdir) || !existsSync(file)) return send(404, { error: "not found" });
          res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
          return void createReadStream(file).pipe(res);
        }

        const pageDir = opts.pageDir;
        if (pageDir) {
          const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
          const file = join(pageDir, rel);
          if (file.startsWith(pageDir) && existsSync(file)) {
            res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain" });
            return void createReadStream(file).pipe(res);
          }
        }
        send(404, { error: "not found" });
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 5174, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 5174);
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}
```

Register the command in `apps/cli/src/index.ts`:

```ts
program
  .command("edit")
  .description("open the editing page on a produced workdir")
  .argument("<workdir>", "a work directory containing render-props.json")
  .option("--port <n>", "port to listen on", (v) => Number.parseInt(v, 10), 5174)
  .option("--no-open", "do not open a browser")
  .action(async (workdir: string, opts) => {
    const { startEditServer } = await import("./edit");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const pageDir = join(dirname(fileURLToPath(import.meta.url)), "../../editor/dist");
    const server = await startEditServer(workdir, { port: opts.port, pageDir });
    console.log(`▸ editor at ${server.url}`);
    if (opts.open) spawn("open", [server.url], { stdio: "ignore" });
  });
```

Add a browser-safe subpath to `packages/renderer/package.json` so the editor can import the composition without dragging `@remotion/bundler` and `node:path` into Vite:

```json
  "exports": {
    ".": "./src/index.ts",
    "./composition": "./src/ProductionComposition.tsx"
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/cli/test/edit-server.test.ts && pnpm typecheck`
Expected: 4 passed, typecheck clean

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/edit.ts apps/cli/test/edit-server.test.ts apps/cli/src/index.ts \
        packages/renderer/package.json
git commit -m "Add the edit server: serve a produced workdir, own overrides.json"
```

---

### Task 5: The editor page — Player and edit state

**Files:**
- Create: `apps/editor/package.json`, `apps/editor/vite.config.ts`, `apps/editor/index.html`, `apps/editor/tsconfig.json`
- Create: `apps/editor/src/main.tsx`, `apps/editor/src/App.tsx`, `apps/editor/src/useEdits.ts`
- Create: `apps/editor/test/useEdits.test.ts`

**Interfaces:**
- Consumes: `/api/production`, `/api/overrides` from Task 4; `ProductionComposition` from `@ossclip/renderer/composition`; `applyOverrides`, `resolveTheme` from `@ossclip/core/browser`.
- Produces: `useEdits()` returning `{ doc, dirty, undo, canUndo, save, patchProps, patchElement, clearElement, patchTiming, patchTheme }`.

**Note:** `applyOverrides` and `resolveTheme` must be re-exported from `packages/core/src/browser.ts` in this task — they are pure and browser-safe, but the barrel is not.

- [ ] **Step 1: Write the failing test**

```ts
// apps/editor/test/useEdits.test.ts
import { describe, expect, it } from "vitest";
import { editReducer, initialEditState } from "../src/useEdits";

describe("edit state", () => {
  it("starts clean", () => {
    const s = initialEditState();
    expect(s.dirty).toBe(false);
    expect(s.past).toHaveLength(0);
  });

  it("marks dirty and pushes history on a prop patch", () => {
    const s = editReducer(initialEditState(), {
      type: "patchProps", sceneId: "scene-0", patch: { value: "999%" },
    });
    expect(s.doc.scenes["scene-0"]!.props.value).toBe("999%");
    expect(s.dirty).toBe(true);
    expect(s.past).toHaveLength(1);
  });

  it("undoes to the previous document", () => {
    let s = editReducer(initialEditState(), {
      type: "patchProps", sceneId: "scene-0", patch: { value: "999%" },
    });
    s = editReducer(s, { type: "undo" });
    expect(s.doc.scenes["scene-0"]?.props.value).toBeUndefined();
  });

  it("clears dirty on save, and undoing past the save marks it dirty again", () => {
    let s = editReducer(initialEditState(), {
      type: "patchProps", sceneId: "scene-0", patch: { value: "9%" },
    });
    s = editReducer(s, { type: "saved" });
    expect(s.dirty).toBe(false);
    s = editReducer(s, { type: "undo" });
    expect(s.dirty).toBe(true);
  });

  it("records a timing patch as a pin", () => {
    const s = editReducer(initialEditState(), {
      type: "patchTiming", sceneId: "scene-0", startSec: 2, endSec: 6,
    });
    expect(s.doc.scenes["scene-0"]!.timing).toEqual({ startSec: 2, endSec: 6 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/editor/test/useEdits.test.ts`
Expected: FAIL — cannot resolve `../src/useEdits`

- [ ] **Step 3: Scaffold the app and write the reducer**

`apps/editor/package.json`:

```json
{
  "name": "@ossclip/editor",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": {
    "@ossclip/core": "workspace:*",
    "@ossclip/renderer": "workspace:*",
    "@ossclip/scenes": "workspace:*",
    "@remotion/player": "^4.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "remotion": "^4.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.7.0",
    "vite": "^5.4.0"
  }
}
```

`apps/editor/vite.config.ts` — proxy the API to the edit server so `pnpm dev` works against a live workdir:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:5174",
      "/media": "http://127.0.0.1:5174",
    },
  },
  build: { outDir: "dist" },
});
```

`apps/editor/src/useEdits.ts`:

```ts
import { useReducer } from "react";
import {
  OverrideDocSchema,
  clearElementTransform,
  emptyOverrideDoc,
  setElementTransform,
  type ElementTransform,
  type OverrideDoc,
} from "@ossclip/core/browser";

export interface EditState {
  doc: OverrideDoc;
  /** Snapshots, newest last. Undo is free because the doc is plain JSON. */
  past: OverrideDoc[];
  dirty: boolean;
  /** History length at the last save, so undoing past it re-marks dirty. */
  savedAt: number;
}

export type EditAction =
  | { type: "load"; doc: OverrideDoc }
  | { type: "patchProps"; sceneId: string; patch: Record<string, unknown> }
  | { type: "patchElement"; sceneId: string; elementId: string; patch: ElementTransform }
  | { type: "clearElement"; sceneId: string; elementId: string }
  | { type: "patchTiming"; sceneId: string; startSec: number; endSec: number }
  | { type: "patchTheme"; patch: Record<string, unknown> }
  | { type: "undo" }
  | { type: "saved" };

export const initialEditState = (): EditState => ({
  doc: emptyOverrideDoc(),
  past: [],
  dirty: false,
  savedAt: 0,
});

const withScene = (doc: OverrideDoc, id: string) =>
  doc.scenes[id] ?? { props: {}, elements: {} };

export function editReducer(state: EditState, action: EditAction): EditState {
  const commit = (doc: OverrideDoc): EditState => ({
    doc,
    past: [...state.past, state.doc],
    dirty: true,
    savedAt: state.savedAt,
  });

  switch (action.type) {
    case "load":
      return { doc: action.doc, past: [], dirty: false, savedAt: 0 };
    case "patchProps": {
      const scene = withScene(state.doc, action.sceneId);
      return commit({
        ...state.doc,
        scenes: {
          ...state.doc.scenes,
          [action.sceneId]: { ...scene, props: { ...scene.props, ...action.patch } },
        },
      });
    }
    case "patchElement":
      return commit(
        setElementTransform(state.doc, action.sceneId, action.elementId, action.patch),
      );
    case "clearElement":
      return commit(clearElementTransform(state.doc, action.sceneId, action.elementId));
    case "patchTiming": {
      const scene = withScene(state.doc, action.sceneId);
      return commit({
        ...state.doc,
        scenes: {
          ...state.doc.scenes,
          [action.sceneId]: {
            ...scene,
            timing: { startSec: action.startSec, endSec: action.endSec },
          },
        },
      });
    }
    case "patchTheme":
      return commit({ ...state.doc, theme: { ...state.doc.theme, ...action.patch } });
    case "undo": {
      if (state.past.length === 0) return state;
      const doc = state.past[state.past.length - 1]!;
      const past = state.past.slice(0, -1);
      return { doc, past, savedAt: state.savedAt, dirty: past.length !== state.savedAt };
    }
    case "saved":
      return { ...state, dirty: false, savedAt: state.past.length };
  }
}

export function useEdits() {
  const [state, dispatch] = useReducer(editReducer, undefined, initialEditState);
  const save = async (): Promise<void> => {
    const res = await fetch("/api/overrides", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state.doc),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "save failed");
    dispatch({ type: "saved" });
  };
  return { ...state, dispatch, save, OverrideDocSchema };
}
```

`apps/editor/src/App.tsx` renders the Player with edits applied live:

```tsx
import React, { useEffect, useMemo, useState } from "react";
import { Player } from "@remotion/player";
import { ProductionComposition } from "@ossclip/renderer/composition";
import { applyOverrides, resolveTheme, defaultTheme } from "@ossclip/core/browser";
import { useEdits } from "./useEdits";

export const App: React.FC = () => {
  const edits = useEdits();
  const [renderProps, setRenderProps] = useState<any>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/production");
      const body = await res.json();
      setRenderProps(body.renderProps);
      edits.dispatch({ type: "load", doc: body.overrides });
    })();
  }, []);

  const live = useMemo(() => {
    if (!renderProps) return null;
    const { cues } = applyOverrides(renderProps.sceneCues ?? [], edits.doc);
    return {
      ...renderProps,
      sceneCues: cues,
      theme: resolveTheme(renderProps.theme ?? defaultTheme, edits.doc),
      videoFileName: `/media/${renderProps.videoFileName}`,
    };
  }, [renderProps, edits.doc]);

  if (!live) return <div style={{ padding: 24, fontFamily: "system-ui" }}>Loading…</div>;

  return (
    <Player
      component={ProductionComposition}
      inputProps={live}
      durationInFrames={Math.max(1, Math.round(live.outputDurationSec * live.settings.fps))}
      fps={live.settings.fps}
      compositionWidth={live.settings.width}
      compositionHeight={live.settings.height}
      style={{ width: 360 }}
      controls
    />
  );
};
```

Add `applyOverrides`, `resolveTheme`, `emptyOverrideDoc`, `setElementTransform`, `clearElementTransform`, `OverrideDocSchema` and the override types to `packages/core/src/browser.ts`.

- [ ] **Step 4: Run tests and see the page**

```bash
pnpm install
pnpm vitest run apps/editor/test/useEdits.test.ts   # 5 passed
pnpm typecheck
# Terminal A: pnpm ossclip edit <WORKDIR> --no-open
# Terminal B: pnpm --filter @ossclip/editor dev  → open the printed URL
```
Expected: the produced video plays in the page with scenes and captions.

- [ ] **Step 5: Commit**

```bash
git add apps/editor packages/core/src/browser.ts
git commit -m "Add the editor page: Remotion Player with the edit layer applied live"
```

---

### Task 6: Selection overlay and inspector

**Files:**
- Create: `apps/editor/src/Overlay.tsx`, `apps/editor/src/Inspector.tsx`
- Create: `apps/editor/src/hitTest.ts`, `apps/editor/test/hitTest.test.ts`
- Modify: `apps/editor/src/App.tsx`

**Interfaces:**
- Consumes: `useEdits` from Task 5; `data-edit-id` attributes from Task 3.
- Produces:
  - `findEditable(root: HTMLElement, clientX: number, clientY: number): { sceneId: string; elementId: string; rect: DOMRect } | null`
  - `<Overlay playerRef sceneId onSelect selection />`, `<Inspector selection cue edits />`

**Before writing the UI, load the `frontend-design` skill** (the user asked for it explicitly). This task is where its guidance applies.

- [ ] **Step 1: Write the failing test**

```ts
// apps/editor/test/hitTest.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findEditableFrom } from "../src/hitTest";

describe("findEditableFrom", () => {
  it("finds the nearest tagged ancestor of the clicked node", () => {
    document.body.innerHTML = `
      <div data-edit-scene="scene-0">
        <div data-edit-id="value"><span id="inner">861%</span></div>
      </div>`;
    const hit = findEditableFrom(document.getElementById("inner")!);
    expect(hit).toEqual({ sceneId: "scene-0", elementId: "value" });
  });

  it("returns null when the click was not inside anything editable", () => {
    document.body.innerHTML = `<div><span id="loose">x</span></div>`;
    expect(findEditableFrom(document.getElementById("loose")!)).toBeNull();
  });

  it("returns null for a tagged element with no scene ancestor", () => {
    // A leaf outside a scene is not addressable — the override doc keys on both.
    document.body.innerHTML = `<div data-edit-id="value"><span id="inner">x</span></div>`;
    expect(findEditableFrom(document.getElementById("inner")!)).toBeNull();
  });
});
```

Add `jsdom` to the root devDependencies for this test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/editor/test/hitTest.test.ts`
Expected: FAIL — cannot resolve `../src/hitTest`

- [ ] **Step 3: Write the hit test and the overlay**

```ts
// apps/editor/src/hitTest.ts
export interface EditableHit {
  sceneId: string;
  elementId: string;
}

/**
 * Walk up from a clicked node to the tagged leaf and its scene.
 *
 * The DOM is the registry (SPEC): geometry comes from
 * `getBoundingClientRect`, which already accounts for the stage's zoom and
 * punch-in transforms. Nothing needs to be kept in sync.
 */
export function findEditableFrom(node: Element | null): EditableHit | null {
  const el = node?.closest<HTMLElement>("[data-edit-id]");
  if (!el) return null;
  const scene = el.closest<HTMLElement>("[data-edit-scene]");
  if (!scene) return null;
  return {
    sceneId: scene.dataset.editScene!,
    elementId: el.dataset.editId!,
  };
}

export function rectOf(root: HTMLElement, sceneId: string, elementId: string): DOMRect | null {
  const el = root.querySelector<HTMLElement>(
    `[data-edit-scene="${sceneId}"] [data-edit-id="${elementId}"]`,
  );
  return el ? el.getBoundingClientRect() : null;
}
```

`SceneLayer.tsx` must tag each cue's wrapper so `data-edit-scene` exists: add `data-edit-scene={cue.id}` to the element wrapping each cue's component.

`Overlay.tsx` draws a box over the selection and turns drags into patches. It sits above the Player with `pointer-events: none` except on the handles, listens for `mousedown` on the player container, resolves the hit with `findEditableFrom(document.elementFromPoint(x, y))`, then on `mousemove` dispatches `patchElement` with the accumulated `dx/dy`. Double-click swaps the box for a text input that dispatches `patchProps` on blur. `Escape` clears the selection; `⌘Z` dispatches `undo`; `⌘S` calls `save()`.

`Inspector.tsx` renders, for a selection: the element's text as an input, `dx`/`dy`/`scale` as number inputs (typed values dispatch `patchElement` directly — dragging is imprecise and typing `0` is how a nudge is cleanly undone), and a **Reset element** button dispatching `clearElement`. With a scene selected but no element: component and layout selects, and the pin state. With nothing selected: the theme tokens (`accent`, `bg`, `fg`, `radiusPx`, `fontDisplay`) dispatching `patchTheme`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/editor/test/hitTest.test.ts && pnpm typecheck`
Expected: 3 passed

- [ ] **Step 5: Verify by hand**

With both terminals from Task 5 running: click the `861%` in a StatCard → a box appears; drag it → it moves and the inspector's `x`/`y` update; double-click → edit the text; press `⌘Z` → the edit reverts.

- [ ] **Step 6: Commit**

```bash
git add apps/editor/src/Overlay.tsx apps/editor/src/Inspector.tsx apps/editor/src/hitTest.ts \
        apps/editor/test/hitTest.test.ts apps/editor/src/App.tsx packages/scenes/src/SceneLayer.tsx
git commit -m "Add selection, dragging, inline text editing and the inspector"
```

---

### Task 7: Timeline strip with timing pins

**Files:**
- Create: `apps/editor/src/Timeline.tsx`
- Create: `apps/editor/src/timing.ts`, `apps/editor/test/timing.test.ts`
- Modify: `apps/editor/src/App.tsx`

**Interfaces:**
- Consumes: `useEdits` from Task 5, `SceneCue` from core.
- Produces: `clampTiming(cues, sceneId, startSec, endSec, duration): { startSec: number; endSec: number }`

- [ ] **Step 1: Write the failing test**

```ts
// apps/editor/test/timing.test.ts
import { describe, expect, it } from "vitest";
import { clampTiming } from "../src/timing";
import type { SceneCue } from "@ossclip/core/browser";

const cues = [
  { id: "a", startSec: 0, endSec: 5 },
  { id: "b", startSec: 6, endSec: 11 },
] as SceneCue[];

describe("clampTiming", () => {
  it("keeps a nudge inside the clip", () => {
    expect(clampTiming(cues, "a", -3, 5, 30).startSec).toBe(0);
    expect(clampTiming(cues, "b", 6, 99, 30).endSec).toBe(30);
  });

  it("does not let a scene overlap its neighbour — cues are exclusive", () => {
    expect(clampTiming(cues, "a", 0, 9, 30).endSec).toBeLessThanOrEqual(6);
  });

  it("enforces a minimum on-screen duration", () => {
    const t = clampTiming(cues, "a", 4.9, 5, 30);
    expect(t.endSec - t.startSec).toBeGreaterThanOrEqual(1.2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/editor/test/timing.test.ts`
Expected: FAIL — cannot resolve `../src/timing`

- [ ] **Step 3: Write it**

```ts
// apps/editor/src/timing.ts
import type { SceneCue } from "@ossclip/core/browser";

/** Same floor assembly uses, so a hand nudge cannot make an unrenderable cue. */
const MIN_SCENE_SEC = 1.2;
const GAP = 0.05;

export function clampTiming(
  cues: readonly SceneCue[],
  sceneId: string,
  startSec: number,
  endSec: number,
  duration: number,
): { startSec: number; endSec: number } {
  const i = cues.findIndex((c) => c.id === sceneId);
  const prev = i > 0 ? cues[i - 1] : undefined;
  const next = i >= 0 && i < cues.length - 1 ? cues[i + 1] : undefined;
  const lo = prev ? prev.endSec + GAP : 0;
  const hi = next ? next.startSec - GAP : duration;
  let s = Math.min(Math.max(startSec, lo), Math.max(lo, hi - MIN_SCENE_SEC));
  let e = Math.max(Math.min(endSec, hi), s + MIN_SCENE_SEC);
  if (e > hi) { e = hi; s = Math.max(lo, e - MIN_SCENE_SEC); }
  return { startSec: s, endSec: e };
}
```

`Timeline.tsx` renders a full-width strip: one block per cue positioned at `startSec / duration`, a playhead driven by the Player's `frame`, click-to-seek-and-select, and draggable left/right edges dispatching `patchTiming` through `clampTiming`.

**A pinned cue must look pinned.** Any cue whose id has `timing` in the override doc renders a pin glyph, and the inspector shows "Pinned to 2.0–6.0s" with an **Un-pin (re-anchor to words)** button that deletes `timing` from that scene's override. Scene times are derived from word anchors so they survive a re-cut; an absolute time opts out of that, and silence about it would surface as a mystery bug several rounds later.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/editor/test/timing.test.ts && pnpm typecheck`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add apps/editor/src/Timeline.tsx apps/editor/src/timing.ts apps/editor/test/timing.test.ts \
        apps/editor/src/App.tsx
git commit -m "Add the timeline strip, with timing nudges that pin visibly"
```

---

### Task 8: Round trip — save, re-produce, and the smoke test

**Files:**
- Create: `apps/editor/e2e/edit.spec.ts`
- Create: `apps/editor/playwright.config.ts`
- Modify: `README.md` (document `ossclip edit`)

**Interfaces:**
- Consumes: everything above.
- Produces: proof that hit-test → patch → HTTP → file → render works end to end.

- [ ] **Step 1: Write the failing test**

```ts
// apps/editor/e2e/edit.spec.ts
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const WORKDIR = process.env.OSSCLIP_E2E_WORKDIR!;

test("drag an element, save, and the patch lands on disk", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("[data-edit-id]");
  const el = page.locator("[data-edit-id]").first();
  const box = (await el.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 10);
  await page.mouse.up();
  await page.keyboard.press("Meta+s");
  await expect(page.getByTestId("dirty")).toHaveCount(0);

  const doc = JSON.parse(await readFile(join(WORKDIR, "overrides.json"), "utf8"));
  const scene = Object.values(doc.scenes)[0] as any;
  expect(Object.values(scene.elements)[0]).toMatchObject({ dx: expect.any(Number) });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ossclip/editor exec playwright test`
Expected: FAIL — no config / server not running

- [ ] **Step 3: Add the config**

```ts
// apps/editor/playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: [
    {
      command: `pnpm ossclip edit ${process.env.OSSCLIP_E2E_WORKDIR} --no-open`,
      port: 5174,
      reuseExistingServer: true,
    },
    { command: "pnpm --filter @ossclip/editor dev", port: 5173, reuseExistingServer: true },
  ],
});
```

- [ ] **Step 4: Run it to verify it passes**

```bash
export OSSCLIP_E2E_WORKDIR=<a produced workdir>
pnpm --filter @ossclip/editor exec playwright install chromium
pnpm --filter @ossclip/editor exec playwright test
```
Expected: 1 passed

- [ ] **Step 5: Verify the whole loop by hand**

```bash
pnpm ossclip edit <WORKDIR>          # drag something, retype some copy, ⌘S
pnpm ossclip produce <clip> --produce --workdir <WORKDIR> -o /tmp/edited.mp4
```
Expected: the log says `▸ applied your edits to N scene(s)`, and the rendered mp4 shows the edit.

- [ ] **Step 6: Document and commit**

Add to `README.md`:

```md
### Editing a produced video

    pnpm ossclip edit <workdir>

Click any element to select it, drag to move, double-click to retype, `⌘S` to
save. Edits are written to `<workdir>/overrides.json` — a file the producer
never touches, so re-running `produce` re-plans the video and keeps your edits.
```

```bash
git add apps/editor/e2e apps/editor/playwright.config.ts README.md
git commit -m "Prove the edit round trip with one Playwright smoke test"
```

---

## Self-review

**Spec coverage:** override file and merge rule → Task 1–2. `data-edit-id` hit-testing → Tasks 3, 6. Player page → Task 5. Selection, drag, inline text, inspector, per-element reset → Task 6. Style tokens (global) → Tasks 1, 6. Timeline and pins → Task 7. Explicit save, dirty state, undo → Tasks 5, 6. Failure modes: malformed doc → Tasks 2, 4; atomic write → Task 4; missing workdir → Task 4; orphan ids → Task 1. Round trip → Task 8.

**Deliberately deferred, per the spec:** filler-word cutting, caption per-word editing, z-order, rotation, multi-select, render orchestration.

**Known gap:** the spec's "producer rewrote the workdir — reload" mtime watch is not in any task. It is a nicety on a single-user local tool, and the atomic write plus explicit save already prevent corruption; a stale page is recoverable with a refresh. Ship without it and add it if it bites.
