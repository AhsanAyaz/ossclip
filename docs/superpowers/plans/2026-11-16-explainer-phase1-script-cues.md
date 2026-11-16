# Explainer Phase 1 (script cues and clip scenes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ossclip produce <video> --script <file>` turns each on-screen cue of the author's script into a scene anchored to the spoken words, including transparent video clips made elsewhere.

**Architecture:** Pure parsing and alignment in `packages/core/src/script/`. A script-mode branch in `produceScenes` builds `Moment`s from aligned cues (one `script_plan` LLM call for unhinted cues) and reuses the existing props call, layout repair and assembly. A new non-planner component, `ClipScene`, plays a VP9-alpha WebM that the CLI transcodes on import.

**Tech Stack:** TypeScript, zod v4, vitest, Remotion 4.0.499, ffmpeg/ffprobe.

**Spec:** `docs/designs/explainer-video-patterns.md` (Phase 1). Fixture: `packages/core/test/fixtures/egm-script.md`.

## Global Constraints

- **G6, no change without `--script`.** The beat-sheet prompt text, the JSON schema of `BeatSheetSchema`, the planner's component menu, and all 9:16 and 16:9 layout geometry must be byte-identical for runs without `--script`. `PRODUCER_PROMPT_VERSION` is not bumped.
- Values from a user are parsed with zod, never coerced. A missing script file, an unknown `[Component]` hint, a `clip:` path that is missing or leaves the script's folder: each is an error that names the offending value.
- Pure logic is separate from I/O (parse, align, ffmpeg argument builders are pure and tested without a filesystem).
- Comments explain why and cite `docs/PHASE1-FINDINGS.md` sections where one exists. Add `§158` for this feature (Task 8).
- Alignment floor: **0.6**. Span limit: **2×** the cue's token count. Cue cap: **40**. Scene bounds: **1.2 s to 15 s**. Clip source cap: **500 MB**. Clip default gain: **−13 dB**.
- Run `pnpm test` and `pnpm typecheck` green before each commit. Commit messages follow the repo style (`feat:`, `fix:`, `test:`, `docs:`).

**Deviation from the spec, decided while planning:** spec section 1.5 changes the 16:9 geometry of `graphic-only` and `pip-bubble`. That would change output for existing 16:9 users and break G6, and Phase 1 scenes do not need it. Phase 1 gives `ClipScene` a full frame through the existing per-cue `graphicRect` instead. The layout geometry work moves to Phase 2, where the pattern components need it.

## Review Focus

1. **A script whose spoken lines were mostly re-worded or dropped while recording.** Expected: unmatched cues are skipped and listed; the run still renders. (Task 2, Task 7)
2. **Two cues with the same spoken text** ("And they were right." twice). Expected: each takes the earliest span after the previous cue; they never share words. (Task 2)
3. **A spoken line that survives only inside a cut blooper.** Expected: it does not match the cut take. (Task 2)
4. **A clip longer than the gap before the next cue.** Expected: the next scene starts after the clip ends; nothing overlaps. (Task 5)
5. **Re-plan from the editor after the script file was moved or deleted.** Expected: it uses the script text stored in the project. (Task 7)

---

### Task 1: Script parser

**Files:**
- Create: `packages/core/src/script/cues.ts`
- Modify: `packages/core/src/index.ts` (export `./script/cues`)
- Test: `packages/core/test/script-cues.test.ts`

**Interfaces:**
- Produces:

```ts
export type ScriptCueHint =
  | { kind: "none" }
  | { kind: "component"; component: string }   // validated in Task 4, not here
  | { kind: "clip"; path: string }             // as written, relative
  | { kind: "screen" };
export interface ScriptCue {
  id: string;            // `cue-${index}-${first 8 hex of sha1(cueText)}`
  index: number;         // 0-based order of 🎬 lines in the file
  cueText: string;       // 🎬 text, markdown markup removed, hint prefix removed
  hint: ScriptCueHint;
  spoken: string[];      // 🗣️ lines it covers, markup removed, in order
  line: number;          // 1-based source line of the 🎬
}
export function parseScript(markdown: string): ScriptCue[];
export function stripInlineMarkup(text: string): string; // **bold**, `code`, *em*
```

