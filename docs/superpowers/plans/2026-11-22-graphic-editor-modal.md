# Graphic editor and word-timed list items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List graphics bring each item in on its spoken word, and the author sets those words in a modal that adds or edits a graphic.

**Architecture:** Part 1 puts BulletList into the existing reveal system behind a planner guard. Part 2 stores per-item word pins in `overrides.json` (`scenes[id].itemPins`) and resolves every item (pinned or auto-matched) on the live clock in one pure core pass that produce and the editor preview both call; a modal (replacing the add popover) edits text, pins and the start.

**Tech Stack:** TypeScript, zod v4, vitest, React, Remotion `<Player>`, Playwright e2e.

**Spec:** `docs/designs/graphic-editor-modal.md` (approved draft 5). Read it in full before any task; "§N" below means its sections, "Terms" its Terms. The interaction reference is the mockup `~/ossclip-work/mockups/graphic-modal/index.html` (v3, local only) with screenshots in `~/ossclip-work/mockups/graphic-modal/v3/`.

## Global Constraints

- Values from the user are parsed with zod, never coerced (CLAUDE.md).
- Pure logic separate from I/O; new core functions exported through `packages/core/src/browser.ts` when the editor uses them.
- Comments explain why and cite `graphic-editor-modal §N` or FINDINGS sections.
- AG1: a graphic without `itemPins` renders byte-equal to today, BulletList included (exception: BulletList whose override carries `reveal`/`pacing`/`revealSpeed`/`entrance`).
- `ITEM_LEAD_SEC` = 0.15, `ENTRY_LEAD_SEC` = 0.3 (existing constants in `assemble.ts`; import, never re-declare). Pin tolerance 0.05 s, nearest wins, tie → earlier word.
- Covered components: BulletList, FlowDiagram, StrikethroughReveal, ChatMock, CardRow. Not TerminalMock, not PhoneDemo.
- Override key name is exactly `itemPins`; pin entries `null | { src: number; text: string }`; CardRow item text = `text` and `sub` joined with " · ".
- Machine: 7 GB RAM, one heavy command at a time. Editor unit tests from repo root: `pnpm exec vitest run apps/editor/test` (never `pnpm --filter @ossclip/editor exec vitest`). Never push. One or more local commits per task.

## Review Focus

1. **Existing projects unchanged:** a stored BulletList (cue with `entryWord` only), a FlowDiagram swapped to BulletList, and any project without `itemPins` produce byte-equal render-props. Tests in Tasks 1 and 3.
2. **Preview equals render under a veto:** the parity cases in spec Test plan, run on pure lists. Task 3 owns the harness; Task 5 adds the editor-side call shape to it.
3. **Ordinary editor session:** with no veto, `finishOnClock` takes its early exit; items must still resolve there, and a project without `itemPins` must return the same props object. Task 5.
4. **Saving without changes writes nothing**, and editing a pinned item's text keeps its pin. Task 6.
5. **Transcript gestures and the existing add-graphic e2e keep passing** after the popover is replaced. Task 7.

---

### Task 1: BulletList joins the reveal system (Part 1)

**Files:** Modify `packages/core/src/reveal-match.ts` (`revealItemTexts`), `packages/core/src/scene-registry.ts` (`BulletListProps` gains `...RevealPropsShape`), `packages/core/src/assemble.ts` (`plannedCue` guard), `packages/core/src/overrides.ts` (`withSwappedReveal` guard), `packages/scenes/src/components/BulletList.tsx` (`timing` prop; `componentRevealFrames`, legacy step 7; unset `entrance` keeps `rise`). Tests in the existing test files for each (find with `grep -l`).

**Interfaces — Produces:** `revealItemTexts("BulletList", props)` returns `props.items` as strings.

- [ ] **Step 1: Failing tests:**
  - `revealItemTexts("BulletList", {items:["A","B"]})` → `["A","B"]`.
  - `assembleScenes` on a BulletList scene with `cue: {entryWord}` only → cue has no `reveal` key (byte-equal to a pre-change fixture you capture first).
  - Same with `cue: {entryWord, itemWords:[w1,w2]}` → `reveal.itemAtSec` = each word's output start − 0.15.
  - `applyOverrides` swapping a FlowDiagram cue (with `reveal`) to BulletList → result has no `reveal`.
  - Renderer: BulletList with no `itemAtSec` and no reveal props → item k enters at frame `k*7` (as today); with `itemAtSec` → enters on those frames.
  - Invariant: BulletList with neither `itemWords` nor `itemPins` has no `reveal` (the override part is asserted again in Task 3).
