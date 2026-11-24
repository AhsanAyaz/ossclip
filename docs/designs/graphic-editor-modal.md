# The graphic editor: items that land on their words

*   **Author:** Muhammad Ahsan Ayaz (drafted with Claude)
*   **Status:** Approved by the author (2026-11-22). Draft 5, revised after five review rounds (round 1: design, code accuracy, build readiness, scope; rounds 2 and 3: design, code accuracy, build readiness; rounds 4 and 5: code accuracy, build readiness). The round-5 finding (legacy timing pins converted on their own clock) is applied. The author confirmed the five calls at the end (2026-11-22). The interaction was approved from mockup v3 (2026-11-22). Changes are listed at the end.
*   **Builds on:** `docs/superpowers/specs/2026-11-04-reveal-timing-design.md` (the reveal-timing system), `docs/designs/editor-added-graphics.md` and FINDINGS §170 (added graphics), FINDINGS §153 (element text edits), §161 (PhoneDemo pills).
*   **Mockup:** `~/ossclip-work/mockups/graphic-modal/index.html` (v3) and its `v3/` screenshots. Local only. The mockup owns the visual details (marker shapes, colours, focus order); this doc owns behaviour and data.

--------------------------------------------------------------------------------

## Overview

A list graphic should bring each item in when the speaker says it. On the author's EGM short, a bullet list over "they hallucinate, they forget the context … they themselves review the code" showed all three bullets within half a second (screenshot, 2026-11-21).

Two causes:

1.  **BulletList is outside the reveal system.** Its items enter on a fixed 7-frame stagger (`packages/scenes/src/components/BulletList.tsx:22`), and `revealItemTexts` has no BulletList case (`packages/core/src/reveal-match.ts:197-239`).
2.  **Nothing after planning sets item timing.** Item times come only from the planner's `scene.cue.itemWords` (`packages/core/src/producer/scene-props.ts:48-64`), matched once at plan time. Editor-added graphics never get one (`packages/core/src/added-scenes.ts:203-213`), and no editor code calls the matcher.

The fix has two parts that ship separately:

*   **Part 1, BulletList joins the reveal system.** New plans time bullet items on their words. Existing projects render unchanged until re-planned.
*   **Part 2, the graphic editor.** A modal, opened to add a graphic (replacing the selection-bar popover) or to edit one, that shows the block's spoken words, the items and a live preview, and lets the author pin each item to a word.

## Terms

*   **Item.** One revealed part of a graphic, as listed by `revealItemTexts(component, props)`. An item's **text** is that entry; for CardRow, whose entry is `[text, sub]` (`reveal-match.ts:226-230`), the text is the two joined with " · ".
*   **Covered components.** BulletList, FlowDiagram, StrikethroughReveal, ChatMock, CardRow. Not TerminalMock (reveals per window; windows are not editable in the modal) and not PhoneDemo (pills are not in the add form, `packages/core/src/scene-props-controls.ts:217`).
*   **Live clock.** The time map the cues are finally on: produce's run map; in the editor, `liveRecut?.newMap ?? oldClockMap` (`apps/editor/src/App.tsx:1613-1631, 1673`).
*   **Word time.** A word's output start on a map, by the planner's own conversion `map.mapWord(w)` (`packages/core/src/timemap.ts:105-114`, used at `packages/core/src/assemble.ts:311-314, 336-344`), extracted as `wordOutputStart(w, map) → number | null` in `assemble.ts` and shared. Null means the word is cut on that map. An item's time is its word time minus `ITEM_LEAD_SEC` (0.15 s, `assemble.ts:77`), floored at 0.
*   **Block window.** A source-seconds span, computed from stored source data only, never from a cue's output times (output limits such as `minScene`, the 15 s cap, gaps and seams differ between clocks, `assemble.ts:172-192, 230`, `timemap.ts:90-99`). In this order:
    1.  the root's timing pin, by form (`overrides.ts:100-118`; `resolveTimingPin` returns output seconds and passes a legacy pin through unchanged, `overrides.ts:1137-1155`):
        *   a **src pin** `{srcStart, srcEnd}`: the window is the stored span, used only when `resolveTimingPin(pin, liveMap)` is non-null (in the editor, `liveMap = liveRecut?.newMap ?? oldClockMap`, read from the raw `edits.doc` inside the preview memo);
        *   a **legacy output pin** `{startSec, endSec}`: its numbers are output seconds on the clock they were written for, so they are converted with that clock's `toSource`: `oldClockMap.toSource` in the editor, the run map in produce (after `remapOverridesThroughRecut`);
    2.  an added graphic: its entry's `[srcStart, srcEnd)`;
    3.  a plan cue: from the source start of `cue.anchor.startWord` to the source end of `cue.anchor.endWord`;
    4.  no anchor: no window; the graphic is skipped with a note.

    Anchor word indices are in the run's transcript list, which is the same list in both pipelines (produce's `transcript.words`, `produce.ts:4072`; the editor's `sfxPlan.words`, `apps/cli/src/edit.ts:4161-4182`), including the `--clip` slice.

    **Block words:** the transcript words whose source start lies in the block window and whose word time on the live clock is not null. **Window words:** all transcript words in the block window, cut or not.