Rules (spec 1.1): `🎬` starts a cue; `🗣️` lines attach to the most recent cue **in the same heading section**; a heading (`#`…) or a `✂️` line does not end a cue, but a heading ends the section; a `🗣️` line with no cue yet in its section belongs to no cue. Hint prefixes: `[Name]`, `clip:`, `screen:` (case-insensitive, at the start of the cue text). Variation selectors after the emoji (`🗣️` is two code points) must be tolerated.

- [ ] **Step 1: Write the failing tests**

```ts
import { readFileSync } from "node:fs";
import { parseScript, stripInlineMarkup } from "../src/script/cues";
const egm = readFileSync(new URL("./fixtures/egm-script.md", import.meta.url), "utf8");

it("parses the EGM script: 20 cues, in order", () => {
  const cues = parseScript(egm);
  expect(cues).toHaveLength(20);
  expect(cues[0]!.cueText).toMatch(/^Cold open on the final captions/);
  expect(cues[0]!.spoken).toEqual(["These captions were choreographed by AI.", "But that's not the cool part."]);
});
it("strips bold and code from spoken lines and cues", () => {
  const cues = parseScript(egm);
  expect(cues.find((c) => c.spoken[0]?.startsWith("One."))!.spoken[0]).toBe(
    "One. When you cut a word in the editor, it would wipe out all the AI caption data. Silently.");
  expect(cues.some((c) => c.spoken.includes("I typed /egm:egm-brainstorm."))).toBe(true);
});
it("a cue with no spoken line has an empty list", () => {
  expect(parseScript(egm).find((c) => c.cueText.includes("4,494 tests passing"))!.spoken).toEqual([]);
});
it("a heading ends the section: a spoken line before any cue belongs to no cue", () => {
  const cues = parseScript("🎬 A\n🗣️ one\n## Next\n🗣️ orphan\n🎬 B\n🗣️ two");
  expect(cues.map((c) => c.spoken)).toEqual([["one"], ["two"]]);
});
it("reads hints", () => {
  const [a, b, c] = parseScript("🎬 [BugCard] x\n🗣️ a\n🎬 clip: clips/a b.mov\n🗣️ b\n🎬 Screen: demo\n🗣️ c");
  expect(a!.hint).toEqual({ kind: "component", component: "BugCard" });
  expect(a!.cueText).toBe("x");
  expect(b!.hint).toEqual({ kind: "clip", path: "clips/a b.mov" });
  expect(c!.hint).toEqual({ kind: "screen" });
});
it("ids are stable across unrelated edits to other cues", () => {
  const before = parseScript("🎬 A\n🗣️ a\n🎬 B\n🗣️ b");
  const after = parseScript("🎬 A\n🗣️ a changed\n🎬 B\n🗣️ b");
  expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
});
it("ignores ✂️ lines and plain prose", () => {
  expect(parseScript("🎬 A\n✂️ note\nprose\n🗣️ a")[0]!.spoken).toEqual(["a"]);
});
```

