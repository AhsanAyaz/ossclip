# A background colour per graphic

*   **Author:** Muhammad Ahsan Ayaz (drafted with Claude)
*   **Status:** Approved by the author (2026-11-24; calls 1-4 confirmed). Draft 3, revised after review rounds 1 (code accuracy, build readiness, design) and 2 (code accuracy, build readiness): `~/ossclip-work/egm-short/backdrop-color-review-r{1,2}.md`. Direction chosen by the author: a per-graphic override (option A), not the project-wide `bg` made easier to find (option B).
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
*   Changing the panel scrim (`SceneLayer.tsx:265`, via the `scrimColor` helper at `:66`). It keeps `theme.bg`.
*   A text field for the colour. The swatch alone writes valid hex, so there is no invalid input to handle (round 1, M11 and S3).
*   A colour cross-fade between two adjacent backdrop graphics with different colours (see §3).

## Approaches

*   **A. Per-graphic override (chosen by the author, 2026-11-24).** A new optional scene field, stored in `overrides.json`, read by the renderer.
*   **B. Show the project-wide `bg` picker when a backdrop graphic is selected.** Editor-only and smaller, but one colour for every graphic. The author did not want this.

## Design

### 1. Data

*   **Field:** `backdropColor`, a string matching `/^#[0-9a-fA-F]{6}$/`.
    *   One exported schema, `HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)`, lives in `packages/core/src/scene-schema.ts`, which is already in the browser bundle (`browser.ts:7`). `SceneOverrideSchema` (`overrides.ts:130`) and `SceneCueSchema` both use it as `HexColorSchema.optional()`.
    *   It is parsed with zod, never coerced (CLAUDE.md): `#fff`, `red` or `rgb(...)` are rejected.
    *   It is the same hex format the `<input type="color">` produces.
*   **Applied to the cue** in `applyOverrides`, in the same place and form as `captionScale` (`overrides.ts:1468`): `...(o.backdropColor !== undefined ? { backdropColor: o.backdropColor } : {})`.
*   **Split halves inherit it.** `effectiveOverride` passes every root field except `timing` and `hidden` (and the framing fields for take pieces) to a half (`overrides.ts:1324-1326`). No change is needed.
*   **Stored whatever the layout (call 4).** If the author switches the graphic to a layout without a backdrop, the colour stays in the doc and has no effect, so switching back restores it. This is the same rule `pip` follows under non-`pip-bubble` layouts.
    *   `patchLayout` keeps the entry (`useEdits.ts:1236-1248`).
    *   While the layout has no backdrop, the control and its Reset are hidden, so the stored colour can only be cleared by switching back first (round 1, M8). No Reset is added elsewhere.
    *   The kit reuse key hashes the whole cue, so a colour stored on a `full-bleed` graphic causes one kit re-render with identical pixels. This is accepted (round 1, M2).

### 2. Which graphics show the control

The colour picker shows for a selected graphic whose resolved layout satisfies `drawsSolidBackdrop`: `graphic-only` or `pip-bubble`.

*   `pip-bubble` also paints the solid backdrop behind the graphic, around the speaker's bubble.
*   **My call:** offering the colour there too costs nothing and keeps one rule, "the layouts that paint the background can colour it". The author asked about `graphic-only`; this is a small extension to confirm.
*   The predicate is imported from `@ossclip/scenes/geometry` (`drawsSolidBackdrop` is exported from `stage.ts`), so the editor and renderer share one rule.
*   Do not use core's `isBackdropLayout`/`BACKDROP_LAYOUTS` (`framing.ts:289-293`), which the Inspector already imports. It includes `full-bleed` and means something else (round 1, M6).

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

**Between two adjacent backdrop graphics with different colours** (call 2), the colour switches at the boundary with no cross-fade. Usually the graphic itself changes at that instant, so the background changes with it. The exception is a split graphic with only one half coloured, which snaps mid-graphic; the author chose that colour per half (round 1, M7). A cross-fade would need a second fill layer, and nobody has asked for one (Non-goals).

`backdropColorAt` and `backdropOpacityAt` both derive the active cue, T, `prev` and `next` the same way. The plan may extract one private resolver for both (round 1, M1).