*   **Pinned item.** The author chose its word. Stored.
*   **Auto item.** Its word is found from its text by the matcher on every resolve. Not stored.
*   **Unmatched item.** An item with no word. The renderer places it (`packages/scenes/src/reveal.ts:167-214`): between two matched neighbours, interpolated; before the first match, spread from the block start (forced synced only); after the last match, stepped at the paced gap; with nothing matched, the whole graphic is paced. The mockup calls these "Even".
*   **Word timing on.** The graphic's override carries the `itemPins` marker (section 2).

## Goals

*   **G1.** Every item of a covered graphic can land on a chosen spoken word, in planner, script, storyboard-run and editor-added graphics.
*   **G2.** With word timing on, auto items land on their words without the author doing anything, from the first preview.
*   **G3.** Editing an auto item's text re-finds its word, in the modal preview, the timeline preview and the render.
*   **G4.** Items never enter out of list order.
*   **G5.** The modal previews the block with the graphic before saving.
*   **G6.** One modal for adding and editing.
*   **G7.** Render matches the preview, including under a live cleanup veto.

## Non-goals

*   **NG1.** No dragging item markers on the timeline.
*   **NG2.** No item timing for TerminalMock or PhoneDemo.
*   **NG3.** No reordering of items in the modal (add and delete only).
*   **NG4.** No changes to paced mode's curves or `revealSpeed`; no LLM call.

## Anti-goals

*   **AG1.** A graphic without the `itemPins` marker renders exactly as today, byte-equal in render-props, BulletList included. The one exception: a BulletList whose override carries reveal props (`reveal`, `pacing`, `revealSpeed`, `entrance`, set by the author or carried over by a component swap, `overrides.ts:1086`), which after Part 1 take effect.
*   **AG2.** No item lands on a word outside its block, out of order, or on a word another item holds.
*   **AG3.** No item keeps a time on footage that is gone.

## Approaches

**A. Store a word-timing marker with the author's pins as an override; resolve items on the live clock wherever cues are finished (chosen).** Auto items stay live because they are computed, never stored. Source-second pins survive cuts and the `--clip` slice.

**B. Write `scene.cue.itemWords` through the server.** Rejected: `production.json` is rewritten by every sync run, and word indices shift when it is rewritten from a new transcript. (The comment at `packages/core/src/added-scenes.ts:31-33` saying editor and produce index spaces differ on `--clip` is stale against `apps/cli/src/edit.ts:4178-4182`; to be noted in FINDINGS.)

**C. Store every item's resolved time.** Rejected: an auto item would freeze at its old word when its text changes (G3).

This reverses one decision of the reveal-timing spec (§7, "edits do not re-run the matcher"): with word timing on, the matcher runs every time cues are finished. Graphics without the marker keep the old rule.

## Design

### 1. Part 1: BulletList in the reveal system

