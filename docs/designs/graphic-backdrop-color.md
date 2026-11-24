# A background colour per graphic

*   **Author:** Muhammad Ahsan Ayaz (drafted with Claude)
*   **Status:** Draft 1 (2026-11-24). Direction chosen by the author: a per-graphic override (option A), not the project-wide `bg` made easier to find (option B).
*   **Builds on:** FINDINGS §163 (backdrops in 16:9 and the kit clip's solid background), §175 (timeline lanes, where the hatch shows `graphic-only`).

--------------------------------------------------------------------------------

## Overview

When a graphic's layout hides the footage, the renderer fills the frame behind the graphic with `theme.bg`.
*   `VideoStage.tsx:206` draws `<AbsoluteFill style={{ background: theme.bg, opacity: backdrop }} />`.
*   The opacity comes from `backdropOpacityAt` (`stage.ts:1346`), which fades the colour in and out over `LAYOUT_TRANSITION_SEC`.
*   `drawsSolidBackdrop` (`stage.ts:1337`) names the two layouts that get the fill: `graphic-only` and `pip-bubble`.

`theme.bg` is one colour for the whole project. The Inspector's theme panel can change it (`Inspector.tsx:2445`), but only when nothing is selected, and the change applies to every graphic.

The author wants to pick the colour per graphic, at the place where the graphic is chosen.

## Goals

*   A graphic whose layout draws the solid backdrop can carry its own background colour.
*   The colour is picked in the Inspector, beside the layout control.
*   The full render, the editor preview and the kit clip all show the same colour.
*   Without an override, everything renders as it does today, byte for byte.

## Non-goals

*   Gradients, images or video behind a graphic.
*   Per-take colours: takes have no backdrop unless set to `graphic-only`, which is rare (FINDINGS §175 known limits).
*   Changing the panel scrim (`SceneLayer.tsx:66`) or the contain-fit fill (`VideoStage.tsx:227`). Both keep `theme.bg`.
*   A colour cross-fade between two adjacent backdrop graphics with different colours (see §3).

## Approaches

*   **A. Per-graphic override (chosen by the author, 2026-11-24).** A new optional scene field, stored in `overrides.json`, read by the renderer.
*   **B. Show the project-wide `bg` picker when a backdrop graphic is selected.** Editor-only and smaller, but one colour for every graphic. The author did not want this.

## Design

### 1. Data

*   **Field:** `backdropColor`, a string matching `/^#[0-9a-fA-F]{6}$/`.
    *   It is added to `SceneOverrideSchema` (`overrides.ts:130`) and `SceneCueSchema` (`scene-schema.ts`), both `.optional()`.
    *   It is parsed with zod, never coerced (CLAUDE.md): `#fff`, `red` or `rgb(...)` are rejected.
    *   It is the same hex format the `<input type="color">` produces.
*   **Applied to the cue** in `applyOverrides`, in the same place and form as `captionScale` (`overrides.ts:1468`): `...(o.backdropColor !== undefined ? { backdropColor: o.backdropColor } : {})`.
*   **Split halves inherit it.** `effectiveOverride` passes every root field except `timing` and `hidden` (and the framing fields for take pieces) to a half (`overrides.ts:1324-1326`). No change is needed.
*   **Stored whatever the layout.** If the author switches the graphic to a layout without a backdrop, the colour stays in the doc and has no effect, so switching back restores it. This is the same rule `pip` follows under non-`pip-bubble` layouts.

### 2. Which graphics show the control

The colour picker shows for a selected graphic whose resolved layout satisfies `drawsSolidBackdrop`: `graphic-only` or `pip-bubble`.

*   `pip-bubble` also paints the solid backdrop behind the graphic, around the speaker's bubble.
*   **My call:** offering the colour there too costs nothing and keeps one rule, "the layouts that paint the background can colour it". The author asked about `graphic-only`; this is a small extension to confirm.
*   The predicate is imported from `@ossclip/scenes/geometry` (`drawsSolidBackdrop` is exported from `stage.ts`), so the editor and renderer share one rule.

### 3. Rendering

**New pure function** in `packages/scenes/src/stage.ts`, next to `backdropOpacityAt`:

```ts
export function backdropColorAt(allCues: readonly SceneCue[], tSec: number, themeBg: string): string;
```

It resolves the colour with the same morph cues and neighbours as `backdropOpacityAt`:

*   **Active cue draws the backdrop:** its `backdropColor ?? themeBg`.
*   **Active cue does not draw the backdrop** but sits in a fade window: the colour of the neighbour that does, its `backdropColor ?? themeBg`.
    *   In the fade-in window (`sinceStart < T`), the neighbour is `prev`.
    *   In the fade-out window (`untilEnd < T`), the neighbour is `next`.

    This keeps the fading backdrop the colour of the graphic it belongs to, instead of jumping to `themeBg` while it fades.
*   **Otherwise:** `themeBg`. The opacity is 0 there, so the value is never seen.

**Between two adjacent backdrop graphics with different colours**, the colour switches at the boundary with no cross-fade. The graphic itself changes at that instant, so the background changes with it. A cross-fade would need a second fill layer, and nobody has asked for one (Non-goals).

**`VideoStage.tsx:206`** uses `backdropColorAt(cues, tSec, theme.bg)` for `background`. The opacity is unchanged.

**Kit clip:** `sceneClipBackground` (`renderer/src/scene-clip.ts:66-72`) returns `color: p.cue.backdropColor ?? p.theme.bg`. The kit's reuse key already hashes the whole cue (`kit-plan.ts:139-147`), so a changed colour re-renders the clip and a clip without the field keeps its key.

**Editor preview:** the Player renders the same composition, so it needs no extra work.

### 4. Editor

*   **Reducer action:** `patchBackdropColor { sceneId, color: string | null, coalesce? }` in `useEdits.ts`, following `patchCaptionScale` (`useEdits.ts:943-955`).
    *   `null` deletes the key, which is the Reset.
    *   One undo step per gesture, coalesced on `backdropColor:<sceneId>`, so dragging through the colour wheel is one step.
*   **Inspector:** directly under the layout control ("Behind the graphic" or "Layout", `Inspector.tsx:1752-1790`), when §2 holds:
    *   a row labelled `Background`, built with the existing `ThemeField` pattern: a colour swatch input plus a text input. The `data-testid` is `backdrop-color`.
    *   The value shown is `sceneDoc.backdropColor ?? resolvedTheme.bg`.
    *   A `Reset` link appears only when the scene has its own colour. It dispatches `null`. Its `data-testid` is `backdrop-color-reset`.
    *   **Text input validation:** text that fails the hex pattern is not written. The field keeps the typed text, gets a red border, and does not dispatch. The colour swatch always yields valid hex.
*   **Look mode / takes:** not offered. The control shows only for graphic cues (`kind !== "plain"`).

## Edge cases

*   **Legacy docs** have no field and render exactly as today. A test pins `backdropColorAt` returning `themeBg` when no cue has the field.
*   **Split graphic.** Both halves carry the root's colour. A half cannot have its own colour unless it is edited by its half id, which the Inspector already does for selected halves, the same as `captionScale`.
*   **Downgrade.** An older build's zod strips the unknown key, and the graphic renders on `theme.bg`. This is acceptable and matches how `takeLooks` behaved (§174).
*   **Kit clip of a `pip-bubble` graphic.** It gets the colour behind the graphic. The bubble itself has no footage in the kit (NG5, §163), so nothing changes there.

## Files

*   `packages/core/src/overrides.ts`: schema field and `applyOverrides` spread.
*   `packages/core/src/scene-schema.ts`: cue field.
*   `packages/scenes/src/stage.ts`: `backdropColorAt`.
*   `packages/scenes/src/VideoStage.tsx`: use it.
*   `packages/renderer/src/scene-clip.ts`: kit clip colour.
*   `apps/editor/src/useEdits.ts`: `patchBackdropColor`.
*   `apps/editor/src/Inspector.tsx`: the `Background` row.
*   Tests:
    *   `packages/core/test/overrides*.test.ts`;
    *   `packages/scenes/test/stage*.test.ts`;
    *   `packages/renderer/test/scene-clip*.test.ts`;
    *   `apps/editor/test/useEdits*.test.ts`;
    *   `apps/editor/test/Inspector*.test.ts`.

    The plan names the exact files.
*   `docs/PHASE1-FINDINGS.md`: §176.

## Test plan

*   **Schema.** `#1a2b3c` parses. `#fff`, `red`, `rgb(1,2,3)` and `""` are rejected by `SceneOverrideSchema`.
*   **`applyOverrides`.** An override with `backdropColor` puts it on the cue. Without one, the cue has no key (deep-equal to today's output). A split half inherits the root's colour.
*   **`backdropColorAt`.** Cues: a take [0, 4], graphic A `graphic-only` `#ff0000` [4, 8], graphic B `graphic-only` with no colour [8, 12], take [12, 16]. `themeBg` is `#000000`.
    *   At 6 s: `#ff0000`.
    *   At 4.1 s, inside A's fade-in from the take: `#ff0000`.
    *   At 10 s: `#000000`, the theme.
    *   At 7.99 s: `#ff0000`. At 8.01 s: `#000000`. This is the snap at the A/B boundary.
    *   At 12.1 s, inside the take's window during B's fade-out: `#000000`.
    *   At 2 s: `#000000`.
    *   With no field anywhere, every sample returns `themeBg`.
*   **Kit clip.** `sceneClipBackground` returns the override colour for a `graphic-only` cue with `backdropColor`, `theme.bg` without it, and `null` for `full-bleed` whether or not the field is set. The reuse key changes when only `backdropColor` changes.
*   **Reducer.**
    *   `patchBackdropColor` sets the colour, and `null` deletes it.
    *   Two coalesced dispatches make one undo step.
*   **Inspector.**
    *   The `Background` row shows for a selected `graphic-only` graphic and a `pip-bubble` graphic. It does not show for a `full-bleed` graphic or a take.
    *   It shows `resolvedTheme.bg` when the scene has no colour of its own.
    *   Picking a colour dispatches it. Invalid text does not dispatch. Reset clears the colour.

## Calls made in this draft (author to confirm)

1.  The control is also offered for `pip-bubble` graphics, because they paint the same background.
2.  Two adjacent backdrop graphics with different colours switch at the boundary, with no cross-fade.
3.  A fading backdrop keeps the colour of the graphic it belongs to.
4.  The colour stays stored when the layout changes to one without a backdrop, and does nothing there.