- [ ] **Step 2:** Run the touched test files — FAIL.
- [ ] **Step 3:** Implement per spec §1.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat: bullet lists can land items on their spoken words`.

### Task 2: `wordOutputStart` and `resolveItemWords`

**Files:** Modify `packages/core/src/assemble.ts` (extract `wordOutputStart(w, map): number | null` from `plannedCue`'s conversion, `assemble.ts:311-314, 336-344`; `plannedCue` uses it), `packages/core/src/reveal-match.ts` (`resolveItemWords`), `packages/core/src/browser.ts`. Tests in the matcher and assemble test files.

**Interfaces — Produces:**
```ts
export function wordOutputStart(w: Word, map: TimeMap): number | null
export type ItemWordState = { word: number; state: "pinned" | "auto" } | { word: null; state: "cut" | "unmatched" }
export function resolveItemWords(
  texts: RevealItem[], allWords: readonly { text: string; srcStart: number }[],
  window: { srcStart: number; srcEnd: number }, isSpoken: (i: number) => boolean,
  pins: readonly ({ src: number; text: string } | null)[],
): { items: ItemWordState[]; notes: string[] }
```
Pins rows and order exactly as spec §3's table (moved → outside → out of order → cut → pinned); "bounding pins" = pinned or cut; auto segments via `locateSpoken` on spoken window words strictly between bounding pins' words.

- [ ] **Step 1: Failing tests:** `plannedCue` output unchanged after the extraction (existing tests green + one fixture with a word whose start is clipped by a cut → still timed). `resolveItemWords`: one test per table row with its note text; tie-break (two words within 0.05 s → nearer; equal → earlier); a cut pin bounds segments (an auto item after it cannot match before it); auto items never cross a pinned word; no two items share a word; all-null pins → same words as `locateSpoken` over the spoken window.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run file + `pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(core): resolve list items to spoken words with author pins`.

### Task 3: `itemPins` and `resolveItemTimings` (core), with the parity harness

**Files:** Modify `packages/core/src/overrides.ts` (`SceneOverrideSchema.itemPins` per spec §2; `resolveItemTimings` per §3 with the Terms "Block window" rules), `packages/core/src/browser.ts`. Create `packages/core/test/item-timing.test.ts` and `packages/core/test/item-timing-parity.test.ts`.

**Interfaces — Consumes:** Task 2. **Produces:**
```ts
export type ItemTimingRoot = { component: string; props: Record<string, unknown>; window: { srcStart: number; srcEnd: number } | null }
export function blockWindow(rootCue: SceneCue, doc: OverrideDoc, words: readonly Word[], pinMap: TimeMap, liveMap: TimeMap): { srcStart: number; srcEnd: number } | null
export function resolveItemTimings(
  cues: SceneCue[], doc: OverrideDoc, words: readonly Word[], map: TimeMap,
  roots?: ReadonlyMap<string, ItemTimingRoot>,
): { cues: SceneCue[]; notes: string[] }
```
`blockWindow` applies Terms rule order: timing pin by form (src pin as stored when `resolveTimingPin(pin, liveMap)` is non-null; legacy output pin via `pinMap.toSource`), else added entry span, else anchor words' source span, else null. `resolveItemTimings` steps 1–6 of §3: gate `itemPins` present and component covered; mismatches → that pin (or all) auto with a note; writes `itemAtSec` only to cues with the root id AND the root's component; `props.reveal = "synced"` only with a bounding pin and no `reveal` in that cue's own effective override; never touches `startSec`/`endSec`/`entryAtSec`.

- [ ] **Step 1: Failing tests (`item-timing.test.ts`):** schema accepts the shape, old docs parse unchanged and round-trip byte-equal; gate (no marker → cues returned `===` unchanged; non-covered component → unchanged); component mismatch, count mismatch, per-pin text mismatch → auto with notes; CardRow text joining; synced rules; split halves (same component) both get the root's times, a half with its own swap is left as swapped; window rules incl. legacy pin and missing anchor (skip + note); start/end/entryAtSec untouched; BulletList invariant (no `itemPins` → no `reveal`).
- [ ] **Step 2: Failing tests (`item-timing-parity.test.ts`):** a pure harness that, for one doc + words + optional veto, computes `itemAtSec` the produce way (resolve on the run map, pre-split, then split) and the editor way (roots from the unsplit list, legacy pins on the old map, resolve on the live map after split + second applyOverrides). Cases from spec Test plan "Parity": no veto; veto cuts a pinned word; veto revives a word an auto item matches; seam at block start revived; revived pause inside a minScene-extended cue; revived entry word; src timing pin resolving only on the live clock; legacy output pin under a veto; split half with own swap. Assert equal `itemAtSec` per cue id.
- [ ] **Step 3:** Run — FAIL.
- [ ] **Step 4:** Implement. If a parity case cannot be made equal under the spec's rules, stop and report NEEDS_CONTEXT with the case.
- [ ] **Step 5:** `pnpm exec vitest run packages/core`, `pnpm typecheck` — PASS.
- [ ] **Step 6:** Commit `feat(core): word-timing overrides resolved on the live clock`.

### Task 4: Produce wiring

**Files:** Modify `apps/cli/src/produce.ts` (one `resolveItemTimings` call right after the first `applyOverrides`, ~`:5470`, on the run's `transcript.words` and map; notes printed one line each, as override orphans are). Tests under `apps/cli/test/` following the added-graphics produce tests (`grep -l addedSceneIssues apps/cli/test`).

**Interfaces — Consumes:** Task 3.

- [ ] **Step 1: Failing tests:** a planner run, a storyboard run and a `--scenes` replay with an override `itemPins` on a covered graphic → render-props `itemAtSec` at the pinned words (and auto items at matched words); an added graphic with the marker → auto items timed; a project without `itemPins` → render-props byte-equal to before; a note printed for a moved pin; `--clip`: with a repair straddling the clip edge, `transcript.words` and the server's `sfxPlan.words` (`apps/cli/src/edit.ts:4161-4182`) have equal length and source starts (if not, stop and report).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(produce): list items land on their pinned and matched words`.

