# Splits land where their source time says

Status: draft 4. It revises draft 3 after review round 3 (`~/ossclip-work/egm-short/split-positions-review-r3.md`). The author picked options 1B + 2A on 2026-11-23. Context: `take-looks-by-source.md` and `take-framing-identity.md` (both built), and `framing-phase2-review-r1.md` (hazards B1, B2 and S1). Sites are cited by symbol.

## Problem

A ⌘B split stores `{at, src, id}`. `src` is the source second, and `at` is the output second when the split was made. `recut.ts` passes `{at, src}` splits through unchanged, so `at` goes stale after a cut in front. Two readers still trust it:

1. **Graphic splits render at the wrong time.** Produce's pass 1 (`splitThenDropHidden(editedCues, overrideDoc)`) uses the default `atSplitPoints`.
   - **A drifted split is cut twice.** Pass 2 (`resolveSplitPoints` on `filled`) then cuts the graphic again at `toOutput(src)`, giving a duplicate `G@sid`, a graphic cut short, or a stray take half.
2. **The editor shows splits the render doesn't make.** The editor's take pass (`splitCues(filled, atSplitPoints(...))`) and `ghosts.ts` use `atSplitPoints`, so a split the render margin-skips still splits in the editor. FE Loop 20752 is one. Phase 1's step 7 covers only take splits that landed.

## Goals

- **G1.** A labelled graphic split renders at `toOutput(src)` and follows its footage after cuts in front.
  - A drift that already exists when the split is labelled is frozen where the last render showed it, not repaired.
- **G2.** After a render, the editor's old-clock split cues equal produce's, apart from the listed exceptions.
- **G3.** Every run with no new edit renders exactly the same cues as the run before it.
  - One exception: on the first upgraded run, a drifted graphic split stops being cut twice (problem 1, a declared one-time fix).

  The equality is exact, because of the snap rule below.
- **G4.** No deleted graphic half comes back, with the declared limits below.

