# Editor Dogfood Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan was written for pickup by a fresh session** — it carries its own context; read this header fully before Task 1.

**Goal:** Fix the six defects found in the first serious dogfooding session of the editor (repo owner, real reel, 2026-08-04), the biggest being that the editor cannot remove any part of the video — the ROADMAP's parked "User cuts" item, now with a verdict attached: *"I can split a Take, but can't delete any of it. Which makes it useless."*

**The reporting session's artifacts, for repro:** workdir `/Users/amu1o5/Downloads/.ossclip/anthropic-ci-compiler-03857547` (a real 122s → 90s produce with `--blooper-marker blooper`, gemini→claude-cli provider). The six bugs, verbatim summaries:

1. A **silent chunk survived cleanup** into the output, and there is no way to cut it in the editor.
2. `--blooper-marker blooper` **never fired** because whisper transcribed the spoken "blooper" as **"looker"** — exact-match found nothing.
3. **Split a scene, deleted one half → both halves died** (scene-6 split into `scene-6` + `scene-6@36400`; deleting `scene-6` turned the whole region into plain takes).
4. **After deleting a scene, keyboard shortcuts go dead** until the window loses and regains focus.
5. **Takes can be split but not deleted** — same underlying gap as 1.
6. **Clicking the timeline does not blur the Inspector's text input** — shortcuts type into the field until tab-away.

**Verified code facts (checked against source on 2026-08-04, cite by symbol not line):**

- `packages/core/src/overrides.ts` → `effectiveOverride` documents that a split half inherits its root's overrides EXCEPT `timing` and `hidden` — "deleting the original is not deleting one half." Bug 3 proves the protection fails in practice. Prime suspect: `applyOverrides` drops a hidden scene's cue to a plain take BEFORE `splitCues` runs (splits are applied "after the plain fill"), so by the time splitting happens there is no `scene-6` cue to split — the exception in `effectiveOverride` never gets a say. Confirm order by reading `applyOverrides`/`splitCues` call sites in `apps/cli/src/produce.ts` and the edit server's live-doc path.
- `packages/core/src/blooper.ts` → `findBloopSpans` matches `normalizeToken(words[i].text) === normalizeToken(marker)` — exact only. `packages/core/src/phonetics.ts` already exports `soundsLike(a,b): number` and `soundsSimilar(a,b,floor)` (used by the repair pass). "blooper"→"looker" is Levenshtein distance 2 on normalized tokens.
- Editor keyboard shortcuts: the global `keydown` listener lives in `apps/editor/src/Overlay.tsx` (`window.addEventListener("keydown", …)`); `ShortcutsModal.tsx` and `ProjectPicker.tsx` have their own capture-phase listeners. `App.tsx` has none. Bug 4's shape: the handler (or its guard) ignores keys while `document.activeElement` is the Inspector's delete/restore `<button>`, which keeps focus after the click; window blur resets `activeElement` to body, which is why leaving the window "fixes" it. Bug 6 is the same guard working as designed against an input that nothing ever blurs.
- ROADMAP "Later" already names the user-cuts hazard: `splits` and pinned scene `timing` are stored in ABSOLUTE OUTPUT SECONDS, so any re-cut of the output silently shifts every stored decision after the cut point. `TimeMap` (`packages/core/src/timemap.ts`) is the property-tested output↔source mapping; remapping through source time is the designed way out.

## Global Constraints

