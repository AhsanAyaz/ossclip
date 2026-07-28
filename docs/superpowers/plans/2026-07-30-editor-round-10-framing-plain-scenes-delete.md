# Editor round 10 — framing you can grab, scenes you can delete, a timeline that's full

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Status:** implemented 2026-07-30 (remote session), in the planned order A → B → C, one commit each.

> **Status 2026-07-30 — Tasks A, B, C done.** 12 Playwright e2e, 460+ unit tests, typecheck and editor build green. Deviations and discoveries, so the next reader doesn't re-derive them:
>
> - **Task A:** `kind` is OPTIONAL rather than `.default("graphic")` — `render-props.json` reaches the editor as unparsed JSON, so pre-Task-A cues carry no `kind` at runtime and a defaulted (required-in-type) field would be a lie the type system tells; every check is written `=== "plain"`. The forcing function the plan wanted (tsc enumerating consumers) came from `component`/`props` optionality and worked — it surfaced `SceneLayer`'s component map key, `source-fit`'s registry lookup, and `applyOverrides`' swap path. Full-bleed plain cues are filtered out of `videoSlotAt`/`backdropOpacityAt`: they butt FLUSH against graphic cues, so the ±1e-3 neighbour probes would see them where they used to see a gap and double-morph the slot (pinned by a sweep test asserting plain ≡ gap at every 0.05s sample). A plain cue whose layout override leaves full-bleed stages like any scene. Two consumers the plan didn't list: `timing.ts`'s clamp had to ignore plain neighbours (a flush take pins every graphic exactly where it stands — no drag could move; caught by the Task 6 e2e), and plain blocks SCRUB on press-and-drag — the takes cover most of the track, and click-only takes would have regressed the R9 scrub gesture.
> - **Task B:** as planned (getScale math, no compensateEdits — commented at both sites; videoPreview applied at the END of the live memo; one gesture = one patch = one undo step). The hit walk stops at video-slot descendants AND at real controls (button/input/select/textarea); the Player's transport strip keeps pointer events while faded out and has no stable DOM marker, so the bottom 64px of the stage never starts a grab. One defect found by e2e: the slider's keyup committed on EVERY key — the "s" of Cmd+S re-dirtied the doc right after saving; it now commits only on keys that move a range input.
> - **Task C:** as planned. `dropHiddenCues` keeps `applyOverrides` 1:1; hide keeps the scene's other edits so restore brings them back intact; orphan reporting subtracts hidden ids (a deletion is not a lost edit). Ghosts paint above the take that took over their window, same `timeline-block-<id>` testid.
> - **Author's run still owed (cannot be done in the container):** re-produce the real clip, confirm the timeline is fully covered, drag the picture inside a `take-*` block, delete a weak scene and restore it.

**Goal:** every second of the timeline is a selectable block — graphic scenes, plain takes, and ghosts of deleted scenes — and any of them can be reframed by dragging the picture, with one undo step per gesture.

**Tech stack:** React 18, Remotion `<Player>`, TypeScript strict, zod (`zod/v4`), vitest + Playwright e2e.

---

## Context — the three symptoms

1. **Framing is unusable (verbatim: "the scale UI/UX is horrible").** `Inspector.tsx:234-262` offers three `<input type="number">`. They commit on **every keystroke** (`NumberField`, `Inspector.tsx:87-99`), so each character is its own undo step, and `dx`/`dy` are raw **composition pixels** — the session's `DX: 1` moved the picture by one pixel of 1080. There is no direct manipulation: the video slot (`VideoStage.tsx:101-129`) carries no `data-*` tag, so the Overlay's drag machinery — which already converts page-px → composition-px correctly via `playerRef.getScale()` (`Overlay.tsx:340-353`) — cannot see it.

2. **A scene can't be deleted.** No `hidden`/`deleted` concept exists in `OverrideDocSchema` (`overrides.ts:91-97`) and no action in `useEdits.ts:22-36`. If the producer picks a bad graphic, the only recourse today is a re-produce.

3. **The timeline is half empty, and the zooms aren't in it.** `zoomPlan` (`zoom.ts:95-124`) already tiles the whole output — one ramp + hold per clip — but it is a *parallel array*, invisible to the editor (`grep zoom apps/editor/src` finds only a comment). Cues are deliberately sparse: gaps are "implicit full-bleed" (`assemble.ts:35`, `stage.ts:505-507`). Two consequences: the timeline shows holes, and `cue.video` framing **only applies where a cue is active** — most of the video is unreachable by any framing control, however good the control is.

Symptom 3 is the keystone: filling the timeline with real cues is what makes framing work everywhere. That is why it lands first.