*   `revealItemTexts` gains `case "BulletList": return arr(props.items).map(str)`.
*   `BulletListProps` gains `...RevealPropsShape` (no defaults, `packages/core/src/scene-registry.ts:34-39`). An unset `entrance` keeps BulletList's own `rise` (`BulletList.tsx:27`).
*   `BulletList.tsx` takes a `timing` prop (as `FlowDiagram.tsx:126-128`; `SceneLayer` already passes it, `packages/scenes/src/SceneLayer.tsx:287-291`) and its delays from `componentRevealFrames` with legacy step 7 (the same `i*7`, `reveal.ts:120, 146-147`).
*   **Guards that keep AG1:**
    *   `plannedCue` (`assemble.ts:300-347`) emits `reveal` for a BulletList only when `scene.cue.itemWords` is present. Every stored BulletList cue holds `entryWord` only (`scene-props.ts:55-63`).
    *   `withSwappedReveal` (`overrides.ts:1380-1386`) returns a cue swapped to BulletList without `reveal`.
    *   Those are the only two writers of `reveal` (`assemble.ts:241`, `overrides.ts:1385`); every other path spreads or rebuilds it.
*   **Re-planning** (a `produce` run that calls the planner: a fresh run, `--produce` with a cached plan miss, a script run; not a `--scenes` replay or a storyboard sync run) writes `itemWords` for bullet lists, and their items land on their words. That alone fixes the screenshot's project on a re-plan.

### 2. Stored shape (Part 2)

`SceneOverrideSchema` (`packages/core/src/overrides.ts:129+`) gains one optional key, named apart from BulletList's own `props.items`:

```ts
itemPins: z.object({
  component: z.string(),                    // the component the pins were made for
  pins: z.array(z.union([
    z.null(),                               // auto
    z.object({ src: z.number().finite().nonnegative(),  // the chosen word's source start
               text: z.string() }),         // the item's text when pinned (or last saved)
  ])),
}).optional()
```

*   **Present = word timing on**, even with every pin null. Absent = today's behaviour.
*   **When the graphic starts** is not stored here: the modal's When row writes the existing timing pin (section 5).
*   **Older builds** strip the key when they save. Accepted; recorded in FINDINGS.

### 3. Resolving items (core, pure)

**`resolveItemWords(texts, allWords, window, isSpoken, pins) → { items: ({ word: number; state: "pinned" | "auto"; note?: string } | { word: null; state: "cut" | "unmatched"; note?: string })[]; notes: string[] }`** in `packages/core/src/reveal-match.ts`. `allWords` is the whole transcript word list, `window` the block window, `isSpoken(i)` whether word i has a word time on the live clock. Each pin is checked in item order, against these rows in this order; the first that applies wins:

| Order | Case | Result |
|---|---|---|
| 1 | No transcript word whose source start is within 0.05 s of `src` (nearest wins; on a tie, the earlier word) | **auto**, note "its word moved" |
| 2 | The word lies outside the window | **auto**, note "its word is outside this block" |
| 3 | The word is not strictly after the previous bounding pin's word | **auto**, note "out of order" |
| 4 | The word is not spoken on the live clock | **cut**: no time; it still bounds segments by its word; counts as a pin for `synced`; note "its word was cut" |
| 5 | Otherwise | **pinned** on that word |

A **bounding pin** is one in state pinned or cut. Auto items are matched with `locateSpoken` one segment at a time: the items between two bounding pins search only spoken window words strictly between those pins' words. So no item crosses a pin (G4), and no two items share a word.

**`resolveItemTimings(cues, doc, words, map, roots?) → { cues, notes }`** in `packages/core/src/overrides.ts`, list-level because the per-cue override merge (`effectiveOverride`, `overrides.ts:1112`) is private. `roots` is an optional map from root id to `{ component, props, window }`; when absent, these come from the root cue in `cues` (produce, where cues are not split yet). For each root id whose override has `itemPins` and whose root component is covered:

1.  Take the root's merged props (split halves' own text edits do not change item timing).
2.  `texts = revealItemTexts(component, props)`. Each pin becomes null-auto when `itemPins.component !== component`, when `pins.length !== texts.length` (all pins), or when `pins[k].text !== texts[k]` (that pin), with a note. The marker stays, so swapping back restores the pins.
3.  Block words on `map` (the live clock), then `resolveItemWords`.
4.  Every cue with that root id **and the root's component** gets `reveal.itemAtSec[k] = wordOutputStart(word, map) − ITEM_LEAD_SEC` floored at 0, or null. A split half whose own override swapped its component is left as its swap made it (`withSwappedReveal`).
5.  `props.reveal = "synced"` on those cues only when at least one pin is pinned or cut and that cue's own effective override has no `reveal` prop. Otherwise `reveal` is left as is, and the renderer's `syncDecision` decides as today.
6.  Nothing else changes: `startSec`, `endSec` and `entryAtSec` are untouched.

**Precedence:** a bounding pin, then (word timing on) the live match; with word timing off, the planner's stored `itemWords` as today.

### 4. Where it runs

Both pipelines resolve once, on the live clock, against the same words: the repaired transcript words with source start and end (`transcript.words` in produce; `sfxPlan.words` in the editor, `apps/editor/src/addedGraphics.ts:37-40`).

*   **Produce:** the same shape as the editor (build ruling 2026-11-22, Task 3: resolving before the split let a half with its own component swap inherit a `reveal` the editor never gave it). `roots` are built from the unsplit cues after the first `applyOverrides` (`apps/cli/src/produce.ts:5470`) with `itemTimingRoots`, the function the editor uses; the resolve runs after the second `applyOverrides` (`produce.ts:5568`), on the run's map, writing each root's times onto its halves. Later passes leave `reveal` untouched. Reclamp (`produce.ts:5508`) can narrow a pinned cue before the resolve; items timed outside it are clamped by the renderer as today.
*   **Editor preview:** in `finishOnClock`, on both of its exits, so it runs in an ordinary session as well as under a veto:
    *   **Early exit** (`App.tsx:1613-1615`, taken with no veto and no live-only split): return `{...props, sceneCues: resolve(props.sceneCues)}` only when `clockMap` and `sfxPlan.words` are non-null and some root has `itemPins`; otherwise return `props` unchanged, so the byte-identical path (`App.tsx:1609-1611`) holds.
    *   **Main path:** resolve `merged` after its `applyOverrides` (`App.tsx:1631`) and before `withStagePreviews` (`App.tsx:1634`), so a src timing pin that resolves only on the live clock has applied.
    *   Notes join that pass's `reports`. The memo's dependency list (`App.tsx:1678`) already covers `edits.doc`, the clocks and `sfxPlan`. The cues are split by then, so the `roots` map is built from the unsplit list at the first `applyOverrides` (`App.tsx:1429`): each root's component and props there, and its window from stored source data (Terms), which is the same on any clock. Earlier remaps of `itemAtSec` (`packages/core/src/retime-preview.ts:469-474`) are overwritten for these cues; cues without the marker are untouched. The second `applyOverrides` in `finishOnClock` changes only what produce's second pass changes, and the resolve runs after it, as produce's split halves meet the same overrides at `produce.ts:5568`.
*   **When `oldClockMap` or `sfxPlan.words` is null** (`App.tsx:1398, 1613`), the editor pass is skipped; the modal says the preview cannot place items yet.
*   **Kit:** `rebaseCue` keeps `reveal` as `{itemAtSec}` (`packages/core/src/kit-rebase.ts:35`); nothing new to carry.
*   **The modal's preview** runs the same `resolveItemTimings` on the one cue being edited, on the live clock, and renders through the same scene components.
*   **Notes** go to the produce console (one line per note, as override orphans do) and to the modal's item rows. The Inspector's reveal select reads the override's own `props.reveal` (today it reads the live cue, `Inspector.tsx:1594-1597`), so the forced `synced` never looks like the author's choice.

Added graphics reach the same `applyOverrides` step in both pipelines (produce assembles them separately, `produce.ts:5198`), so the same pass covers them.

### 5. The modal

Replaces `AddGraphicPopover.tsx` (its helpers `ADD_TYPE_COPY`, `addFormFieldsFor`, `initialAddValues`, `addFormIssue` move to `apps/editor/src/graphicEditorModel.ts`; tests importing them move too). Interaction as in mockup v3:

*   **Add:** from the selection bar's **Graphic…** (`apps/editor/src/TranscriptPanel.tsx:2469`). `addGraphicCheck`'s refusals (overlap, all words cut) show in the modal in place of the form, as the popover does today (`AddGraphicPopover.tsx:196-206`). The block window is the selection's source span, the span the new entry will store, so the modal, the timeline and produce use the same window.
*   **Edit:** a new Inspector button, **Edit text & timing…**, on a selected graphic of an offered type (plan or added). On a split half it opens the root. The type column is hidden; the button reads **Save**.
*   **Preview:** a second Remotion `<Player>` (the stage uses one, `App.tsx:3125`) with a composition of the one cue over the stage background and captions, limited to the block; play loops.
*   **Spoken words:** the window words with item markers (pinned, auto, unmatched) and the start mark. A cut pin shows its marker on its cut word, struck through, with the row note "its word was cut".
*   **When row:** shows the block's start word. Choosing a word, or **Start with item 1**, writes `scenes[id].timing = {srcStart, srcEnd}` where `srcStart = map.toSource(wordOutputStart(word) − ENTRY_LEAD_SEC)` on the live clock (so it never lands in a cut pause, `overrides.ts:1146-1155`), floored at the start of the kept span the word is in and at the previous graphic's end plus `SCENE_GAP_SEC`, and `srcEnd = map.toSource(cue.endSec)`. A one-time set: it does not follow item 1 later.
*   **Items:** text, a lands-on box (state, word, time; for an unmatched item the reason and the renderer's estimated time), unpin, delete; counts within the component schema's own min and max (`scene-registry.ts:112-113, 127, 131, 168-169, 290-291`). Picking enables only block words strictly between the neighbouring bounding pins.
*   **Offered types without item timing** (TitleCard, StatCard, RuleCard, CtaCard, BugCard, PhoneDemo): fields and the When row only; no `itemPins`.

### 6. Saving

*   **No change, no dispatch.** If nothing differs from what the modal opened with, Save closes without dispatching (`patchProps` would create `scenes[id]` even for an empty patch, `apps/editor/src/useEdits.ts:672-688`).
*   **When the marker is written:** for a covered type, Save writes `itemPins` when the author changed an item's text, a pin, or the item count. A change to other fields only (title, kicker) does not turn word timing on. This holds for plan graphics and for added graphics made before this feature alike. An add of a covered type always writes it, so G2 holds from the first preview.
*   **Pins on save:** every pinned or cut row stores the item's current text, so editing a pinned item's text in the modal keeps its pin. A pin the resolver turned auto (moved, outside, out of order) is kept as stored unless the author changed that row; a row the author edited stores what the modal shows. Deleting or adding a row splices `pins` at the same index (`null` for a new row).
*   **After a component or count mismatch** (all pins auto), Save leaves `itemPins` as stored unless the author changed an item, so swapping back still restores the pins; once the author changes an item, `itemPins` is rewritten for the current component from the modal's rows.
*   **The patch holds only changed fields** (`patchProps` merges the whole patch, `useEdits.ts:681`).
*   **Add:** `addScene` takes an optional patch for `scenes[newId]` (`itemPins`, `timing`), written in the same commit as the entry.
*   **Edit:** `patchProps` (`useEdits.ts:70-81, 672-688`) already bundles props and an optional timing pin into one undo step; it gains optional `itemPins` and `clearKeys` (props to remove, so a cleared field is the same undo step instead of a second `clearProp`, `useEdits.ts:689-699`).

## Edge cases

*   **Inspector text edit at the same count.** A pin whose stored text no longer matches becomes auto with a note.
*   **Pinned word cut later:** state `cut` (no time, still bounds its neighbours) until the word is back; the pin stays stored.
*   **Re-transcribe** shifting word starts by more than 0.05 s: the pin becomes auto with a note.
*   **Component swap** to another covered component: all pins auto (component mismatch); the marker stays; swapping back restores them. A swap to BulletList without the marker stays legacy (section 1).
*   **Timing pin on the block:** the block window follows the pin (src or legacy output pin, Terms rule 1); pins outside it become auto with a note.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Existing renders change (AG1) | Part 1's two guards; byte-equal fixtures (stored BulletList; FlowDiagram swapped to BulletList; a project with overrides and no `itemPins`). |
| Preview and render disagree (G7) | One resolver, one clock (live), one word list, one window rule; a pure parity test (below). |
| Stale pins land on the wrong item | Component, count and per-pin text checks; mismatch → auto with a note. |
| Matcher cost on every preview | Runs only for roots with the marker, over the block words (tens); cache by (root id, texts, pins, map identity). |
| Older build drops the marker | Accepted; FINDINGS. |

## Files

*   **Part 1:** `packages/core/src/reveal-match.ts` (BulletList case), `packages/core/src/scene-registry.ts` (`RevealPropsShape` on BulletList), `packages/core/src/assemble.ts` (BulletList guard in `plannedCue`; `wordOutputStart` extracted), `packages/core/src/overrides.ts` (`withSwappedReveal` guard), `packages/scenes/src/components/BulletList.tsx`. Tests in `packages/core/test/` and `packages/scenes/test/`.
*   **Part 2 core:** `packages/core/src/reveal-match.ts` (`resolveItemWords`), `packages/core/src/overrides.ts` (`itemPins`, `resolveItemTimings`), `packages/core/src/browser.ts` (exports), `apps/cli/src/produce.ts` (one call).
*   **Part 2 editor:** `apps/editor/src/App.tsx` (the `roots` map at `:1429`, the resolve in `finishOnClock`; opening the modal), `apps/editor/src/GraphicEditorModal.tsx` and `apps/editor/src/graphicEditorModel.ts` (new), `AddGraphicPopover.tsx` (removed), `TranscriptPanel.tsx`, `Inspector.tsx` (button; reveal select reads the override), `useEdits.ts`. Tests that move or change: `apps/editor/test/AddGraphicPopover.test.ts`, `apps/editor/e2e/added-graphics.spec.ts` (popover test ids).
*   `docs/PHASE1-FINDINGS.md`: new section.

## Test plan

*   **AG1 fixtures:** a stored `{entryWord}`-only BulletList → render-props byte-equal before and after Part 1; a FlowDiagram swapped to BulletList stays legacy; a project with overrides but no `itemPins` → byte-equal after Part 2; an old `overrides.json` round-trips unchanged.
*   **Part 1:** a BulletList scene with `itemWords` → `itemAtSec` at those words minus 0.15 s; the renderer enters bullets on those frames; legacy keeps `i*7`.
*   **`resolveItemWords`:** each row of the pin table; auto only between bounding pins; no shared word.
*   **`resolveItemTimings`:** gate and per-pin mismatches; `synced` only with a bounding pin and no `reveal` in the cue's own effective override; every split half gets the root's times; `startSec`/`endSec`/`entryAtSec` untouched.
*   **Parity (pure):** for one doc, words and veto, `resolveItemTimings` on produce's cue list and on the editor's (roots from the unsplit list, resolve on the live clock) give equal `itemAtSec`: no veto; a veto cutting a pinned word (null in both); a veto reviving a word an auto item matches; a seam at the block start that the veto revives; a revived pause inside a `minScene`-extended cue; a revived entry word; a src timing pin that resolves only on the live clock; a legacy output timing pin under a veto; a split half with its own component swap (left as swapped in both).
*   **Invariant:** a BulletList with neither `itemWords` nor `itemPins` has no `reveal` after both pipelines.
*   **Editor, no veto:** the ordinary preview (early exit of `finishOnClock`) resolves items; a project with no `itemPins` returns the props object unchanged.
*   **`--clip` index space:** with a repair straddling the clip edge, produce's `transcript.words` and the server's `sfxPlan.words` have equal length and equal source starts. If they can differ, rule 3 matches anchor words by source seconds instead of index.
*   **Live:** G2 before the first Render: a new added list's auto items are timed in the preview.
*   **When row:** at a seam, the timing pin is not inert and starts in the kept span.
*   **Editor model:** allowed words; estimates equal `revealFrames`; the Save patch for add, edit, no change (no dispatch), a pinned item's text edit (pin kept, text updated), item delete (pins spliced), title-only edit (no marker).
*   **Produce:** pins honoured in a planner run, a storyboard run and a `--scenes` replay; an added graphic with the marker lands auto items on words.
*   **e2e:** add a bullet list, pin item 3, Add: the preview shows item 3 at its word; Save, reload; open a planner graphic, Save without changes: doc unchanged; edit an auto item's text: its marker moves; the When row writes a timing pin.

## Phasing

1.  Part 1 (BulletList). Its own commits and review; shippable alone.
2.  Part 2 core: `itemPins`, `resolveItemWords`, `resolveItemTimings`, `wordOutputStart`, produce call. Tests, parity test.
3.  Editor preview wiring; `addScene`/`patchProps` extensions. Tests.
4.  The modal (add and edit), popover removed, Inspector button. jsdom tests and e2e.
5.  FINDINGS section; a real run on the author's short.

## Calls made in this draft (author to confirm)

1.  The When row writes the existing timing pin; "Start with item 1" is a one-time set.
2.  Auto-only graphics keep the renderer's own synced/paced decision; only a pin forces synced.
3.  Saving turns word timing on only after an item change; a no-change Save dispatches nothing.
4.  TerminalMock and PhoneDemo stay out of item timing.
5.  Split halves share their root's item times; a half's own text edit does not re-time items.

## Changes from draft 4

*   The editor resolves on both exits of `finishOnClock` (round 4 B1).
*   Legacy output timing pins set the window too; rule 1 computed on the live clock against the raw doc (S1, S2).
*   "Bounding pin" throughout; cut pins have a marker (S3).
*   `--clip` index-space test (S4); Approach B's reason and a stale comment noted; leftover Phasing text removed (S5).

## Changes from draft 3

*   Block window defined from stored source data (timing pin, added entry, anchor words), never from output times, so it is the same on every clock (round 3 B1); the editor resolves after `finishOnClock`'s `applyOverrides`, with a `roots` map from the unsplit list.
*   Item times written only to cues with the root's component; a half's own swap stays as swapped (B2).
*   `resolveItemWords` takes all words, the window and a spoken test, and returns per-item state; `resolveItemTimings` takes `roots` (B3).
*   Pin table ordered, with "bounding pins", a tie-break and cut pins bounding segments (S1); save rules for stale pins, mismatches and partial patches (S2); `synced` tested per cue, Inspector reads the override (S3); null clock skip (S4); `entrance` in AG1, PhoneDemo item-less (S5); the Inspector splicing bullet dropped, moved tests listed (S6); citation fixed.

## Changes from draft 2

*   Resolve on the live clock in both pipelines; the editor resolves in `finishOnClock` with each root's block window taken from the unsplit cue; `itemSrc` dropped (round 2 B1, B2, M1, M2).
*   One gate (`itemPins` present and component covered); mismatches become auto inside the resolver (B3).
*   `withSwappedReveal` returns a BulletList without `reveal`; AG1 narrowed to exclude author-set reveal props (B4).
*   A pin table separates "cut" (unmatched) from "moved" and "outside" (auto) (B5).
*   Save refreshes pinned rows' text (B6); When-row pin computed on the live clock, floored at the kept span and the previous graphic (S1); block window and block words defined (S2); save rules for no-change, title-only edits, old added graphics, Inspector splicing, `clearKeys` (S3); list-level `resolveItemTimings` and exact call sites (S4); CardRow item text (S5); word lists named, null case (S6); tests added (S7).
*   Override key renamed `itemPins` (M3); "neighbouring bounding pins" (M4); re-plan commands listed (M5); where notes appear (M6); reclamp sentence (M7); citations (M8).

## Changes from draft 1

*   BulletList's planner guard keeps existing renders unchanged; Part 1 ships alone.
*   An explicit marker decides word timing.
*   No new `start` field: the When row writes the timing pin, and the resolver never moves the start.
*   Word times via the planner's `mapWord` conversion; pins carry component and text; precedence and the spec reversal stated; synced only with a pin; matching rules; covered components; existing actions extended; Risks section and concrete tests.
