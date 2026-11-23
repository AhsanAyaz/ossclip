# Each split cuts once, in one place

Status: draft 7 (round 6 review: `split-positions-review-r6.md`). The "Draft 7 rulings" section at the end overrides earlier text where they differ. Draft 6 was a rewrite that replaced drafts 1–5, which took the exact-preservation route; their reviews are `~/ossclip-work/egm-short/split-positions-review-r1.md`…`r5.md`.

On 2026-11-23 the author chose the simpler route and accepted a one-time change for splits that had already drifted. This can ship as a major update, and full backward compatibility is not required. Telemetry backs that up: in the last 30 days, about 12 installs outside the author's own ran `produce`.

## Problem

A ⌘B split stores `{at, src, id}`: `at` is the output second when the split was made, `src` the source second.

- **`at` goes stale.** `recut.ts` re-anchors `at` only for legacy splits that have no `src`. For `{at, src}` splits, `at` goes stale after a cut in front.
- **Produce cuts a drifted split twice.** Pass 1 (graphics, `splitThenDropHidden(editedCues, overrideDoc)`) cuts at the stale `at`. Pass 2 (takes, `resolveSplitPoints` on `filled`) cuts the same split again at `toOutput(src)`.
- **The editor shows splits the render doesn't make.** The editor's take pass uses `atSplitPoints`, so it shows splits that produce margin-skips (FE Loop 20752).

## Design

### D1. `at` follows cuts for every split

`remapOverridesThroughRecut` (`recut.ts`) moves `at` for every split that has one, through `remapPoint`, the same path legacy splits already take. `src` is untouched.

- **In produce,** this runs through `applyUserCuts` on every run that has a prior map. The existing `cutResult.changed` gate writes the result.
- **What `at` means:** it always means "output time on the last render's clock".
- **In the editor,** the live recut preview uses the same function, so live previews move graphic splits too.

### D2. Each split applies in exactly one pass

- **Pass 1 (graphics):** `atSplitPoints(doc.splits)`, as today. `splitThenDropHidden` now also returns `landed`, via `splitCuesWithLanding`.
- **Pass 2 (takes, after the carve):** `resolveSplitPoints(splits NOT landed in pass 1, map)`. Inert splits still drop out of pass 2, as today.

A split that cut a graphic never cuts again in pass 2. Every other split cuts its take at `toOutput(src)`, unchanged.

### D3. The editor follows the same rule

