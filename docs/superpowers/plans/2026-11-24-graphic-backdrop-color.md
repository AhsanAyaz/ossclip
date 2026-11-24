# Graphic Backdrop Colour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A graphic whose layout paints the solid backdrop (`graphic-only`, `pip-bubble`) can carry its own background colour, picked in the Inspector, rendered identically in preview, full render and kit clip.

**Architecture:**
- A new optional scene field, `backdropColor` (6-digit hex, `HexColorSchema`), flows from `overrides.json` through `applyOverrides` onto the cue.
- One pure resolver, `backdropColorAt`, in `packages/scenes/src/stage.ts` chooses the colour on the same morph cues as `backdropOpacityAt`.
- `VideoStage` and the kit clip read the colour from that resolver.
- The editor adds two reducer actions and an Inspector swatch.

**Tech Stack:** TypeScript, zod v4, React, Remotion, vitest + jsdom.

**Spec:** `docs/designs/graphic-backdrop-color.md` (approved, draft 3). Every value below is copied from it.

## Global Constraints

- **Hex format.** `HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)` is exported from `packages/core/src/scene-schema.ts`. It is the only definition: both schemas and the Inspector use it. User values are parsed, never coerced.
- **Backdrop layouts.** They are decided by `drawsSolidBackdrop` (`packages/scenes/src/stage.ts:1337`). Never use core's `isBackdropLayout`/`BACKDROP_LAYOUTS`, which include `full-bleed`.
- **Legacy docs** (no field anywhere) render byte for byte as today.
- **Unchanged.** The panel scrim (`SceneLayer.tsx:265`) keeps `theme.bg`. No text input is added for the colour.
- **Comments** explain why and cite `backdrop-color §N`.
- **Machine.** 7 GB RAM, one heavy command at a time. The full suite is `pnpm test --maxWorkers=2 --minWorkers=1`.
- **Branch.** `feat/timeline-lanes`, which ships in the same PR as timeline lanes. Commit locally only.

## Review Focus

1. **The fading backdrop must keep its graphic's colour** (call 3). If the resolver ignores `prev`/`next`, a coloured card fades out through `theme.bg`. This is pinned by Task 2's 12.1 s sample.
2. **The contain-fit bubble interior must match the backdrop around it.** Task 2 asserts that VideoStage uses the resolver at both sites; check it with grep in the review.
3. **A split half that inherits a colour must not offer Reset,** or Reset would write a no-op on the half and confuse the author. This is pinned by Task 3's inherited-half test.
4. **A take set to `graphic-only` must not get the row.** This is pinned by Task 3's take case, which uses a `graphic-only` take.
5. **The kit reuse key must change when only the colour changes,** or a stale kit clip is reused. This is pinned by Task 1's `kit-plan.test.ts` case.

---

### Task 1: Core — `HexColorSchema`, the field, `applyOverrides`

**Files:**
- Modify `packages/core/src/scene-schema.ts`: add `HexColorSchema`, and add `backdropColor: HexColorSchema.optional()` on the cue schema.
- Modify `packages/core/src/overrides.ts`:
  - `SceneOverrideSchema` (`:130`) gets `backdropColor: HexColorSchema.optional()`;
  - the `applyOverrides` merged cue (`:1462-1470`) gets `...(o.backdropColor !== undefined ? { backdropColor: o.backdropColor } : {})`, next to `captionScale`.
- Tests: `packages/core/test/overrides.test.ts`, `packages/core/test/kit-plan.test.ts`.

**Interfaces:**
- **Produces:**
  - `export const HexColorSchema` from `@ossclip/core` and `@ossclip/core/browser` (it rides `scene-schema`, `browser.ts:7`);
  - `SceneCue.backdropColor?: string`;
  - `SceneOverride.backdropColor?: string`.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - **`overrides.test.ts`:**
    - `HexColorSchema.safeParse("#1a2b3c").success === true`.
    - `SceneOverrideSchema.safeParse({ backdropColor: v }).success === false` for each of `"#fff"`, `"red"`, `"rgb(1,2,3)"`, `""`.
    - `applyOverrides` with `scenes: { "scene-0": { backdropColor: "#ff0000" } }` puts `backdropColor === "#ff0000"` on that cue.
    - Without the override, the output cue has no `backdropColor` key (`"backdropColor" in cue === false`).
    - A split half inherits the root's colour. Use the file's existing split helper and pattern: root `scene-0` has the colour, and the half `scene-0@<split id>` carries it.
  - **`kit-plan.test.ts`:** two `graphic-only` cues that differ only by `backdropColor` get different `reuseKey`s.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/overrides.test.ts packages/core/test/kit-plan.test.ts`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** the schema, the field and the spread above.
- [ ] **Step 4: Run** the same command, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/core/src/scene-schema.ts packages/core/src/overrides.ts packages/core/test/overrides.test.ts packages/core/test/kit-plan.test.ts
  git commit -m "feat(core): per-scene backdropColor override (hex, zod-parsed)"
  ```

