# Editor-added template graphics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The author selects transcript words, picks a template graphic type, types its text, and a graphic block appears over those words, previews at once, undoes, and renders.

**Architecture:** Added graphics live in `overrides.json` `addedScenes` (loose schema). Produce drops every `added-` scene and appends fresh `Scene`s converted from the doc before the landscape remap, so assembly, routing, fill and overrides treat them like any scene. The editor previews adds made since the last run with a one-scene `assembleScenes`, drops baked cues whose entry is gone, and lists entries produce reported in `render-props.json` `addedSceneIssues`.

**Tech Stack:** TypeScript, zod v4, vitest, React (editor), Playwright e2e, Remotion.

**Spec:** `docs/designs/editor-added-graphics.md` (approved 2026-11-21, draft 3). Read it in full before any task; section numbers below refer to it.

## Global Constraints

- Values from the user are parsed with zod, never coerced (CLAUDE.md).
- Pure logic separate from I/O; every new core function is pure and exported through `packages/core/src/browser.ts` when the editor uses it.
- Comments explain why and cite the design (`editor-added-graphics §2`) or FINDINGS sections (§137, §153).
- Id prefix is exactly `added-`; key root = strip trailing `#orphaned`, then the part before `@`.
- `addedScenes` is `.optional()`; an empty list deletes the key (no file change on untouched projects).
- Offered types: `TitleCard, StatCard, RuleCard, StrikethroughReveal, BulletList, FlowDiagram, ChatMock, CardRow, CtaCard, BugCard, PhoneDemo`. Not offered: `TerminalMock`, `ScreenshotFrame`, `ClipScene`.
- Conversion accepts any id in `ScriptComponentIdSchema` except `ScreenshotFrame` (an entry swapped to TerminalMock later still renders).
- Overlap refusal copy: `These words overlap the graphic ‘<component>’ at <m:ss>. Trim that block or pick other words.`
- 15 s note copy: `Shown for the first 15 s of these words.`
- Skipped-list heading: `<n> added graphic(s) are not shown` (singular "graphic is" for 1).
- Machine: 7 GB RAM, one heavy command at a time. Editor unit tests run from repo root: `pnpm exec vitest run apps/editor/test` (never `pnpm --filter @ossclip/editor exec vitest`).
- Never push. One local commit per task.

## Review Focus

1. **Render after delete/undo:** a graphic deleted (or an add undone) after a run baked it must be gone from the preview AND the next Render. Test in Task 4 (replay) and Task 5 (preview).
2. **Undo an add, re-add on the same words before a run:** must get a new id and a fresh cue, never the old baked look. Test in Task 5.
3. **Storyboard approve after an add:** the sync run must keep the added graphic, and an approved shot over the same words is pushed by assembly, not lost. Test in Task 4.
4. **A stale entry** (component renamed, props invalid) must not break save, produce, or other edits; it shows in the skipped list with Remove. Tests in Tasks 1, 4, 5.
5. **Transcript gestures unchanged:** drag-select, shift-extend, double-click retype, Esc/✕ clear, seek on click still work with the new Graphic… button. e2e in Task 6.

---

### Task 1: Core module `added-scenes.ts`

**Files:**
- Create: `packages/core/src/added-scenes.ts`, `packages/core/test/added-scenes.test.ts`
- Modify: `packages/core/src/overrides.ts` (`OverrideDocSchema` ~:615 gains `addedScenes: z.array(AddedSceneSchema).optional()`), `packages/core/src/browser.ts` (exports)
- Modify: `apps/editor/src/TranscriptPanel.tsx:363-365` (use the extracted span-end helper)

