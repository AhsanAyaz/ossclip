# Reveal Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Graphics enter on cue (just before their content is spoken), list items appear when spoken or on a paced curve, with per-scene speed, pacing curve and entrance style — for new plans only.

**Architecture:** A pure matcher in core locates each graphic's text in the moment's transcript window at PLAN time and stores the result on the `Scene` (`scene.cue`). `assembleScenes` turns that into an on-cue `startSec` and absolute per-item output times on the `SceneCue` (`cue.reveal`). A shared scenes helper turns cue + reveal props into per-item entrance progress for FlowDiagram, ChatMock, TerminalMock and StrikethroughReveal. Scenes without `scene.cue` (every plan made before this ships) take today's path byte-identically.

**Tech Stack:** TypeScript, zod v4, Remotion (React), vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-11-04-reveal-timing-design.md` — read it first; its "Decisions" and "Builder-check answers" sections supersede earlier sections where they conflict.

## Global Constraints

- New plans only: a `Scene` without `cue` must assemble and render exactly as today (spec decision 1). A regression test pins this.
- Never move a scene's END, the 15s `MAX_SCENE_SEC` cap, de-overlap, or the min-duration floors (spec anti-goals). Only `startSec` moves.
- A scene with a `timing` override is never re-cued (already true: pins apply after assembly — keep it so).
- Matching is confined to the moment's own word window `[anchor.startWord, anchor.endWord]`.
- Constants (spec, my calls): `ENTRY_LEAD_SEC = 0.3`, `ITEM_LEAD_SEC = 0.15`, `SYNC_MIN_SHARE = 2/3`, `REVEAL_SPEED_DEFAULT = 0.66`, `revealSpeed` range `0.1–1.0`.
- Legacy stagger to preserve exactly: FlowDiagram chip `i*6`, arrow `i*6+3`; ChatMock `i*8`; TerminalMock `i*6`; StrikethroughReveal `i*6` (frames).
- The LLM never sees `reveal` / `pacing` / `revealSpeed` / `entrance`.
- `PRODUCER_PROMPT_VERSION` goes `"v2"` → `"v3"` (spec decision 2 accepts the re-plan this causes).
- House style: comments explain why and cite the spec; pure logic separate from React/I/O; user-facing values parsed with zod.
- Green before done: `pnpm test` from repo root (NOT `pnpm --filter … test`, which is a no-op), `pnpm typecheck`, and the editor Playwright e2e.

## Review Focus

1. **A matched word removed by a cut** (cleanup or user cut): `map.mapWord` returns null → that item is treated as unmatched (interpolated), and an entry word that was cut falls to the next matched item, never to a nonsense time. → Task 4 test.
2. **Stop-word or tiny labels** ("AI", "IT", "THE") matching any occurrence: single-token items shorter than 3 letters or in the stop list never match on their own. → Task 1 test.
3. **Duplicate labels** (two chips "AI" or a repeated word): monotonic matching assigns the second chip the LATER occurrence. → Task 1 test.
4. **On-cue start leaves too little screen time**: entry near the moment's end must pull back so the existing floor holds, never earlier than the moment's start. → Task 4 test.
5. **Old scene + reveal prop set in the editor**: a legacy scene (no `cue.reveal`) whose author sets `pacing`/`revealSpeed`/`entrance` must switch to the paced path, not ignore the control. → Task 5 test.

---

### Task 1: The matcher (core, pure)

**Files:**
- Create: `packages/core/src/reveal-match.ts`
- Modify: `packages/core/src/index.ts` (and `browser.ts` if scenes need it — they don't; core-only)
- Test: `packages/core/test/reveal-match.test.ts`

**Interfaces:**
- Produces:
  - `locateSpoken(items: readonly string[], words: readonly { text: string }[], window: { startWord: number; endWord: number }): (number | null)[]` — per item, the source word index where it is first spoken, monotonic (item i+1's index ≥ item i's).
  - `syncDecision(matches: readonly (number | null)[]): "synced" | "paced"` — synced iff `matches[0] !== null` and matched share ≥ `SYNC_MIN_SHARE`.
  - `revealItemTexts(component: SceneComponentId, props: Record<string, unknown>): string[] | null` — FlowDiagram `nodes`; ChatMock `messages[].text`; TerminalMock one string per window = `[title, ...lines].join(" ")`; StrikethroughReveal `lines[].text`; null for every other component.
  - `entryTexts(component, props): string[]` — the texts whose first spoken occurrence defines the entry: the item texts for the four, plus single-text fields for others (TitleCard `title`/`emphasis`, ScreenshotFrame `label`, ChatMock `keyword`, StatCard `label`/`value`, RuleCard `kicker`/`text`, BulletList `items`). Missing fields skipped.
  - `export const SYNC_MIN_SHARE = 2 / 3;`

Matching rule (the spec leaves exact normalization to you; this is the bar): lowercase, strip punctuation, collapse plural/-ed/-ing suffixes; drop stop words; an item's content tokens must appear in order within a span of `tokens + 2` words; an item with ONE content token needs it ≥ 3 letters; an item with no content tokens never matches. A candidate whose start precedes the previous item's match is skipped (keep searching forward).

- [ ] **Step 1: Write failing tests** in `reveal-match.test.ts`, on a word list built from the field take's scene-16 window: `"the way I was able to do this was to build a framework myself which stops me from creating more projects or even if I'm having some amazing ideas"`:
  - `locateSpoken(["NEW IDEA","FRAMEWORK","BLOCKED"], words, all)` → `[null, <index of "framework">, null]` and `syncDecision` of that → `"paced"`.
  - `locateSpoken(["FRAMEWORK","IDEAS"], …)` → both matched, increasing; `syncDecision` → `"synced"`.
  - Duplicate: words `"AI writes code then AI reviews code"`, items `["AI WRITES","AI REVIEWS"]` → second index > first.
  - Stop/tiny: items `["IT","THE"]` on any text → `[null, null]`.
  - Window confinement: a match outside `window` returns null.
  - Order: items `["IDEAS","FRAMEWORK"]` (reverse of speech) → `[idx("ideas"), null]`.
  - `revealItemTexts("TerminalMock", {windows:[{title:"PROJECT-A",lines:["npm start"]}]})` → `["PROJECT-A npm start"]`; `revealItemTexts("StatCard", …)` → `null`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/reveal-match.test.ts` from repo root — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the five exports in `packages/core/src/reveal-match.ts`; export from `packages/core/src/index.ts`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): locate a graphic's words in its moment (reveal matcher)`.