- [ ] **Step 2: Run** `npx vitest run packages/core/test/script-cues.test.ts`. Expected: FAIL, module not found. (If the EGM count differs from 25, count the `🎬` lines in the fixture and fix the test number, not the parser.)
- [ ] **Step 3: Implement `parseScript` and `stripInlineMarkup`** in `packages/core/src/script/cues.ts`; export from `packages/core/src/index.ts`. Use `node:crypto` `createHash("sha1")` for the id.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: parse on-screen cues from a video script`

---

### Task 2: Cue alignment

**Files:**
- Create: `packages/core/src/script/align.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/script-align.test.ts`

**Interfaces:**
- Consumes: `ScriptCue` (Task 1); `normalizeAlignToken(text): string` from `packages/core/src/restamp.ts`; `Transcript` (`words: {text,start,end}[]`).
- Produces:

```ts
export const ALIGN_FLOOR = 0.6;
export const ALIGN_SPAN_FACTOR = 2;
export interface AlignedCue { cue: ScriptCue; startWord: number; endWord: number; score: number }
export interface SkippedCue { cue: ScriptCue; reason: "no-spoken-lines" | "screen" | "below-floor"; score?: number }
export function alignCues(
  cues: readonly ScriptCue[],
  transcript: Transcript,
  cut?: ReadonlySet<number>,   // word indices removed by the cutlist
): { aligned: AlignedCue[]; skipped: SkippedCue[] };
```

Algorithm, fixed by the spec (1.2): tokens = `normalizeAlignToken` of each word, empty tokens dropped. Only words **not** in `cut` are candidates, but `startWord`/`endWord` are indices into the full `transcript.words`. Cues are processed in order; each search begins at the word after the previous aligned cue's `endWord`. For a cue with `n` tokens, consider every window of kept words starting at each candidate position with length up to `ALIGN_SPAN_FACTOR × n`; the window's score is (script tokens matched in order inside it) ÷ `n`. Take the highest score; ties go to the earliest start, then the shortest window. `startWord` and `endWord` are the first and last **matched** words. Below `ALIGN_FLOOR` the cue is skipped and the search position does not move. `screen` hints and cues with no spoken lines are skipped before any search.

- [ ] **Step 1: Write the failing tests.** Build transcripts with a helper `t("word word …")` giving each word 0.3 s.

```ts
it("aligns a verbatim line", …);                       // score 1, exact indices
it("aligns a paraphrase above the floor", …);          // script "big prompt big pile of code", said "big prompt and a big pile of code" → aligned
it("skips a cue below 0.6 and reports its best score", …);
it("two cues with the same text take consecutive spans, never the same words", …);
it("a line said only inside cut words does not match there", …); // cut = indices of the blooper take
it("cues cannot cross: a later cue never matches before an earlier one", …);
it("a skipped cue does not block the next cue from matching earlier words", …);
it("screen hints and cues with no spoken lines are skipped with their reason", …);
it("returns indices into the full transcript when cut words sit before the match", …);
```

Each test asserts concrete `startWord`, `endWord` and (to 2 dp) `score`.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `alignCues`.** A two-pointer in-order match per window is enough; a transcript is a few thousand words and a script has at most 40 cues.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: align script cues to the spoken words`

---

### Task 3: `ClipScene` in the registry, hidden from every planner

**Files:**
- Modify: `packages/core/src/scene-schema.ts` (ids), `packages/core/src/scene-registry.ts` (meta, entry), `packages/core/src/producer/beats.ts` (menu and `sceneKind`), `packages/core/src/producer/scene-props.ts` and any other site that iterates `SCENE_REGISTRY` for an LLM prompt
- Test: `packages/core/test/scene-registry.test.ts`, new `packages/core/test/planner-prompt-frozen.test.ts`

**Interfaces:**
- Produces:

```ts
// scene-schema.ts
export const PlannerComponentIdSchema = z.enum([...the nine ids, in today's order]);
export type PlannerComponentId = z.infer<typeof PlannerComponentIdSchema>;
export const SceneComponentIdSchema = z.enum([...the nine, "ClipScene"]);
// scene-registry.ts
export interface SceneComponentMeta {
  …existing fields…
  /** false = never offered to an LLM (ClipScene). Default true. */
  plannerSelectable?: boolean;
  /** false = no frosted scrim behind it over live video. Default true. */
  scrim?: boolean;
  /** When set, the scene lasts this long instead of its word span. */
  fixedDurationSec?: (props: Record<string, unknown>) => number | undefined;
}
export const ClipSceneProps: z.ZodObject<…>; // { src: string(min 1), durationSec: number positive, gainDb: number default -13, muted: boolean default false }
export function plannerComponentIds(): PlannerComponentId[]; // registry order, plannerSelectable !== false
```

`MomentSchema.sceneKind` becomes `z.union([PlannerComponentIdSchema, z.literal("none")])`. Every prompt menu is built from `plannerComponentIds()`.

- [ ] **Step 1: Freeze today's prompt first.** Before changing any source, write `planner-prompt-frozen.test.ts`: it asserts `JSON.stringify(z.toJSONSchema(BeatSheetSchema))` and the output of `buildBeatsUserPrompt` (fixed small transcript, 30 s, no intent) against inline snapshots (`toMatchInlineSnapshot()`), and the same for the props-call schema list if it enumerates components. Run it to record the snapshots on unchanged code, and commit that alone: `test: freeze the planner prompt and schema`.
- [ ] **Step 2: Write the failing registry tests:** `ClipScene` is in `SCENE_REGISTRY` with `plannerSelectable: false`, `scrim: false`, `defaultLayout: "full-bleed"`, `altLayouts: []`; `plannerComponentIds()` equals the nine in order; `resolveSceneProps("ClipScene", { src: "clips/a.webm", durationSec: 4.6 })` returns `gainDb: -13, muted: false`; `fixedDurationSec` returns `4.6`.
- [ ] **Step 3: Run.** Expected: registry tests FAIL; frozen test PASS.
- [ ] **Step 4: Implement.** Fix every `Record<SceneComponentId, …>` and exhaustive switch the compiler now flags (`pnpm typecheck` lists them): the grounding and copy-repair field lists get an empty entry for `ClipScene`; `revealItemTexts` returns no items for it.
- [ ] **Step 5: Run all core tests and typecheck.** Expected: PASS, with the frozen snapshots **unchanged**. If a snapshot changed, a menu still reads the whole registry; fix that, do not update the snapshot.
- [ ] **Step 6: Commit** `feat: ClipScene component id, hidden from planners`

