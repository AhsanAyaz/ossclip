# Splits land where their source time says

Status: draft 3. It revises draft 2 after review round 2 (`~/ossclip-work/egm-short/split-positions-review-r2.md`). The author picked options 1B + 2A on 2026-11-23. Context: `take-looks-by-source.md` and `take-framing-identity.md` (both built), and `framing-phase2-review-r1.md` (hazards B1, B2 and S1). Sites are cited by symbol.

## Problem

A ⌘B split stores `{at, src, id}`: `src` is the source second, and `at` is the output second at the time the split was made. `recut.ts` passes `{at, src}` splits through unchanged, so after a cut in front `at` is stale. Two readers still trust it:

1. **The render puts graphic splits in the wrong place.** Produce's pass 1 (`splitThenDropHidden(editedCues, overrideDoc)`) uses the default `atSplitPoints`, so graphic splits render at a stale time.
   - **Second cut on a drifted split.** Pass 2 (`resolveSplitPoints` on `filled`) then cuts the graphic AGAIN at `toOutput(src)`. Depending on the case, that gives a duplicate `G@sid`, a graphic cut short, or a stray take half.
2. **The editor shows splits the render doesn't make.** Its take pass (`splitCues(filled, atSplitPoints(...))`) and `ghosts.ts` use `atSplitPoints`, so a split the render margin-skips still splits in the editor. FE Loop 20752 is one. Phase 1's step 7 papers over this only for take splits that landed.

## Goals

- **G1.** A labelled graphic split renders at `toOutput(src)`, so it follows its footage after cuts in front.
- **G2.** After a render, the editor's old-clock split cues equal produce's, except for the listed exceptions.
- **G3.** Every run with no new edit renders identically to the run before it. One exception: on the first upgraded run, a graphic split that had already drifted stops being cut twice (problem 1's second cut). That is a declared one-time fix.
- **G4.** No deleted graphic half comes back. Two limits are declared below.

**G2 exceptions:**
- Produce's `reclampPinnedTiming` does not run in the editor (today's gap).
- During a live veto, a split that is inert on the old clock does not preview.

**G4 limits:**
- A labelled graphic split whose footage moves into a different, hidden graphic splits that one instead.
- A label stays on a graphic that a re-plan removed. If the graphic returns, the split applies again.

## Design

### Definitions and helpers (`packages/core/src/overrides.ts`)

- **Schema.** The `SplitSchema` object arm gains `on: z.enum(["take", "graphic"]).optional()`. The legacy number arm emits `on: undefined`. `recut.ts` passes splits through whole.
- **Plain.** A cue counts as plain when `isLookPieceKey(id)` is true.
- **`keptSrc(s, doc)`.** True when `s.src` lies inside a `cleanup.kept` or `dismissed` range.

**`graphicSplitPoints(splits, map: TimeMap | null): ResolvedSplitPoint[]`** gives the pass-1 points:

| Split | Point |
| --- | --- |
| src-only (no `at`) | none (post-carve pass) |
| at-only (legacy) | `at` |
| `{at, src}`, `on: "graphic"`, `map` set, `toOutput(src)` not null | `toOutput(src)` |
| `{at, src}`, `on: "graphic"`, inert or `map` null | `at` (keeps a deleted half hidden) |
| `{at, src}`, `on: "take"` | none |
| `{at, src}`, unlabelled | `at` (today) |

**`takeSplitPoints(splits, map: TimeMap | null, doc): ResolvedSplitPoint[]`** gives the editor's old-clock take-pass points.
- **Which splits:** every split with `at`, except those with `keptSrc` (round-2 S3). Those go to the post-carve pass together with the src-only ones, matching produce, which applies every split after the carve.
- **With a map:** `resolveSplitPoints(those, map).points`.
- **Without a map:** `atSplitPoints(those)`.
- **Graphic splits in this set** are no-ops here when they are labelled or undrifted, because they sit on a graphic joint. A drifted unlabelled split is the case problem 1 describes. After the labelling below, the only unlabelled graphic splits left are row-2 splits (see the table), whose second cut is today's behaviour on both sides.

**`splitThenDropHidden(cues, doc, points?)`** additionally returns `landed: Map<splitId, rootId>`, using `splitCuesWithLanding` internally. This is additive.

### S1. Labels, in two steps (`packages/core/src/split-labels.ts`)

**`labelGraphicSplits(doc, pass1Landed, pass1Cues, map, priorMap): { doc, notes, changed }`.**
- **When:** it runs on every produce, right AFTER pass 1 and BEFORE pass 2 (B1). The freeze therefore applies within the same run.
- **Which splits:** splits without `on` that have both `at` and `src`.
- G is the pass-1 input cue named `pass1Landed.get(id)`, and its window is `[G.startSec, G.endSec]`. `out = map.toOutput(src)`.