---

### Task 2: Reveal props on the four components, hidden from the LLM

**Files:**
- Modify: `packages/core/src/scene-registry.ts` (FlowDiagramProps, ChatMockProps, TerminalMockProps, StrikethroughRevealProps)
- Modify: `packages/core/src/producer/scene-props.ts:79-90,178` (both places the props schema reaches the LLM)
- Modify: `packages/core/src/scene-props-controls.ts` (number kind)
- Test: `packages/core/test/reveal-props.test.ts`

**Interfaces:**
- Produces:
  - `RevealPropsShape` spread into each of the four schemas: `reveal: z.enum(["auto","synced","paced"]).optional()`, `pacing: z.enum(["even","accelerate","decelerate","ease-in-out"]).optional()`, `revealSpeed: z.number().min(0.1).max(1).optional()`, `entrance: z.enum(["pop","fade","rise","bounce"]).optional()`. All OPTIONAL with no `.default()` — absence is how the renderer recognises "author never touched it" (Review Focus 5).
  - `REVEAL_PROP_KEYS: readonly ["reveal","pacing","revealSpeed","entrance"]`
  - `llmPropsSchema(component: SceneComponentId): z.ZodType` — the registry schema with `REVEAL_PROP_KEYS` omitted (`.omit` on the z.object); used by both LLM call sites in `scene-props.ts`. Parsing the LLM's output still uses the full schema.
  - `PropControl` gains `{ kind: "number"; key; min: number; max: number; step: number; fallback: number }`; `scalarPropControls` emits it for numeric props with min/max (`step 0.05`, `fallback` = `REVEAL_SPEED_DEFAULT` for `revealSpeed`). Enum props already get dropdowns (§153) — the dropdown must offer an "unset" option so an author can return to auto; check how the existing enum control handles an unset value and match it.