---

### Task 4: Script-mode planning

**Files:**
- Create: `packages/core/src/producer/script-plan.ts`
- Modify: `packages/core/src/producer/index.ts` (`produceScenes`), `packages/core/src/producer/beats.ts` (`normalizeBeatSheet` mode), `packages/core/src/producer/mock.ts`
- Test: `packages/core/test/script-plan.test.ts`

**Interfaces:**
- Consumes: `AlignedCue` (Task 2), `PlannerComponentIdSchema`, `plannerComponentIds()`, `ClipSceneProps` (Task 3), `momentSceneId(i)`, `generateScenes`, `LlmProvider.complete({system,user,schema,schemaName})`.
- Produces:

```ts
export const SCRIPT_PLAN_PROMPT_VERSION = "s1";
export const MAX_SCRIPT_CUES = 40;
export interface ResolvedClip { cueId: string; src: string; durationSec: number } // src = project-relative WebM (Task 6)
export interface ScriptPlanInput { aligned: AlignedCue[]; clips: ResolvedClip[] }
export class ScriptPlanError extends Error {}   // >40 cues, unknown [Component] hint
export async function planScriptMoments(
  provider: LlmProvider, input: ScriptPlanInput, transcript: Transcript,
): Promise<{ moments: Moment[]; clipScenes: Scene[]; issues: BeatsValidationIssue[] }>;
// produceScenes gains: args.script?: ScriptPlanInput
// normalizeBeatSheet gains a 5th parameter: mode: "auto" | "script" = "auto"
```

Decisions:
- `moments[i]` corresponds to `aligned[i]`; `startWord`/`endWord` come from the alignment and the LLM cannot change them.
- A `clip` cue yields a moment with `sceneKind: "none"` plus a `Scene` in `clipScenes`: `id: momentSceneId(i)`, `component: "ClipScene"`, `layout: "full-bleed"`, `anchor` = the cue's span, `props: { src, durationSec }`, `rationale: "script clip"`. A clip cue with no entry in `clips` is a `ScriptPlanError`.
- A `component` hint must be in `plannerComponentIds()`, else `ScriptPlanError` listing the valid names; its moment skips the component choice but still gets `onScreenCopy` from the LLM.
- One call, `schemaName: "script_plan"`, schema `{ cues: [{ id, sceneKind (planner id), layout?, onScreenCopy (≤60) }] }`, covering every non-clip cue. The user prompt lists per cue: id, cue text, spoken text; then the component menu (`whenToUse` lines). The system prompt states: the cue text is the instruction; on-screen copy may only use words and numbers from the cue text or the spoken text.
- One retry on a thrown call. After that, or for any cue id the reply omits, the moment is `sceneKind: "TitleCard"` with `onScreenCopy` = the cue text cut to 60 characters at a word boundary, and an issue is recorded.
- `purpose` = the cue text (capped to 100).
- In `produceScenes`, when `args.script` is set: skip `generateBeatSheet`; call `planScriptMoments`; run `normalizeBeatSheet(…, mode "script")`, which keeps bounds checks, cut-only removal and overlap repair and skips the coverage budget, the short-take floor and same-kind demotion; then the existing `forceComponent` and `repairMomentLayouts` steps; then `generateScenes` for the moments; then append `clipScenes` whose moment survived normalization. `beatSheet.hook` = the first moment's `onScreenCopy`. `graphics.asked` = number of aligned cues. `args.clip` (the `--clip` highlight) together with `args.script` throws: the two modes are exclusive.
- Mock provider: for `script_plan`, return each listed cue id with `sceneKind: "TitleCard"` and `onScreenCopy` = the first 60 characters of its cue text. Parse the ids from the prompt the same way `beatSheet` parses word indices.

