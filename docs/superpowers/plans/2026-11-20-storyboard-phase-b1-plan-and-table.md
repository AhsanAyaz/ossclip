# Storyboard Phase B1 (plan and table) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ossclip produce <input> --storyboard` plans the shots of a video from its transcript in one LLM call, stores them in `storyboard.json`, and opens the editor on a table where the author drops, rewords, moves and adds shots and can plan again.

**Architecture:** The shot record, the plan limits and the plan-again merge are pure functions in core beside the Phase A draw code. The planner is one `complete` call with its own prompt. `produce` gains a storyboard branch beside the script branch. The editor server gains three endpoints, and the editor a modal panel. Drawing is not part of this phase.

**Tech Stack:** TypeScript, zod (`zod/v4`), vitest, Playwright (editor e2e), React.

**Spec:** `docs/designs/storyboard-drawn-scenes.md` sections 1, 2, 9, 10 and "Phase B1". FINDINGS §167 records Phase A. Read both before any task.

## Facts from the code map (2026-11-20)

*   `--script` is declared at `apps/cli/src/program.ts:442`, implies `--produce` at `:804`, and its conflicts are thrown in `produce()` at `apps/cli/src/produce.ts:2882-2901`. A run stops before rendering when `ProduceOptions.render === false` (`produce.ts:7287`); the action then calls `offerEditor`.
*   In `produce()`: `work` (workdir), `frame`, `landscape`, `transcript`, `cutlist`, `map = new TimeMap(cutlist)`, `provider` (from `createTieredProvider`, gated on `needsLlm`), `scenes`. The planning chain starts at `:4032`; the script branch is `if (scriptRun)` at `:4174`.
*   The effective cut for planning: `scriptPlanCutlist({words, cutlist, doc, priorMap})` then `cutWordIndices(words, cutlist)` (indices of cut words), and `keptWordTimes(words, cut, map)` for output times (`apps/cli/src/script-mode.ts:318-344`).
*   Kept words are shown to an LLM as `[i]word`, cut words as `[i]⟦word⟧` (`buildBeatsUserPrompt`, `packages/core/src/producer/beats.ts:257`).
*   Cache helpers to copy: `keptWordsKey`, `scriptPlanCacheKey`, `scriptPlanCacheKeyCandidates`, `actualProvider` (`script-mode.ts:344-413`, `produce.ts:829`). Files are `<work>/scriptplan-<key>.json`.
*   Limits: `minSceneSec(outputDurationSec)`, `MAX_SCENE_SEC = 15`, `SCENE_GAP_SEC = 0.05` (`packages/core/src/assemble.ts`). `ossclip draw` accepts a duration of 2 to 15 s.
*   Mock provider routes by `schemaName` in a chained ternary (`packages/core/src/producer/mock.ts:23-49`).
*   Editor server: `startEditServer` (`apps/cli/src/edit.ts:658`) with the seam `makeLlmProvider`. The pattern for an LLM endpoint is `/api/youtube/generate` (`:2416-2598`): busy flag and 409, `captionRegenProvider`, `ok:false` with status 200 on provider failure, atomic usage append. `heardWords(workdir)` (`:1197`) gives the kept words under the live cut. Tests start a real server on port 0 (`apps/cli/test/edit-server.test.ts`).
*   Editor: panels are modals opened by top-bar buttons from booleans in `App.tsx` (`:683-711`, rendered at `:2362`). The closest model is `PublishPanel.tsx`. Styles are inline constants. The transcript's selection is local to `TranscriptPanel` and uses positional indices, not transcript indices; it leaves the panel as `{srcStart, was}` per word (`deleteWords.ts:19-30`).
*   The wizard's header comment (`apps/cli/src/interactive/produce-wizard.ts:13-67`) lists every flag it does not offer, with a count.
*   Phase A: `ShotIdSchema`, `AssetNameSchema` (`packages/core/src/draw/shot-record.ts`); `loadShot`, `stageAssets` (`apps/cli/src/draw/shot-store.ts`).