### Task 2: Render — `backdropColorAt`, VideoStage, kit clip

**Files:**
- Modify `packages/scenes/src/stage.ts`:
  - add `export function backdropColorAt(allCues: readonly SceneCue[], tSec: number, themeBg: string): string`;
  - extract a private resolver, shared with `backdropOpacityAt`, that returns `{ cue, T, prev, next, sinceStart, untilEnd } | null` on `morphCues`. `backdropOpacityAt`'s output must stay identical.
- Modify `packages/scenes/src/VideoStage.tsx`: compute `backdropColor` once per frame, then use it at `:206` (backdrop `background`) and `:227` (contain-fit `backgroundColor`).
- Modify `packages/renderer/src/scene-clip.ts`: `sceneClipBackground` returns `color: backdropColorAt([p.cue], frame / p.settings.fps, p.theme.bg)`.
- Tests: `packages/scenes/test/stage.test.ts`, `packages/renderer/test/scene-clip.test.ts`.

**Interfaces:**
- **Consumes:** `SceneCue.backdropColor` (Task 1).
- **Produces:** `backdropColorAt`, exported through `@ossclip/scenes` and `@ossclip/scenes/geometry` (`geometry.ts` re-exports `stage`).

**The resolver's rules (spec §3):**
1. The active morph cue draws the backdrop: return its `backdropColor ?? themeBg`.
2. Otherwise, inside the fade-in window (`sinceStart < T`), if `prev` draws the backdrop, return `prev.backdropColor ?? themeBg`. Inside the fade-out window (`untilEnd < T`), if `next` draws it, return `next.backdropColor ?? themeBg`.
3. Otherwise return `themeBg`.

**Steps:**

- [ ] **Step 1: Write the failing tests.**

  **`stage.test.ts`** uses the spec fixture, with `themeBg` `#000000`:

  | cue | span | layout | `backdropColor` |
  | --- | --- | --- | --- |
  | plain take | [0, 4] | full-bleed | none |
  | graphic A | [4, 8] | graphic-only | `#ff0000` |
  | graphic B | [8, 12] | graphic-only | `#00ff00` |
  | graphic C | [12, 16] | full-bleed | `#123456` (must be ignored) |
  | graphic D | [16, 20] | graphic-only | `#0000ff` |

  Expected results:

  | t (s) | colour |
  | --- | --- |
  | 6 | `#ff0000` |
  | 4.1 | `#ff0000` |
  | 7.99 | `#ff0000` |
  | 8.01 | `#00ff00` |
  | 12.1 | `#00ff00` |
  | 11.8 | `#00ff00` |
  | 15.9 | `#0000ff` |
  | 2 | `#000000` |
  | 3.9 | `#000000` |
  | 14 | `#000000` |

  - With every colour removed, every sample returns `#000000`.
  - `backdropOpacityAt` returns the same values as before on this fixture. Record the samples before the refactor and assert them after, as a guard.

  **`scene-clip.test.ts`:**
  - `sceneClipBackground` gives `color` `#ff0000` for a `graphic-only` cue with `backdropColor: "#ff0000"`.
  - The same cue without the colour gives `theme.bg`.
  - A `full-bleed` cue gives `null`, with or without the field.
- [ ] **Step 2: Run** `pnpm vitest run packages/scenes/test/stage.test.ts packages/renderer/test/scene-clip.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the resolver, `backdropColorAt`, the two VideoStage uses and `sceneClipBackground`, as above.
- [ ] **Step 4: Run** the step-2 command, `pnpm vitest run packages/scenes packages/renderer` (render-adjacent suites; the renderer suite takes minutes) and `pnpm typecheck`. Expected: PASS, with existing outputs unchanged.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/scenes/src/stage.ts packages/scenes/src/VideoStage.tsx packages/renderer/src/scene-clip.ts packages/scenes/test/stage.test.ts packages/renderer/test/scene-clip.test.ts
  git commit -m "feat(scenes): backdrop colour follows the graphic's own backdropColor"
  ```

### Task 3: Editor — reducer actions and the Inspector swatch