**Interfaces — Produces:**
```ts
export const AddedSceneSchema: z.ZodObject<...>   // spec §1, exact fields; no enum/regex/refine
export type AddedScene = z.infer<typeof AddedSceneSchema>
export const ADDED_ID_PREFIX = "added-"
export function sceneKeyRoot(key: string): string            // strip "#orphaned", take part before "@"
export function isAddedKey(key: string): boolean            // sceneKeyRoot(key).startsWith(ADDED_ID_PREFIX)
export function withAddedScenes(doc: OverrideDoc, list: AddedScene[]): OverrideDoc  // empty list deletes key
export function nextAddedId(taken: Iterable<string>): string // "added-<n>", n = 1 + max n among taken roots matching /^added-(\d+)$/, else 1
export function wordSrcEnd(w: { srcStart: number; start: number; end: number }): number // srcStart + (end - start)
export type AddedConversion = { scene: Scene } | { skipped: string }
export function addedSceneToScene(entry: AddedScene, words: readonly { srcStart: number }[]): AddedConversion // spec §2 steps 1-5
export function graphicOverlap(cues: readonly SceneCue[], startSec: number, endSec: number): SceneCue | null // ignores kind:"plain"; pads by SCENE_GAP_SEC
export function previewAddedScenes(args: {
  baseCues: readonly SceneCue[]; added: readonly AddedScene[]; issueIds: ReadonlySet<string>;
  transcript: Transcript; map: TimeMap;
}): { cues: SceneCue[]; skipped: { id: string; reason: string }[] }  // spec §4 rules 1-2; one-scene assembleScenes per new entry
```
`ADDED_OFFERED` (readonly array of the 11 offered ids) also lives here.

- [ ] **Step 1: Write failing tests** in `added-scenes.test.ts`:
  - schema: an entry with `component: "Gone"` and `srcEnd < srcStart` still parses inside a full `OverrideDocSchema` doc; a doc without the key parses and has `addedScenes === undefined`.
  - `withAddedScenes(doc, [])` removes the key; non-empty sets it.
  - `sceneKeyRoot("added-3@12.5#orphaned") === "added-3"`; `isAddedKey("scene-2") === false`.
  - `nextAddedId(["added-2", "added-10@4", "scene-1"]) === "added-11"`; `nextAddedId([]) === "added-1"`.
  - `addedSceneToScene`: skipped with reason for unknown component, for `ScreenshotFrame`, for invalid props (reason = first zod issue message), for `srcEnd <= srcStart`, for no word in span; success gives `anchor {startWord, endWord}` = first/last word with `srcStart ∈ [srcStart, srcEnd)`, `layout = SCENE_REGISTRY[c].defaultLayout`, `overrides: {}`, `rationale: "added in the editor"`.
  - `graphicOverlap`: plain cues ignored; a cue ending `SCENE_GAP_SEC/2` before `startSec` counts as overlap; one ending `2*SCENE_GAP_SEC` before does not.
  - `previewAddedScenes`: drops a base `added-4` cue with no entry; keeps a base `added-2` cue with an entry (no duplicate); adds a cue for an entry with no base cue; does not add an entry whose id is in `issueIds`; a new entry whose props fail is in `skipped`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/core/test/added-scenes.test.ts` — expect FAIL (module missing).
- [ ] **Step 3:** Implement. Use `SCENE_REGISTRY[c].propsSchema.safeParse` for the reason; `ScriptComponentIdSchema` for the id check; `assembleScenes([scene], transcript, map)` for the preview window. Move the span-end arithmetic out of `TranscriptPanel.tsx:363-365` into `wordSrcEnd` and import it there.
- [ ] **Step 4:** Run the test file — PASS. Run `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat(core): added-scene schema, conversion and preview helpers`.

### Task 2: §137 remap guard

**Files:** Modify `packages/core/src/overrides.ts` (`remapSceneOverrides` :1585, `anchored` :1594, parking :1643-1653); test in the existing remap test file (find with `grep -l remapSceneOverrides packages/core/test`).

**Interfaces — Consumes:** `isAddedKey` (Task 1).

- [ ] **Step 1: Failing tests:** (a) doc key `added-2` whose cue is missing, stamped anchor matching plan cue `scene-1` → stays under `added-2`, `scene-1` untouched; (b) `added-2` cue exists but words moved → key stays, not parked as `#orphaned`; (c) orphaned `scene-5` key whose words match only cue `added-2` → never moved onto `added-2` (parked as today).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Skip `isAddedKey` keys in the remap loop; filter `added-` cue ids out of `anchored`.
- [ ] **Step 4:** Run file + whole core suite (`pnpm exec vitest run packages/core`) — PASS.
- [ ] **Step 5:** Commit `fix(core): override remap never moves an added graphic's edits or onto one`.