- [ ] **Step 1: Write failing tests:**
  - each of the four schemas parses `{...validProps, pacing:"accelerate", revealSpeed:0.5, entrance:"bounce"}` and rejects `revealSpeed: 1.5` and `pacing: "fast"`;
  - `JSON.stringify(z.toJSONSchema(llmPropsSchema("FlowDiagram")))` contains none of the four keys, and still contains `nodes`;
  - `scalarPropControls("FlowDiagram")` contains `{key:"revealSpeed",kind:"number",min:0.1,max:1}` and enum controls for `reveal`, `pacing`, `entrance`;
  - `scalarPropControls("StatCard")` gains nothing (no reveal keys).
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/reveal-props.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as above; export `REVEAL_PROP_KEYS`, `llmPropsSchema`, `REVEAL_SPEED_DEFAULT = 0.66` from core (index + browser entry, since the editor and scenes read them).
- [ ] **Step 4: Run** the test file, then `pnpm vitest run packages/core/test` — Expected: PASS; any existing prop-call cache-key test that hashes the schema text must still pass unchanged (the LLM-facing schema is unchanged by construction).
- [ ] **Step 5: Commit** `feat(scenes): reveal, pacing, speed and entrance props (author-only)`.

---

### Task 3: Plan-time cue (`cueWord`, `scene.cue`, prompt v3)

**Files:**
- Modify: `packages/core/src/producer/beats.ts` (MomentSchema, prompt text near line 153, `PRODUCER_PROMPT_VERSION`, the moment validation loop near 390)
- Modify: `packages/core/src/scene-schema.ts` (SceneSchema)
- Modify: `packages/core/src/producer/scene-props.ts` (`generateScenes`, both `scenes.push` sites)
- Test: `packages/core/test/scene-cue.test.ts`

**Interfaces:**
- Consumes: Task 1 `locateSpoken`, `syncDecision`, `revealItemTexts`, `entryTexts`.
- Produces:
  - `MomentSchema.cueWord: z.number().int().nonnegative().optional().describe("word index where the graphic should appear — where its content is first said; omit if it is the moment's first word")`.
  - Validation: a `cueWord` outside `[startWord, endWord]` is dropped (deleted from the moment) with an issue pushed, not a failure.
  - `SceneSchema.cue: z.object({ entryWord: z.number().int().nonnegative(), itemWords: z.array(z.number().int().nonnegative().nullable()).optional() }).optional()` with a why-comment citing spec §7.
  - `planCue(component, props, moment, words): Scene["cue"]` (exported from `scene-props.ts`, pure): `itemWords` = `locateSpoken(revealItemTexts(...))` when non-null; `entryWord` = earliest non-null of (`itemWords`, `locateSpoken(entryTexts(...))`), else `moment.cueWord`, else `moment.startWord`. Every NEW scene (including the TitleCard fallback) gets a `cue`.
  - Prompt line added to the rules list: `- CUE: set \`cueWord\` to the word where the graphic's content is first said — the payoff phrase, not the start of the topic. The moment still spans the whole beat; only the graphic's entrance moves.`
  - `PRODUCER_PROMPT_VERSION = "v3"`; update its comment with the date and reason.