**`VideoStage.tsx`** computes `const backdropColor = backdropColorAt(cues, tSec, theme.bg)` once and uses it in two places:
*   the stage backdrop at `:206`, whose opacity is unchanged;
*   the contain-fit slot fill at `:227`.

At `:227`, a `pip-bubble` graphic with `sourceFit: "contain"` would otherwise fill the inside of its bubble with `theme.bg` while the backdrop around the bubble used the new colour (round 1, S6). For a layout without a backdrop, outside any fade window, `backdropColorAt` returns `theme.bg`, so the contain fill there stays exactly as today. Inside a fade window next to a coloured backdrop graphic, the contain fill takes that graphic's colour for the 0.35 s fade, the same colour as the backdrop fading behind it. Two adjacent backdrop colours meet at the boundary with a snap. Both are accepted: one rule for both fills is simpler than gating the contain fill separately (round 2, SF5).

**Kit clip:** `sceneClipBackground` (`renderer/src/scene-clip.ts:66-72`) returns `color: backdropColorAt([p.cue], frame / p.settings.fps, p.theme.bg)`, the same call shape it already uses for opacity (round 1, M1). The kit's reuse key already hashes the whole cue (`kit-plan.ts:139-147`), so a changed colour re-renders the clip and a clip without the field keeps its key.

**Editor preview:** the Player renders the same composition from the override-applied cues (`App.tsx:1462`, `:1580`, `:1758`), so it needs no extra work. The graphic editor modal's preview is not covered (round 1, M9).

**Needs nothing (round 1, M10):**
*   `remapOverridesThroughRecut` remaps time values only, and a colour is not one.
*   The kit notes need nothing.
*   The cover is out of scope: it paints `theme.bg` itself.
*   Scene stills inherit the change, because they render the composition.

### 4. Editor

*   **Reducer actions,** following the house pairs `patchPip`/`clearPip` and `patchCaptionScale`/`clearCaptionStyle` (`useEdits.ts:909-964`):
    *   **`patchBackdropColor { sceneId, color, coalesce? }`** sets `scenes[sceneId].backdropColor`. Dragging the colour wheel fires many `onChange` events. They coalesce on `backdropColor:<sceneId>`, so one drag is one undo step.
    *   **`clearBackdropColor { sceneId }`** deletes the key. A clear of an absent key returns `state` unchanged, with no undo step, as `clearPip` does (`:923-924`). An entry left empty by the delete is kept, which matches `clearPip`.
    *   **Wiring:** add both to the action union (`:161`) and as hook methods near `:2141`.
    *   **`idKeyedLookTarget`** (`:723-737`) does not list them. That switch routes look writes for take pieces. The control is offered only for graphic cues (`kind !== "plain"`), and a graphic is never in look mode, so neither action reaches a take through the UI (round 1, S5). A hand-edited `backdropColor` on a take set to `graphic-only` renders, which is harmless.
*   **Inspector:** directly under the layout control (`Inspector.tsx:1742-1795`), shown when §2 holds and the selected cue is a graphic:
    *   **A row labelled `Background`.** It holds one `<input type="color" data-testid="backdrop-color">`, styled like `ThemeField`'s swatch (`Inspector.tsx:672-697`). It is a separate small element, not `ThemeField`, which hard-wires `theme-${id}` (round 1, S3).
    *   **Value shown:** `cue.backdropColor ?? resolvedTheme.bg`. `cue` is the selected cue after overrides, so a split half shows the colour it inherits from its root (round 1, S2).
        *   No fallback code is needed. A colour input sanitises its value itself: browsers and jsdom turn a value that is not 6-digit hex into `#000000` and lowercase the rest (round 2, SF3).
    *   **`onChange`:** parses the value with `HexColorSchema.safeParse`, so the Inspector is the parse boundary (round 1, S4). On success it dispatches `patchBackdropColor` with the `backdropColor:<sceneId>` coalesce key.
    *   **A `Reset` link** (`data-testid="backdrop-color-reset"`) shows only when the selected scene's OWN doc entry has `backdropColor`. An inherited colour on a split half shows no Reset. Reset dispatches `clearBackdropColor`.

