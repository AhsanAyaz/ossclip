# Split Positions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every split cuts exactly once, in one place.
- Graphic splits follow cuts.
- The editor makes the same splits as the render.
- The two anchors of each split are reconciled after every produce.

**Architecture:**
- Core helpers (`pass1SplitPoints`, `survivingLandings`, `doubleCutNotes`, `reconcileSplitAnchors`) and a three-branch `remapOverridesThroughRecut` are shared by produce and the editor memo.
- `rekeyTakeHalves` step 7 is removed.

**Tech Stack:** TypeScript, pnpm monorepo, zod v4, vitest.

**Spec:** `docs/designs/split-positions-by-source.md` (draft 9). The authority is the draft-6 body plus the rulings sections R7-*, R8-* and R9-*. Rulings override the body, and later rulings override earlier ones.

**Plan-level detail:** the file list and the test literals come from `~/ossclip-work/egm-short/split-positions-review-r8.md` (S3, S5, m19).

## Global Constraints

- **Releases.** This ships in 0.2.0 (major), with a release note. One-time output changes are accepted and must be named in the produce log (spec D5/R7-1).
- **Remap (R8-1, R9-2).** `{at, src}` splits use three branches:
  - `src` removed on the new map: `at` unchanged, no report;
  - `src` removed on the old map: `at = round(newMap.toOutput(src), ms)`;
  - otherwise: `remapPoint`.
  At-only and src-only splits keep today's handling.
- **Pass 1 (R8-2).** Pass 1 uses `pass1SplitPoints(splits, map)`, which is `atSplitPoints` minus splits whose `src` maps to null. It is used in produce, in the editor graphic pass (`oldClockMap`) and in `ghosts.ts` (via a new `clock` parameter).
- **Landings (R9-1, R8-4).**
  - `landed` holds root ids; `landedHost` holds host cue ids.
  - A landing counts only if its host or `${root}@${sid}` survives the hidden and overlap drops (`survivingLandings`).
  - Pass 2 takes only splits that did not land.
- **Reconcile (R8-3).**
  - Only splits with both `at` and `src` take part.
  - A pass-1 survivor gets `src = round(map.toSource(at), ms)`.
  - A pass-2 landing gets `at = round(point, ms)`, unless the old or the new value lies in any pass-1 graphic window (hidden ones included).
  - The threshold is a difference of more than 1 ms.
  - Note: `split ${id} anchors reconciled (at ${a}s, source ${b}s)`.
- **Notes (exact).** The D5 note is `split ${id} cuts only ${G} now (it used to cut ${H} too)`, where `G = splitRootId(host)`.
- **Write gate.** The new reason `splitsReconciled` gets the phrase `split anchors reconciled to where they cut`. `refreshBackup` is unchanged.
- **Editor `finishOnClock`.**
  - Its post-carve set is: src-only splits, plus carved-range splits (closed containment), minus graphic-pass landings.
  - `dropHiddenCues` runs after `previewItemTimings`.
  - The early-exit condition uses the same set.
- **Comments.** Comments explain why, cite `split-positions-by-source` and its review ids, and every comment that becomes false is rewritten.
- **Testing and git.**
  - Run single test files with `pnpm vitest run <file>`.
  - Run the full suite once with `pnpm test --maxWorkers=2 --minWorkers=1`.
  - Commit locally only; never push.

## Review Focus

1. **Legacy at-only splits.** Their behaviour is unchanged. Add a recut test, plus a pipeline case with an at-only graphic split.
2. **A second produce with no edits.** `overrides.json` must be byte-identical and print no reconcile or D5 notes. Covered by a pipeline idempotence test and field-check run 2.
3. **A deleted graphic half under a split whose stale `at` sits in it.** The half stays hidden. Covered by a pipeline case and the R8-3 guard case.
4. **A cut-then-restore on a graphic split and on a take split.** Each returns to its exact place: fc1 14.015; the take split at `{37.412, 45.0}`.
5. **Editor/produce parity on FE Loop shapes.** The cases are 20752 (carved and margin-skipped), inert, drifted fc2, src-only, and carved with a hidden half. Each case also asserts that it took its intended path.

---

### Task 1: Split positions (spec D1–D5 + R7/R8/R9)

**Files** (complete list in review r8 S3):

- Create:
  - `packages/core/test/split-positions-pipeline.test.ts`.
- Modify (core):
  - `packages/core/src/recut.ts`;
  - `packages/core/src/overrides.ts`: `splitCuesWithLanding` and `splitThenDropHidden` (`landedHost`), plus `pass1SplitPoints`, `survivingLandings` and `doubleCutNotes`;
  - `packages/core/src/take-halves.ts`: `reconcileSplitAnchors`; step 7 removed;
  - `packages/core/src/index.ts`.
- Modify (CLI):
  - `apps/cli/src/produce.ts`;
  - `apps/cli/src/overrides-write.ts`.
- Modify (editor):
  - `apps/editor/src/App.tsx`;
  - `apps/editor/src/ghosts.ts`.
