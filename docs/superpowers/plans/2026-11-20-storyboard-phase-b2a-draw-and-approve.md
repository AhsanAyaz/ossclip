# Storyboard Phase B2a: Draw, Steer and Approve in the Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the editor's Storyboard panel the author draws a kept shot, steers it with notes, previews it, approves it, and the approved shot plays in the video as a clip scene.

**Architecture:** The Phase A draw pipeline (`runDraw`) gains a stop check and is called by one job runner in the editor server; one job runs at a time. Approval renders a ProRes 4444 clip, imports it with the existing `importClip`, stores the approval on the shot in `storyboard.json`, and re-runs the recorded `--storyboard` command so `produce` (still the only writer of `production.json`) builds one `ClipScene` per approved shot. A new optional `storyboard` record in `production.json` lets a pinned replay, `ossclip kit` and the §163 backdrop rule find those clips.

**Tech Stack:** TypeScript, zod (`zod/v4`), vitest, Playwright, Remotion 4.0.499, React.

**Spec:** `docs/designs/storyboard-drawn-scenes.md` sections 5 to 10. Findings: `docs/PHASE1-FINDINGS.md` §167 (Phase A), §168 (Phase B1).

**Out of this plan (Phase B2b, planned later):** the after-approval table of spec section 8 except "a note makes a new draft" and "a dropped shot leaves the video": no "render at the new length", no theme or kit change marks, no "not in the video / put it back".

## Global Constraints