## Edge cases

*   **Legacy docs** have no field and render exactly as today. A test pins `backdropColorAt` returning `themeBg` when no cue has the field.
*   **Split graphic.** Both halves carry the root's colour. A half cannot have its own colour unless it is edited by its half id, which the Inspector already does for selected halves, the same as `captionScale`.
*   **Downgrade.** An older build's zod strips the unknown key, and the graphic renders on `theme.bg`. This is acceptable and matches how `takeLooks` behaved (§173).
*   **Kit clip of a `pip-bubble` graphic.** It gets the colour behind the graphic. The bubble itself has no footage in the kit (NG5, §163), so nothing changes there.

## Risks

*   **Contrast.** A light background under a graphic drawn in `theme.fg` can make the graphic unreadable. The author picks the colour and sees the result in the preview at once, so this is the author's call. No contrast check is added.
*   **Downgrade, then save.** An older editor's zod strips `backdropColor` on load. If the author saves in that older editor, the colour is lost for good. This is the same exposure every new field has had (`takeLooks`, §173).
*   **Components that use `theme.bg` as ink.** ChatMock, StatCard, FlowDiagram, ScreenshotFrame and RuleCard draw some text in `theme.bg`, expecting it to match the background. On a custom backdrop that text keeps `theme.bg`. It sits on the component's own panels, not on the backdrop, so it stays readable. This is accepted, and noted for the by-eye check.

## Files

*   `packages/core/src/overrides.ts`: schema field and `applyOverrides` spread.
*   `packages/core/src/scene-schema.ts`: cue field.
*   `packages/scenes/src/stage.ts`: `backdropColorAt`.
*   `packages/scenes/src/VideoStage.tsx`: use it.
*   `packages/renderer/src/scene-clip.ts`: kit clip colour.
*   `apps/editor/src/useEdits.ts`: `patchBackdropColor`.
*   `apps/editor/src/Inspector.tsx`: the `Background` row.
*   Tests:
    *   `packages/core/test/overrides.test.ts`;
    *   `packages/core/test/kit-plan.test.ts` (reuse key);
    *   `packages/scenes/test/stage.test.ts`;
    *   `packages/renderer/test/scene-clip.test.ts`;
    *   `apps/editor/test/useEdits.test.ts`;
    *   `apps/editor/test/Inspector.test.ts`.
*   `docs/PHASE1-FINDINGS.md`: §176.

## Test plan