- [ ] **Step 1: Write the failing tests** with a stub provider that records calls and returns canned JSON:
  - moments carry the alignment's word spans regardless of what the reply says;
  - a clip cue produces no LLM entry, a `"none"` moment and a `ClipScene` scene with the right id, anchor and props;
  - a `[StatCard]` hint forces the kind; `[Nope]` throws `ScriptPlanError` whose message contains `TitleCard`;
  - 41 aligned cues throw `ScriptPlanError` containing `41`;
  - a provider that throws twice yields TitleCard moments and one issue per cue;
  - a reply missing one cue id falls back for that cue only;
  - `normalizeBeatSheet` in `"script"` mode keeps three adjacent same-kind moments and keeps coverage at 80%; in `"auto"` mode the same sheet is demoted as today;
  - `produceScenes` with `script` and the `MockProvider` returns scenes for every cue including the clip, and never requests `beat_sheet`;
  - `produceScenes` with both `script` and `clip` rejects.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run core tests and typecheck.** Expected: PASS; frozen prompt test unchanged.
- [ ] **Step 5: Commit** `feat: plan scenes from script cues`

---

### Task 5: Assembly honours a fixed clip duration

**Files:**
- Modify: `packages/core/src/assemble.ts` (the cue loop near the `MAX_SCENE_SEC` clamp)
- Test: `packages/core/test/assemble.test.ts`

**Interfaces:**
- Consumes: `SCENE_REGISTRY[component].fixedDurationSec` (Task 3).
- Produces: the assembler's existing result gains `shortened: { id: string; fromSec: number; toSec: number }[]`.

Decisions: for a cue whose component has `fixedDurationSec`, `endSec = startSec + duration` after the start has been pushed past the previous cue, before the 15 s and output-duration clamps; the minimum-length extension does not apply to it. Any cue (clip or not) whose length is reduced by the 15 s clamp is listed in `shortened`. Exclusivity stays: a following cue still starts after this one ends.

- [ ] **Step 1: Write the failing tests:** a 4.6 s `ClipScene` anchored to a 9 s word span ends 4.6 s after its start; a 20 s clip ends at 15 s and appears in `shortened`; a `TitleCard` after a clip whose 6 s run overlaps its first word starts `0.05` s after the clip ends; a 22 s word span on a `TitleCard` appears in `shortened`; existing fixtures produce no `shortened` entries.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, all existing assemble tests unchanged.
- [ ] **Step 5: Commit** `feat: clip scenes keep their own duration`

---

### Task 6: Clip import (transcode to VP9 alpha)

**Files:**
- Create: `apps/cli/src/clip-import.ts`
- Test: `apps/cli/test/clip-import.test.ts`

**Interfaces:**
- Consumes: `run(bin, args, opts)` from `@ossclip/core`.
- Produces:

```ts
export const MAX_CLIP_BYTES = 500_000_000;
export class ClipImportError extends Error {}
/** Absolute path of a `clip:` cue, or throws naming the path. Pure. */
export function resolveClipPath(scriptPath: string, clipPath: string): string; // must stay inside dirname(scriptPath)
/** Pure. */
export function clipTranscodeArgs(src: string, out: string): string[];
/** Project-relative output name. Pure. */
export function clipOutputName(srcAbs: string, sizeBytes: number, mtimeMs: number): string; // `clips/<12 hex>.webm`
export interface ClipProbe { durationSec: number; hasAudio: boolean }
export async function importClip(
  srcAbs: string, publicDir: string,
  deps?: { run: typeof run; stat: (p: string) => Promise<{ size: number; mtimeMs: number }>; exists: (p: string) => boolean },
): Promise<{ src: string; durationSec: number }>;   // src is relative to publicDir
```

Decisions: `clipTranscodeArgs` = `-y -i <src> -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 -row-mt 1 -auto-alt-ref 0 -c:a libopus -b:a 128k <out>` (`-auto-alt-ref 0` is required for alpha with libvpx). Duration comes from `ffprobe -v error -show_entries format=duration -of csv=p=0`. An existing output file is reused (the name hashes path, size and mtime). Over 500 MB, a missing file, or a path outside the script folder (including through `..` or an absolute path) raises `ClipImportError` naming the path. `publicDir` is the directory the render bundles and the editor serves; Task 7 passes the same one the `ScreenshotFrame` copy uses.