## Global Constraints

*   A run without `--storyboard` on a project without `storyboard.json` is unchanged: no existing prompt, cache key, schema default or output changes.
*   `storyboard.json` is never planned again unless the author asks ("Plan again"). A `--storyboard` run on a workdir that has it loads it and makes no plan call.
*   Shot ids are stable and never reused.
*   Coverage limit 0.6 of the kept runtime. Priority 1 is the most important, 3 the least.
*   User values are parsed with zod. Pure logic is separated from I/O. Comments say why and cite `§168` (the FINDINGS section this phase writes).
*   Commit after each task. Do not push.

## Review Focus

1.  **The planner returns word indices that are cut, reversed or out of range.** Expected: snapped inward to kept words, swapped, or the shot dropped with a reported reason; never a crash. Test in Task 1.
2.  **A `--storyboard` run after the author edited the table.** Expected: the stored table is loaded untouched and no LLM call is made. Test in Task 3.
3.  **"Plan again" while a shot is reworded, added by the author or already drawn.** Expected: those shots survive with their ids; only untouched planned shots are replaced; new shots never overlap a surviving one. Test in Task 1.
4.  **A stale or hand-edited `storyboard.json` that fails its schema.** Expected: the run stops with a message naming the file and the first problem; the file is not overwritten. Test in Task 3.
5.  **Two requests at once to the plan endpoint.** Expected: the second gets 409. Test in Task 4.

---

### Task 1: Storyboard record, plan limits, plan-again merge (core, pure)