**Decisions taken with the author (2026-07-30), do not re-litigate:**
- Framing UI: **drag-to-pan on the stage + a zoom slider**. Not a corner-handle transform box, not wheel-zoom.
- Zoom-as-scenes: **plain cues fill the gaps** in the real pipeline, with a per-scene **auto-zoom toggle**. Not editor-only ghost blocks, and not an editable zoom curve (yet).
- Delete: **`hidden` override + a restorable ghost block** in the timeline. Not a hard vanish.

## Global constraints

- `pnpm vitest run` (441 green today), `pnpm -r --parallel exec tsc --noEmit`, `pnpm --filter @ossclip/editor build` and the 9 Playwright e2e stay green.
- Browser-safe imports only under `apps/editor/src/**`: `@ossclip/core/browser`, `@ossclip/renderer/composition`. Never the bare barrels. zod specifier exactly `zod/v4`.
- **Run the e2e with plain `npx playwright test` on macOS.** `OSSCLIP_E2E_CHROMIUM` points at a Linux container path.
- Do not regress round 9 (`2026-07-29-editor-playback-and-captions.md`) or the six fixes in `2026-07-28-editor-usability-fixes.md` — read their status blocks first.

---

## Task A: plain scenes fill the timeline

### A1. Cue schema gains a kind

- [ ] **Step A1.1:** `packages/core/src/scene-schema.ts:50-91` —
  ```ts
  kind: z.enum(["graphic", "plain"]).default("graphic"),
  component: SceneComponentIdSchema.optional(),   // required when kind === "graphic"
  props: z.record(z.string(), z.unknown()).optional(),
  ```
  plus a `.superRefine` making `component`+`props` mandatory for `"graphic"`. The optionality is deliberate: TS strict then **forces** every `cue.component` reader to state what it does with a plain cue, which is how we find them all instead of guessing. Treat `tsc`'s error list as the consumer checklist.
- [ ] **Step A1.2:** `video` gains `autoZoom: z.boolean().optional()`, mirrored in `SceneOverrideSchema.video` (`overrides.ts:62-68`).

### A2. New pure module `packages/core/src/fill.ts`

- [ ] **Step A2.1:** implement
  ```ts
  export const MIN_PLAIN_SEC = 0.6;
  export function fillPlainCues(
    cues: SceneCue[],
    opts: { outputDurationSec: number; clipStarts?: readonly number[] },
  ): SceneCue[]
  ```
  - Gaps: before the first graphic cue, between consecutive ones, after the last.
  - **Split each gap at every `clipStart` strictly inside it**, so a plain cue never straddles a cut. One plain cue = one continuous take, aligned with both the zoom ramp (`zoom.ts:106-121`) and `EdlVideo`'s punch-in (`EdlVideo.tsx:31-41`), which already key off those same boundaries.
  - Drop pieces under `MIN_PLAIN_SEC`: the `SCENE_GAP_SEC = 0.05` slivers (`assemble.ts:23`) must not become blocks, and the renderer's implicit full-bleed already covers them identically.
  - Emit `{ id, kind: "plain", layout: "full-bleed", startSec, endSec }`. Ids `take-<clipIndex>`, suffixed `take-<clipIndex>-<k>` only when graphics split one clip into several pieces.
  - Return graphic + plain merged and time-sorted.
- [ ] **Step A2.2:** export it from `packages/core/src/browser.ts` — the editor must call the *same* function, not a copy.

**Id stability, stated honestly in the module doc comment:** ids derive from (graphic cues, clip starts), so deleting a graphic merges two pieces and a framing override on the vanished suffix becomes an **orphan** — an already-reported condition (`overrides.ts:148`, `produce.ts:596-598`), not a silent loss. Worth the simplicity; time-keyed ids would drift on every re-cut instead.

### A3. Zoom stays the automatic layer, switchable per scene

- [ ] **Step A3.1:** `VideoStage.tsx:77-79` —
  ```ts
  const autoZoom = userVideo?.autoZoom !== false;
  const zoom = autoZoom ? 1 + (zoomRaw - 1) * zoomDamp : 1;
  ```
  Do **not** fold `zoomPlan` into cues. It already tiles the output, and turning eased ramp/hold splits into cue boundaries would fire the 0.35 s layout-morph machinery twice per clip (`stage.ts:459`, `videoSlotAt:509-520`). "Adjust the zoomed part" = select the take, switch auto zoom off, dial your own scale — or leave it on and correct on top, which is today's multiplicative behaviour (`VideoStage.tsx:93`).

### A4. Consumers