- Tests:
  - `packages/core/test/recut.test.ts`: invert the `{at, src}` "rides verbatim" case (~847-871);
  - `packages/core/test/overrides.test.ts`;
  - `packages/core/test/take-halves.test.ts`: the step-7 tests become reconcile tests;
  - `packages/core/test/take-halves-pipeline.test.ts`;
  - `packages/core/test/take-looks-migration.test.ts`;
  - `packages/core/test/take-looks.fixtures.ts`: the `runTakePipeline` reconcile step, and `FE_SPLITS_B` expectations;
  - `apps/editor/test/item-timing-parity.test.ts`: produce's `takeClipStarts`, and an `(id, start, end)` comparator;
  - `apps/editor/test/ghosts.test.ts`;
  - `apps/editor/test/take-looks-wiring.test.ts` (~18, ~34);
  - `apps/cli/test/scene-edit-remap.test.ts`;
  - `apps/cli/test/caption-report.test.ts` (gate regex ~610-612);
  - `apps/cli/test/overrides-write.test.ts`;
  - any reason-key fixture.
- Docs: supersede notes in `docs/designs/take-framing-identity.md` (P2 step 7) and `docs/designs/take-looks-by-source.md` (L5 and its field-check `at` lines).

**Interfaces (produces):**
```ts
splitCuesWithLanding(cues, points): { cues: SceneCue[]; landed: Map<string, string>; landedHost: Map<string, string> }
splitThenDropHidden(cues, doc, points?): DropHiddenResult & { landed: Map<string,string>; landedHost: Map<string,string> }
pass1SplitPoints(splits: readonly Split[], map: TimeMap | null): ResolvedSplitPoint[]
survivingLandings(landedHost: ReadonlyMap<string,string>, shown: readonly SceneCue[]): Set<string>
doubleCutNotes(splits, pass1Surviving: ReadonlySet<string>, landedHost, pass2Input: readonly SceneCue[], map: TimeMap): string[]
reconcileSplitAnchors(doc, pass1Surviving: ReadonlySet<string>, pass2Landed: ReadonlyMap<string,string>, pass2Points: readonly ResolvedSplitPoint[], graphicWindows: ReadonlyArray<{startSec:number; endSec:number}>, map: TimeMap): { doc; notes: string[]; changed: boolean }
ghostCues(cues, doc, toLive, clock: TimeMap | null)
```
`rekeyTakeHalves` loses its `points` and `graphicWindows` parameters, which every caller updates.

**Build order** (review r8 m19): core helpers → recut → reconcile and the step-7 removal → produce wiring and the write gate → editor (both passes, `finishOnClock`, ghosts) → tests → docs.

- [ ] **Step 1: Write the failing core tests.**
  - `recut.test.ts`, for each of the three branches:
    - fc1 `{14.015, 16.5}`: a cut over `src [16, 17]` leaves `at` at 14.015; restoring it gives `at` 14.015;
    - the take split `{37.412, 45.0}`, the same way;
    - at-only and src-only splits are unchanged.
  - `overrides.test.ts`:
    - `pass1SplitPoints`, including the inert drop and the null map;
    - `landedHost` for a chained split (fc2 cuts `shot-s1@fc1`);
    - `survivingLandings` with both host pieces hidden, and with an added graphic dropped for overlap;
    - `doubleCutNotes` for fc2, which gives exactly `split fc2 cuts only shot-s1 now (it used to cut shot-s1 too)`.
  - `take-halves.test.ts`:
    - reconcile of a pass-1 survivor (fc2 `src` → 18.485);
    - reconcile of a pass-2 landing (66055 `at` 58.784 → 58.467);
    - the graphic-window guard skip;
    - single-anchor splits untouched;
    - idempotence;
    - the step-7 assertions rewritten.
- [ ] **Step 2: Write the failing pipeline tests** (`split-positions-pipeline.test.ts`).
  - Setup: FE Loop fixture spans; `shot-s1` at [10.085, 17.950]; `applyUserCuts` or remap with before and after maps; take clip starts recomputed after the cut.
  - Assert the literal cue lists:
    - run 1 gives `shot-s1` [10.085, 14.015], `@fc1` [14.015, 16.000] and `@fc2` [16.000, 17.950], plus the D5 note;
    - run 2 with no edit is identical, with no notes;
    - after the cut `src [2, 4]`, fc1 `at` is 12.015 and fc2 `at` is 14.000 (±0.002);
    - an inert graphic split is not cut in pass 1;
    - an at-only graphic split behaves as today;
    - a deleted half stays hidden.
- [ ] **Step 3: Run the new tests.** They should FAIL.
- [ ] **Step 4: Implement** in the build order above.
- [ ] **Step 5: Update the editor and the parity tests.** Add the five parity cases, each with a literal `Run` fixture and a path assertion, plus the ghosts and wiring guards.
- [ ] **Step 6: Run checks.** Run the touched files, then `pnpm typecheck`, then the full suite once. All should be green.
- [ ] **Step 7: Commit** with the message `feat: each split cuts once; graphic splits follow cuts; editor matches the render`.

### Task 2: Field check (main thread, spec R7-10, R8-7)

- [ ] **Step 1: Write and run the field-check script.** Write `~/ossclip-work/fe-loop/splits-field-check.sh` with its python checker, then run it. Its runs:
  - copy the workdir and repoint it;
  - add fc1 and fc2;
  - run 1 (cues, the D5 note, fc2 `src` 18.485, and the 66055 reconcile note);
  - run 2 (overrides byte-identical, no notes);
  - run 3 with the cut (fc1 `at` 12.015, fc2 `at` 14.000);
  - after `pnpm build`, editor parity in headless chromium on port 5182, with no `@20752` block.
- [ ] **Step 2: Update `looks-field-check.sh`** (`:40`, `:76`, plus tolerance at `:78`) for the reconciled 66055 `at`, and re-run it.
- [ ] **Step 3: Record the results.** Add FINDINGS §174, including the PostHog usage note and the 0.2.0 release-note text, then commit.