| Pass 1 landed on | `out` | Result |
| --- | --- | --- |
| graphic G | inside G's window | `on: "graphic"`, then the freeze check |
| graphic G | null (inert) | `on: "graphic"` (it keeps `at` in pass 1) |
| graphic G | outside G | unlabelled. Note: `split ${id} left unlabelled — its source is outside the graphic it splits` |
| nothing | any | left to the take step |

- **Freeze (B1, round-2 S1).** If `|out − at| > 0.001`, then `src = round(ref.toSource(at), ms)`, where `ref` is `priorMap` when it exists and `map` otherwise.
  - Using `priorMap` keeps the footage the LAST render showed at `at`. So a cut added in this same run still moves the split with that footage.
  - Note: `split ${id} kept on the footage it showed (source ${old}s → ${new}s)`.

**`labelTakeSplits(doc, pass2Landed): { doc, notes, changed }`.**
- **When:** it runs after pass 2 and `rekeyTakeHalves`, and before `pinnedDoc` and `migrateTakeLooks`.
- **Which splits:** splits without `on` and with `{at, src}` that landed in pass 2 on a plain root and not in pass 1 get `on: "take"`. All others stay as they are.

**Notes and `changed`:** each step prints `labelled ${n} split(s) by what they cut` when `n > 0`. `changed` is true on any write.

### S2. Produce

- **Pass 1:** `splitThenDropHidden(editedCues, overrideDoc, graphicSplitPoints(overrideDoc.splits, map))`, followed by `labelGraphicSplits`.
- **Pass 2:** unchanged, then `labelTakeSplits`.
- **Write gate:** `const splitsLabelled = graphic.changed || take.changed`.
  - It goes into the gate's `if (…)` condition and into the reasons object.
  - `apps/cli/src/overrides-write.ts` gets `REASON_PHRASES.splitsLabelled = "splits labelled by what they cut"`.
  - `.bak` is not refreshed (`refreshBackup` stays `cutResult.changed`).
  - The gate regex in `apps/cli/test/caption-report.test.ts` gains `|| splitsLabelled`.

**Output, run by run:**
- **Label run.** Pass 1 uses today's `at` points, because nothing is labelled yet. Pass 2 sees frozen `src` values, so a drifted graphic split is no longer cut a second time. That is G3's one-time fix.
- **Next run.** A labelled graphic split resolves `toOutput(src) = at`, a take-labelled split gives no pass-1 point (as before), and pass 2 is unchanged. So output is identical.

### S3. Editor

- **Graphic pass:** `splitThenDropHidden(graphicCues, doc, graphicSplitPoints(doc.splits, oldClockMap))`.
- **Take pass:** `splitCues(filled, takeSplitPoints(doc.splits, oldClockMap, doc))`.
- **Post-carve pass (`finishOnClock`):** applies src-only splits plus `keptSrc` splits.
- **Ghosts:** `ghostCues(..., clock)` uses `graphicSplitPoints(doc.splits, clock)`. App passes `liveRetimed.oldClock`.

### S4. Reducer

`addSplit` with `targetId` sets `on: isLookPieceKey(targetId) ? "take" : "graphic"`. Without `targetId`, no label is set.

### S5. Phase 1's step 7 removed

`rekeyTakeHalves` drops step 7 and its `points` and `graphicWindows` parameters. Its call site and these tests change:
- `take-halves.test.ts`: 11b, 11d, 11e, and the "moved to 58.467s" assertion at about line 60;
- `take-halves-pipeline.test.ts`;
- `take-looks-migration.test.ts`;
- `take-looks.fixtures.ts`;
- `scene-edit-remap.test.ts`.

Supersede notes go into:
- `take-framing-identity.md` (P2 step 7, lines about 44-45);
- `take-looks-by-source.md` (L5, and the `at: 58.467` / `56.467` field-check expectations near line 339).

### S6. Comments to rewrite

The house rule says comments stay true, so rewrite:
- the `SplitSchema` `src`/`at` comment;
- the `atSplitPoints` and `resolveSplitPoints` docs;
- the `splitThenDropHidden` comment on default points;
- the module and step docs in `take-halves.ts`;
- produce's comments on the src backfill, on pass 2 and step 7, and on the write gate;
- `App.tsx`'s pass-1 split comment.

## Tests (inline values)

FE Loop numbers: the `shot-s1` output window is [10.085, 17.950] and `toOutput(16.5) = 14.015`.

**`overrides.test.ts`:**
- schema;
- `graphicSplitPoints`, one case per row;
- `takeSplitPoints` with a map, without a map, inert, and `keptSrc` excluded;
- `splitThenDropHidden` returns `landed`.