- [ ] **Step A4.1:** `packages/scenes/src/SceneLayer.tsx:32-93` — skip `kind === "plain"`: no graphic, no `data-edit-scene`.
- [ ] **Step A4.2:** `packages/scenes/src/stage.ts` — expect **no change**: a plain cue's layout *is* the `full-bleed` base (`stage.ts:505`), so graphic↔plain morphs behave exactly like today's cue↔gap. Prove it with the test in A5 rather than assuming it.
- [ ] **Step A4.3:** `packages/scenes/src/CaptionTrack.tsx:166-176` — expect no change: `activeCueAt` now returns a full-bleed cue with no `graphicRect`, which is what the null branch already assumed. Confirm.
- [ ] **Step A4.4:** `apps/cli/src/produce.ts` — caption `breakpoints` (:696-698), the CTA-window scan (:811-817) and the framing assessment (:750-766) all filter to **graphic** cues, so caption line-splitting and the report stay byte-identical. `sceneCues` (:829) = the filled list; `baseSceneCues` (:838) stays **graphic-only pristine** so the editor can re-derive the fill after a delete. `clipStarts` needs no new field — `spans[].outIn` already travels (:827).
- [ ] **Step A4.5:** `apps/editor/src/App.tsx:114-132` — live memo becomes `applyOverrides(baseGraphic)` → `dropHiddenCues` (Task C) → `fillPlainCues(..., spans.map(s => s.outIn))` → `applyOverrides` again for the plain ids. The second pass is a no-op on graphic cues (same component ⇒ `swapped` false ⇒ idempotent prop merge); say so in a comment or someone will delete it.
- [ ] **Step A4.6:** `apps/editor/src/Timeline.tsx:236-273` — render every cue; plain blocks dimmer, labelled `TAKE-n`, no `PIN` badge, and **no move/edge drag** (their window is derived, not stored). Click selects only.

### A5. Tests

- [ ] **Step A5.1:** `packages/core/test/fill.test.ts` — covers the timeline with no overlap; never straddles a cut; drops sub-`MIN_PLAIN_SEC` slivers; ids stay stable when an unrelated graphic changes.
- [ ] **Step A5.2:** `packages/scenes/test/stage.test.ts` — a plain cue carrying no `video` renders identically to today's gap. This is the no-regression pin for the whole task.
- [ ] **Step A5.3:** commit.

---

## Task B: framing you can grab

### B1. Tag the video (renderer)

- [ ] **Step B1.1:** `VideoStage.tsx:101` gets `data-edit-video={activeCue?.id}` on the slot div. Attribute only — no cursor, no `pointerEvents`. Editor affordances stay in the editor.

### B2. Hit-test and drag

- [ ] **Step B2.1:** `apps/editor/src/hitTest.ts:13-22` — add `findVideoFrom(node)` beside `findEditableFrom`, unit-tested in the existing jsdom spec.
- [ ] **Step B2.2:** `Overlay.tsx:270-314` (`mousedown`) — elements still win; when nothing editable is hit, fall through to the video → select `{ sceneId, elementId: null }` and arm `videoDragRef`.
- [ ] **Step B2.3:** `mousemove` — rAF-throttled preview. Page-px → composition-px with `1 / playerRef.getScale()`, same `settings.width / stageRect.width` fallback as `Overlay.tsx:340-347`. **No `compensateEdits` division**: the video slot has no scaled wrapper the way graphics do (`SceneLayer.tsx:84`). Comment the asymmetry — it is exactly the kind of thing someone later "fixes" into a bug.
- [ ] **Step B2.4:** `mouseup` — one `edits.patchVideo(sceneId, { dx: prior + Δ, dy: prior + Δ })`. One gesture, one undo step.
- [ ] **Step B2.5:** cursor `grab`/`grabbing` on the stage while the pointer is over the video.

### B3. Preview plumbing

- [ ] **Step B3.1:** `App.tsx` — `videoPreview: { sceneId, scale?, dx?, dy? } | null` in state, applied to the matching cue at the END of the `live` memo so the Player shows the drag/slider live; cleared when the real patch lands. Both the Overlay drag and the Inspector slider write it.

### B4. Inspector

- [ ] **Step B4.1:** `Inspector.tsx:234-262` becomes:
  ```
  VIDEO FRAMING
    ZOOM   [====|=========]  1.35×        data-testid="zoom-slider"
           0.5×            3×
           auto zoom 1.05× → 1.42× on screen
    [x] auto zoom
    PAN    drag the video on the stage
           dx 120   dy -40
    [ Reset framing ]
  ```
  Slider `type=range` min 0.5 max 3 step 0.01: `onChange` → preview, release (`onPointerUp`/`onKeyUp`) → `patchVideo`. Number fields stay as the precision fallback and keep `step="any"` — `interactions.spec.ts:151-156` pins that.

