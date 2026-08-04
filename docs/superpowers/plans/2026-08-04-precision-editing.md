# Precision Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **(corrected, final-review fix wave):** the spec this plan was built from carried two errors, both corrected in place at `docs/superpowers/specs/2026-08-04-precision-editing-design.md`. (1) Its frames-readout section assumed an existing transport current/total time display for `formatTimecode` to share units with — there was none; this was caught and adjudicated during Task 2's execution, not here, and the drag readout that actually shipped is a new UI element kept because it serves the user's complaint directly. (2) Its `guideSnap` signature (`handle: BoxHandle | "move", frame: FrameSize`) drifted from what shipped (`handle: BoxHandle, safe: SafeArea`) during Task 3. Neither correction changes any task below — see the spec for what actually shipped.

**Goal:** Timeline snapping, a `min:sec:frame` readout, centre + safe-area overlay guides, and the picker rebuilt around one visible scroll region.

**Architecture:** Pure cores first (`timing.ts`, a `guides.ts` beside `hitTest.ts`), UI wiring second. Snap runs BEFORE the existing clamps, which remain the single authority on legality. Spec: `docs/superpowers/specs/2026-08-04-precision-editing-design.md` — read it before any task.

**Tech Stack:** TypeScript (ESM), React, vitest. No new dependencies.

## Global Constraints

- pnpm workspace, never `npm install`. **No dependency may be added.**
- Relative imports carry no file extension. `strict` + `noUncheckedIndexedAccess` are on. Editor tsconfig includes only `src` — `pnpm typecheck` does NOT cover test files; read test types.
- Comments explain **why**, citing the spec or feedback where it forced a choice.
- **Parity invariant:** with snapping inactive (Alt held / outside threshold), drags are byte-identical to 0.1.7. The existing `apps/editor/test/timing.test.ts` (if present) and `transport/Overlay/hitTest` tests must pass UNTOUCHED — needing to edit one is a finding to report, not an update to make.
- Pure logic separated from I/O: no test needs a TTY, network, or real `$HOME`.
- Every task ends `pnpm test` + `pnpm typecheck` green before its commit. Suite is 834 at plan start; counts are direction, not assertion.
- **Line numbers in this plan are not cited on purpose** — locate anchors by symbol (`moveTiming`, `applyBoxHandle`, `entryList`). Previous rounds proved cited numbers stale by execution time.

---

### Task 1: the pure timeline core — `snapTargets`, `applySnap`, `formatTimecode`

**Files:** modify `apps/editor/src/timing.ts`; test `apps/editor/test/snap.test.ts` (new — do NOT touch any existing timing test file).

**Interfaces produced:**

```ts
export function snapTargets(
  cues: readonly SceneCue[], sceneId: string,
  playheadSec: number, durationSec: number,
): number[]
// All OTHER stored (non-plain) cues' startSec/endSec, plus playheadSec, plus 0
// and durationSec. Excludes the dragged scene's own edges. Sorted ascending,
// deduplicated within 1e-6.

export function applySnap(
  sec: number, targets: readonly number[], thresholdSec: number,
): { sec: number; snapped: number | null }
// Nearest target within threshold wins; exact tie → the EARLIER target
// (deterministic). No targets / threshold <= 0 → passthrough with snapped: null.

export function formatTimecode(sec: number, fps: number): string
// "m:ss:ff". ff = Math.floor((sec - Math.floor(sec)) * fps) — floor, never
// round: rounding at 29.97 yields ff === fps, a timecode that does not exist.
// Negative sec clamps to 0. fps <= 0 → `${sec.toFixed(1)}s` (seconds-only guard).
```

**Required tests (write first, watch fail, then implement):** targets exclude the dragged scene's own edges and include neighbours/playhead/bounds; dedup; applySnap at/inside/outside threshold; the tie rule; passthrough cases; `formatTimecode(0,30)==="0:00:00"`, `(1.5,30)==="0:01:15"`, minute rollover `(61,30)==="1:01:00"`, **the floor trap**: `(0.9999,30)==="0:00:29"` not `0:00:30`; negative clamp; fps guard. Match the existing `timing.ts` house style — pure, documented with why.

**Commit** with a message explaining the tie rule and the floor trap in the repo's voice.

---

### Task 2: wire the timeline — snap on both drag kinds, the tick, the readout

**Files:** modify `apps/editor/src/Timeline.tsx` (and `App.tsx` only if the transport readout lives there — locate the current time display that uses `live.settings.fps`). No new test file: the logic is Task 1's; the wiring is guarded by existing suites staying green. Report — do not fix — anything that forces an existing test to change.

**Contract:**

- Threshold: `8 / pxPerSec` where `pxPerSec` is the track's current pixels-per-second (derive from the same values the existing drag math uses — scroller width × zoom / duration). Compute per pointer-move, so zoom changes what snaps.
- **Body drag:** compute proposed `start' = start + delta`, `end' = end + delta`; run `applySnap` on both against `snapTargets(...)`; take whichever snapped correction is smaller in magnitude (nearest edge wins); apply the corrected delta through the EXISTING `moveTiming` — snap before clamp, clamp stays authoritative.
- **Edge drag:** `applySnap` the dragged edge only, then the existing `clampTiming`.
- **Alt/Option held** (`event.altKey`) skips `applySnap` entirely — the pure core never reads modifier state.
- **Tick:** while `snapped !== null`, render a 1-px vertical line at the snapped time in the accent `#FFE14D`, via the existing `dragPreview` state channel (extend its shape; do not add a parallel state).
- **Readout:** the transport's current/total time display and the drag preview's numbers switch to `formatTimecode(sec, fps)`. Locate every place the transport formats seconds; change the FORMAT only, never the underlying seek/seconds math.