- [ ] **Step 1: Write the failing tests:** `resolveClipPath("/s/script.md", "clips/a.mov")` → `/s/clips/a.mov`; `"../x.mov"` and `"/etc/x.mov"` throw naming the path; `clipTranscodeArgs` contains `yuva420p`, `libvpx-vp9`, `-auto-alt-ref`, `0` and ends with the output; `clipOutputName` is stable for equal inputs and differs when mtime differs; `importClip` with fake deps calls ffmpeg once, returns the probed duration, and skips ffmpeg when the output exists; a 600 MB stat throws.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: One real check** (not a unit test): transcode `/mnt/c/Users/ahsanayaz/Videos/EGM/egm_steps_alpha_sfx.mov` with the built args into the scratch directory and confirm `ffprobe -show_entries stream=codec_name,pix_fmt` reports `vp9`, and `ffprobe -show_entries stream_tags=alpha_mode` reports `1`. Record the encode time in the commit body. Skip with a note if the file is absent.
- [ ] **Step 6: Commit** `feat: import transparent clips as VP9 alpha`

---

### Task 7: `ClipScene` rendering

**Files:**
- Create: `packages/scenes/src/components/ClipScene.tsx`
- Modify: `packages/scenes/src/SceneLayer.tsx` (`COMPONENTS` map; scrim), `packages/scenes/src/fit.ts` (metrics entry), `packages/core/src/browser.ts` if the registry flags are not already reachable from `@ossclip/core/browser`
- Test: `packages/scenes/test/clip-scene.test.ts`, `packages/scenes/test/fit.test.ts`

**Interfaces:**
- Consumes: `ClipSceneProps` and `SCENE_REGISTRY[id].scrim` (Task 3).
- Produces: `ClipScene` React component with the standard scene component props; `export function clipVolume(gainDb: number, muted: boolean): number` (pure: `muted ? 0 : 10 ** (gainDb / 20)`).

Decisions: render `<OffthreadVideo src={staticFile(props.src)} transparent volume={clipVolume(...)} />` filling its slot with `objectFit: "contain"`; in the editor's Player, Remotion's `OffthreadVideo` falls back to a `<video>` element, which plays VP9 alpha. The scrim is drawn only when the layout is over video **and** the component's `scrim !== false`. `ClipScene` has no editable text elements. Its fit metrics report "no scaling": it always fills the slot.

- [ ] **Step 1: Write the failing tests:** `clipVolume(-13, false)` ≈ `0.2239` (4 dp); `clipVolume(0, true)` is `0`; the fit metrics for `ClipScene` return scale 1 for any slot; a pure helper `drawsScrim(layout, component)` is true for `("full-bleed","TitleCard")` and false for `("full-bleed","ClipScene")` and `("graphic-only","TitleCard")`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, extracting `drawsScrim` from the inline `overVideo` check in `SceneLayer.tsx`.
- [ ] **Step 4: Run scenes tests, typecheck, and `pnpm build`** (the editor bundle must still build with the new component). Expected: PASS.
- [ ] **Step 5: Commit** `feat: render clip scenes with transparency`

---

### Task 8: CLI wiring, report, storage, Re-plan

**Files:**
- Create: `apps/cli/src/script-mode.ts`
- Modify: `apps/cli/src/program.ts` (flag), `apps/cli/src/produce.ts` (wiring at the planning call near `produceScenes(provider!, {` — the non-clip call), `apps/cli/src/replay-argv.ts`, `packages/core/src/schema.ts` (`ProductionSchema`), `apps/cli/src/edit.ts` (Re-plan), `docs/PHASE1-FINDINGS.md` (§158), `README.md` flag table if one lists produce flags
- Test: `apps/cli/test/script-mode.test.ts`, existing `apps/cli/test/replay-argv*.test.ts`

**Interfaces:**
- Consumes: `parseScript`, `alignCues`, `AlignedCue`, `SkippedCue`, `ScriptPlanInput`, `ResolvedClip`, `SCRIPT_PLAN_PROMPT_VERSION`, `resolveClipPath`, `importClip`, the assembler's `shortened`.
- Produces:

```ts
// apps/cli/src/script-mode.ts
export type CueOutcome =
  | { cueId: string; line: number; text: string; status: "placed"; component: string; startSec: number }
  | { cueId: string; line: number; text: string; status: "skipped"; reason: string; score?: number }
  | { cueId: string; line: number; text: string; status: "shortened"; component: string; startSec: number; fromSec: number; toSec: number }
  | { cueId: string; line: number; text: string; status: "reported"; reason: "screen recording" };
export function cueOutcomes(parts: {…cues, aligned, skipped, scenes, cues-with-times, shortened}): CueOutcome[]; // pure
export function formatCueReport(outcomes: readonly CueOutcome[]): string; // pure, one line per cue + a summary line
export function scriptPlanCacheKey(parts: { promptVersion: string; scriptText: string; keptWords: string; clipNames: string[] }): string;
// ProductionSchema gains: script: z.object({ text: z.string(), sourcePath: z.string().optional() }).optional()
```

Decisions:
- `--script <file>`: validated with zod as a non-empty string; the file is read once; an unreadable file fails before any transcription with `script file not found: <path>`. `--script` with `--clip` or `--scenes` is an error naming both flags.
- Order inside `produce`: parse the script → after the cutlist exists, `alignCues(cues, transcript, cutWordIndices)` → import each aligned clip cue with `importClip` into the render's public dir (the directory the existing `ScreenshotFrame` side-image copy targets) → `produceScenes(…, script: { aligned, clips })`.
- The plan is cached in the workdir like the beat sheet, keyed by `scriptPlanCacheKey`.
- The report prints after planning and before rendering (so `--review` shows it too), and is written to `<workdir>/script-report.json` as `{ outcomes }`.
- `production.json` stores `script.text` and `script.sourcePath`. Replay argv includes `--script <sourcePath>`. The editor's Re-plan passes the **stored text** (written to `<workdir>/script.md` and pointed to with `--script`), so it works when the original file is gone; clip paths resolve against `dirname(sourcePath)`, and a missing clip file whose WebM already exists in the project is reused.
- `§158` in `docs/PHASE1-FINDINGS.md` records: why the planner's `sceneKind` is a frozen subset, the 0.6 floor and what it was measured on (Task 9 fills in the numbers), `-auto-alt-ref 0`, and the deferral of the 16:9 geometry.

- [ ] **Step 1: Write the failing tests:** `cueOutcomes` produces one outcome per parsed cue in script order, covering each status; `formatCueReport` prints `placed 17 of 20 · skipped 2 · reported 1` style summary and one line per cue with its script line number; `scriptPlanCacheKey` changes when the script text, kept words or prompt version change; replay argv round-trips `--script`; `ProductionSchema` parses with and without `script`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the pure pieces, then the wiring.
- [ ] **Step 4: Prove it end to end without an LLM.** Using the `verify-ossclip` skill's fixture flow (`pnpm fixture`, mock provider), add a fixture script whose spoken lines are the fixture's known words, run `produce --script` with the mock provider, and assert in a test under `apps/cli/test/` that `production.json` has one scene per cue and `script-report.json` lists them as placed. Follow the pattern of the existing produce-driving tests, including their skip when ffmpeg is absent.
- [ ] **Step 5: Run `pnpm test`, `pnpm typecheck`, `pnpm build`.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: ossclip produce --script`

---

### Task 9: Acceptance on the EGM video (main session, not delegated)

- [ ] Write `EGM/egm-script-clips.md` beside the clips in `/mnt/c/Users/ahsanayaz/Videos/EGM/`: the fixture script with each cue rewritten as `🎬 clip: <file>_alpha_sfx.mov` for the shot it corresponds to (mapping from the playbook's shot table), and spoken lines updated to what was recorded where the recording departed from the script.
- [ ] Run `ossclip produce "<raw footage>" --script … --aspect 16:9 --no-captions --no-watermark --review` and read the cue report.
- [ ] Check the acceptance bars from the spec: at least 22 of 24 cues placed; each scene starts within 0.5 s of its line; clips show with transparency in the editor preview and in a render; the same footage without `--script` yields the same plan as before this branch.
- [ ] Record measured alignment scores in `§158`. If the 0.6 floor wrongly skips or wrongly places a cue, stop and report to the author rather than tuning silently.