*   **Schema.** `HexColorSchema` accepts `#1a2b3c`. `SceneOverrideSchema` rejects `backdropColor` values `#fff`, `red`, `rgb(1,2,3)` and `""`.
*   **`applyOverrides`.** An override with `backdropColor` puts it on the cue. Without one, the cue has no key (deep-equal to today's output). A split half inherits the root's colour.
*   **`backdropColorAt`.** `themeBg` is `#000000`. Cues:

    | cue | window | layout | `backdropColor` |
    | --- | --- | --- | --- |
    | plain take | [0, 4] | full-bleed | — |
    | graphic A | [4, 8] | graphic-only | `#ff0000` |
    | graphic B | [8, 12] | graphic-only | `#00ff00` |
    | graphic C | [12, 16] | full-bleed | `#123456` (stored, ignored) |
    | graphic D | [16, 20] | graphic-only | `#0000ff` |

    `morphCues` drops the plain take, so A's fade-in starts from nothing. C is the morph neighbour after B and before D. C stores a colour that rule 1 must ignore, because C draws no backdrop (round 2, SF2).
    *   **6 s:** `#ff0000`. Rule 1: A draws the backdrop.
    *   **4.1 s:** `#ff0000`. Rule 1, inside A's fade-in from nothing.
    *   **7.99 s:** `#ff0000`, and **8.01 s:** `#00ff00`. The snap at the A/B boundary (call 2).
    *   **12.1 s:** `#00ff00`. Rule 2: C is active, does not draw the backdrop, and is inside its fade-in window, so it takes the colour of `prev` (B), which does (call 3).
    *   **11.8 s:** `#00ff00`. Rule 1, inside B's own fade-out.
    *   **15.9 s:** `#0000ff`. Rule 2 with `next`: C is in its fade-out window, and D draws the backdrop (round 2, SF1).
    *   **2 s and 3.9 s:** `#000000`. Rule 3: the plain take is filtered out, so there is no active morph cue. 3.9 s would wrongly give A's colour if the `morphCues` filter were missing (round 2, SF1).
    *   **14 s:** `#000000`. C is active, outside its fade windows, and its stored `#123456` is ignored.
    *   **With no `backdropColor` anywhere,** every sample returns `themeBg`.
*   **Kit clip.**
    *   `sceneClipBackground` returns the override colour for a `graphic-only` cue with `backdropColor`, `theme.bg` without it, and `null` for `full-bleed` whether or not the field is set.
    *   In `kit-plan.test.ts`, the reuse key of a `graphic-only` cue changes when only `backdropColor` changes.
*   **Reducer.**
    *   `patchBackdropColor` sets the colour.
    *   Two dispatches with the same coalesce key make one undo step.
    *   `clearBackdropColor` deletes the key.
    *   A clear of an absent key returns the same state object, with no undo entry.
*   **Inspector.**
    *   The `Background` row shows for a selected `graphic-only` graphic and a `pip-bubble` graphic. It does not show for a `full-bleed` graphic or a take.
    *   Its swatch value equals `resolvedTheme.bg.toLowerCase()` when no colour is set. The colour input lowercases its value.
    *   **Harness.** `Inspector.test.ts`'s harness needs a `resolvedTheme` prop and an `initialScenes` type that accepts `backdropColor`.
    *   **The "no row for a take" case** uses a take whose layout is `graphic-only`, so the test fails if the `kind` gate is missing (round 2, SF4).
    *   A `change` event on the swatch dispatches `patchBackdropColor`.
    *   Reset is present only when the scene's own entry has a colour. Clicking it clears the colour.
    *   A split half that inherits its root's colour shows that colour and no Reset.

## Calls made in this draft (author to confirm)

1.  The control is also offered for `pip-bubble` graphics, because they paint the same background.
2.  Two adjacent backdrop graphics with different colours switch at the boundary, with no cross-fade.
3.  A fading backdrop keeps the colour of the graphic it belongs to.
4.  The colour stays stored when the layout changes to one without a backdrop, and does nothing there.

The author confirmed calls 1-4 on 2026-11-24.

## Changes from draft 2

*   **SF1, SF2.** The fixture gains graphic D and a colour on C. The new samples at 3.9, 11.8 and 15.9 s test the `morphCues` filter, rule 2 with `next`, and the layout gate in rule 1.
*   **SF3.** The swatch's `#000000` fallback is dropped, because the input sanitises its value itself. The tests compare lowercase.
*   **SF4.** The Inspector harness needs are listed, and the take case uses `graphic-only`.
*   **SF5.** The contain-fit fill's colour in fade windows is stated and accepted.
*   **M9, M10.** The preview citations and the "needs nothing" answers are added.

## Changes from draft 1

*   **S1.** The `backdropColorAt` fixture now exercises all three rules and the `morphCues` filter.
*   **S2.** The Inspector shows `cue.backdropColor` (which covers inherited colours), and Reset follows the scene's own entry.
*   **S3 and M11.** The colour is set with a swatch only, with no text field. *(Draft 3 dropped the `#000000` fallback: the input sanitises its value itself.)*
*   **S4.** One `HexColorSchema` is used by both schemas and by the Inspector.
*   **S5.** `idKeyedLookTarget` is left alone, with the reason given.
*   **S6.** The contain-fit fill uses `backdropColorAt` too.
*   **S7.** A Risks section is added.
*   **M1.** The kit clip calls `backdropColorAt`, and the plan may share one resolver.
*   **M2.** The one-off kit re-render under call 4 is accepted.
*   **M3.** There is a separate `clearBackdropColor` action, and clearing an absent key does nothing.
*   **M4.** The test files are named.
*   **M5.** The citation is corrected to §173.
*   **M6.** The line references are fixed, with a warning about `isBackdropLayout`.
*   **M7.** The split-half snap is named under call 2.
*   **M8.** The hidden Reset is stated.