- pnpm workspace; **no new dependency anywhere in this plan**. Relative imports carry no extension. `strict` + `noUncheckedIndexedAccess`. Package tsconfigs include only `src` — `pnpm typecheck` does NOT cover tests; read test types.
- Comments explain **why**, citing this plan or the findings that forced choices. No line numbers in anchors — symbols only.
- Suite is 873 passing at plan time; counts are direction, not assertion. Every task ends `pnpm test` + `pnpm typecheck` green before its commit.
- `overrides.json` stays user-owned and the producer must never write it. Any schema addition must be optional-with-default so existing files parse unchanged (zod `.default()` — match `OverrideDocSchema`'s existing style).
- Versions: check `apps/cli/package.json` at pickup. If 0.1.8 is published, this is 0.1.9; bump-last per CLAUDE.md.

---

### Task 1: deleting one split half must not delete the other (bug 3)

**Files:** `packages/core/src/overrides.ts` (and only if the order-of-application diagnosis demands it, the call sites in `apps/cli/src/produce.ts` / `apps/cli/src/edit.ts`); test appended to `packages/core/test/overrides.test.ts` (or the file that currently tests `applyOverrides`/`splitCues` — locate it).

- [ ] **Step 1: pin the bug.** Write the failing test first, from the field case: cues containing `scene-6`; overrides with `splits: [36.4]` and `scenes["scene-6"].hidden: true`. Run the SAME pipeline order production uses (read `produce.ts` to get it — likely `applyOverrides` → `fillPlainCues` → `splitCues`). Assert: the output contains a cue covering `scene-6@36400`'s window WITH its graphic intact. Expected today: FAIL — both halves are plain.
- [ ] **Step 2: diagnose which of the two orderings is broken** (hide-before-split vs `effectiveOverride` leaking `hidden` to the half) and fix the minimal one. The likely fix: `hidden` on a ROOT id must apply only to the root's own post-split segment (the half that still carries the bare id), never to `id@ms` halves — which may mean applying `hidden` after `splitCues`, or resolving hidden per-cue through `effectiveOverride` (which already implements the exception) instead of wherever it is short-circuited today.
- [ ] **Step 3:** second test: deleting the RIGHT half (`scenes["scene-6@36400"].hidden: true`) keeps the left intact. Third: deleting an UNSPLIT scene still works exactly as today (the Restore-scene flow in `Inspector.tsx` depends on it).
- [ ] **Step 4:** full suite; commit with the why (the comment in `effectiveOverride` promised this; the pipeline order broke the promise).

### Task 2: focus management — dead shortcuts after delete, sticky text input (bugs 4, 6)

**Files:** `apps/editor/src/Overlay.tsx` (the keydown guard), `apps/editor/src/Inspector.tsx` (destructive buttons), `apps/editor/src/Timeline.tsx` (background mousedown); test appended to `apps/editor/test/Overlay.test.ts` if the guard is pure enough to test, else a new jsdom test.

- [ ] **Step 1:** read the keydown handler's guard in `Overlay.tsx`. Confirm the bug-4 mechanism (keys ignored while a `<button>` holds focus). 
- [ ] **Step 2, bug 4:** after any destructive/mutating Inspector button (delete scene, restore, reset element), blur the button — `(document.activeElement as HTMLElement | null)?.blur?.()` in the click handler, with a why-comment naming this plan. Alternative if cleaner: narrow the guard to inputs/textareas/selects only, letting buttons keep focus but not eat shortcuts — decide by reading what else the button-guard protects (Enter/Space activating the focused button is the reason it exists; if so, blur-after-click is the right fix, not guard-narrowing).
- [ ] **Step 3, bug 6:** on timeline track/scene-block mousedown AND on player-area mousedown, if `document.activeElement` is an INPUT/TEXTAREA, blur it before handling. The Inspector's inputs commit on change/blur already — verify a click-away therefore commits rather than discards, and say so in the comment.
- [ ] **Step 4:** jsdom test for whichever pieces are testable (the guard function if extracted; the blur-on-mousedown via dispatched events). Full suite; commit.

### Task 3: fuzzy blooper marker (bug 2)

**Files:** `packages/core/src/blooper.ts`; test `packages/core/test/blooper.test.ts` (locate the existing one); `apps/cli/src/produce.ts` only for the report line.

**Design, decided:** stay deterministic — no LLM. Extend `isMarker` to accept a word when EITHER normalized-exact (today's rule) OR `soundsSimilar(word, marker)` from `phonetics.ts` OR Levenshtein ≤ 2 on normalized tokens when the marker is ≥ 6 chars (write the small distance function in `blooper.ts` if none exists in core — check first). **Every fuzzy hit must be reported**: `findBloopSpans` gains a per-span record of the matched surface forms, and produce's existing blooper report line (`formatBloopSpan` in core — locate) prints `matched "looker" ~ "blooper"` so a false positive is visible in `report.txt` instead of silently cutting a good take. That reporting requirement is why this is safe to ship on-by-default.

- [ ] **Step 1:** failing test with the field pair: transcript containing "looker" where the marker is "blooper" → one span found, `matched` records `"looker"`. Also a guard test: a marker of "cut" (3 chars) must NOT fuzzy-match "but"/"cat" — short markers stay exact-only.
- [ ] **Step 2:** implement; verify "blooper"/"looker" actually passes whichever predicate you rely on (phonetics may reject it — the b/l onset differs; if `soundsSimilar` fails the pair, the Levenshtein arm is the load-bearing one and the test proves it).
- [ ] **Step 3:** thread the matched forms into the report line. Full suite; commit.

### Task 4: user cuts — remove a range of the output, without drifting every stored decision (bugs 1, 5)

**This is the round's real feature and the reason the plan exists.** ROADMAP parked it with the hazard named; the dogfooding verdict unparks it. Its design is decided here at the level that matters; an executing session should re-read ROADMAP's "User cuts" entry, then build exactly this:

**Storage:** `OverrideDocSchema` gains `cuts: z.array(z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() })).default([])` — ranges in **the output seconds of the CURRENT render-props** (what the user saw when they cut). User-owned like everything in overrides.

**The core, pure, in `packages/core` (new module `recut.ts`):**

```ts
/** Re-anchor output-second decisions through source time across a re-cut.
 * Every stored absolute-output-seconds value (splits, pinned timing, cuts
 * recorded against an older output) maps old-output → source via the OLD
 * TimeMap, then source → new-output via the NEW TimeMap. A value whose
 * source moment was itself removed by the new cut maps to the cut's edge
 * and is reported, never silently dropped. */
export function remapOverridesThroughRecut(doc: OverrideDoc, oldMap: TimeMap, newMap: TimeMap): { doc: OverrideDoc; reports: string[] }
```

Property tests with fast-check (root devDep): remapping through an identity re-cut is the identity; a split strictly before the cut range is unchanged; one strictly after shifts by exactly the removed duration; one inside the range lands on the edge and reports. TimeMap already exposes the directional mappings — read `timemap.ts` for the exact function names before writing.

**The pipeline:** produce already rebuilds everything from the cutlist. Injection point: after the automatic cutlist is built and BEFORE assembly, subtract the user's `cuts` (mapped output→source through the CURRENT map) from the keep-spans — locate `buildCutlist` consumers in `produce.ts`. Then run `remapOverridesThroughRecut` so the rest of the overrides doc re-anchors, and write the remapped doc back (this is the ONE sanctioned write to `overrides.json`, because it is rewriting the user's own decisions to keep meaning them — say exactly that in the comment, and keep a `.bak` like `saveConfigPatch` does).

**The server:** the edit server's existing Render replays the recorded command (`command.json`) — cuts ride the overrides file, so NO new endpoint is needed for rendering. What is needed: `PUT /overrides` already exists; the editor just writes `cuts`. Verify the live-preview doc path (`edit.ts`) applies cuts to the in-editor `<Player>` timeline the same way splits are applied today — if live preview cannot cheaply re-derive the timeline, the honest v1 is: cuts show as marked-dead regions in the editor and take effect on the next produce/Render, with copy in the Inspector saying so. DECIDE by reading `edit.ts`'s live-doc flow; do not build a second EDL implementation in the browser.

**The editor UI:** on a selected plain TAKE (and any scene), Inspector gains "Delete this chunk" → writes the block's window into `cuts`. Split-then-delete becomes the cutting gesture — exactly what the reporter tried to do. Soft like scene deletes: a deleted region renders struck-through on the timeline with a Restore, backed by removing the range from `cuts`.

- [ ] Task 4a: `recut.ts` + property tests (pure, no UI).
- [ ] Task 4b: cutlist subtraction in `produce.ts` + the overrides rewrite-with-backup + report lines; verify on the repro workdir: add a cut over the silent chunk, re-run produce `--no-render`, confirm splits/pins landed re-anchored and the report says what moved.
- [ ] Task 4c: editor UI (Inspector button, timeline dead-region rendering, restore) + jsdom tests for the pure parts.

### Task 5: why did the silent chunk survive? (bug 1, diagnosis)

**Investigation, not implementation.** Using the repro workdir's `report.txt`, `production.json` and the cutlist artifacts: find the chunk (visible near a scene around 0:32 in the field report), determine whether it (a) sat inside a pinned/graphic scene window the cleaner refuses to cut, (b) was above the measured noise floor (fan/room tone measured hot), or (c) exposes a real cutlist bug. Outcome: a findings entry (next free § number, per ROADMAP convention) and — only if (c) — a fix task appended to this plan. Do not tune thresholds on one sample.

---

## Sequencing and sizing

1, 2, 3 are independent small fixes — land first, any order. 4a→4b→4c is the feature and dominates the round. 5 can run anytime (read-only). If the round needs to ship before 4c, note that 4b alone already gives CLI users cuts via hand-edited `overrides.json` — but the editor UI is the point, per the verdict.

## Self-Review

Bug→task mapping is total: 1→(4,5), 2→3, 3→1, 4→2, 5→4, 6→2. The only design leaps are Task 3's fuzzy-with-reporting rule and Task 4's storage/remap design — both stated with their reasoning and their tests, both grounded in code that exists (`phonetics.ts`, `TimeMap`). Facts an executing session must re-verify rather than trust: the applyOverrides/splitCues ordering (Task 1 Step 2 says diagnose, not assume), the TimeMap function names, and whether live preview can re-derive a cut timeline (Task 4's DECIDE). Nothing here touches the closed component enum, grounding, or the producer prompts.