The editor works on the old clock (`oldClockMap`, the last render's), with `at` fresh as of that render (D1).

- **Graphic pass:** `atSplitPoints` (unchanged), which keeps its `landed`.
- **Take pass:** `resolveSplitPoints` over the splits that have `at`, did not land in the graphic pass, and whose `src` is not in the carved ranges, on `oldClockMap`. With no map, it uses `atSplitPoints` over the same set.
  - **Carved ranges:** the vetoed and dismissed removals the memo builds for the carve. They are hoisted above the take pass and use closed containment, as in `carveKeptTakes`.
- **Post-carve pass (`finishOnClock`):** the src-only splits plus the carved-range ones. It then runs `dropHiddenCues`, so a deleted half of such a split drops here as it does in produce.
- **`ghosts.ts`:** unchanged. It uses `atSplitPoints` on graphics, and `at` is now fresh.

The editor then makes the splits produce made, by the same rule on the same clock. FE Loop 20752 stops showing, because its `src` point is margin-skipped in both.

### D4. Phase 1's step 7 goes

D1 keeps `at` fresh for every split, so phase 1's `at` refresh is no longer needed.

- **`rekeyTakeHalves`:** drops step 7 and its `points` and `graphicWindows` parameters.
- **Callers and tests:** updated to match.
- **Docs:** supersede notes go into `take-framing-identity.md` and `take-looks-by-source.md`.

### D5. The one-time change is reported

On every run, produce emits a note for each split that landed in pass 1 AND would have cut a plain cue in pass 2 at a different point (more than 0.3 s from its pass-1 point):

`split ${id} cuts only ${G} now (it used to cut ${take} too)`

In practice this fires only for splits that had drifted before the upgrade.

## Goals and limits

- **Graphic splits stay on their footage.** They follow cuts in front (D1). A split that had already drifted stays where it renders now, because `at` is treated as the truth; it only loses its second cut.
- **Every split cuts once.**
- **The editor matches the render on the old clock.** The exception is `reclampPinnedTiming`, which runs in produce only (today's gap).
- **Accepted one-time change.** Take splits whose stale `at` sits inside a graphic stop splitting their take. That take piece merges back, and any id-keyed edit on its half becomes an orphan, which the orphan warning reports. Take looks are unaffected, because they are source-attached.
- **Limit.** A split whose `at` is moved into removed material by a cut is reported by `remapPoint`, as legacy splits are today.

## Tests

- **`recut.test.ts`:** a `{at, src}` split's `at` moves through a cut in front, and `src` is unchanged.
- **`overrides.test.ts`:** `splitThenDropHidden` returns `landed`.
- **Core pipeline, `split-positions-pipeline.test.ts` (new).** It uses the FE Loop spans from `take-looks.fixtures.ts`, with `scene-1` = `shot-s1` at [10.085, 17.950].
  - `fc2 {at: 16.0, src: 14.0}` is cut once, at 16.0, and gets the D5 note. Today's code cuts it at 11.515 and again at 16.0.
  - `fc1 {at: 14.015, src: 16.5}`: after the cut `src [2, 4]` and the remap, its `at` is 12.015 and it cuts `scene-1` there.
  - A take split with no graphic is cut at `toOutput(src)`, as before.
  - Split 20752 is margin-skipped.
- **Parity (`apps/editor/test/item-timing-parity.test.ts`).** The mirrors change to the D2/D3 sets, and a new `(id, start, end)` comparator is added. Cases:
  - the 20752 shape;
  - an inert split;
  - fc2 (drifted);
  - a src-only split;
  - a carved-range split with a hidden half.
- **`take-halves` tests:** step 7 removal; `at` is left untouched.
- **Source guards:**
  - produce's pass 2 calls `resolveSplitPoints(` on the set that excludes pass 1's landings;
  - the editor's take pass excludes the graphic pass's landings.

## Field check

On a fresh copy of FE Loop:

1. **Add `fc1` and `fc2` to `splits`, then run `--no-render`.** Expect:
   - `shot-s1` at [10.085, 14.015];
   - `@fc1` at [14.015, 16.000];
   - `@fc2` at [16.000, 17.950];
   - the D5 note for fc2.
2. **Add the cut `src [2, 4]` and run again.** Expect:
   - in `overrides.json`, fc1's `at` is 12.015 and fc2's is 14.000;
   - the cues sit at those times.
3. **Check the editor in a headless browser.** The Timeline block starts equal the render-props starts, and there is no `@20752` block.

## Build

One task, then the field check.

- **Files:**
  - core: `packages/core/src/recut.ts`, `overrides.ts`, `take-halves.ts`;
  - CLI: `apps/cli/src/produce.ts`;
  - editor: `apps/editor/src/App.tsx`;
  - tests: those named above, plus the `rekeyTakeHalves` call sites in tests and fixtures;
  - docs: the two supersede notes.
- **Release:** ships as the next minor or major bump, with a release note for the one-time change.

## Draft 7 rulings (round 6)

**R7-1. The D5 note uses a dry-run helper (B1).**
- `doubleCutNotes(splits, pass1Landed, pass2Input, map): string[]` is a pure core helper.
- It dry-runs `splitCuesWithLanding(pass2Input, resolveSplitPoints(pass1-landed splits, map).points)`. For each landing whose point differs from the pass-1 point by more than 0.3 s, it notes `split ${id} cuts only ${G} now (it used to cut ${H} too)`, where `H` is the cue it would have landed on, of any kind.
- For fc2, the note is exactly `split fc2 cuts only shot-s1 now (it used to cut shot-s1 too)`.
- The Problem section now also states that today's code makes two cues both named `shot-s1@fc2`.

**R7-2. A landing counts only if one of its pieces survives (B2).** In both produce and the editor, the pass-1 landing set is filtered after the hidden drop and the overlap drop. A split stays "landed" only if `root` or `root@sid` is still in the shown list. Otherwise it goes to pass 2.

**R7-3. Splits in removed material (B3).**
- `remapOverridesThroughRecut` leaves `at` UNCHANGED for a split whose `src` is in removed material on the new map. The split is skipped in BOTH passes for that run: it is inert, with the existing inert report and no snap report.
- When the material is restored, the split comes back at `toOutput(src)`, and R7-4 then reconciles `at`.
- Tests cover a cut over a graphic split's `src` followed by a restore, and the same for a take split.

**R7-4. The two anchors are reconciled on every produce (S3).** This replaces D4's "goes away".
- After both passes, for every split that landed and survived:
  - a pass-1 split (graphic) gets `src = round(map.toSource(at), ms)` if it differs by more than 1 ms;
  - a pass-2 split (take) gets `at = round(resolvedPoint, ms)` if it differs by more than 1 ms.
- A split that landed nowhere is left as it is.
- **Write gate:** a new reason, `splitsReconciled`, with the phrase `split anchors reconciled to where they cut`. `refreshBackup` stays as it is.
- **Consequences:**
  - after one run, the D5 note never repeats, and no stale anchor lingers;
  - step 7 of `rekeyTakeHalves` is removed, because this pass subsumes it;
  - existing drift is repaired once: graphics keep their rendered position, and take splits sit on their footage.
- It is a pure core function: `reconcileSplitAnchors(doc, pass1Landed, pass2Points, map): { doc, notes, changed }`. It is called after `rekeyTakeHalves`, before `migrateTakeLooks`.

**R7-5. Wording fixes (S1, S2, S4).**
- **S1.** The editor does not call `remapOverridesThroughRecut`. Its live preview moves cues through `retimeForPreview`. The editor reads `at` as written by the last produce, which is enough for parity on the old clock.
- **S2.** On a merged take piece, the look with the larger overlap shows (`take-looks.ts`). This is declared as part of the accepted one-time change.
- **S4.** `{at, src}` splits now get `remapPoint`'s "too close" report and, when the remap moves them onto a seam, the "snapped" report.

**R7-6. Editor details (S5, S6).**
- **Post-carve set:** src-only splits, plus splits whose `src` is in the carved ranges, minus the graphic-pass landings.
- **Containment:** closed, `srcIn ≤ src ≤ srcOut`.
- **`dropHiddenCues`** in `finishOnClock` goes after the look pass and before `previewItemTimings`.
- **Early-exit condition:** uses the same post-carve set.
- **No `oldClockMap`:** `atSplitPoints` for all splits, as today.
- **20752:** in FE Loop its `src` lies inside `cleanup.kept`, so the editor handles it in the post-carve path. There it is margin-skipped against the carved block, the same as in produce. The parity case uses that shape.

**R7-7. Declared live-recut gaps (S7).** During a live cut that has not been rendered yet, two cases preview on the old clock and settle on the next render:
- a user cut removed live;
- a live cut over a split's `src`.

**R7-8. Tests (S8, S9).**
- **Pipeline harness** (`split-positions-pipeline.test.ts`):
  - flow: `applyOverrides`, then pass 1 with landing, the survival filter, fill with the fixture's `TAKE_CLIP_STARTS`, carve, pass 2 over the non-landed splits, `doubleCutNotes`, then `reconcileSplitAnchors`;
  - after the cut, it uses the map with `src [2, 4]` removed, where every `outIn` after source 4.0 drops by 2.000 and `shot-s1` becomes [8.085, 15.950];
  - it asserts the full cue lists.
- **Parity mirror:** uses `editorTakeClipStarts` with the fixture's `takeClipStarts`, so take ids match. The comparator compares the full sorted `(id, start, end)` list, rounded to the millisecond.

**R7-9. Build list (S10).**
- **Tests to invert or delete:**
  - the `recut.test.ts` case asserting that `{at, src}` splits pass through unchanged (about lines 847–871);
  - step 7's tests in `take-halves.test.ts` and the pipeline tests (11b, 11d, 11e, the "moved to 58.467s" assertion).
- **New signatures:** `splitThenDropHidden` gains `landed`; plus `doubleCutNotes` and `reconcileSplitAnchors`.
- **Source guards** (`apps/cli/test/scene-edit-remap.test.ts`):
  - `resolveSplitPoints(` over `notLandedInPass1`;
  - `reconcileSplitAnchors(` after `rekeyTakeHalves(`;
  - `splitsReconciled` in the write gate.
- **Comments:** every comment that claims `{at, src}` splits are not remapped is rewritten. That covers `recut.ts`, `SplitSchema`, `atSplitPoints`/`resolveSplitPoints`, and produce's pass comments.

**R7-10. Field check (S11).** It is a script, `~/ossclip-work/fe-loop/splits-field-check.sh`, with a python checker that exits 1 on any failure.
1. **Copy:** copy the workdir and repoint it, as in `looks-field-check.sh`.
2. **Add two splits** to `overrides.json` `splits`: `{"at": 14.015, "src": 16.5, "id": "fc1"}` and `{"at": 16.0, "src": 14.0, "id": "fc2"}`.
3. **Run 1 (`--no-render`).** Expect:
   - `shot-s1` [10.085, 14.015], `shot-s1@fc1` [14.015, 16.000], and exactly one `shot-s1@fc2`, at [16.000, 17.950];
   - the R7-1 note for fc2;
   - fc2's `src` reconciled to 18.485.
4. **Run 2, no edit.** Same cues, and no `cuts only` or `reconciled` notes.
5. **Run 3,** with the cut `{"startSec": 0, "endSec": 0, "src": {"startSec": 2.0, "endSec": 4.0}}` added. Expect:
   - fc1 `at` 12.015 and fc2 `at` 14.000 (±0.002);
   - the cues are at those positions.
6. **Editor.** Run `pnpm build`, then start the editor on the copy at port 5182. In headless Chromium, read the `[data-testid^="timeline-block-"]` ids and their `data-piece-start`. They must equal render-props `sceneCues` within 0.001, with no `@20752` block.

**R7-11. Minor wording.**
- Release: this ships as a MAJOR update (0.2.0), with a release note.
- "Phase 1" means `take-framing-identity.md`.