**Files:**
- Create: `packages/core/src/storyboard/record.ts`, `packages/core/src/storyboard/limits.ts`, `packages/core/src/storyboard/merge.ts`
- Modify: `packages/core/src/index.ts` and `packages/core/src/browser.ts` (the editor needs the schema and types; these files import only zod and the draw record's schemas)
- Test: `packages/core/test/storyboard-record.test.ts`, `storyboard-limits.test.ts`, `storyboard-merge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const STORYBOARD_COVERAGE = 0.6;
  export const STORYBOARD_MIN_SHOT_SEC = 2;   // the lower bound `ossclip draw` accepts
  export const StoryboardShotSchema = z.object({
    id: ShotIdSchema, startWord: z.number().int().nonnegative(), endWord: z.number().int().nonnegative(),
    idea: z.string().min(1).max(400), why: z.string().max(200), priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    assets: z.array(AssetNameSchema), kept: z.boolean(), origin: z.enum(["planner", "author"]), touched: z.boolean(),
  }).refine((s) => s.endWord >= s.startWord);
  export const StoryboardSchema = z.object({ version: z.literal(1), intent: z.string().optional(), assetsDir: z.string().optional(), nextShot: z.number().int().positive(), shots: z.array(StoryboardShotSchema) });
  export type Storyboard, StoryboardShot;
  export function newShotId(sb: Storyboard): { id: string; sb: Storyboard }; // "s1", "s2", …; bumps nextShot
  export interface PlannedShot { startWord: number; endWord: number; idea: string; why: string; priority: 1 | 2 | 3; assets: string[] }
  export interface LimitContext { wordCount: number; cut: ReadonlySet<number>; outputTimeOf: (wordIndex: number) => { start: number; end: number } | null; outputDurationSec: number; maxShotSec: number; gapSec: number; assetNames: readonly string[]; blocked: readonly { startWord: number; endWord: number }[] }
  export interface LimitChange { index: number; kind: "dropped" | "moved" | "trimmed" | "asset-removed"; reason: string }
  export function enforcePlanLimits(shots: PlannedShot[], ctx: LimitContext): { shots: PlannedShot[]; changes: LimitChange[] };
  export function isProtectedShot(s: StoryboardShot, hasVersions: boolean): boolean; // touched, author's, or drawn
  export function mergePlanAgain(sb: Storyboard, fresh: PlannedShot[], hasVersions: (id: string) => boolean): Storyboard;
  ```

- [ ] **Step 1: Write the failing tests.**
  - Record: a valid storyboard parses; `endWord < startWord` fails; an id `../x` fails; `newShotId` returns `s1` then `s2` and never repeats after a shot is removed.
  - Limits, each asserting the returned shots and the `changes` entry (Review Focus 1): reversed indices are swapped; an index past `wordCount` is clamped; a start or end on a cut word moves inward to the nearest kept word; a shot whose words are all cut is dropped; a shot overlapping an earlier one starts at the first kept word after the earlier shot's end plus `gapSec` ("moved"); a shot then under 2 s is dropped; a shot over `maxShotSec` is trimmed at its end to the last kept word inside the limit; an asset name not in `assetNames` is removed from the shot; with coverage over 0.6, priority 3 shots are dropped before priority 2, and the latest first among equals, until coverage is at most 0.6; a shot overlapping a `blocked` range is moved after it or dropped. Output is sorted by `startWord`. The fixed order is: indices, cut snap, sort, overlap, minimum, maximum, coverage.
  - Merge (Review Focus 3): untouched planner shots are removed; a touched shot, an author's shot and a shot with versions stay with their ids, dropped ones included; fresh shots get new ids, `origin: "planner"`, `touched: false`, `kept: true`; ids of removed shots are not reused.
- [ ] **Step 2: Run** the three test files. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement.** `mergePlanAgain` does not run limits; the caller runs `enforcePlanLimits` with the protected kept shots as `blocked` before merging.
- [ ] **Step 4: Run** the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: storyboard record, plan limits and plan-again merge (pure)`.

### Task 2: The planner call (core)

**Files:**
- Create: `packages/core/src/storyboard/plan.ts`
- Modify: `packages/core/src/producer/mock.ts` (route `storyboard_plan`), `packages/core/src/index.ts`
- Test: `packages/core/test/storyboard-plan.test.ts`

**Interfaces:**
- Consumes: `PlannedShot`, `LlmProvider`.
- Produces:
  ```ts
  export const STORYBOARD_PLAN_PROMPT_VERSION = "b1";
  export const StoryboardPlanReplySchema = z.object({ shots: z.array(z.object({ startWord: z.number().int(), endWord: z.number().int(), idea: z.string().min(1).max(400), why: z.string().max(200), priority: z.number().int().min(1).max(3), assets: z.array(z.string()) })).max(40) });
  export interface StoryboardPlanInput { words: readonly { text: string }[]; cut: ReadonlySet<number>; outputDurationSec: number; width: number; height: number; intent?: string; assets: { name: string; width: number; height: number; note?: string }[]; taken: readonly { startWord: number; endWord: number; idea: string }[] } // taken: spans already covered, for plan again
  export function storyboardPlanPrompt(input: StoryboardPlanInput): { system: string; user: string };
  export async function planStoryboard(provider: LlmProvider, input: StoryboardPlanInput): Promise<PlannedShot[]>; // one call; throws on provider failure
  ```

- [ ] **Step 1: Write the failing tests:** the user prompt lists kept words as `[i]word` and cut words as `[i]⟦word⟧`; it contains the intent, the frame size with its orientation, the runtime, the coverage limit as "at most 60%", the 2 to 15 second bounds, each asset name with its note, and each `taken` span with "do not plan here"; with no assets it says the planner should expect everything to be drawn; the system prompt says what a drawn shot can be (characters, props and diagrams drawn as animated SVG, short labels) and what it cannot (photos, screenshots, video, sound); it asks for an idea of one or two sentences saying what is on screen and how it moves, and a `why`; it contains no all-caps words; `planStoryboard` makes exactly one call with `schemaName: "storyboard_plan"` and `tier: "editorial"` and returns the shots with `priority` typed 1, 2 or 3; a provider error propagates; the mock route returns a deterministic plan of one shot per 40 kept words, with word ranges on kept words.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Write the prompt as plain prose in short sections, with the reason for each limit. The prompt tells the planner to pick moments where a picture explains more than the speaker's face does, to leave the hook and direct-address lines (a call to action) without a shot unless a picture adds something, and that each idea must stand alone: the artist who draws it sees only that idea and its spoken line.
- [ ] **Step 4: Run** the test, then `pnpm vitest run packages/core`. Expected: PASS, no existing prompt test changed.
- [ ] **Step 5: Commit** `feat: storyboard planner call`.

### Task 3: `--storyboard` in produce

**Files:**
- Create: `apps/cli/src/storyboard/storyboard-store.ts` (I/O), `apps/cli/src/storyboard/storyboard-run.ts` (the branch's logic, dependencies injected)
- Modify: `apps/cli/src/program.ts`, `apps/cli/src/produce.ts`, `apps/cli/src/render-replay-args.ts`, `apps/cli/src/replay-argv.ts`, `apps/cli/src/interactive/produce-wizard.ts` (header comment and count)
- Test: `apps/cli/test/storyboard-run.test.ts`, `apps/cli/test/storyboard-produce.test.ts`, additions to `produce-argv-roundtrip.test.ts`, `produce-flag-forwarding.test.ts`, `render-replay-args.test.ts`, `replay-argv.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2; `stageAssets`, `loadShot` (Phase A).
- Produces:
  ```ts
  // storyboard-store.ts
  export const STORYBOARD_FILE = "storyboard.json";
  export function loadStoryboard(workdir: string): Storyboard | null; // throws StoryboardFileError naming the file and the first zod issue
  export function saveStoryboard(workdir: string, sb: Storyboard): void; // temp file then rename
  export function storyboardPlanCacheKey(parts: { promptVersion: string; keptWords: string; intent?: string; assets: string; frame: string; providerName: string; llmModel?: string }): string;
  // storyboard-run.ts
  export interface StoryboardRunResult { storyboard: Storyboard; planned: boolean; changes: LimitChange[] }
  export async function runStoryboardPlan(a: { workdir: string; words; cut: ReadonlySet<number>; wordTimes; outputDurationSec: number; frame: { width: number; height: number }; intent?: string; assetsDir?: string; provider: LlmProvider; providerName: string; llmModel?: string }, deps): Promise<StoryboardRunResult>;
  ```
  Flags on `produce`: `--storyboard` (boolean) and `--assets <dir>` (zod-parsed path; only with `--storyboard`).

- [ ] **Step 1: Write the failing unit tests** for `runStoryboardPlan` with the mock provider and a temp workdir: the first run makes one call, writes `storyboard.json` with ids `s1…`, every shot `kept: true`, `origin: "planner"`, `touched: false`, and returns the limit changes; a second run with the file present makes no call and returns `planned: false` (Review Focus 2); a file that fails its schema throws `StoryboardFileError` and is left as it is (Review Focus 4); with no file and a plan cache hit, no call is made and the file is written from the cache; `--assets` stages nothing at plan time but its absolute path is stored in the storyboard and its names reach the planner.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement the store and the run.** The cache file is `<work>/storyboardplan-<key>.json`, holding the planner's raw shots before limits.
- [ ] **Step 4: Wire the flags.** `--storyboard` implies `--produce`, sets `render: false` and opens the editor as `--review` does (an explicit `--no-open-editor` is honoured, so tests can run it). Thrown in `produce()` beside the script conflicts: `--storyboard` with `--script`, with `--scenes`, with `--clip`; `--assets` without `--storyboard`. In the planning chain add `if (storyboardRun)` before `if (scriptRun)`: compute the effective cut as the script branch does, call `runStoryboardPlan`, leave `scenes` empty, print `▸ storyboard: N shots planned (M changed by limits)` or `▸ storyboard: loaded N shots (not planned again)`, and print each limit change in `report.txt` under "storyboard plan:". The beat sheet and the logo finder do not run in a storyboard run. When neither `--look` nor the config names a look, a storyboard run uses the explainer look. `renderReplayArgs` drops `--storyboard` and `--assets` when it pins `--scenes`, as it drops `--script`; a replan keeps them. `recordedProduceArgs` records both.
- [ ] **Step 5: Write the end-to-end test** (`storyboard-produce.test.ts`, modelled on `apps/cli/test/script-produce.test.ts`, mock provider, injected transcript): a `--storyboard --no-open-editor` run writes `storyboard.json`, `production.json` with no scenes, no rendered video, and `command.json` holding `--storyboard`; a second identical run makes no `storyboard_plan` call; each conflict throws its message; a run without `--storyboard` on a fresh workdir writes no `storyboard.json` and its `production.json` equals the one from before this change (compare with the existing fixture expectation).
- [ ] **Step 6: Update** the wizard's header comment: one paragraph each for `--storyboard` and `--assets` saying why the wizard does not offer them (experimental; the editor is its surface), and the flag count.
- [ ] **Step 7: Run** the new and touched test files, `pnpm typecheck`, then `pnpm test` once. Expected: PASS.
- [ ] **Step 8: Commit** `feat: produce --storyboard plans shots and stops at the editor`.

### Task 4: Editor server endpoints

**Files:**
- Modify: `apps/cli/src/edit.ts`
- Create: `apps/cli/src/storyboard/storyboard-edit.ts` (pure: apply an author's edit to a storyboard)
- Test: `apps/cli/test/storyboard-edit.test.ts`, additions to `apps/cli/test/edit-server.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type StoryboardEdit =
    | { op: "drop"; id: string } | { op: "restore"; id: string }
    | { op: "idea"; id: string; idea: string }
    | { op: "span"; id: string; startWord: number; endWord: number }
    | { op: "add"; startWord: number; endWord: number; idea: string };
  export const StoryboardEditSchema: z.ZodType<StoryboardEdit>;
  export function applyStoryboardEdit(sb: Storyboard, edit: StoryboardEdit, wordCount: number): Storyboard; // throws StoryboardEditError
  ```
  Endpoints:
  - `GET /api/storyboard` → `{ storyboard: Storyboard | null, drawn: Record<id, { draft: number | null; versions: number }> }`
  - `POST /api/storyboard/edit` body `StoryboardEdit` → `{ ok: true, storyboard }` or 400 `{ ok: false, error }`
  - `POST /api/storyboard/plan` ("Plan again") → `{ ok: true, storyboard, changes, usage }` or 200 `{ ok: false, error }`; 409 when busy or when there is no workdir; 412 when no provider is available

- [ ] **Step 1: Write the failing pure tests:** `idea`, `span` and `drop` set `touched: true`; `add` creates an author's shot with a new id, priority 1, `kept: true`; a `span` or `add` that overlaps another kept shot throws with the other shot's id in the message; a span past `wordCount` throws; an unknown id throws; `restore` of a shot that now overlaps a kept shot throws.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** the pure file.
- [ ] **Step 4: Write the failing server tests** (real server on port 0, seams as the existing youtube tests use): `GET` with no file returns `storyboard: null`; an edit is persisted and returned; a bad edit returns 400 and leaves the file unchanged; `plan` calls the provider once, keeps a touched shot and an author's shot with their ids, replaces untouched ones, appends to `usage.json`, and plans on the cut as edited (a word cut in `overrides.json` is shown as cut in the prompt the seam's provider receives); a provider failure returns 200 with `ok: false` and leaves the file unchanged; a second concurrent `plan` gets 409 (Review Focus 5).
- [ ] **Step 5: Implement** the endpoints after the pattern of `/api/youtube/generate`. The effective cut comes from the same clock `heardWords` uses, as a set of cut word indices; add that helper beside `heardWords` rather than changing it.
- [ ] **Step 6: Run** the two test files and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** `feat: editor server reads, edits and re-plans the storyboard`.

### Task 5: The storyboard panel (editor)

**Files:**
- Create: `apps/editor/src/StoryboardPanel.tsx`, `apps/editor/src/storyboardModel.ts` (pure)
- Modify: `apps/editor/src/App.tsx` (button, modal, word selection hand-off), `apps/editor/src/TranscriptPanel.tsx` (a callback that reports the selected words)
- Test: `apps/editor/test/storyboardModel.test.ts`, `apps/editor/e2e/storyboard.spec.ts` with a fixture `storyboard.json` in `apps/editor/e2e/fixtures/workdir`

**Interfaces:**
- Consumes: the endpoints of Task 4; `Storyboard` types from `@ossclip/core/browser`.
- Produces (pure):
  ```ts
  export interface StoryboardRow { id: string; startSec: number | null; endSec: number | null; line: string; idea: string; why: string; priority: 1 | 2 | 3; state: "planned" | "dropped" | "drawn" | "cut away"; touched: boolean }
  export function storyboardRows(sb: Storyboard, words: readonly { text: string }[], outputTimeOf: (i: number) => { start: number; end: number } | null, drawn: Record<string, { draft: number | null; versions: number }>): StoryboardRow[];
  export function coverage(rows: StoryboardRow[], outputDurationSec: number): number; // kept rows only
  export function wordIndexAtSourceTime(words: readonly { start: number }[], srcStart: number): number | null; // exact match within 1 ms, else null
  export function selectionSpan(words: readonly { start: number }[], selected: readonly { srcStart: number }[]): { startWord: number; endWord: number } | null;
  ```

- [ ] **Step 1: Write the failing pure tests:** rows are sorted by start; `line` is the shot's kept words joined; a shot whose words are all cut has state "cut away" and null times; a dropped shot has state "dropped"; a shot with a draft is "drawn"; `coverage` ignores dropped and cut-away rows; `selectionSpan` maps a selection to the first and last transcript index and returns null when a word cannot be matched.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** the pure file.
- [ ] **Step 4: Build the panel.** A top-bar button "Storyboard" that appears only when `GET /api/storyboard` returns a storyboard. A modal in the style of `PublishPanel` and `CleanupPanel` (inline style constants, the same backdrop, header and close button). A list with one row per shot: time range, spoken line, idea (click to edit in place, saved on blur or Enter), why, priority, state, and row actions "Drop" or "Restore", and "Use selection" (sets the span from the transcript selection; disabled with a title when nothing is selected). Above the list: shot count, coverage as a percentage, "Add shot from selection" (asks for the idea in an inline field), and "Plan again" with the text "one LLM call" and the busy and error display `PublishPanel` uses. Errors from the server are shown verbatim. Requests run one at a time. Every control has a `data-testid`.
- [ ] **Step 5: Hand the selection over.** `TranscriptPanel` gets an optional `onSelectionChange(words: { srcStart: number }[] | null)` prop, called when its selection changes; `App` keeps the last value and passes it to the panel. No other behaviour of `TranscriptPanel` changes.
- [ ] **Step 6: Write the e2e test:** with the fixture storyboard, the button is shown, the panel lists the fixture's shots, editing an idea persists across a reload, "Drop" then "Restore" round-trips, and with a transcript selection "Add shot from selection" adds a row. Without a storyboard file the button is absent (use the existing fixture arrangement for a second workdir, or delete the file in the test's temp copy).
- [ ] **Step 7: Run** `pnpm vitest run apps/editor`, `pnpm typecheck`, `pnpm build`, then the editor e2e suite once. Expected: PASS, no existing e2e test changed.
- [ ] **Step 8: Commit** `feat: storyboard panel in the editor (plan table)`.

### Task 6: Real run (main thread, with the author; not delegated)

- [ ] `ossclip produce <the author's short> --storyboard --assets <logo folder> --intent "<one line>"` with the Claude command line. Record: the plan call's time, the shots, the limit changes.
- [ ] The author reviews the table in the editor. Record how many planned shots the author keeps, rewords, drops and adds.
- [ ] FINDINGS §168.