### Task 3: `addFormFields`

**Files:** Modify `packages/core/src/scene-props-controls.ts`, test in its existing test file; export via `browser.ts`.

**Interfaces — Produces:**
```ts
export type AddFormField =
  | { kind: "text"; key: string; label: string; max: number }
  | { kind: "list"; key: string; label: string; min: number; max: number; itemMax: number; item: "string" | "text-object" }
  | { kind: "messages"; key: "messages"; min: number; max: number; itemMax: number; from: readonly string[] }
  | { kind: "choice"; key: string; label: string; options: readonly string[] }
  | { kind: "number"; key: string; label: string; min: number; max: number }
export function addFormFields(component: AddedOffered): AddFormField[]
export function addFormProps(component: AddedOffered, values: Record<string, unknown>): Record<string, unknown> // values → props object ready for safeParse
```
Fields per type are the spec §5 table, in that order. Bounds are read from the schema (not hard-coded) where zod exposes them; the table of keys is data.

- [ ] **Step 1: Failing tests:** for each of the 11 types, every field key exists in the schema; filling each field with a short valid value (text "A", lists at `min` items of "A", first choice, number at min) → `addFormProps` output `safeParse`s; `addFormFields("TitleCard")` is exactly `[{kind:"text", key:"title", …, max:48}]`; `scalarPropControls` output unchanged for all components (snapshot of current output taken before the change).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(core): add-form fields per template graphic`.

### Task 4: Produce

**Files:** Modify `apps/cli/src/produce.ts`, the render-props shape (find the type that declares `baseSceneCues`; `grep -rn "baseSceneCues" packages apps/cli/src`); tests under `apps/cli/test/` (follow the existing produce/replay test harness, e.g. how storyboard `approvedClipScenes` runs are tested).

**Interfaces — Consumes:** `addedSceneToScene`, `isAddedKey` (Task 1). **Produces:** `render-props.json` optional `addedSceneIssues: { id: string; reason: string }[]` (omitted when empty).

Exact steps (spec §2): after `canonicalizeDictionaryCasing` (~:4904) and before the landscape remap (~:4913): `scenes = scenes.filter(s => !isAddedKey(s.id))`, then append converted `overrideDoc.addedScenes`; skipped ones go to issues. Variety pass (~:4974): `if (isAddedKey(sc.id)) continue;` next to the `graphicRect` skip. Grounding (~:5481-5497) and `cueOutcomes` (~:5121): filter out added ids. After `assembleScenes` (:5107): any added id in its `dropped` → issues with assembly's reason. Log one line per issue: `  ⚠ added graphic <id> not shown: <reason>`.

- [ ] **Step 1: Failing tests:** an entry yields a cue in a planner run, a script run, a storyboard run and a `--scenes` replay; replay with the same entry already in `scenes-reviewed.json` gives exactly one cue; entry removed from the doc → replay has no `added-` cue; storyboard sync after approving a shot over the same words keeps both (shot pushed or added pushed per assembly, neither dropped unless too short); invalid entry → run succeeds, `addedSceneIssues` has it; variety pass leaves a plan neighbour's layout identical with and without the add; `--clip` project anchor indexes the clip words; no `addedScenes` → render-props has no `addedSceneIssues` key.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test` (whole workspace) — PASS. `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat(produce): added graphics enter every run from overrides.json`.

### Task 5: Editor model — reducer, preview, Delete, skipped list

**Files:** Modify `apps/editor/src/useEdits.ts`, `apps/editor/src/App.tsx` (preview merge ~:1365-1414), `apps/editor/src/Inspector.tsx` (Delete routing, no-selection skipped list); tests in `apps/editor/test/` (existing useEdits and Inspector tests).

**Interfaces — Consumes:** Task 1 helpers; `addedSceneIssues` from render-props (Task 4). **Produces:**
```ts
// useEdits actions
{ type: "addScene"; component: string; props: Record<string, unknown>; srcStart: number; srcEnd: number; baseIds: readonly string[] }
{ type: "removeAddedScene"; id: string }
// hook API
addScene(input: Omit<AddScene, "type">): string   // returns the minted id
removeAddedScene(id: string): void
```
Mint: `nextAddedId([...doc.addedScenes ids, ...Object.keys(doc.scenes).map(sceneKeyRoot), ...baseIds])`. The hook computes the id synchronously the same way so it can return it.