**Manual verification (required, paste output):** `pnpm ossclip edit --no-open --port <free>` against a produced fixture workdir, Playwright: drag a block near a neighbour edge, evaluate the committed `startSec` equals the neighbour's `endSec` + gap exactly; confirm Alt-drag does not snap. If no fixture workdir exists in the sandbox, produce one with `--produce --llm mock --no-render` first.

---

### Task 3: overlay guides — `guideSnap` pure + `Overlay.tsx` wiring

**Files:** create `apps/editor/src/guides.ts`; modify `apps/editor/src/Overlay.tsx`; test `apps/editor/test/guides.test.ts` (new).

**Interfaces produced:**

```ts
export interface Guide { axis: "x" | "y"; at: number /* frame fraction 0..1 */ }

export function guideSnap(
  rect: GraphicRect, handle: BoxHandle | "move",
  safe: { top: number; bottom: number; left: number; right: number },
  thresholdFrac: number,
): { rect: GraphicRect; guides: Guide[] }
```

- Candidates: x-centre 0.5, y-centre 0.5, and the four safe-area edges (`left`, `1-right`, `top`, `1-bottom`).
- **Move:** snap rect centre to centres, rect edges to safe edges; per axis pick the nearest hit within threshold; at most one guide per axis.
- **Resize:** snap only the dragged edge(s) implied by `handle` (reuse the `BoxHandle` semantics `applyBoxHandle` defines); centre candidates do not apply to resize.
- Passthrough outside threshold: returned rect `toEqual` input, `guides: []`.
- Reuse types: `GraphicRect`/`BoxHandle` from wherever `Overlay.tsx` gets them today. Safe-area values: reuse the SAME source the overlay's existing bleed guide uses — locate it before writing; if the editor has no local source, import from `@ossclip/scenes` only if it is already a dependency (check `apps/editor/package.json`; report if not, do not add it).
- Wiring: in the existing drag handler, after `applyBoxHandle`, before commit; `event.altKey` skips; render active guides as 1-px `#FFE14D` lines spanning the frame, visible only while `guides.length > 0`.

**Required tests:** each candidate on each axis; move vs resize semantics; threshold boundary (at exactly threshold → snaps); passthrough identity; one-guide-per-axis when centre and edge both hit.

---

### Task 4: the picker — one scroll region, visible scrollbar, first rendering test

**Files:** modify `apps/editor/src/ProjectPicker.tsx`; the editor's global CSS entry (locate — likely `index.html` or a css file imported by `main.tsx`); test `apps/editor/test/project-picker.test.ts` (new).

**Contract (from the spec's live diagnosis — read that section first):**

- Card: keep `maxHeight: "82vh"`, add `display: flex; flexDirection: column`, REMOVE its `overflowY: "auto"` — no outer scroll region.
- Browse list (`entryList`): replace `maxHeight: "34vh"` with `flex: 1; minHeight: 0; overflowY: "auto"`.
- Recent list: cap at its natural height (recents are ≤12 by `recordRecentProject`); if it has its own scroll today keep it, else leave natural.
- Scrollbar: styled visible via global CSS — thin, thumb `#3a3a44`, `::-webkit-scrollbar*` plus `scrollbar-width: thin` fallback — scoped to the picker's list (class it, don't style the world).
- Bottom fade: `maskImage` (with `WebkitMaskImage`) fading the last ~24px, present only while `scrollTop + clientHeight < scrollHeight - 1`; a small `onScroll` + resize-safe recompute. Degrade to no-fade when the ref is unmounted.
- **Nothing else in the file changes** — same handlers, same testids, same copy.

**Required test (the file's first):** jsdom render of `ProjectPicker` with a mocked `fetch` for `/api/fs` returning 40 entries (and `/api/recent` or whatever the component calls — read it first) — assert the list element's style carries `flex: 1` + `minHeight: 0` + `overflowY: auto` and the CARD no longer declares `overflowY: auto`. Mutation-check it: revert the style change locally, watch red, restore. State in the report that you did.

**Manual verification (required, paste output):** Playwright against the live server at `$HOME`, re-run the spec's measurement snippet (chain of `scrollHeight/clientHeight/overflowY`): exactly ONE overflowing scroll region in the chain, and the list's `clientHeight` grows when the window does.

---

## Self-Review

Spec coverage: snapping core+wiring (T1+T2), timecode (T1+T2), guides (T3), picker (T4); parity invariant restated as a Global Constraint; out-of-scope items untouched by any task. No placeholders: every pure contract carries exact semantics and enumerated tests; wiring steps name anchors by symbol per the stated no-line-numbers rule. Type consistency: `snapTargets`/`applySnap`/`formatTimecode` (T1) consumed only in T2; `guideSnap` (T3) self-contained; no cross-task type is produced by a later task. Honest limits: drag wiring has no new unit tests (logic is in the pure cores; wiring is verified live via Playwright with pasted evidence, and by existing suites staying green) — this is the same argument the motion round used, and this time the "existing suites guard it" claim is scoped to suites that actually render the code they guard, with the picker gaining its first rendering test precisely because none existed.
