# Adding a template graphic from the editor

*   **Author:** Muhammad Ahsan Ayaz (drafted with Claude)
*   **Status:** Approved by the author (2026-11-21). Draft 3, revised after two review rounds (round 1: design, code accuracy, build readiness, scope, readability; round 2: design, code accuracy, build readiness). Changes are listed at the end.
*   **Builds on:** `docs/PHASE1-FINDINGS.md` §137 (anchored override remap), §153 (derived Inspector controls, element text edits), §158 (script cues, ClipScene), §161 (script-only cards in every swap menu), §168 (storyboard plan table); `storyboard-drawn-scenes.md` (a storyboard run plans no template graphics)

--------------------------------------------------------------------------------

## Overview

A graphic block reaches a video today in one of three ways: the beat-sheet planner, script cues (`--script`), or an approved storyboard shot. The editor can edit, retime, swap, hide and restore a block that already exists. It cannot make a new one.

This matters most in a storyboard project. A storyboard run makes no beat-sheet, script-plan or scene-props call (`apps/cli/src/produce.ts:4263-4310`), so its only graphics are the drawn shots. The author's 2026-11-21 run had four planned shots and no template graphics. A title card over the opening line could only be added by re-running `produce` in another mode.

This design adds one gesture: select words in the transcript, pick a graphic type, fill in its text, and a block appears over those words. It previews at once, is undoable, and goes into the final render.

## Terms

*   **Template graphic.** A registered, parametric scene component in `SCENE_REGISTRY` (`packages/core/src/scene-registry.ts:508-659`), for example `TitleCard` or `BulletList`.
*   **Added graphic.** A template graphic the author created in the editor, stored in `overrides.json`.
*   **Plan graphic.** A graphic that came from a produce run (planner, script, storyboard).
*   **Scene / cue.** A `Scene` is word-anchored (`anchor: {startWord, endWord}`, `packages/core/src/scene-schema.ts:90-140`). Assembly turns it into a `SceneCue` with output seconds.
*   **Assembly.** `assembleScenes` (`packages/core/src/assemble.ts:111`): starts each scene at its first kept word, applies the minimum and maximum duration, pushes a scene past an overlap, drops one whose words are all cut.
*   **Base cues.** `render-props.json` `baseSceneCues`: the cues produce wrote before the author's overrides. The editor merges `overrides.json` onto them for the live preview (`apps/editor/src/App.tsx:1357-1406`).
*   **Sync run.** The no-render produce run the editor starts after a storyboard approve (`storyboardSyncArgs`), which rewrites `production.json` and `render-props.json`.
*   **Render replay.** The editor's Render: produce re-run with `--scenes` and no LLM call (`apps/cli/src/edit.ts:2303-2354`).
*   **Timing pin.** `scenes[id].timing` in `overrides.json`, written by a timeline drag; applied to cues that are not `pinned` (`packages/core/src/overrides.ts:1221`).
*   **Plain take.** The talking-head cue that fills a gap between graphics (`kind: "plain"`, id `take-…`, `packages/core/src/fill.ts`).

## Goals

*   **G1.** From a transcript selection, the author adds a template graphic in two or three clicks.
*   **G2.** The author types the graphic's main text in the same step, so it never shows a placeholder (`"TITLE"`, `"FIRST"`).
*   **G3.** The block previews immediately, with no produce run and no LLM call.
*   **G4.** Undo, redo, save and dirty state cover the add.
*   **G5.** After it is added, it is an ordinary block: the Inspector edits it, the timeline retimes it, the swap menu changes its type, Delete removes it.
*   **G6.** Render includes it, in every kind of project (planner, script, storyboard), and it survives every sync run.

## Non-goals

*   **NG1.** No LLM help to fill in the text.
*   **NG2.** No drawn (storyboard) shot from this gesture. "Add shot from selection" already does that.
*   **NG3.** No new graphic types.
*   **NG4.** No editing of optional or styling props in the add form. The Inspector edits them afterwards.
*   **NG5.** No right-click entry point in this version. The word menu stores output seconds, not a word (`apps/editor/src/TranscriptPanel.tsx:528`), and exists only when `onAddOverlayAt` is passed.

## Anti-goals