**`split-labels.test.ts` (new).** G is `scene-1` at `[10.085, 17.950]`, with identity-like maps built from FE Loop spans.
- inside: `{at: 14.015, src: 16.5}` → `"graphic"`, no freeze;
- drift: `{at: 15.0, src: 16.5}` → `"graphic"`, and `src` becomes `priorMap.toSource(15.0)`, with the note;
- inert: `src` removed → `"graphic"`;
- outside → unlabelled, with the note;
- take: landed only in pass 2 on `take-2` → `"take"`;
- idempotent: running again changes nothing.

**`split-positions-pipeline.test.ts` (new).** A core pipeline mirroring produce (fill, carve, pass 1, label, pass 2, label), with inline FE Loop spans plus `scene-1` and these splits:
- `fc1 {14.015, 16.5}`;
- `fc2 {15.0, 16.5}` (drifted);
- `fc3` inert, with `scene-1@fc3` hidden;
- `66055`.

Asserts:
- the label run gives no double cut for `fc2`;
- the run after it is identical;
- after cut `src [2, 4]`, `fc1` lands at 12.015 ± 0.002;
- `scene-1@fc3` stays hidden;
- the `"take"` split never cuts `scene-1` in pass 1.

**Parity (`item-timing-parity.test.ts`).** The editor's old-clock pipeline and produce agree on split cue ids and windows for:
- the 20752 shape (margin-skipped);
- an inert split;
- a labelled graphic split after a cut;
- a src-only split;
- a `keptSrc` split.

With no clock, the editor falls back to `at`.

**`ghosts.test.ts`:** with a clock, a labelled graphic split resolves by `src`.

**`useEdits.test.ts`:** ⌘B on a take gives `"take"`, on a graphic gives `"graphic"`, and with no `targetId` gives no label.

**Source guards (exact strings):**
- `splitThenDropHidden(editedCues, overrideDoc, graphicSplitPoints(overrideDoc.splits, map))`;
- `labelGraphicSplits(` comes before `resolveSplitPoints(overrideDoc.splits`;
- `labelTakeSplits(` comes after `rekeyTakeHalves(` and before `migrateTakeLooks(`;
- `splitsLabelled` is in the write `if (`;
- `App.tsx` contains `takeSplitPoints(edits.doc.splits, oldClockMap` and `graphicSplitPoints(edits.doc.splits, oldClockMap`.

## Field check (`~/ossclip-work/fe-loop/splits-field-check.sh`)

1. **Run A (baseline).** Make a fresh copy of the workdir (repointed as in `looks-field-check.sh`) and run `--no-render`. That absorbs phase 1 and the look migration. Save `render-props.A.json`.
2. **Edit.** Add splits `fc1 {at: 14.015, src: 16.5}` and `fc2 {at: 15.0, src: 16.5}` to `overrides.json`. With these numbers fc2's `src` resolves inside `shot-s1`.
3. **Run B (label run).** Expect:
   - `fc1` and `fc2` both get `on: "graphic"`;
   - fc2 gets the freeze note and `src` = `toSource(15.0)`;
   - 66055 gets `on: "take"`;
   - 20752 stays unlabelled (margin-skipped);
   - 24518, 167648 and 176577 stay unlabelled (src-only);
   - `shot-s1@fc1` and `shot-s1@fc2` cues exist, starting at 14.015 and 15.0;
   - against run A, no other cue changed.
4. **Run C (no edit).** `render-props.json` cues equal run B's, and no notes appear.
5. **Run D.** Add the cut `src [2, 4]` and run again. Expect:
   - `shot-s1@fc1` starts at 12.015 ± 0.002, and `shot-s1@fc2` at 13.0 ± 0.002;
   - the 66055 half is found by source 66.1 and is framed (its id is recorded, not asserted).
6. **Editor parity.** Start the editor on the copy, wait for the Timeline, and read every block's `data-testid` id and `data-piece-start`. Compare them with render-props `sceneCues` ids and starts, rounded to the millisecond. The only allowed extra is `take-*@20752`, which must be ABSENT now. Pass/fail goes through a python checker, and the script exits 1 on failure.

## Build

One task, then the field check.
- **Create:**
  - `packages/core/src/split-labels.ts`;
  - `packages/core/test/split-labels.test.ts`;
  - `packages/core/test/split-positions-pipeline.test.ts`.
- **Modify:**
  - `packages/core/src/overrides.ts`;
  - `packages/core/src/take-halves.ts`;
  - `packages/core/src/index.ts`;
  - `apps/cli/src/overrides-write.ts`;
  - `apps/cli/src/produce.ts`;
  - `apps/editor/src/App.tsx`;
  - `apps/editor/src/ghosts.ts`;
  - `apps/editor/src/useEdits.ts`;
  - the tests named above, plus `take-halves*.test.ts`, `take-looks-migration.test.ts`, `take-looks.fixtures.ts`, `scene-edit-remap.test.ts` and `caption-report.test.ts`;
  - the two design docs (supersede notes).