### Task 5: Editor preview wiring and edit actions

**Files:** Modify `apps/editor/src/App.tsx` (build the `roots` map at the first `applyOverrides` ~`:1429` from the unsplit list using `blockWindow` with `pinMap = oldClockMap`, `liveMap = liveRecut?.newMap ?? oldClockMap`; resolve on both exits of `finishOnClock` per spec §4), `apps/editor/src/useEdits.ts` (`patchProps` gains optional `itemPins` and `clearKeys`; `addScene` gains an optional patch for `scenes[newId]`: `itemPins`, `timing`), `apps/editor/src/Inspector.tsx` (reveal select reads the override's own `props.reveal`). Tests in `apps/editor/test/` (useEdits, Inspector, and a pure test of the extracted App helper).

**Interfaces — Consumes:** Task 3. **Produces:** `patchProps(id, props, { timing?, itemPins?, clearKeys? })` one undo step; `addScene({..., scenePatch?: { itemPins?, timing? }})`.

Extract the finishOnClock item step into a pure helper in `apps/editor/src/addedGraphics.ts` (or a new `apps/editor/src/itemTimingPreview.ts`) so it is unit-tested: `previewItemTimings(props, roots, words, liveMap) → props` returning the SAME object when no root has `itemPins` or inputs are null.

- [ ] **Step 1: Failing tests:** helper returns `===` props with no `itemPins`, with null map, with null words; resolves on the early-exit path; Task 3's parity harness gets one case built through this helper; `patchProps` with `itemPins` + `clearKeys` is one undo step and an empty patch is never dispatched by callers (assert via the modal model in Task 6); `addScene` writes the entry and `scenes[newId]` in one commit; Inspector reveal select shows the override value, not a forced `synced`.
- [ ] **Step 2:** Run `pnpm exec vitest run apps/editor/test` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Editor tests + `pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(editor): preview lands list items on their words`.

### Task 6: `graphicEditorModel.ts` (pure)

**Files:** Create `apps/editor/src/graphicEditorModel.ts`, `apps/editor/test/graphicEditorModel.test.ts`. Move `ADD_TYPE_COPY`, `addFormFieldsFor`, `initialAddValues`, `addFormIssue` here from `AddGraphicPopover.tsx` (re-export from the old file until Task 7 deletes it; move their tests from `apps/editor/test/AddGraphicPopover.test.ts`).

**Interfaces — Consumes:** Tasks 2–3 (`resolveItemWords`, `resolveItemTimings`), `revealFrames` from `@ossclip/scenes` for estimates. **Produces:**
```ts
export type ModalRow = { text: string; state: "pinned" | "auto" | "cut" | "unmatched"; word: number | null; estSec: number | null; note: string | null }
export function modalRows(...): ModalRow[]                 // from component, props, itemPins, words, window, live map
export function allowedWords(rows: ModalRow[], picking: number | "start", windowWords: number[]): Set<number>
export function saveFor(opened: ModalState, now: ModalState): null | { props: Record<string, unknown>; clearKeys: string[]; itemPins?: ItemPins; timing?: TimingPin }
export function whenRowPin(word: Word, liveMap: TimeMap, keptSpanStart: number, prevGraphicEndSec: number | null, cueEndSec: number): { srcStart: number; srcEnd: number }
```
Save rules exactly spec §6 (no change → null; marker only after an item change; pinned rows store current text; stale pins kept unless that row changed; mismatch keeps stored pins unless an item changed; only changed fields). `whenRowPin` per spec §5 When row (floors at the kept span start and previous graphic end + `SCENE_GAP_SEC`).

- [ ] **Step 1: Failing tests:** rows for each state with notes; estimates equal `revealFrames` timing; allowed words strictly between neighbouring bounding pins; `saveFor` cases: no change → null; title-only edit → no `itemPins`; pinned text edit keeps pin with new text; delete row splices pins; add row appends null; stale pin untouched when row unchanged; mismatch + no item change → no `itemPins` in patch; `whenRowPin` at a seam lands in the kept span and resolves non-null.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Editor tests + `pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(editor): graphic editor model`.

### Task 7: The modal

**Files:** Create `apps/editor/src/GraphicEditorModal.tsx`; delete `apps/editor/src/AddGraphicPopover.tsx` (and its test file once moved); modify `apps/editor/src/TranscriptPanel.tsx` (Graphic… opens the modal), `apps/editor/src/Inspector.tsx` ("Edit text & timing…" on a selected offered-type graphic; split half opens the root), `apps/editor/src/App.tsx` (mount, second Remotion `<Player>` with a one-cue composition, wiring to `addScene`/`patchProps`). Tests: jsdom in `apps/editor/test/GraphicEditorModal.test.ts`; e2e: update `apps/editor/e2e/added-graphics.spec.ts` (popover test ids) and add `apps/editor/e2e/graphic-editor.spec.ts` (+ Playwright project if the config needs one).

**Interfaces — Consumes:** Tasks 5–6.

Behaviour and look: spec §5 and mockup v3 (states, markers with icons, When row, picking chip, allowed words, Needs text, footer reason, edit mode hides types, Esc rules, focus returns to the box, word strip one tab stop with arrow keys). Keep the editor's visual language (colours in `selectionMenuChrome.tsx`/`StoryboardPanel.tsx`; the mockup's tokens are derived from them).