*   **AG1.** An added graphic is never lost by a sync run, a Render or a re-plan.
*   **AG2.** The add gesture never covers or moves another block. An overlapping selection is refused at add time, with the reason.
*   **AG3.** One bad added graphic never breaks the project. A stale entry is skipped, reported, and removable; every other edit and the render still work.

## Approaches

**A. Store in `overrides.json`, inject cues after assembly.** Draft 1's choice. The review showed it re-implements part of assembly (drop threshold, gap, output cap, landscape remap), has no safe insertion point (before routing it is baked into base cues and doubled by the editor; after routing it skips the landscape fix), and needs `pinned`, which blocks retiming.

**B. Write into `production.json` through a server endpoint.** Rejected: a sync run rewrites `production.json` from the storyboard, so the graphic would be lost (AG1).

**C. A storyboard row with a template type.** Rejected: nothing previews until Approve and a sync run (G3), and it only works in storyboard projects (G6).

**D. Store in `overrides.json`, convert to `Scene`s before assembly (chosen).** Produce reads the entries and appends them to the scene list before `assembleScenes`, exactly as a storyboard run appends `approvedClipScenes` (`produce.ts:4303-4309`, `packages/core/src/storyboard/approval.ts:56-66`). Assembly, routing, the landscape remap, the plain-take fill and the override pass all treat them as any scene. Because produce reads them on every run, nothing can drop them (AG1). The only new client logic is the preview of an add made since the last run (section 4).

## Design

### 1. Stored shape

`OverrideDocSchema` (`overrides.ts:615`) gains an optional key, loose on purpose (AG3):

```ts
addedScenes: z.array(AddedSceneSchema).optional()

AddedSceneSchema = z.object({
  id: z.string(),                          // "added-<n>", minted by the reducer
  component: z.string(),                   // validated at conversion, not here
  props: z.record(z.string(), z.unknown()),
  srcStart: z.number().finite().nonnegative(),
  srcEnd: z.number().finite().nonnegative(),
})
```

*   No enum, regex or refine in the doc schema. A removed component, a bad id or an inverted span must not make `overrides.json` fail to parse, because every reader parses the whole doc (`produce.ts:720-726`, `edit.ts:1253`, `edit.ts:1797`, `edit.ts:2405`, `apps/cli/src/storyboard/draw-project.ts:77`). Each entry is validated in `addedSceneToScene` (section 2) and skipped there.
*   `.optional()`, with a `withAddedScenes(doc, list)` helper that deletes the key when the list is empty, as `withSfx` and `withOverlays` do (`useEdits.ts:454-462`, `510-532`). An untouched project's file does not change.
*   The span is in **source seconds**: `srcStart` is the first selected word's `srcStart`; `srcEnd` is the last selected word's `srcStart + (end − start)`, its spoken length added to its source start. Caption words carry no `srcEnd` (`packages/core/src/captions.ts:66-71`). The transcript panel computes this already (`TranscriptPanel.tsx:363-365`); extract that into a shared helper rather than copy it. A selection with an anchorless word is refused, with the panel's existing reason.
*   The entry is written once and never changed. Every later edit lives in `scenes[id]` like for any block: props, `component` (swap through `patchComponent`, `useEdits.ts:164`, `967`, `1844`), timing, hidden, video, pip.
*   **The id** is minted in the reducer, following the `addOverlay` case (`useEdits.ts:1639-1658`): `added-<n>` with `n` one past the highest number used by any of (a) `doc.addedScenes` ids, (b) root keys of `doc.scenes` (the part before `@` or `#`), (c) `baseSceneCues` ids. The reducer gets (c) as an argument, so a deleted id that a past run baked into base cues is never reused (a reused id would preview the old cue).
*   **Older builds.** A plain `z.object` strips unknown keys, and produce writes `overrides.json` (`produce.ts:7230-7289`). A build without this feature would delete `addedScenes` on its next run. Accepted: ossclip runs from one checkout, and the FINDINGS entry records it.

### 2. Conversion (core, pure)

`addedSceneToScene(entry, words) → { scene } | { skipped: string }` in a new `packages/core/src/added-scenes.ts`, exported through `browser.ts`:

1.  `component` must be in `ScriptComponentIdSchema` (`scene-schema.ts:62`); else skipped ("graphic type X no longer exists"). `ScreenshotFrame` is skipped with its own reason ("cannot be added in the editor").
2.  `SCENE_REGISTRY[component].propsSchema.safeParse(props)` must succeed; else skipped with the first issue's message. (`resolveSceneProps`, `scene-registry.ts:750-758`, returns only null and loses the reason.)
3.  `srcEnd > srcStart`; else skipped.
4.  The anchor is the words of the given list whose source start lies in `[srcStart, srcEnd)`: first and last index. None found: skipped ("its words are no longer in the transcript"). The index space is the caller's list: produce passes `transcript.words` as it stands at the insertion point (on a `--clip` project, the clip's slice, `produce.ts:4066`); the editor passes its full repaired list (`App.tsx:340-349`). The editor's anchor is display-only; only produce's anchor reaches the render.
5.  Returns `{ id, anchor, layout: SCENE_REGISTRY[component].defaultLayout, component, props, overrides: {}, rationale: "added in the editor" }`.

Cut words are not checked here. Assembly already starts a scene at its first kept word and drops it when every word is cut (`assemble.ts`); a dropped added graphic is reported like any dropped scene.

**Produce** (`produce.ts`), in every run kind (planner, script, storyboard, and the `--scenes` replay at `:4103-4120`):

1.  **The doc is the only source.** First remove every scene whose id starts with `added-` from `scenes`, whatever put it there. The replay parses `scenes-reviewed.json`, which is written from `production.json` (`edit.ts:2310-2324`, `render-replay-args.ts:110-114`), and `production.json` holds every scene of the last run (`produce.ts:6173`). Without this step a deleted or undone graphic would come back on the next Render.
2.  **Then append** the converted entries of `overrideDoc.addedScenes`.
3.  **Where:** after the transcript rewrites (`:4891`, `:4904`) and before the landscape remap and variety pass (`:4913-4990`). So the anchors index the final transcript, and the landscape remap applies to added graphics as to any scene.
4.  **Variety pass:** skip `added-` scenes, as it skips `graphicRect` scenes (`:4974`). Otherwise an added graphic would change its neighbours' layouts (AG2), and its preview layout would differ from the next run's.
5.  **Other passes that read `scenes`:** the grounding post-check (`:5481-5497`) and `cueOutcomes` (`:5121`) filter out `added-` ids. The grounding check compares text with the transcript; an added graphic's text is the author's.