- Values that come from a user or a file are parsed with zod, never coerced.
- Pure logic is separate from I/O: every new rule is a function a test calls with no filesystem, server or browser.
- `produce` is the only writer of `production.json`.
- LLM-written code runs only in the headless render browser. Never import, evaluate or mount a shot's `.tsx` in Node or in the editor page. The editor shows stills (PNG) and previews (WebM) only.
- Every path is derived on the server from a shot id that passed `ShotIdSchema`. No endpoint takes a path.
- One storyboard job at a time. A second request answers 409.
- A provider failure is a normal reply or job result with `ok: false`, never a 500. Each LLM call lands in `usage.json`.
- A run without `--storyboard` on a project with no storyboard gives the same prompts and the same `production.json` as before (existing tests must stay green and unedited).
- Comments explain why and cite `§169` (this phase's findings section) or the spec section.
- Machine limit: 7 GB RAM. Run one heavy command at a time (`pnpm test`, `pnpm e2e`, a render).
- Commit locally after each task. Never push.
- Before a task is reported done: `pnpm typecheck` exit 0, `pnpm test` green, and for Tasks 4 and 5 `pnpm build` and `pnpm --filter @ossclip/editor e2e` green.
- If a step needs a decision this plan does not make, stop and report. Do not guess at design.

## Review Focus

1. **The author approves, then cuts every word of the shot.** The clip scene must leave the video (existing assembly rule) and nothing must throw. Test in Task 3.
2. **A draw is interrupted (editor closed mid-call).** The version without a result is discarded on the next load (`discardUnfinished`), the job state is empty after a restart, and the shot can be drawn again. Test in Task 4.
3. **One shot in "Draw all" fails three times.** It is marked failed with its error; the other shots complete. Test in Task 4.
4. **Approve with unsaved edits in the editor.** The replay reads the saved `overrides.json`, so the panel refuses Approve while the document is dirty and says "Save first". Test in Task 5.
5. **Render on a storyboard project with no approved shot.** It must render the video with no graphics and make no LLM planning call. Test in Task 3.

---

### Task 1: Records and pure rules (core)

**Files:**
- Modify: `packages/core/src/storyboard/record.ts`
- Create: `packages/core/src/storyboard/approval.ts`
- Modify: `packages/core/src/schema.ts` (near `ProductionScriptSchema`, line 287, and `ProductionSchema`, line 460)
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts` (export the new names; `approval.ts` must be browser-safe: no `node:` imports. `clipKey` takes a hash function as an argument for that reason)
- Test: `packages/core/test/storyboard-approval.test.ts`, and the existing `packages/core/test/storyboard-record*.test.ts`

**Interfaces:**
- Consumes: `ShotIdSchema` (`packages/core/src/draw/shot-record.ts`), `MAX_SCENE_SEC`, `SCENE_GAP_SEC` (`packages/core/src/assemble.ts`), `STORYBOARD_MIN_SHOT_SEC` (`record.ts`), `SCENE_REGISTRY.ClipScene.defaultLayout`, `Scene` type.
- Produces:

```ts
// record.ts — optional, so every stored storyboard.json still parses (version stays 1)
export const ShotApprovalSchema = z.object({
  version: z.number().int().positive(),      // the draft version that was approved
  durationSec: z.number().positive(),        // the clip's length
  clipKey: z.string().min(1),
  clip: z.string().min(1),                   // workdir-relative original, "storyboard/<id>/approved.mov"
  src: z.string().min(1),                    // workdir-relative preview copy, "clips/<hash>.webm"
});
export type ShotApproval = z.infer<typeof ShotApprovalSchema>;
// StoryboardShotSchema gains: approval: ShotApprovalSchema.optional()

// schema.ts
export const ProductionStoryboardSchema = z.object({
  shots: z.array(z.object({
    id: ShotIdSchema, startWord: z.number().int().nonnegative(), endWord: z.number().int().nonnegative(),
    clip: z.string().min(1), src: z.string().min(1), durationSec: z.number().positive(),
  })),
});
export type ProductionStoryboard = z.infer<typeof ProductionStoryboardSchema>;
// ProductionSchema gains: storyboard: ProductionStoryboardSchema.optional()

// approval.ts
export const SHOT_SCENE_ID_PREFIX = "shot-";
export function shotSceneId(shotId: string): string;                 // "shot-" + id
/** One ClipScene per shot that is kept and approved, in startWord order. */
export function approvedClipScenes(sb: Storyboard): Scene[];
/** The production.json record for the same shots. Undefined when there are none. */
export function productionStoryboardOf(sb: Storyboard): ProductionStoryboard | undefined;
/** Output seconds from the shot's first kept word's start to its last kept word's end,
 *  clamped to [STORYBOARD_MIN_SHOT_SEC, MAX_SCENE_SEC], rounded to 2 decimals.
 *  Null when no word of the shot is kept. `at[i]` is word i's output {start,end} or null. */
export function shotLengthSec(shot: { startWord: number; endWord: number },
  at: readonly ({ start: number; end: number } | null)[]): number | null;
/** The kept words of the shot joined by one space. */
export function shotSpokenLine(shot: { startWord: number; endWord: number },
  words: readonly { text: string }[], kept: (i: number) => boolean): string;
export interface ClipKeyParts { code: string; kitVersion: number; theme: unknown;
  width: number; height: number; fps: number; durationSec: number }
/** Stable: object keys of `theme` sorted before hashing. */
export function clipKey(parts: ClipKeyParts, sha1Hex: (text: string) => string): string;
```

`approvedClipScenes` builds each scene as script clips are built (`packages/core/src/producer/script-plan.ts:388-404`): `{ id: shotSceneId(id), anchor: { startWord, endWord }, layout: SCENE_REGISTRY.ClipScene.defaultLayout, component: "ClipScene", props: { src, durationSec, muted: true }, overrides: {}, rationale: "storyboard shot <id>" }`. `muted: true` because a drawn clip has no sound.

- [ ] **Step 1: Write the failing tests** in `storyboard-approval.test.ts`:
  - `approvedClipScenes`: a storyboard with shots A (kept, approved), B (kept, not approved), C (dropped, approved) gives exactly one scene, id `shot-<A>`, `component: "ClipScene"`, `props.src` and `props.durationSec` from A's approval, `anchor` from A's words; two approved shots come out in `startWord` order.
  - `productionStoryboardOf`: same input gives `{ shots: [A's record] }`; no approved kept shot gives `undefined`.
  - `shotLengthSec`: words at output 10.0–10.4 and 13.1–13.6 give `3.6`; a span of 0.5 s gives `2` (minimum); a span of 20 s gives `15`; a middle word that is cut (null) is skipped; all words null gives `null`.
  - `shotSpokenLine`: skips words that are not kept.
  - `clipKey`: equal for two themes with the same keys in a different order; differs when any one of code, kitVersion, a theme value, width, height, fps, durationSec changes (one assertion each).
  - `StoryboardSchema`: parses a shot without `approval` (an existing B1 file) and with one; rejects `approval.durationSec: 0`.
  - `ProductionSchema`: parses a production without `storyboard` and with one.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/storyboard-approval.test.ts`. Expected: FAIL, names not exported.
- [ ] **Step 3: Implement** the schemas and functions above.
- [ ] **Step 4: Run** the test again, then `pnpm vitest run packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: storyboard approval record and its pure rules`.

---

### Task 2: A draw the server can run, and approval (CLI, no server)

**Files:**
- Modify: `packages/core/src/draw/draw-shot.ts` (stop check)
- Modify: `apps/cli/src/draw/draw-command.ts` (stop check passed through; project settings injectable)
- Modify: `apps/cli/src/draw/shot-store.ts` (`approvedClipPath`)
- Create: `apps/cli/src/storyboard/draw-project.ts`
- Create: `apps/cli/src/storyboard/approve.ts`
- Test: `packages/core/test/draw-shot.test.ts` (existing), `apps/cli/test/draw-command.test.ts` (existing), `apps/cli/test/storyboard-approve.test.ts` (new), `apps/cli/test/storyboard-draw-project.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `ShotApproval`, `clipKey`, `shotLengthSec`; `importClip(srcAbs, publicDir, deps)` (`apps/cli/src/clip-import.ts:233`); `bundleDrawnScene`, `renderDrawnStills`, `renderDrawnClip`, `makeCancelSignal` (`@ossclip/renderer`); `DrawProject`, `DrawDeps`, `runDraw` (`draw-command.ts`); `resolveTheme` (`packages/core/src/overrides.ts:2762`); `loadShot`, `saveShot`, `versionPaths`, `shotDir`.
- Produces:

```ts
// draw-shot.ts: drawShot's argument gains
shouldStop?: () => boolean;   // asked before every LLM call; true ends the draw
// DrawResult gains: stopped?: true   (ok is false when stopped)

// draw-command.ts
// DrawArgs gains: shouldStop?: () => boolean; project?: DrawProject
//   `project` given: used instead of reading production.json (the server passes the live theme).
// DrawRunResult gains: stopped?: true; usage: LlmUsageRecord[]  (the provider's usage records for this run)
// A stopped draw leaves no version: the version recorded before the call is removed again and saved.

// shot-store.ts
export function approvedClipPath(workdir: string, id: string): string; // <shotDir>/approved.mov

// storyboard/draw-project.ts
/** Frame, fps and the theme as the editor shows it now: render-props.json's `settings`
 *  and `baseTheme ?? theme`, with the saved overrides.json applied through resolveTheme.
 *  Throws StoryboardProjectError (message names the file) when render-props.json is missing or fails its schema. */
export function liveDrawProject(renderPropsText: string, overridesText: string | null): DrawProject;
export class StoryboardProjectError extends Error {}

// storyboard/approve.ts
export interface ApproveDeps {
  readTextFile(path: string): string;
  hashHex(text: string): string;                                        // sha1
  bundle(a: { scenePath: string; workDir: string; publicDir: string }): Promise<string>;
  renderStills(a: { serveUrl: string; props: DrawnRenderProps; outDir: string; timeoutMs: number }): Promise<string[]>;
  renderClip(a: { serveUrl: string; props: DrawnRenderProps; outPath: string; cancelSignal?: CancelSignal }): Promise<void>;
  importClip(srcAbs: string, publicDir: string): Promise<{ src: string; durationSec: number }>;
  stage(project: DrawProject, publicDir: string, assetsDir: string | undefined): Promise<Record<string, string>>; // fonts + assets, returns the assets map
  makeRenderDir(): string; removeDir(dir: string): void; log(line: string): void;
}
export interface ApproveArgs { workdir: string; shotId: string; durationSec: number;
  project: DrawProject; assetsDir?: string; cancelSignal?: CancelSignal }
/** Renders the draft version at `durationSec`: three stills into the version's stills dir
 *  (replacing the draft-length ones) and the clip to approvedClipPath; imports the clip;
 *  returns the approval. Does NOT write storyboard.json (the caller does, so a failed
 *  render leaves the stored approval as it was). Throws ApproveError when the shot has
 *  no draft, the draft's code file is missing, or the draft's kit version is not DRAW_KIT_VERSION. */
export function approveShot(a: ApproveArgs, deps: ApproveDeps): Promise<ShotApproval>;
export class ApproveError extends Error {}
export function liveApproveDeps(): ApproveDeps;
```

Notes for the implementer:
- `runDraw`'s private `stageRender` and `renderProps` already do the staging and props work; export them (or move them to a shared module) and use them in `approveShot` and `liveApproveDeps` rather than writing them again.
- The clip is written through `renderDrawnClip`'s own partial-file rename; a cancelled or failed render leaves the previous `approved.mov` in place only if the render writes to a temp name first. Render to `approved.next.mov` and rename over `approved.mov` after the import succeeded.
- `clipKey` gets `{ code, kitVersion: DRAW_KIT_VERSION, theme: project.theme, width, height, fps, durationSec }`.

- [ ] **Step 1: Failing tests.**
  - `draw-shot.test.ts`: with `shouldStop` returning true from the start, the provider is never called and the result is `{ ok: false, stopped: true }`; with `shouldStop` turning true after the first failed check, exactly one provider call is made.
  - `draw-command.test.ts`: a stopped draw leaves `history.json` with no new version and `nextVersion` unchanged from what a fresh load reports as usable (the removed number may be skipped; assert no version without a result remains); `project` given is the one passed to `renderStills` (assert theme and size in the props); `usage` holds one record per provider call.
  - `storyboard-draw-project.test.ts`: `liveDrawProject` takes `settings` and `baseTheme` from render-props and applies an overrides doc's `theme.accent`; falls back to `theme` when `baseTheme` is absent; throws `StoryboardProjectError` on `"{}"`.
  - `storyboard-approve.test.ts` (fake deps, real temp workdir with a shot that has an ok draft v2): `approveShot` calls `renderClip` with `props.durationSec === 5.5` and `outPath` ending `approved.next.mov`; the returned approval is `{ version: 2, durationSec: 5.5, clipKey: <non-empty>, clip: "storyboard/<id>/approved.mov", src: <what importClip returned> }`; `approved.mov` exists after; when `renderClip` rejects, an existing `approved.mov` is unchanged byte for byte and `approved.next.mov` is gone; a shot with `draft: null` throws `ApproveError`.
- [ ] **Step 2: Run** the four test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them again and `pnpm vitest run apps/cli packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: draws can be stopped; approving a shot renders and imports its clip`.

---

### Task 3: produce, replay, kit and the backdrop rule

**Files:**
- Modify: `apps/cli/src/produce.ts` (the `if (storyboardRun)` branch at ~4230 "scenes stays empty"; the record write at ~6064-6142; `isScriptProject` call at ~3139)
- Modify: `apps/cli/src/script-mode.ts` (`isScriptProject`, lines 81-87; add `storedStoryboardFrom`)
- Modify: `apps/cli/src/render-replay-args.ts`, `apps/cli/src/edit.ts` (`POST /api/render`, lines 1925-2065, only the scenes pin)
- Modify: `apps/cli/src/kit.ts` (clip lookup at 533-579)
- Test: `apps/cli/test/storyboard-produce.test.ts` (existing), `apps/cli/test/render-replay-args.test.ts` (existing), `apps/cli/test/script-mode.test.ts` (existing), the existing kit test file that covers "no record of this clip's original file"

**Interfaces:**
- Consumes: Task 1's `approvedClipScenes`, `productionStoryboardOf`, `ProductionStoryboard`.
- Produces:

```ts
// script-mode.ts
export function storedStoryboardFrom(productionJson: string): ProductionStoryboard | undefined; // tolerant, like storedScriptFrom
export function isScriptProject(run: { scriptFlag: boolean; scenesPinned: boolean;
  storedScript: ProductionScript | undefined;
  storyboardFlag: boolean; storedStoryboard: ProductionStoryboard | undefined }): boolean;
// true also when storyboardFlag, or scenesPinned && storedStoryboard !== undefined

// render-replay-args.ts
/** True when the recorded argv holds --storyboard. */
export function isStoryboardCommand(recorded: readonly string[]): boolean;
```

Behaviour:
- **A `--storyboard` run** sets `scenes = approvedClipScenes(storyboard)` (the loaded or just-planned table) and writes `storyboard: productionStoryboardOf(storyboard)` into `production.json`. With no approved shot both are as today (no scenes, no record). The scenes then go through the same assembly every scene list goes through; do not add a second path.
- **A pinned replay (`opts.scenes`)** carries the prior `storyboard` record forward, exactly as `scriptRecord` is carried at produce.ts:6084.
- **`POST /api/render` on a storyboard command:** when `isStoryboardCommand(args)` and `reviewedScenesText` returns undefined (no scenes), write `[]` as `scenes-reviewed.json` and pin it, so the existing strip of `--storyboard` and `--assets` (render-replay-args.ts:54-62) runs and the video renders with no planning call. If `produce` refuses an empty `--scenes` file, stop and report; do not change what `--scenes` accepts.
- **Kit:** when the script record has no entry for a clip's `src`, look in `storedStoryboardFrom(project.productionText)?.shots` for the same `src`; the original file is `join(workdir, shot.clip)`. The three skip messages stay for a clip in neither record.

- [ ] **Step 1: Failing tests.**
  - `storyboard-produce.test.ts`: write an approval onto shot s1 of a planned table by hand (a real small WebM at `clips/x.webm` made with ffmpeg in `beforeAll`, `clip` pointing at any existing file), run `--storyboard` again: `production.json` has one scene `{ id: "shot-s1", component: "ClipScene" }` and `storyboard.shots` of length 1; no `storyboard_plan` call was made. Then set `kept: false` on s1 and run again: no scene, no `storyboard` field. Then a pinned replay (`scenes` option pointing at the reviewed scenes of the approved state, `storyboard` option off): the `storyboard` record is carried forward. Review Focus 1: with every word of s1 inside a cut (use the options the existing tests use to force a cut, or an `overrides.json` removal), the run completes and `production.json` has no `shot-s1` scene.
  - `render-replay-args.test.ts`: `isStoryboardCommand`; with `scenesPath` set and a recorded `--storyboard --assets d`, both are stripped (existing behaviour, keep the existing test) .
  - An edit-server test beside the existing `/api/render` tests: on a workdir whose command.json holds `--storyboard` and whose production has no scenes, `POST /api/render` spawns argv that contains `--scenes` and not `--storyboard`, and `scenes-reviewed.json` is `[]` (Review Focus 5).
  - `script-mode.test.ts`: the two new true cases and that every existing case is unchanged with `storyboardFlag: false, storedStoryboard: undefined`.
  - Kit test: a ClipScene whose `src` is only in the storyboard record is "reused", with the original path `join(workdir, clip)`.
- [ ] **Step 2: Run** those files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/cli`. Expected: PASS, with no existing test edited except to add the two new `isScriptProject` arguments.
- [ ] **Step 5: Commit** `feat: approved storyboard shots become clip scenes; kit and backdrop know them`.

---

### Task 4: The job runner and the endpoints (editor server)

**Files:**
- Create: `apps/cli/src/storyboard/jobs.ts` (pure job state and the batch loop, no HTTP)
- Create: `apps/cli/src/storyboard/shot-detail.ts`
- Modify: `apps/cli/src/edit.ts` (beside the three `/api/storyboard*` routes, ~2649-2800; `/api/production` at 1554-1563)
- Modify: `apps/cli/src/storyboard/storyboard-edit.ts` (two new ops)
- Test: `apps/cli/test/storyboard-jobs.test.ts`, `apps/cli/test/storyboard-shot-detail.test.ts`, `apps/cli/test/edit-storyboard-draw.test.ts` (new, modelled on the existing edit-server storyboard test from B1)

**Interfaces:**
- Consumes: Task 2's `runDraw` (with `shouldStop`, `project`, `usage`), `approveShot`, `liveDrawProject`; Task 1's `shotLengthSec`, `shotSpokenLine`; B1's `heardCut`, `servedWords`, `captionRegenProvider`, `appendUsageRun` as used by `POST /api/storyboard/plan` (edit.ts:2705-2799); the render-child machinery of `POST /api/render`.
- Produces:

```ts
// jobs.ts
export type StoryboardJobKind = "draw" | "redraw" | "preview" | "approve";
export interface StoryboardJobState {
  kind: StoryboardJobKind;
  shots: string[];                 // all shots of the job, in order
  current: string | null;          // the shot being worked on
  done: { id: string; ok: boolean; error?: string }[];
  lines: string[];                 // progress lines, capped at 200
  calls: number;                   // LLM calls so far in this job
  startedAt: number;
  stopping: boolean;
}
export interface JobRunner {
  state(): { job: StoryboardJobState | null; last: StoryboardJobState | null };
  /** Throws JobBusyError when a job is running. `each` runs per shot, in order; a throw or
   *  an `ok: false` for one shot is recorded and the next shot still runs (Review Focus 3).
   *  After `stop()`, no further shot is started. */
  start(kind: StoryboardJobKind, shots: string[],
    each: (id: string, ctx: { shouldStop(): boolean; log(line: string): void; addCalls(n: number): void })
      => Promise<{ ok: boolean; error?: string }>): Promise<void>;   // resolves when the job ends
  stop(): boolean;                 // false when nothing runs
}
export function createJobRunner(now: () => number): JobRunner;
export class JobBusyError extends Error {}

// shot-detail.ts
export interface ShotDetail {
  versions: { n: number; ok: boolean; error?: string; said?: string; kitVersion: number;
              stills: string[];            // "/media/storyboard/<id>/v<n>/still-1.png" … only files that exist
              preview: string | null }[];  // "/media/storyboard/<id>/v<n>/preview.webm" when it exists
  draft: number | null;
  notes: { onVersion: number; text: string }[];
  drawnIdea: string | null;       // the idea the draft was drawn from (history.idea)
}
export function shotDetail(workdir: string, id: string): ShotDetail | null;  // peekShot; null with no history

// storyboard-edit.ts: StoryboardEdit gains
//   { op: "approve"; id: string; approval: ShotApproval }   // server-internal, never accepted from a request body
//   { op: "unapprove"; id: string }
// StoryboardEditSchema (the request schema) gains only "unapprove".
```

Endpoints (all need an open workdir, else 409; all bodies are zod-parsed, 64 KB cap, 400 on failure):

| Route | Body | Reply |
|---|---|---|
| `GET /api/storyboard` | | adds `detail: Record<shotId, ShotDetail>` and `job: { job, last }` to today's `{ storyboard, drawn }` |
| `GET /api/storyboard/job` | | `{ job, last }` (the panel polls this once a second while a job runs) |
| `POST /api/storyboard/draw` | `{ ids: string[] }` (1 to 40) | 202 `{ ok: true }`; 409 busy; 412 with the reason when there is no transcript, no clock, no provider, or render-props is unreadable; 400 when an id is not a kept shot |
| `POST /api/storyboard/note` | `{ id, text }` (text 1 to 1000 chars) | 202; 409 when the shot has no draft |
| `POST /api/storyboard/preview` | `{ id }` | 202; 409 when the shot has no draft |
| `POST /api/storyboard/draft` | `{ id, version }` | 200 `{ ok: true }`; sets `draft` to an earlier version whose result is ok; 400 otherwise; 409 while a job runs |
| `POST /api/storyboard/approve` | `{ id }` | 202; 409 when the shot has no draft, a job runs, or a render child runs |
| `POST /api/storyboard/cancel` | | 202, or 409 when nothing runs |

Per-shot work:
- **draw** (shot has no draft): `runDraw` in idea mode with `idea` = the shot's idea, `spokenLine` = `shotSpokenLine`, `durationSec` = `shotLengthSec` on the live cut (`heardCut`), `assetsDir` = `storyboard.assetsDir`, `project` = `liveDrawProject`, the chosen provider, `shouldStop`. A shot with no kept word is recorded `ok: false, error: "every word of this shot is cut"`. A shot that already has a draft is drawn again as a first draft only when its stored `drawnIdea` differs from the shot's idea ("Draw again", spec section 10); otherwise it is skipped with `ok: true`.
- **redraw**: `runDraw` in note mode.
- **preview**: `runDraw` in preview mode.
- **approve**: `approveShot` at `shotLengthSec` on the live cut; then `applyStoryboardEdit(sb, { op: "approve", … })` and `saveStoryboard`; then start the recorded command exactly as `POST /api/render` does but with the recorded argv unchanged plus `--no-open-editor` if absent (so `--storyboard` is kept and `produce` rebuilds the clip scenes). It uses the same `renderChild` state, so `GET /api/render/status` reports it and Render cannot start during it.
- Edits `drop`, `restore` and `unapprove` on a shot that has an approval start the same recorded-command run after saving, so the scene leaves or returns. They answer 409 while a job or a render child runs.
- After every job: the provider's usage is appended to `usage.json` (one run entry per job), as `/api/storyboard/plan` does.
- `GET /api/production` gains `storyboardProject: boolean` (the recorded command is a storyboard command, or production.json has a `storyboard` record).

- [ ] **Step 1: Failing tests.**
  - `storyboard-jobs.test.ts`: a second `start` while one runs throws `JobBusyError`; three shots where the second returns `ok: false` and the third throws give `done` of length 3 with the right flags and errors (Review Focus 3); `stop()` during shot 1 means shot 2 never starts and `stopping` is true until the job ends; `last` holds the finished job and `job` is null; `lines` never exceeds 200.
  - `storyboard-shot-detail.test.ts`: lists only still files that exist; a failed version carries its error and no stills; `preview` is null until the file exists; a version without a result does not appear; unknown shot gives null.
  - `edit-storyboard-draw.test.ts` (injected provider via `makeLlmProvider`, and injected draw/approve functions so no browser starts; add an option beside `makeLlmProvider` for them): draw on two shots ends with both drafts set and one usage run appended; the second POST during the job is 409; `cancel` sets `stopping`; a provider that throws gives a finished job with `ok: false` for that shot and HTTP 202 on the POST (never 500); approve calls the injected approve with `durationSec` equal to `shotLengthSec`, saves the approval, and spawns argv containing `--storyboard` and `--no-open-editor`; `draft` rejects a failed version with 400; a request body `{ op: "approve" }` to `/api/storyboard/edit` is 400. Review Focus 2: a `history.json` holding a version without a result, loaded by a fresh server, shows no such version in `detail` and the shot can be drawn.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run apps/cli`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: editor server draws, redraws, previews and approves storyboard shots`.

---

### Task 5: The shot view (editor)

**Files:**
- Modify: `apps/editor/src/storyboardModel.ts`, `apps/editor/src/StoryboardPanel.tsx`
- Create: `apps/editor/src/StoryboardShotView.tsx`
- Modify: `apps/editor/src/App.tsx` (three new props on `<StoryboardPanel>`; the backdrop gate)
- Modify: `apps/editor/src/Inspector.tsx` (line ~1552: the §163 backdrop control shows for `scriptProject || storyboardProject`. If `scriptProject` gates anything else there, leave that alone and say so in the report.)
- Test: `apps/editor/test/storyboardModel.test.ts`, `apps/editor/e2e/storyboard.spec.ts`, fixture files under `apps/editor/e2e/fixtures/workdir/storyboard/s1/`

**Interfaces:**
- Consumes: Task 4's endpoints and the `ShotDetail`, `StoryboardJobState` shapes (declare them again as types in `storyboardModel.ts`; the editor does not import from `apps/cli`).
- Produces (model, pure):

```ts
// StoryboardRow.state becomes:
//   "dropped" | "cut away" | "planned" | "drawing" | "failed" | "drawn" | "in the video"
// first match wins, in that order of checks: dropped; cut away; drawing (the job's current shot,
// or a shot of the job not yet done); in the video (has an approval); failed (no draft and the
// newest version failed); drawn (has a draft); planned.
export function storyboardRows(sb, words, outputTimeOf, drawn, detail, job): StoryboardRow[];
/** True when the shot has a draft whose drawnIdea differs from the shot's idea. */
export function draftIsStale(shot: { idea: string }, detail: ShotDetail | null): boolean;
/** "Drawing s3 (2 of 5) · 4 calls" / "Stopping after s3…" / null when no job. */
export function jobLine(job: StoryboardJobState | null): string | null;
/** One line for a finished job: "5 drawn" / "4 drawn, 1 failed: s2: <error>". */
export function jobResultLine(last: StoryboardJobState | null): string | null;
/** Why Approve is disabled, or null: "Save first" when dirty; "no draft"; "a job is running". */
export function approveBlock(a: { dirty: boolean; draft: number | null; jobRunning: boolean }): string | null;
```

- `StoryboardPanel` props gain `dirty: boolean`, `onReplayStarted(): void` (App wires it to its existing render poll start, `beginRenderPoll`, so the page reloads the production when the replay ends), and `storyboardProject` is not needed here.
- **Table view** adds: a "Draw" button per kept row that has no draft or a stale draft (label "Draw again" when stale); "Draw all" for every kept row with no draft; clicking a row's state or its stills thumbnail opens the shot view; a job line with "Cancel" while a job runs; the last job's result line.
- **Shot view** (`StoryboardShotView`), inside the same modal with a "Back to table" control: the draft's three stills; a version list (number, ok or failed with the error, "Make draft" on ok versions that are not the draft); "Preview" (shows the WebM in a `<video controls loop muted>` once it exists); the idea; the note history; a note box with "Redraw"; "Approve" (disabled with `approveBlock`'s reason shown beside it); for an approved shot "In the video (version n, m s)" and "Remove from video" (the `unapprove` edit).
- The panel polls `GET /api/storyboard/job` once a second only while a job runs, and reloads `GET /api/storyboard` when the job ends. After an approve job ends ok, and after a `drop`, `restore` or `unapprove` of an approved shot, it calls `onReplayStarted()`.
- Stills and previews are `<img>` and `<video>` with the `/media/…` URLs from `detail`. Add `?v=<job startedAt>` so a re-rendered still is not served from cache.
- Test ids: `storyboard-draw-<id>`, `storyboard-draw-all`, `storyboard-job`, `storyboard-job-cancel`, `storyboard-job-result`, `storyboard-open-shot-<id>`, `storyboard-shot-view`, `storyboard-shot-back`, `storyboard-still-<k>`, `storyboard-version-<n>`, `storyboard-make-draft-<n>`, `storyboard-preview`, `storyboard-preview-video`, `storyboard-note-input`, `storyboard-redraw`, `storyboard-approve`, `storyboard-approve-block`, `storyboard-unapprove`.

- [ ] **Step 1: Failing unit tests** in `storyboardModel.test.ts`: one test per row state in the order above (including that an approved shot whose words are all cut reads "cut away"); `draftIsStale`; `jobLine` for a running and a stopping job; `jobResultLine` for all-ok and one-failed; `approveBlock` for its three reasons and null.
- [ ] **Step 2: Run** `pnpm vitest run apps/editor/test/storyboardModel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the model, the panel changes and the shot view.
- [ ] **Step 4: E2E.** Add to the fixture a drawn shot s1: `storyboard/s1/history.json` (one ok version, `draft: 1`, `idea` equal to s1's idea in `storyboard.json`), `storyboard/s1/v1.tsx` (any text), and three small PNG stills. In `storyboard.spec.ts` add: s1's row reads "drawn" and opens the shot view with three stills visible; "Approve" is disabled with "Save first" after a drag makes the document dirty (Review Focus 4) and enabled when clean; s2's row has "Draw"; the note box and "Redraw" exist. Never press Draw, Draw all, Redraw, Preview or Approve in e2e: the e2e server has no mock provider and would start a real LLM call or a render. No existing e2e test is edited.
- [ ] **Step 5: Run** `pnpm vitest run apps/editor`, `pnpm typecheck`, `pnpm build`, `pnpm --filter @ossclip/editor e2e`. Expected: all green.
- [ ] **Step 6: Take a screenshot** of the shot view from the e2e run and name its path in the report.
- [ ] **Step 7: Commit** `feat: storyboard shot view: draw, note, preview and approve from the editor`.

---

### Task 6: The real run (main thread, with the author)

- [ ] On the author's short (`~/ossclip-work/egm-short/work/EGM-07054187`, five planned shots): Draw all, give notes where the author wants, preview, approve, Render.
- [ ] Record per shot: calls, minutes, notes given, approved or not; per approval: clip render time and replay time; whether the clip sits right in the rendered video; anything the author had to work around.
- [ ] `ossclip kit` on the project: every approved shot has a clip.
- [ ] Write FINDINGS §169 and commit.