- [ ] **Step 1: Write failing tests:** `planCue` on the field scene-16 window with nodes `["NEW IDEA","FRAMEWORK","BLOCKED"]` → `entryWord` = index of "framework", `itemWords[1]` = same; ScreenshotFrame `{label:"SKILLS THAT STILL MATTER"}` with `moment.cueWord = k` → `entryWord === k` (the label must not match: "matter" is never said); a moment with `cueWord` 5 words past `endWord` → validation drops it and `planCue` returns `entryWord === moment.startWord`; `MomentSchema` parses an old moment without `cueWord`; `SceneSchema` parses an old scene without `cue`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/scene-cue.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** the file, then `pnpm vitest run packages/core/test` — Expected: PASS. A test asserting the prompt version or prompt snapshot will need its expected value updated to v3 — that is intended; any other failure is not.
- [ ] **Step 5: Commit** `feat(producer): plan where each graphic enters (cueWord, scene.cue, prompt v3)`.

---

### Task 4: On-cue start and item times in `assembleScenes`

**Files:**
- Modify: `packages/core/src/assemble.ts`
- Modify: `packages/core/src/scene-schema.ts` (SceneCueSchema)
- Modify: `packages/core/src/retime-preview.ts` (`retimeForPreview`'s sceneCues branch, ~line 402)
- Test: `packages/core/test/assemble.test.ts` (extend), `packages/core/test/retime-preview.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3 `Scene.cue`.
- Produces:
  - `SceneCueSchema.reveal: z.object({ itemAtSec: z.array(z.number().nonnegative().nullable()) }).optional()` — ABSOLUTE output seconds per item (spec "Builder-check answers": items stay on their words wherever the final start lands; split halves inherit via `...cue`).
  - `ENTRY_LEAD_SEC = 0.3`, `ITEM_LEAD_SEC = 0.15` (exported from assemble.ts).
  - In `assembleScenes`, ONLY when `scene.cue` is present:
    - `startSec = max(momentStartOut, mapped(entry word).start - ENTRY_LEAD_SEC)`, where the entry word is `cue.entryWord`, or if that word was cut, the first later non-null `itemWords` entry whose word survives, else the moment start (Review Focus 1).
    - Floor: if `endSec - startSec < minScene`, move `startSec` back to `endSec - minScene`, never before `momentStartOut`. This runs BEFORE the existing de-overlap/floor loop, which is unchanged.
    - `reveal.itemAtSec[i] = mapped(itemWords[i]).start - ITEM_LEAD_SEC`, or null when unmatched or cut. Omit `reveal` when `itemWords` is absent.
  - `retimeForPreview` remaps each non-null `itemAtSec` with the same old-output → new-output mapping it uses for the cue's own start (null stays null; a point without preimage clamps the way `startSec` does).

- [ ] **Step 1: Write failing tests** in `assemble.test.ts`:
  - **legacy byte-identical:** a fixture plan of 3 scenes without `cue` → `assembleScenes` result deep-equals a snapshot taken from the CURRENT code before you change it (record it first, inline as a literal);
  - on-cue: a 10s moment whose `cue.entryWord` is at 7.0s → `startSec ≈ 6.7`, `endSec` unchanged from the legacy result;
  - floor: entry word 0.5s before the moment's end → `startSec = endSec - MIN_SCENE_SEC` (1.2), and never < moment start;
  - cut entry word: the entry word inside a cut → start falls to the next surviving item word minus the lead;
  - `reveal.itemAtSec` absolute: items at 7.0s/8.5s → `[6.85, 8.35]`; a cut item word → `null`.
  - In `retime-preview.test.ts`: a cue with `reveal.itemAtSec` through a recut that removes 1s before it → every non-null value shifts by −1s.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/assemble.test.ts packages/core/test/retime-preview.test.ts` — Expected: new tests FAIL, snapshot test PASSES (recorded against current code).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `pnpm vitest run packages/core` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(assemble): graphics enter on cue; items keep their spoken times`.

---

### Task 5: The shared reveal schedule (scenes, pure + hook)

**Files:**
- Create: `packages/scenes/src/reveal.ts`
- Modify: `packages/scenes/src/anim.ts` (entrance styles)
- Test: `packages/scenes/test/reveal.test.ts`

**Interfaces:**
- Consumes: Task 2 prop names/enums and `REVEAL_SPEED_DEFAULT`; Task 4 `SceneCue.reveal`.
- Produces:
  - `revealFrames(input: { count: number; legacyStepFrames: number; fps: number; durationInFrames: number; cueStartSec: number; itemAtSec?: readonly (number | null)[]; props: { reveal?: string; pacing?: string; revealSpeed?: number } }): number[]` — per-item delay in frames from the cue's first frame, each ≥ 0. Rules:
    - **Legacy:** no `itemAtSec` AND none of `reveal`/`pacing`/`revealSpeed` set → `i * legacyStepFrames` exactly.
    - **Synced:** `reveal` is `"synced"`, or `"auto"`/unset with `itemAtSec` passing `syncDecision`-equivalent share (≥ 2/3 non-null, first non-null) → `round((itemAtSec[i] - cueStartSec) * fps)` clamped ≥ 0 (a word before the final start → 0, visible from the first frame); null items interpolated between their matched neighbours; trailing nulls continue at the paced gap.
    - **Paced:** otherwise → items spread over `revealSpeed ?? REVEAL_SPEED_DEFAULT` × `durationInFrames`, first item at 0, shaped by `pacing ?? "even"`: `even` equal gaps; `accelerate` gaps strictly shrinking; `decelerate` gaps strictly growing; `ease-in-out` first and last gaps longer than the middle ones. Curve formulas are yours.
  - `useReveal(delays: readonly number[]): number[]` — progress 0→1 per item via `useEnter(delay)`.
  - `entranceStyle(style: "pop" | "fade" | "rise" | "bounce" | undefined, progress: number): CSSProperties` in `anim.ts`; `undefined` → today's `pop`. Bounce mechanics are yours (spring overshoot or keyframes); the progress it takes is the same 0→1.

- [ ] **Step 1: Write failing tests:** legacy `count 4, step 6` → `[0,6,12,18]`; Review Focus 5: same input with `props.pacing:"even"` and `durationInFrames 300` → NOT `[0,6,12,18]`, last delay ≈ `0.66*300`; synced `itemAtSec [10.0, 11.0, 12.5]`, `cueStartSec 9.5`, fps 30 → `[15, 45, 90]`; word before start `itemAtSec [9.0, …]` → first `0`; synced with a middle null → value strictly between neighbours; each pacing curve's gap property above; `revealSpeed 1.0` → last delay ≤ `durationInFrames`; `entranceStyle(undefined, 0.5)` deep-equals `pop(0.5)`.
- [ ] **Step 2: Run** `pnpm vitest run packages/scenes/test/reveal.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(scenes): one reveal schedule for every staggered graphic`.

---

### Task 6: Wire the four components and SceneLayer

**Files:**
- Modify: `packages/scenes/src/SceneLayer.tsx:220-230` (pass timing to the component)
- Modify: `packages/scenes/src/components/FlowDiagram.tsx`, `ChatMock.tsx`, `TerminalMock.tsx`, `StrikethroughReveal.tsx`
- Test: `packages/scenes/test/reveal-wiring.test.ts`

**Interfaces:**
- Consumes: Task 5 `revealFrames`, `useReveal`, `entranceStyle`.
- Produces: components accept an optional `timing?: { cueStartSec: number; durationInFrames: number; itemAtSec?: (number | null)[] }`. SceneLayer passes `{ cueStartSec: cue.startSec, durationInFrames, itemAtSec: cue.reveal?.itemAtSec }`. Each component replaces its hand-written `delay={i * N}` with `revealFrames({... legacyStepFrames: N ...})[i]`; FlowDiagram's arrow stays `chipDelay + 3`. Components without `timing` (tests, direct use) behave as legacy. Entrance uses `entranceStyle(props.entrance, p)` where the component used `pop`/`rise` before — keep each component's current style as its `undefined` default (pass it as the fallback so FlowDiagram stays `pop`, and any component that used `rise` stays `rise`).

- [ ] **Step 1: Write failing tests:** for each of the four, the per-item delays the component would use (export a small pure `itemDelays(props, timing, fps)` per component, or test via `revealFrames` with the component's `legacyStepFrames`) equal the legacy constants when `timing` is absent, and the synced values when `timing.itemAtSec` is given; ChatMock with `keyword` still passes the existing `applyCtaKeyword` tests in `flow.test.ts`.
- [ ] **Step 2: Run** `pnpm vitest run packages/scenes` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run packages/scenes` and `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(scenes): FlowDiagram, ChatMock, TerminalMock, StrikethroughReveal reveal on cue`.

---

### Task 7: Editor — speed slider, live preview

**Files:**
- Modify: `apps/editor/src/Inspector.tsx:1103-1140` (render the `number` control kind)
- Test: editor Playwright spec alongside the existing prop-control tests (find the one asserting `data-testid="prop-kenBurns"` and add beside it)

**Interfaces:**
- Consumes: Task 2 `PropControl` number kind.
- Produces: a range input `data-testid="prop-revealSpeed"` (min/max/step from the control; value = `cue.props.revealSpeed ?? control.fallback`) writing through `edits.patchProps(sceneId, { revealSpeed })` with a coalesce key so one drag is one undo step (the convention the other sliders follow — see the sfx gain slider ~line 641). Enum controls `prop-reveal`, `prop-pacing`, `prop-entrance` already render.

- [ ] **Step 1: Write the failing e2e:** select a FlowDiagram scene in the fixture project, change `prop-pacing` to `decelerate` and drag `prop-revealSpeed`; assert the saved `overrides.json` scene props carry `pacing:"decelerate"` and a `revealSpeed` in `[0.1, 1]`, and undo reverts the drag in one step.
- [ ] **Step 2: Run** the editor Playwright suite (kill any `ossclip edit` on port 5174 first; `pnpm build` so the served bundle is fresh) — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite — Expected: PASS.
- [ ] **Step 5: Commit** `feat(editor): reveal speed slider`.

---

### Task 8: Field verification and full green

**Files:**
- Create: `docs/verification/2026-11-04-reveal-timing/README.md` (+ copied artifacts)

- [ ] **Step 1: Baseline drive:** `.claude/skills/verify-ossclip/scripts/drive.sh` — Expected: every assertion PASS (the fixture has no scenes, so numbers must not move).
- [ ] **Step 2: Legacy proof:** copy the author's take workdir (`/Users/amu1o5/personal/VideoEditing/Videos/Stop Creating More Projects/.ossclip/26-11-04 16-14-25 3337-f5829057/`) to the scratchpad and run the editor-Render replay there (pinned `scenes-reviewed.json`, `--workdir` on the copy, NEVER the original, never writing next to the source video). Assert `render-props.json` `sceneCues[*].startSec/endSec` equal the current file's values.
- [ ] **Step 3: Fresh plan:** on another scratch copy, `produce --produce` with a real LLM. Pass bar from the spec: scene-12-equivalent ("SKILLS THAT STILL MATTER") enters at 99s ±1s; the "comment slot" ChatMock enters at 170s ±1s; the FlowDiagram is wholly synced or wholly paced; no scene ends earlier than the matching scene in the current `production.json`. Record before/after start times in the README.
- [ ] **Step 4: Full green:** `pnpm test`, `pnpm typecheck`, editor Playwright e2e — Expected: all pass; paste the counts into the README.
- [ ] **Step 5: Commit** `docs(verification): reveal timing on the 2026-11-04 field take`.