**Issues.** Produce writes `addedSceneIssues: [{ id, reason }]` into `render-props.json` for every entry that conversion skipped or assembly dropped (assembly's drops only reach the console today, `produce.ts:5108`), and prints one line each. The editor reads this list (sections 4 and 7). An empty list is omitted.

**Invariant:** after any produce run, `baseSceneCues` holds a cue for every entry not in `addedSceneIssues`, and no `added-` cue whose entry is gone. Tested, including after a replay.

### 3. Remap guard (§137)

At save, `stampSceneAnchors` stamps a word anchor on every `scenes[id]` entry (`apps/editor/src/useEdits.ts:1759`), and `remapSceneOverrides` (`produce.ts:5148`, `overrides.ts:1624-1666`) moves an entry whose id is missing to a plan cue on the same words. For added graphics:

*   **Which keys.** A key is an added key when its root starts with `added-`. The root: strip a trailing `#orphaned`, then take the part before `@`.
*   **Never moved away.** An added key stays where it is when its cue is missing (the entry was skipped or dropped; its edits wait for it), and when its cue exists but no longer overlaps its stamped words (the case the current code parks, `overrides.ts:1643-1653`).
*   **Never a target.** `added-` cues are left out of the `anchored` candidates (`overrides.ts:1594`), so another id's orphaned edits can never land on an added graphic.
*   Tests for all three cases.

### 4. Editor preview

The editor builds the preview from base cues plus the doc (`App.tsx:1365-1414`). Two new rules, in one pure function `previewAddedScenes(baseCues, addedScenes, issues, words, clock)`, run before the existing override merge:

1.  **Drop** a base cue with an `added-` id that has no entry in the doc. This is an undone or deleted add whose cue a past run baked in.
2.  **Add** an entry that has no base cue and is not in `addedSceneIssues` (so: added since the last run). Convert with `addedSceneToScene`, then time it by calling `assembleScenes([scene], transcript, clock)` on that one scene. AG2 guarantees no overlap with the rest, so a one-scene assembly gives the same window a full run would; no extraction from `assemble.ts` is needed. The clock is the one the preview already uses for words (`oldClockMap`, `App.tsx:1362-1375`); when that is null the add previews only after the next run, and the popover says so.

An entry in `addedSceneIssues` is not previewed; it is listed (section 7).

The client never pushes other blocks. The add gesture refused overlaps (AG2), so the preview needs no push. If a later run's assembly moves the block (a new storyboard shot over the same words), that is assembly's ordinary push, reported in `report.txt` like any other.

### 5. The add gesture

*   **Entry point.** The transcript selection bar (`TranscriptPanel.tsx`, the `transcript-selection-menu` element) gains **Graphic…** between Timing and Delete/Restore.
*   **Overlap check first.** Before the type list opens, the span's window is computed the way rule 2 of section 4 does (a one-scene assembly, so the duration floor is included), padded by `SCENE_GAP_SEC` on both sides, and checked against the cues the author sees (the live preview list: overrides applied, hidden cues dropped, pins applied) with one exported function `graphicOverlap(cues, startSec, endSec)`. Padding with the gap means a short add extended to the floor can never trim the next block (`assemble.ts:213`). A hit is refused in the popover: "These words overlap the graphic ‘TitleCard’ at 0:12. Trim that block or pick other words." Plain takes do not count.
*   **Step 1, type.** A list of the types offered, each with a plain name and one line on what it shows. The selected words are shown on top.
*   **Step 2, text.** A short form from a new pure function `addFormFields(component)` next to `scalarPropControls` (`packages/core/src/scene-props-controls.ts`). That function keeps skipping strings and arrays on purpose (`:136-138`); this one covers only the add form. Per type:

| Type | Fields in the add form |
|---|---|
| TitleCard | title |
| StatCard | value, label |
| RuleCard | kicker, text |
| StrikethroughReveal | lines (1–4), each a text |
| BulletList | items (2–5) |
| FlowDiagram | nodes (2–5) |
| ChatMock | messages (1–4), each a text and who sends it |
| CardRow | cards (2–4), each a text |
| CtaCard | action (choice), text |
| BugCard | number, headline |
| PhoneDemo | caption words (1–6) |

    `TerminalMock` (nested windows of lines) and `ScreenshotFrame` (needs an image) are not offered in this version. The table is data in `addFormFields`, tested against each schema: every listed field exists, and the form's output plus defaults parses.

*   **Prefill.** The first string field of the form is prefilled with the selected words when they fit its maximum length. Array fields start empty.
*   **Add.** Disabled until `resolveSceneProps` parses the form's output. Pressing it dispatches `addScene` (section 6), then App selects the new block (the reducer holds no selection, `useEdits.ts:427-434`). A span longer than `MAX_SCENE_SEC` (15 s) adds with a note: "Shown for the first 15 s of these words."

### 6. Reducer actions

In `apps/editor/src/useEdits.ts`, following the `addOverlay` case (`:1639-1658`):

*   `addScene: { component, props, srcStart, srcEnd, baseIds }`. The reducer mints the id (section 1, using `baseIds`) and appends via `withAddedScenes`. One undo step. The action creator returns the minted id so App can select the block.
*   `removeAddedScene: { id }`. Removes the entry and every `scenes` key whose root is that id (`id`, `id@…`, and their `#orphaned` variants). One undo step. Splits are left alone: a split is a time point, not tied to an id (`SplitSchema`, `overrides.ts:353-398`), exactly as Delete on a plan graphic leaves them.
*   **Delete in the Inspector.** On the root `added-` block, Delete calls `removeAddedScene`. On a split half (`added-…@…`), Delete hides that half, as for a plan graphic.

### 7. Skipped entries

A skipped or dropped added graphic has no block to select. So the Inspector's no-selection view lists them: "2 added graphics are not shown", each with its reason and a **Remove** button (`removeAddedScene`). The list is `render-props.json` `addedSceneIssues` (section 2), plus entries added since the last run that `addedSceneToScene` skips in the editor.

### 8. Render and Kit

Render (the replay) runs produce, which converts the entries (section 2), so the final MP4 includes them. A Render that re-plans also runs produce, so the same holds. Kit reads `render-props.json` `sceneCues` (`apps/cli/src/kit.ts:125-126,480`), so an added graphic reaches Kit after the next run, like any edit.

### Known limit: take ids

Adding a graphic splits a plain take, and takes are numbered per clip (`fill.ts:19-21`), so a framing edit on a later take of the same clip can move to a neighbour. This already happens when a storyboard approve adds a shot. Recorded in FINDINGS; not fixed here.

## Files

*   New: `packages/core/src/added-scenes.ts` (`AddedSceneSchema`, `withAddedScenes`, `addedSceneToScene`, `previewAddedScenes`, `graphicOverlap`, `isAddedKey`, the span-end helper), test `packages/core/test/added-scenes.test.ts`.
*   `packages/core/src/overrides.ts`: the doc key; the §137 remap guard.
*   `packages/core/src/scene-props-controls.ts`: `addFormFields`.
*   `packages/core/src/browser.ts`: exports.
*   `apps/cli/src/produce.ts`: drop and append; variety-pass, grounding and outcome filters; `addedSceneIssues`.
*   `apps/cli/src/render-props.ts` (or wherever render-props is shaped): the `addedSceneIssues` field.
*   `apps/editor/src/useEdits.ts`: `addScene`, `removeAddedScene`, the id mint.
*   `apps/editor/src/App.tsx`: preview rules; select after add.
*   `apps/editor/src/TranscriptPanel.tsx`: Graphic… and the popover (new component file if it grows past ~200 lines); span-end helper moved to core.
*   `apps/editor/src/Inspector.tsx`: Delete routing for added blocks; skipped list.
*   `docs/PHASE1-FINDINGS.md`: new section.

## Test plan

*   Unit (core): conversion skips for each reason; anchor from span; `withAddedScenes` drops empty; remap guard, three cases; `previewAddedScenes` drop and add rules, and an entry in issues not previewed; `graphicOverlap` with the gap padding and the floor; `addFormFields` table against every schema.
*   Produce: an entry becomes a cue in every run kind; a render replay does not double it; an entry removed from the doc is gone after a replay; a sync run after a storyboard approve keeps it; a bad entry is skipped into `addedSceneIssues` and the run succeeds; the variety pass leaves neighbours' layouts unchanged; on a `--clip` project the anchor indexes the clip's words.
*   Editor unit: `addScene` and `removeAddedScene` with undo; the mint skips ids in base cues; undo an add after a run baked it (the preview drops it); remove an entry and re-add on the same words before a run (new id, new cue); Delete on the root removes it, on a split half hides it.
*   e2e: select words, Graphic…, TitleCard, type a title, Add: block on the timeline and in the preview; undo removes it; overlap refused; save, reload, still there; skipped entry listed and removable.

## Phasing

1.  Core: schema, conversion, remap guard, `graphicOverlap`, `addFormFields`, span-end helper. Tests.
2.  Produce: drop and append, pass filters, `addedSceneIssues`. Tests.
3.  Editor: reducer, preview rules, Delete, skipped list. Tests.
4.  Editor: the gesture (bar button, popover, form). e2e.
5.  FINDINGS section; a real run on the author's project.

## Changes from draft 2

*   Produce drops every `added-` scene, then appends from the doc, so a deleted graphic cannot come back through the Render replay (round 2, B1).
*   Exact insertion point (after the transcript rewrites, before the landscape remap); variety pass, grounding check and outcomes skip added scenes (B2, S4).
*   Delete leaves splits alone; Delete on a split half hides it (B3).
*   Id minted in the reducer, never reusing an id from the doc or the base cues (B4).
*   Produce writes `addedSceneIssues`; the preview skips those and the Inspector lists them (B5).
*   The preview times an add with a one-scene `assembleScenes` instead of an extracted `sceneWindow`; the overlap check pads by `SCENE_GAP_SEC` (S1).
*   Word index spaces named; remap guard spelled out; citations corrected (S2, S3, minor).

## Changes from draft 1

*   Approach D replaces A: entries become `Scene`s before assembly, so there is no `pinned` flag (B1), no ambiguous insertion point or double render (B2), and no partial re-implementation of assembly.
*   §137 remap guard for `added-` keys (B3).
*   Doc schema loosened; validation per entry at conversion (B4).
*   One overlap function, used only at add time on the visible list; later drift is assembly's ordinary push (B5).
*   Skipped entries listed and removable; report lines (B6).
*   Back-compat stated truthfully; `.optional()` with a helper; span end derived from the transcript; swap goes through `scenes[id].component`; Delete removes splits; take-id limit recorded; per-type field table; right-click entry dropped; terms, files, tests and phasing added.