### B5. Undo coalescing

- [ ] **Step B5.1:** `useEdits.ts:49-54` — `commit(doc, coalesceKey?)` replaces the top of `past` when the same key repeats within 600 ms. Typing in a number field and scrubbing the slider pass `video:<sceneId>:<field>`; drags pass nothing. This fixes the "every keystroke is an undo step" defect, which made the current fields feel broken independently of the units problem.
- [ ] **Step B5.2:** tests + commit.

---

## Task C: delete a scene, with a way back

- [ ] **Step C1:** `SceneOverrideSchema` gains `hidden: z.boolean().optional()` (`overrides.ts:29-69`).
- [ ] **Step C2:** **keep `applyOverrides`'s 1:1 contract** — much of `overrides.test.ts` rests on it. Add a pure `dropHiddenCues(cues, doc): { cues, hidden: string[] }` that runs immediately after it, in `produce.ts` and the editor's live memo alike.
- [ ] **Step C3:** `useEdits` — `hideScene(id)` / `restoreScene(id)`. Restore **deletes the key** rather than writing `hidden: false`, matching `clearVideo`/`clearTiming` (`useEdits.ts:100-111`, `overrides.ts:243-248`).
- [ ] **Step C4:** `Inspector` — danger-styled `Delete scene` for graphic cues; a hidden scene shows `scene-3 (deleted)` + `Restore scene`.
- [ ] **Step C5:** `Timeline` — App passes ghost cues (base graphic cues whose id is hidden, at their base timing); dashed and dimmed, still `data-testid="timeline-block-<id>"` so selection and the e2e keep working.
- [ ] **Step C6:** keyboard `Delete`/`Backspace` on a selected graphic scene, guarded by `isTypingContext()` (`Overlay.tsx:454-508`).
- [ ] **Step C7:** `produce.ts` — `applyOverrides` → `dropHiddenCues` (log `▸ 1 scene hidden by the edit layer: scene-3`) → `reclampPinnedTiming` → `fillPlainCues`. The freed window becomes a plain take automatically on both sides, which is the payoff for doing A first.
- [ ] **Step C8:** tests + commit.

---

## Files touched

`packages/core/src/{scene-schema,overrides,fill,browser}.ts` · `packages/scenes/src/{VideoStage,SceneLayer}.tsx` · `apps/cli/src/produce.ts` · `apps/editor/src/{App,Overlay,Inspector,Timeline,useEdits,hitTest}` · this doc's status block.

## Verification

1. **Unit** (`pnpm vitest run`): the suites named in A5/B5/C8 — `fill` (coverage, no straddle, sliver drop, id stability), `overrides` (`hidden` drops exactly one cue and orphans still report; `video.autoZoom` round-trips), `useEdits` (coalescing collapses a keystroke burst into one undo step but never merges two gestures), `hitTest` (`findVideoFrom`), `stage` (plain cue ≡ gap).
2. **Typecheck + build:** `pnpm -r --parallel exec tsc --noEmit`, `pnpm --filter @ossclip/editor build`.
3. **e2e** (`npx playwright test` from `apps/editor` on macOS): drag the video → `overrides.json` `scenes[id].video.dx` matches sign and lands within ±20% of `Δpx × (settings.width / stageBox.width)` — the same band `edit.spec.ts:92-104` uses to catch an un-rescaled delta; slider → one `video.scale` value and **one** undo step; delete → block goes ghost, `hidden: true` on disk, Restore removes the key; a `take-*` block is selectable and its framing override renders.
   **Known breakage to fix in the same commit:** `interactions.spec.ts:156,245-255` index into `renderProps.sceneCues[0]/[1]`; those positions shift once plain cues are in the array. The e2e fixture `e2e/fixtures/workdir/render-props.json` also needs `baseSceneCues` graphic-only.
4. **Fixture render:** `--scenes fixtures/scenes.json` headless; extract frames either side of a graphic→plain boundary and confirm no visible jump. Unedited plain must be indistinguishable from today's gap.
5. **Author's run (cannot be done in the container):** re-produce the real clip, open the editor, confirm the timeline is fully covered, drag the picture inside a `take-*` block, delete a weak scene and restore it.

## Notes for whoever picks this up

- **Order matters.** A before B: until plain cues exist, dragging the picture in a gap has no cue to write to. A before C: a deleted scene's window is supposed to become a plain take, and that only happens if the fill pass exists.
- The screenshot that started this showed `SCALE 0,7` — a locale-formatted decimal separator in `<input type="number">`. Worth a glance while touching the fields; it is cosmetic but it is also the field that "wouldn't take a value".
- Everything here came from ten minutes of the author actually editing. Keep the hand-verification step in each task.