**G2 exceptions:**
- `reclampPinnedTiming` is produce-only (today's gap).
- During a live veto, a split that is inert on the old clock does not preview.

**G4 and other declared limits:**
- **A split whose footage moves into a different graphic H.** A labelled graphic split then cuts H. H's two pieces both show, unless `H@sid` happens to be hidden.
- **A label outliving its graphic.** A re-plan removes graphic G but the split keeps its label. If a later plan brings G back, the split cuts it again, and any old `G@sid` edit applies again, including `hidden`.
- **Rollback and re-upgrade across a cut.** An older build ignores `on`. If a cut lands in between, re-upgrading freezes the split against the older build's last render. That is still the footage that render showed.
- **A stale editor save.** If the editor drops `on` (an older doc in memory), the next produce re-labels. The freeze only fires on drift that was visible in the last render, so a re-label is a no-op.

## Design

### Helpers (`packages/core/src/overrides.ts`)

- **Schema.** The `SplitSchema` object arm gains `on: z.enum(["take", "graphic"]).optional()`. The legacy number arm emits `on: undefined`.
- **Plain.** A cue counts as plain when `isLookPieceKey(id)` is true.
- **`SplitDropResult`** (`DropHiddenResult` plus `landed: Map<string, string>`) is what `splitThenDropHidden(cues, doc, points?)` now returns. Internally it uses `splitCuesWithLanding`.

**`graphicSplitPoints(splits, map: TimeMap | null): ResolvedSplitPoint[]`** gives the pass-1 points:

| Split | Point |
| --- | --- |
| src-only | none (post-carve pass) |
| at-only | `at` |
| `{at, src}`, `on: "graphic"`, `map` set, `p = toOutput(src)` not null | `p`, except `at` when `abs(p − at) ≤ 0.0015` (snap) |
| `{at, src}`, `on: "graphic"`, inert or `map` null | `at` |
| `{at, src}`, `on: "take"` | none |
| `{at, src}`, unlabelled | `at` |

**`takeSplitPoints(splits, map: TimeMap | null, keptRanges: readonly SrcRange[]): ResolvedSplitPoint[]`** gives the editor's old-clock take-pass points.
- It covers every split with `at`, except those whose `src` lies inside one of `keptRanges`. Those are the CARVED ranges, the same `vetoedRemovals` / `dismissedRemovals` ranges both pipelines carve (r3 S4).
- **With a map:** `resolveSplitPoints(those, map).points`.
- **Without a map:** `atSplitPoints(those)`, with no exclusion.

**Editor `finishOnClock` filter.** It applies splits that are src-only OR whose `src` lies in the carved ranges, resolved on `clockMap`. After its `applyOverrides`, it now runs `dropHiddenCues(merged, edits.doc)` (r3 S5), so a hidden half of such a split drops as it does in produce.

### S1. Labelling (`packages/core/src/split-labels.ts`)

**Produce sequence (r3 B1).** All steps run on every produce, so labelling is idempotent.
1. `const dry = splitCuesWithLanding(editedCues, graphicSplitPoints(overrideDoc.splits, map))`. This only computes landings; its cues are discarded.
2. `const g = labelGraphicSplits(overrideDoc, dry.landed, editedCues, map, priorMap)`, then `overrideDoc = g.doc`.
3. The real pass 1: `splitThenDropHidden(editedCues, overrideDoc, graphicSplitPoints(overrideDoc.splits, map))`, on the labelled doc.
4. Fill, carve, pass 2, and `rekeyTakeHalves`, unchanged.
5. `const t = labelTakeSplits(overrideDoc, dry.landed, splitLanded)`, then `overrideDoc = t.doc`.
6. `pinnedDoc` is rebuilt, then `migrateTakeLooks` and the rest, as before.

**`labelGraphicSplits(doc, pass1Landed, pass1Cues, map, priorMap: TimeMap | null): { doc, notes, changed }`.**
- **Which splits:** splits without `on` that have both `at` and `src`.
- **The window:** G is the cue in `pass1Cues` whose id is `pass1Landed.get(id)`. `p = map.toOutput(src)`.

| Landed in pass 1 | `p` | Result |
| --- | --- | --- |
| on G | inside `[G.startSec, G.endSec]` | `on: "graphic"`, then the freeze check |
| on G | null (inert) | `on: "graphic"` |
| on G | outside G | unlabelled. Note: `split ${id} left unlabelled — its source is outside the graphic it splits` |
| nowhere | (any) | left for the take step |

**Freeze (r3 S3).** It applies only when all of these hold:
- `priorMap` is set;
- `q = priorMap.toOutput(src)` is not null;
- `abs(q − at) > 0.0015`, meaning the drift was visible in the last render.

Then `src = round(priorMap.toSource(at), ms)`. The note reads `split ${id} kept on the footage it showed (source ${old.toFixed(3)}s → ${new.toFixed(3)}s)`.

With `priorMap` the same as `map`, the real pass 1 then puts the split at `p = at`, so pass 2 hits the joint and does nothing: no double cut. With `priorMap ≠ map` (a cut added in this run), the real pass 1 puts it at `map.toOutput(src')`, which is the same footage; pass 2 hits that same joint and again does nothing.

**`labelTakeSplits(doc, pass1Landed, pass2Landed): { doc, notes, changed }`.** A split without `on`, with `{at, src}`, that landed in pass 2 on a plain root and is NOT in `pass1Landed`, gets `on: "take"` (r3 S1).

**Notes.** Each step prints `labelled ${n} split(s) by what they cut` when n > 0, as `  ▸ ${note}`. `changed` is true on any write.

### S2. Write gate

- `apps/cli/src/overrides-write.ts`: `OverridesWriteReasons` gains `splitsLabelled: boolean`, and `REASON_PHRASES` gains `["splitsLabelled", "splits labelled by what they cut"]`.
- Produce: `const splitsLabelled = g.changed || t.changed`. It goes into the gate's `if (…)` condition and into the `overridesWriteLine` argument. `refreshBackup` stays `cutResult.changed`.
- Tests: the gate regex in `apps/cli/test/caption-report.test.ts` (~611) gains `|| splitsLabelled`, and `apps/cli/test/overrides-write.test.ts` gains a phrase case.

### S3. Editor

- **Graphic pass:** `splitThenDropHidden(graphicCues, edits.doc, graphicSplitPoints(edits.doc.splits, oldClockMap))`.
- **Take pass:** `splitCues(filled, takeSplitPoints(edits.doc.splits, oldClockMap, carvedRanges))`. `carvedRanges` are the vetoed and dismissed removals the memo already computes for the carve.
- **Ghosts:** the signature becomes `ghostCues(cues, doc, toLive, oldClock: TimeMap | null)`, and it uses `graphicSplitPoints(doc.splits, oldClock)`. App passes `liveRetimed?.oldClock ?? null`.

### S4. Reducer

`addSplit` with `targetId` sets `on: isLookPieceKey(targetId) ? "take" : "graphic"`. Without `targetId`, it sets no label.

### S5. Phase 1's step 7 removed

`rekeyTakeHalves` drops step 7 and its `points` and `graphicWindows` parameters. Every caller is updated:
- produce, plus about 21 test call sites in `take-halves.test.ts`, `take-halves-pipeline.test.ts`, `take-looks-migration.test.ts` and `take-looks-pipeline.test.ts`;
- the assertions on `at` refresh, including "moved to 58.467s" and test 11b/d/e, flip to "`at` untouched";
- `take-looks.fixtures.ts` drops any `at` expectations.

Supersede notes go into `take-framing-identity.md` (P2 step 7) and `take-looks-by-source.md` (L5 and the field-check `at` lines).

### S6. Comments to rewrite

- `SplitSchema`'s `src`/`at` comment;
- the `atSplitPoints` and `resolveSplitPoints` docs;
- the `splitThenDropHidden` default comment;
- the module and step docs in `take-halves.ts`;
- produce's comments on the src backfill, pass 2 and step 7, and the gate;
- the `App.tsx` pass-1 and `finishOnClock` filter comments.

## Tests (inline values)

FE Loop: `shot-s1` sits at output [10.085, 17.950], and `toOutput(16.5) = 14.01488`.

**`overrides.test.ts`:**
- the schema;
- `graphicSplitPoints`, one case per row, including the snap;
- `takeSplitPoints`: with a map, without a map, inert, and excluding a split in a carved range;
- `splitThenDropHidden` returns `landed`.

**`split-labels.test.ts`** (new). G is `scene-1` at [10.085, 17.950], using maps from the FE Loop spans.
- **Inside:** `{at: 14.015, src: 16.5}` gives `"graphic"` and no freeze (|q − at| ≤ 0.0015).
- **Drift:** `{at: 16.0, src: 14.0}` gives `"graphic"` and freezes `src` to `priorMap.toSource(16.0)`, which is 18.485, with the note.
- **Drift with `priorMap ≠ map`** (a 2 s cut in front on `map`): `src` is frozen from `priorMap`, and `map.toOutput(src')` is 14.0 ± 0.002.
- **Inert:** `"graphic"`, no freeze.
- **Outside:** unlabelled, with the note.
- **No `priorMap`:** labelled, never frozen.
- **Take:** landed in pass 2 only, on `take-2`, gives `"take"`. Landed in both passes gives no take label.
- **Idempotent:** a second run changes nothing.

**`split-positions-pipeline.test.ts`** (new). A core harness in produce's order:
1. graphic cues with `applyOverrides`;
2. dry landing, then `labelGraphicSplits`;
3. pass 1;
4. fill with the FE Loop clip starts, then carve;
5. pass 2, then `labelTakeSplits`.

It uses `scene-1` [10.085, 17.950] and these splits:
- `fc1 {14.015, 16.5}`;
- `fc2 {16.0, 14.0}`;
- `fc2h`: the same as fc2, but on `scene-2` with `scene-2@fc2h` hidden;
- `fc3 {16.5, 25.0}`: inert, with `scene-1@fc3` hidden;
- `66055 {58.784, 66.055}`.

Asserts:
- Running today's sequence (pass 1 with `atSplitPoints`, then pass 2) double-cuts fc2. That establishes the bug.
- The label run does not double-cut it.
- The run after the label run gives the same cues, compared as `(id, start, end)` rounded to the millisecond.
- After the cut `src [2, 4]`, fc1 starts at 12.015 ± 0.002 and fc2 at 14.000 ± 0.002.
- `scene-1@fc3` and `scene-2@fc2h` stay hidden.
- `66055` is never in a pass-1 landing, and gets `"take"`.

**Parity (`item-timing-parity.test.ts`).** The editor old-clock pipeline and produce must give equal `(id, start, end)` lists, rounded to the millisecond, for:
- the 20752 shape (margin-skipped);
- an inert split;
- a labelled graphic split after a cut;
- a src-only split;
- a carved-range split with a hidden half.

With no clock, the editor falls back to `at`.

**`ghosts.test.ts`:** a labelled graphic split resolves by `src` when a clock is given.

**`useEdits.test.ts`:** a split on a take gets `"take"`, on a graphic gets `"graphic"`, and with no `targetId` gets nothing.

**Source guards.**
- `apps/cli/test/scene-edit-remap.test.ts`:
  - `labelGraphicSplits(` comes before `splitThenDropHidden(editedCues, overrideDoc, graphicSplitPoints(overrideDoc.splits, map))`;
  - `labelTakeSplits(` comes after `rekeyTakeHalves(` and before `migrateTakeLooks(`;
  - `splitsLabelled` appears in the write `if (`.
- `apps/editor/test/take-looks-wiring.test.ts`: `takeSplitPoints(edits.doc.splits, oldClockMap` and `graphicSplitPoints(edits.doc.splits, oldClockMap`.

## Field check (`~/ossclip-work/fe-loop/splits-field-check.sh`, with a python checker; exit 1 on any failure)

1. **Baseline (old build).** Make a git worktree at `c057ec1`, the last commit before this build, and run `pnpm install --offline` there.
   - Copy the FE Loop workdir and repoint it as `looks-field-check.sh` does.
   - Add to `overrides.json` `splits`: `fc1 {at: 14.015, src: 16.5}` and `fc2 {at: 16.0, src: 14.0}`.
   - Run produce from the worktree with `--no-render`, and save `render-props.R0.json`.
   - Expect a `shot-s1@fc2` cue starting at 16.0 AND a second cut near 14.0. This is the double cut, and it is asserted so the bug is proven on real data.
2. **Run B: label run, new build.** Expect:
   - the notes `labelled 2 split(s) by what they cut` (the graphic step: fc1, fc2), `labelled 1 split(s) by what they cut` (the take step: 66055), and `split fc2 kept on the footage it showed (source 14.000s → 18.485s)`;
   - fc1 and fc2 have `on: "graphic"`, and 66055 has `"take"`;
   - 20752, 24518, 167648 and 176577 are unlabelled;
   - the cues equal R0's, except that the second cut near 14.0 is gone.
3. **Run C (no edit).** The cues equal B's, and there is no `labelled` or `kept` note.
4. **Run D.** Add the cut `src [2, 4]`. Expect:
   - `shot-s1@fc1` starts at 12.015 ± 0.002;
   - `shot-s1@fc2` starts at 14.000 ± 0.002;
   - `take-4@66055` starts at 56.467 ± 0.002 with `video {scale: 2.2, dx: -664.8}`.
5. **Editor parity.**
   - Start `pnpm ossclip edit <copy> --no-open --port 5182`.
   - Use headless Chromium (the repo's `@playwright/test`) to wait for `[data-testid^="timeline-block-"]`.
   - Read each block's id (the testid minus `timeline-block-`) and its `data-piece-start`.
   - The pairs must equal render-props `sceneCues` (id, start rounded to the millisecond) as a set. `take-*@20752` must not appear.
   - Stop the editor and remove the worktree.

## Build

One task, then the field check.
- **Create:**
  - `packages/core/src/split-labels.ts`;
  - `packages/core/test/split-labels.test.ts`;
  - `packages/core/test/split-positions-pipeline.test.ts`.
- **Modify:**
  - `packages/core/src/overrides.ts`, `take-halves.ts` and `index.ts`;
  - `apps/cli/src/overrides-write.ts` and `produce.ts`;
  - `apps/editor/src/App.tsx`, `ghosts.ts` and `useEdits.ts`;
  - the tests named above, plus `take-halves.test.ts`, `take-halves-pipeline.test.ts`, `take-looks-migration.test.ts`, `take-looks-pipeline.test.ts`, `take-looks.fixtures.ts`, `scene-edit-remap.test.ts`, `caption-report.test.ts`, `overrides-write.test.ts`, `ghosts.test.ts`, `Inspector.test.ts` (if it calls `ghostCues`), and `take-looks-wiring.test.ts`;
  - the two design docs (supersede notes).