App: run `previewAddedScenes` on `baseCues` (after the `kind !== "plain"` filter, with `oldClockMap`; if null, skip adding new entries) before `resolveSrcTimingPins`/`applyOverrides`. Inspector: Delete on a selected cue whose id `isAddedKey` and has no `@` → `removeAddedScene`; with `@` → existing hide. No-selection view: heading per Global Constraints, rows `id · component · reason` with Remove (`data-testid="added-skipped-remove-<id>"`), list = `addedSceneIssues` ∪ preview `skipped`, de-duplicated by id, only ids still in the doc.

- [ ] **Step 1: Failing tests:** addScene appends + one undo restores; mint skips an id present only in `baseIds`; removeAddedScene removes entry and `scenes` keys `added-1`, `added-1@3`, `added-1#orphaned` but not `added-10`, and leaves `splits`; empty list removes the key; preview: baked `added-1` with entry removed → no cue (undo-after-run); remove then re-add same words before a run → new id `added-2`, cue present, `added-1` gone; Inspector Delete on root vs split half; skipped list renders and Remove dispatches.
- [ ] **Step 2:** Run `pnpm exec vitest run apps/editor/test` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run editor tests + `pnpm typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(editor): added graphics in the edit model, preview and Inspector`.

### Task 6: The gesture

**Files:** Create `apps/editor/src/AddGraphicPopover.tsx`; modify `apps/editor/src/TranscriptPanel.tsx` (selection bar `transcript-selection-menu`: **Graphic…** `data-testid="transcript-add-graphic"` between Timing and Delete/Restore); App wiring (callback prop from TranscriptPanel carrying the selected words' `{srcStart, start, end, text}`); tests: jsdom in `apps/editor/test/`, e2e in `apps/editor/e2e/` (new spec `added-graphics.spec.ts` + Playwright project if the config needs one).

**Interfaces — Consumes:** `addFormFields`, `addFormProps` (Task 3); `graphicOverlap`, `wordSrcEnd`, `ADDED_OFFERED` (Task 1); `addScene` (Task 5).

Behaviour (spec §5): overlap check first (window from one-scene assembly, via a small App-side helper that reuses `previewAddedScenes`' timing) → refusal copy; else step 1 type list (plain name + one line each; the builder writes these — keep each line under 60 chars), step 2 form; first `text` field prefilled with the selected words joined by spaces when length ≤ its `max`; **Add** disabled until `safeParse` passes; on Add: `addScene`, close, select the new block; 15 s note when the span exceeds `MAX_SCENE_SEC`; null clock → "This graphic will show after the next Render." Popover uses the selection bar's styles (`floatingMenu`, `MenuItem`), anchored like the range editor; Escape closes it (selection stays).

- [ ] **Step 1: Failing tests** (jsdom): button present on the bar in order; overlap shows refusal and no type list; TitleCard flow dispatches `addScene` with the prefilled title; Add disabled on empty required field; Escape closes, selection kept. e2e: select words → Graphic… → TitleCard → type → Add → block on timeline and in preview; Ctrl+Z removes it; overlap refused; Save, reload, block still there; drag-select, shift-extend, double-click retype, ✕ clear still work.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Editor unit tests, the new e2e project, `--project main` on `interactions.spec.ts`, `pnpm typecheck`, `pnpm test`, `pnpm build` — all PASS.
- [ ] **Step 5:** Commit `feat(editor): add a template graphic from a transcript selection`.

### Task 7: FINDINGS and real run (main thread)

- [ ] Add a FINDINGS section: added graphics, older builds strip `addedScenes`, take-id renumbering limit, `addedSceneIssues`.
- [ ] Real run on `~/ossclip-work/egm-short/work/EGM-99c61806`: add a TitleCard, Save, Render; check `render-props.json` and the MP4 frame.
- [ ] Commit `docs: FINDINGS for editor-added graphics`.