- [ ] **Step 1: Failing tests (jsdom):** add flow (type, text, pin item 3, Add dispatches one `addScene` with `scenePatch.itemPins`); refusals render in place of the form; edit mode hides types, Save disabled with reason when an item is empty; Cancel and unchanged Save dispatch nothing; picking enables only allowed words; Esc cancels picking then closes; focus returns to the lands-on box.
- [ ] **Step 2: Failing e2e:** add a bullet list over real words, pin item 3, Add → the stage preview shows item 3 entering at its word's time (seek before/after); Save, reload → still pinned; open a planner graphic, Save without changes → `overrides.json` unchanged; edit an auto item's text → its marker moves; the When row writes a timing pin; existing transcript gesture tests still pass.
- [ ] **Step 3:** Run — FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Editor unit tests, the new and updated e2e projects, `--project main` on `interactions.spec.ts`, `pnpm typecheck`, `pnpm test`, `pnpm build` — PASS.
- [ ] **Step 6:** Commit `feat(editor): graphic editor modal for adding and editing graphics`.

### Task 8: FINDINGS and real run (main thread)

- [ ] FINDINGS section: BulletList in the reveal system and its guard; `itemPins`; live-clock resolve; the reversal of reveal-timing §7; older builds strip `itemPins`; the stale `added-scenes.ts:31-33` comment.
- [ ] Real run on a copy of the author's short: the bullet list from the screenshot, edited in the modal; Render; frames at each item's word.
- [ ] Commit `docs: FINDINGS for the graphic editor`.