**Files:**
- Modify `apps/editor/src/useEdits.ts`:
  - add `patchBackdropColor { sceneId: string; color: string; coalesce?: string }` and `clearBackdropColor { sceneId: string }` to the action union (`:161`);
  - add reducer cases next to `patchCaptionScale` (`:943`) and `clearPip` (`:923`);
  - add hook methods next to `:2141`.
  - Do not add either action to `idKeyedLookTarget` (`:723-737`). Spec §4 gives the reason.
- Modify `apps/editor/src/Inspector.tsx`: add the `Background` row under the layout control (`:1742-1795`).
- Tests: `apps/editor/test/useEdits.test.ts`, `apps/editor/test/Inspector.test.ts`.

**Interfaces:**
- **Consumes:** `HexColorSchema` (from `@ossclip/core/browser`), `drawsSolidBackdrop` (from `@ossclip/scenes/geometry`), `SceneCue.backdropColor`.
- **Produces:** `edits.patchBackdropColor(sceneId, color, coalesce?)` and `edits.clearBackdropColor(sceneId)`.

**Steps:**

- [ ] **Step 1: Write the failing tests.**
  - **`useEdits.test.ts`:**
    - `patchBackdropColor` sets `doc.scenes[id].backdropColor`.
    - Two patches with the coalesce key `backdropColor:<id>` undo in one step.
    - `clearBackdropColor` deletes the key.
    - A clear when the key is absent returns the same state object and adds no undo entry.
  - **`Inspector.test.ts`** (use the file's existing selected-graphic harness):
    - The harness gains a `resolvedTheme` prop and an `initialScenes` type that accepts `backdropColor` (spec §4).
    - A `[data-testid="backdrop-color"]` input renders for a selected graphic with layout `graphic-only`, and also for `pip-bubble`.
    - It does not render for a `full-bleed` graphic, or for a take whose layout is `graphic-only`.
    - Its `value` equals `resolvedTheme.bg.toLowerCase()` when no colour is set.
    - A `change` event with `#123456` calls `patchBackdropColor(sceneId, "#123456", "backdropColor:<sceneId>")`.
    - `[data-testid="backdrop-color-reset"]` exists only when the selected scene's own doc entry has `backdropColor`. Clicking it calls `clearBackdropColor(sceneId)`.
    - A selected split half whose cue carries an inherited `backdropColor`, with no colour in its own doc entry, shows that colour and no Reset.
- [ ] **Step 2: Run** `pnpm vitest run apps/editor/test/useEdits.test.ts apps/editor/test/Inspector.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **The swatch** is `<input type="color">`, styled like `ThemeField`'s swatch (`Inspector.tsx:681-686`), with `value={cue.backdropColor ?? resolvedTheme.bg}`. The input sanitises a value that is not 6-digit hex by itself.
  - **`onChange`** parses with `HexColorSchema.safeParse` and dispatches only on success.
  - **Reset visibility** is keyed on the scene's own `edits.doc.scenes[sceneId]?.backdropColor`.
  - **The row** is shown only when `cue.kind !== "plain"` and `drawsSolidBackdrop(cue.layout)` holds.
- [ ] **Step 4: Run** the step-2 command, the whole `apps/editor/test` directory and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git add apps/editor/src/useEdits.ts apps/editor/src/Inspector.tsx apps/editor/test/useEdits.test.ts apps/editor/test/Inspector.test.ts
  git commit -m "feat(editor): Background colour for graphics that paint the backdrop"
  ```

### Task 4: Verify, check by eye, FINDINGS §176

**Files:** modify `docs/PHASE1-FINDINGS.md` (append §176 after §175).

- [ ] **Step 1: Run** `pnpm test --maxWorkers=2 --minWorkers=1`, `pnpm typecheck` and `pnpm build`. Expected: all green, with the test count above 6735.
- [ ] **Step 2: By-eye check (author).** Restart the editor on FE Loop. Set `added-1` (CtaCard) to `graphic-only` and pick a colour. Check four things:
  - the preview background;
  - the fade in and out;
  - Reset;
  - undo.

  Then revert the change.
- [ ] **Step 3: Write §176.** Cover:
  - the per-graphic colour;
  - calls 1-4;
  - the resolver rules;
  - the contain-fit bubble;
  - the kit reuse key;
  - the known limits from the spec's Risks and Edge cases;
  - the verification results.
- [ ] **Step 4: Commit.**
  ```bash
  git add docs/PHASE1-FINDINGS.md
  git commit -m "docs: FINDINGS §176, per-graphic backdrop colour"
  ```
