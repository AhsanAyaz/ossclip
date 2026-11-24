# Split take pieces keep their own framing

Status: draft 8. It revises draft 7 after review round 7 (`~/ossclip-work/egm-short/take-framing-review-r7.md`). Changes from drafts 4 and 5 are listed at the end.

## The problem

The author splits a take with ⌘B and reframes one piece (zoom or position). Sometimes another piece moves with it. Sometimes a framing set earlier disappears after a re-render.

Field evidence: the FE Loop short, published 2026-11-22. `~/ossclip-work/fe-loop/work/FE Loop-116d3cbc/overrides.json` holds two framings:

- `take-2`: `{scale 2.2, dx 814.4}`;
- `take-2@66055`: `{scale 2.2, dx -664.8}`.

The split `{at: 58.784, src: 66.055, id: "66055"}` resolves inside `take-3` on the final clock. The half is called `take-3@66055`, the edit under `take-2@66055` is an orphan, and output 58.5–60.8 s plays at 1×.

## Causes

1. **Half keys follow the root's ordinal.** A half is `${root}@${splitId}`. Plain-take roots are ordinals of the clip starts (`fillPlainCues`), so a cut in front of the root renames the half, and its edit orphans.
2. **Halves inherit their root's framing.** `effectiveOverride` (`overrides.ts:1143`, R16 §68) layers a half's own entry over its root's, field by field, including `video` and `pip`. Reframing the first piece moves every later half without its own value.
3. **The editor numbers takes differently from produce once cleanup ranges are kept or dismissed.**
   - Produce's clip starts include those ranges' output edges (`produce.ts:5543-5550`).
   - The editor's include only span starts (`App.tsx:1493-1496`).

   With a baked veto, the same footage can carry different take ids in the editor and the render, so an edit made in the editor can land on the wrong take in the render.

   FE Loop is affected. Its last span starts at 160.549, but produce's `take-10` starts at 161.291, a clip start that only a kept-range edge adds. It is part of the same "framing jumps" report.
4. **The editor splits `{at, src}` splits at a stale `at`.** It uses `App.tsx:1506` with `atSplitPoints`, and `at` is never refreshed after a render. After a cut in front, the editor's half can sit in a different root than produce's.

   For split 66055 the editor uses 58.784 while produce resolves 58.467. Left alone, P2 would move the editor's edit to produce's key, and the editor would then show the piece unframed (R5-B1).

Deferred:

- **Root-take drift:** a framed whole take moves to other footage after a cut in front of it. Phase 2.
- **Stale `at` for graphic splits and src-only splits.** Draft 4's broad refresh broke both (R4-B1, B2); phase 1 refreshes only take splits (P2 step 7).

## Phase 1 goals

1. **New take splits:** editing one piece never changes another.
2. **Existing take splits:** the same holds after their first produce, with output unchanged.
3. **Cuts in front:** a take half's framing survives a cut in front of its root, and the FE Loop half comes back.
4. **Same take ids:** after any render made with the upgrade, the editor and the render agree on take ids and on the positions of take splits that LANDED in that render. Two cases are excepted:
   - A split the render skipped (margin or seam) keeps its old `at`. The editor may still show a piece there that the render does not have; that is today's behaviour, deferred.
   - A cleanup choice or cut made since the last render still previews on the old clock, as all live edits do today.
   - A take split whose `at` step 7 refuses to refresh (old or new point inside a graphic window) keeps its old `at`. The editor may place it differently from the render; deferred with the graphic-split work.
5. **Unchanged output:** rendered output is the same for any project without an orphaned take half. Step 7 never moves an `at` into or out of a graphic window, hidden graphics included, so produce's first (graphic) split pass sees the same splits it does today.

Out of scope: graphic splits (overrides apply before their split, `produce.ts:5472` → 5489), splits inside `take-kept-*` blocks, inert splits, and the deferred items above.

## Design

**Plain take key.** `isPlainTakeKey(key)` (exported, core) holds when `isParkedOverrideKey(key)` is false and the root (the text before the first `@`) matches `/^take-\d+(-\d+)?$/`. Every rule below uses it.

**Moving or parking an entry carries the WHOLE entry:** `hidden`, `timing`, `props`, `elements`, `component`, `video`, `pip`, everything (R4-S3).

**An empty entry** is one with no keys other than an empty `props` and an empty `elements` (R4-S6).

### P0. One set of take clip starts, written by produce and read by the editor

- **Produce** binds the list it passes to `fillPlainCues` (`produce.ts:5550`) as `const takeClipStarts = [...]`, and writes the same binding into the render-props object (`produce.ts:~7219`, next to `spans`). It is written always, even when there are no kept edges, so presence means "written by an upgraded produce".
- **The editor:** `RawRenderProps` (`App.tsx:166`) gains `takeClipStarts?: number[]`. A new pure helper `editorTakeClipStarts(renderProps): number[]` (in `apps/editor/src/`) returns `takeClipStarts` when present, otherwise `spans.map(s => s.outIn)`. The memo (`App.tsx:1495`) calls it.
- **`packages/core/src/recut.ts`** needs no change: it passes splits through whole (`:74`, `:129`), so `ownFraming` survives, and it never mints take ids.
- **`apps/editor/test/item-timing-parity.test.ts:194-197`** hand-mirrors the memo's fill line. Its `clipStarts:` argument becomes `editorTakeClipStarts({ spans })`, called with the same spans array the harness already builds its old map from, which is declared above the fill line. The builder may hoist that array if needed. Nothing else changes. The harness does not mirror `rekeyTakeHalves`: that runs only in produce, and its result reaches the editor through the written doc.
- **Migration.** An existing project with kept or dismissed ranges shows different take ids in the editor after its next render. Render output is unchanged, because produce already numbered this way. The editor's ids now match what produce renders, which is the fix. Before that render (old render-props), the editor behaves as today.

  Rollback limits:
  - Framing edits keyed to the new ids would misplace under an older ossclip, the same way they already do today.
  - An older build's schema strips `ownFraming`, so its halves inherit again.
  - An entry made on a pre-P0 editor id inside a kept block previews but orphans in the render. That is today's bug, and it is reported as an orphan.

### P1. New take splits copy framing and stop inheriting it

- **`SplitSchema` gains `ownFraming?: boolean`.**
  - The object arm keeps it through parsing.
  - The legacy `at`-only arm's transform emits `ownFraming: undefined`.
  - `remapOverridesThroughRecut` passes it through.
- **`effectiveOverride` is exported:** `effectiveOverride(scenes, id, ownFraming?: ReadonlySet<string>)`. When `isPlainTakeKey(id)` holds and the half's split id is in the set, the half inherits neither `video` nor `pip` from its root, as whole objects including `volume` and `autoZoom`. All other fields still inherit (R16 §68). The flag is ignored for non-take halves.
- **`ownFramingSplitIds(splits): Set<string>`** is exported. `applyOverrides` builds the set once and passes it at `overrides.ts:1239` and `1318`.
- **The action becomes `{ type: "addSplit"; at?: number; src?: number; targetId?: string }`** (`useEdits.ts:139`). The wrapper (`useEdits.ts:1937`) passes `targetId` through. `Overlay.tsx:1385` passes `target.id` (already computed at `1362`).
- **The reducer (`useEdits.ts:856`):**
  1. Runs the existing guards and dedupe. A duplicate returns early and copies nothing.
  2. Mints the id.
  3. If `targetId` is given and `isPlainTakeKey(targetId)` holds:
     - `halfKey = ${root(targetId)}@${newId}`, the name `splitCues` gives the new piece (`overrides.ts:1723`);
     - `src = effectiveOverride(doc.scenes, targetId, ownFramingSplitIds(doc.splits))`. This reads the override layer, never the cue's resolved `video`;
     - the half entry's `video`/`pip` are set to `src`'s, and a field `src` lacks is deleted;
     - an empty result is not stored;
     - other fields of an existing (reused-id) entry are left alone;
     - the split is stored with `ownFraming: true`.
  4. Commits once, so one undo removes everything.
  5. Otherwise it behaves exactly as today.

### P2. Produce re-keys take halves by where their split landed, and migrates legacy take splits

**`splitCuesWithLanding(cues, points): { cues: SceneCue[]; landed: Map<string, string> }`** is a sibling of `splitCues` in `overrides.ts`. `splitCues` becomes a thin wrapper returning `.cues`. A `landed` entry maps a split id to `splitRootId(host.id)` for every split the loop actually applied. A split skipped by the margin test or by missing every cue is absent.

**`rekeyTakeHalves(doc, landed, points, graphicWindows): { doc: OverrideDoc; notes: string[]; changed: boolean }`**, where `points: ResolvedSplitPoint[]` and `graphicWindows: ReadonlyArray<{ startSec: number; endSec: number }>`, lives in a new file, `packages/core/src/take-halves.ts`, exported from `packages/core/src/index.ts`. It handles every `(sid, rootId)` in `landed` with `isPlainTakeKey(rootId)`, in split-id order:

1. **Candidates** are the input-doc keys `K` with `isPlainTakeKey(K)` and the suffix exactly `@${sid}`.
2. **Target** is `T = ${rootId}@${sid}`.
3. **Choose before writing (R4-B3).**
   - **Incumbent:** the candidate `K === T`, if any.
   - **Mover:** if there is no incumbent, the candidate whose root has the lowest numeric take index. A `take-N` piece sorts before `take-N-k`, which sorts by `k`.
   - **Others:** every remaining candidate.
4. **Materialize (only if the split's `ownFraming` is not true).**
   - Each candidate gets `effectiveOverride(scenes, K, ∅)`'s `video`/`pip` written as its own. The value is computed against K's OWN root, from the input doc, and empty results are not stored.
   - If there are no candidates at all, `T` gets the landed root's `video`/`pip` the same way, which is what the half rendered with.
   - The split gets `ownFraming: true`.
   - Note: `split 66055 now owns its framing`.
5. **Move.** The mover's whole (materialized) entry moves to `T`.
   - Note: `edit for take-2@66055 re-keyed to take-3@66055 — its split now falls in take-3`.
6. **Park.** Each of the others moves whole to `${K}#orphaned`.
   - Note: `edit for take-2@66055 parked — take-3@66055 already has its own edit`.
   - If that park slot is already held, the entry stays where it is, as an orphan that `applyOverrides` reports (today's posture). Note: `edit for take-2@66055 left as an orphan — its park slot is taken`. This one does not set `changed`.

> **Superseded by `split-positions-by-source.md` (D4, R7-4, R8-3), 2026-11-24.** Step 7 is removed and `rekeyTakeHalves` lost its `points` and `graphicWindows` parameters. `remapOverridesThroughRecut` now moves every split's `at` through each re-cut (D1, R8-1), and `reconcileSplitAnchors`, called right after `rekeyTakeHalves`, writes a pass-2 landing's `at` onto its cut with this step's graphic-window guard, and a pass-1 survivor's `src` onto its `at`. Its note is `split 66055 anchors reconciled (at 58.467s, source 66.055s)`, not the `moved to` line below. The step is kept below as the record of the guard's reasoning.

7. **Refresh `at` (take splits only, R5-B1).** For this landed split:
   - **Condition:** it has both `at` and `src`; neither the stored `at` nor `resolvedAt` lies in any `graphicWindows` window (closed interval); and `round(resolvedAt, ms) !== at`.
   - **Write:** `at = round(resolvedAt, ms)`.
   - **Inputs:** `resolvedAt` comes from `points`. `graphicWindows` are the windows of produce's pass-1 graphic cues BEFORE hidden ones are dropped: `editedCues` at `produce.ts:5472`, the list `splitThenDropHidden` receives. No change to `splitThenDropHidden` is needed.
   - **Why both points are checked:**
     - An old `at` inside a graphic splits that graphic today; moving it would remove that split (R6-B1).
     - A new point inside a graphic, including a HIDDEN one whose window a take now covers, would split that graphic on the next run and bring back a deleted half (R7-B1).
   - This is the clock the editor reads as its old clock after this render.
   - Graphic splits, src-only splits, inert splits and splits that did not land are never touched (R4-B1, B2).
   - Note: `split 66055 moved to 58.467s on this cut`.

**Edge rules (R5-S9):**

- **A left-in-place orphan** is materialized like any candidate, so its framing is self-contained if it is ever rescued.
- **A candidate whose merged framing is empty** keeps its other fields and gets no `video`/`pip`.
- **The mover's framing replaces** whatever `T` would have inherited. Because the split is flagged, `T` inherits no framing from the new root.

**`changed`** is tracked, not computed by deep compare. It is set by every write in steps 4, 5, 6 (park) and 7, so a flag-only materialization on a legacy split counts. The "left as an orphan" case does not set it.

A second call on its own output returns `changed: false`. Its only notes are the repeating "left as an orphan" ones, unlike `remapSceneOverrides`, which drops such an entry (`overrides.ts:2021-2029`). Here it stays, so the orphan report keeps telling the author.

**Known limit (R6-S1, corrected):** `recut.ts:74` passes `{at, src}` splits through unchanged, and nothing else re-anchors them. A refreshed `at` is therefore exact for the clock of the render that wrote it. After a new cut in front, it is stale until the next render refreshes it again. In between, the editor previews that split on its old clock, as every live cut preview does today.

**Parked take halves** get their own orphan wording. `orphanEditLine` (`produce.ts:2749`) says `edit for take-2@66055 is parked — its split moved to a piece that already has an edit` when `isParkedOverrideKey(id)` holds, the base contains `@`, and `isPlainTakeKey(parkedOverrideBaseKey(id))` holds. A never-parked orphan keeps the existing "dropped" sentence.

**Wiring in produce:**

- `const split = splitCues(filled, resolvedSplits.points)` (`produce.ts:5572`) becomes `const { cues: split, landed } = splitCuesWithLanding(filled, resolvedSplits.points)`, followed directly by `const takeRekey = rekeyTakeHalves(overrideDoc, landed, resolvedSplits.points, editedCues.map(c => ({ startSec: c.startSec, endSec: c.endSec })))`. `resolveSplitPoints` stays where it is.
- **Taking the result:**
  - `overrideDoc = takeRekey.doc`;
  - notes print as `  ▸ ${n}`, like the scene remap;
  - `pinnedDoc` (`5470`) becomes `let` and is rebuilt with `resolveSrcTimingPins(overrideDoc, map)`, without re-printing its reports.

  So the second `applyOverrides` (`5579`) and `dropHiddenCues` (`5597`) read the new doc.
- **Why the late position is safe** (stated in a code comment):
  - pass 1 `remapSceneOverrides` reads only anchored graphic cues;
  - the first `applyOverrides` and `splitThenDropHidden` run on graphic cues, where plain-take keys match nothing.
- **The write gate (`7448`)** ORs in `const splitHalvesChanged = takeRekey.changed`. `refreshBackup` stays `cutResult.changed`. The gate comment gains one line on why.
- **Guards in `apps/cli/test/scene-edit-remap.test.ts`:** the existing `indexOf("splitCues(filled")` guard (`:176`) becomes `indexOf("splitCuesWithLanding(filled")`. New guards cover the `rekeyTakeHalves(overrideDoc, landed` call, `overrideDoc = takeRekey.doc`, and the `pinnedDoc` rebuild, all before `applyOverrides(split`. A further guard checks that `splitHalvesChanged` appears in the write gate, and that `takeClipStarts` is both the `fillPlainCues` argument and a key of the written props (R5-S5).

The editor needs no re-keying: it reads the written-back doc on reload, and P0 makes its take ids match.

## Tests

`packages/core/test/take-halves.test.ts` (create):

1. **FE Loop shape:** `take-2@66055` with landing `66055 → take-3` re-keys to `take-3@66055`, framing intact, flag set, both notes exact.
   - **1b:** the same with `take-3` itself framed. The mover keeps its own framing and is not parked.
2. **Legacy half with no entry, still in its root:** `T` gets the root's framing, the flag is set, and resolved framing is unchanged.
3. **Legacy half with only `dx`:** the root's `scale` is materialized beside it.
4. **Incumbent present:** another candidate parks with the exact note; the incumbent's resolved framing is unchanged.
5. **Two movers (`take-2` vs `take-10`, and `take-2` vs `take-2-1`):** the lower index moves, the other parks.
6. **Park slot held, on a flagged split:** stays as an orphan, the note is printed, `changed` stays false.
   - **6b:** the same on a legacy split. The first call has `changed: true` (materialization and flag). The second call has `changed: false`.
   - **6c:** a flag-only legacy migration, where nothing moves, has `changed: true` on the first call.
7. **Never candidates:** `scene-3@sid`, `added-1@sid`, `take-kept-…@sid` and `take-2@sid#orphaned`.
8. **Whole-entry move:** `hidden` and `timing` travel with the entry.
9. **Idempotent:** the second call returns `changed: false`.
10. **Cut after the split** (the landing root is unchanged): no move, only the materialization on a legacy split.
11b. **`at` refresh:**
   - a landed `{at, src}` take split gets `at` = the resolved point;
   - a src-only split, a split that did not land, and a split whose root is a graphic are untouched;
   - a difference under 0.5 ms writes nothing.
11d. **Graphic exclusion:** a landed take split keeps its `at` when the stored `at` lies in a graphic window, and also when `resolvedAt` lies in a hidden graphic's window.
11e. **Two runs:** run 1 refreshes `at`. A cut is then added in front; run 2 on the recut clock refreshes it again to the new resolved point, and the half's key and framing hold across both. A split whose refreshed value equals its stored `at` writes nothing and leaves `changed` false.

`packages/core/test/overrides.test.ts` (modify):

11. **Take half flag:** the flag drops `video`/`pip` inheritance as whole objects, other fields still inherit, and an unflagged half still inherits.
12. **Graphic half:** the flag is ignored.
13. **Schema:** the object arm keeps `ownFraming`, the legacy arm gives `undefined`, and `remapOverridesThroughRecut` passes `ownFraming` through.
14. **`isPlainTakeKey` table:** `take-2`, `take-2-1` and `take-2@s` are true; `take-kept-1@s`, `scene-1`, `added-1` and `take-2#orphaned` are false.
15. **`ownFramingSplitIds`.**
16. **`splitCuesWithLanding`:**
    - landing on a root;
    - landing on an existing half, which gives the root id;
    - a margin-skipped split is absent;
    - `.cues` equals `splitCues`.

`apps/editor/test/useEdits.test.ts` (modify):

17. **Split on a root take:** the copy lands on `${root}@${id}`, the flag is set, and one undo removes both.
18. **Split on a flagged half `R@s1`:** `R@s2` gets `R@s1`'s own framing.
19. **Split on an unflagged legacy half:** gets the merged framing.
20. **Root with no framing:** no half entry is stored, the flag is set, and a later `patchVideo` on the root leaves the half resolving to no `video` (via `applyOverrides`).
21. **`clearVideo`:** on either piece leaves the other alone.
22. **Duplicate ⌘B:** copies nothing.
23. **Graphic target:** unchanged behaviour.
24. **Reused id:** `video`/`pip` are overwritten and other fields kept.

`apps/editor/test/take-clip-starts.test.ts` (create):

25. **`editorTakeClipStarts`:** returns `takeClipStarts` when present and span starts otherwise. `fillPlainCues` given its output for a baked-veto fixture yields the same take ids as produce's list.

`apps/cli/test/scene-edit-remap.test.ts` (modify):

26. The guards listed in P2.
26b. **Orphan wording:** `orphanEditLine("take-2@66055#orphaned")` returns exactly `  ⚠ edit for take-2@66055 is parked — its split moved to a piece that already has an edit`. `orphanEditLine("scene-3#orphaned")` keeps the existing sentence.

`packages/core/test/take-halves-pipeline.test.ts` (create):

27. **FE Loop-shaped fixture, all values inline in the test:** clip starts `[0, 8.21438, 17.94988, 21.71588, 60.76448]` (span boundaries, not half starts), no graphics in the window, split `{at: 58.784, src: 66.055, id: "66055"}` resolving to 58.467, and doc entries `take-2: {scale 2.2, dx 814.4}` and `take-2@66055: {scale 2.2, dx -664.8}`. After `splitCuesWithLanding` → `rekeyTakeHalves` → `applyOverrides`:
   - `take-3@66055` resolves to `{scale 2.2, dx -664.8}`;
   - `take-2` is unchanged;
   - the key `take-2@66055` is absent;
   - no orphans;
   - the split has `ownFraming: true` and `at: 58.467`.

## Build order (one task each, each reviewed)

1. **P0 + P1.**
   - Modify:
     - `packages/core/src/overrides.ts`;
     - `apps/cli/src/produce.ts` (`takeClipStarts` binding and render-props key);
     - `apps/editor/src/App.tsx` (`RawRenderProps`, memo);
     - `apps/editor/src/useEdits.ts`;
     - `apps/editor/src/Overlay.tsx`;
     - `packages/core/test/overrides.test.ts`;
     - `apps/editor/test/useEdits.test.ts`;
     - `apps/editor/test/item-timing-parity.test.ts`;
     - `apps/cli/test/scene-edit-remap.test.ts` (the `takeClipStarts` guard).
   - Create:
     - `apps/editor/src/takeClipStarts.ts` (`editorTakeClipStarts`);
     - `apps/editor/test/take-clip-starts.test.ts`.
   - No change: `packages/core/src/recut.ts`.
   - Tests: 11–15, 17–25, plus the `takeClipStarts` guard.
2. **P2.**
   - Modify:
     - `packages/core/src/overrides.ts` (`splitCuesWithLanding`);
     - `packages/core/src/index.ts`;
     - `apps/cli/src/produce.ts` (wiring, `orphanEditLine`);
     - `packages/core/test/overrides.test.ts`;
     - `apps/cli/test/scene-edit-remap.test.ts`.
   - Create:
     - `packages/core/src/take-halves.ts`;
     - `packages/core/test/take-halves.test.ts`;
     - `packages/core/test/take-halves-pipeline.test.ts`.
   - Tests: 1–10, 11b, 11d, 11e, 16, 26, 26b, 27.
3. **Field check** on a copy of the FE Loop project.
   - **Copy:** `cp -r ~/ossclip-work/fe-loop/work ~/ossclip-work/fe-loop/work-framing-test`, then repoint `command.json`'s `--workdir`/`--out` to the copy.
   - **Repoint:** `command.json`'s `--workdir`, `--out`, `--scenes` and its top-level `"out"` all point at the copy, so the editor's Render button replays against the copy too.
   - **Run:** `pnpm ossclip produce` with the copy's `command.json` args plus `--no-render`, logging to `field.log`.
   - **Editor:** `pnpm ossclip edit "<copy>/FE Loop-116d3cbc" --no-open --port 5181`.
   - **Log:** `field.log` has no `dropped` or `parked` line.

   Expected per split:
   - **66055:** lands in `take-3`; `take-2@66055` re-keys to `take-3@66055` and resolves to `{scale 2.2, dx -664.8}`; the split is flagged; `at` becomes 58.467.
   - **20752, 24518, 167648, 176577:** these sit on a cut seam or inside removed or kept material, so produce does not split them today. Each is absent from `landed` and stays untouched (`at` included), and there are no notes for them. The editor still shows a `take-2@20752` piece, the pre-existing deferred case in goal 4.
   - **`take-2`** (17.95 s) is unchanged.
   - **render-props** carries `takeClipStarts`, and it includes 161.291.
   - **The editor** on the copy, after reload, shows `take-10` starting at 161.29 s and `take-3@66055` framed.
   - Any deviation gets recorded and the steps stop until it is understood.

## Changes from draft 7

- **R7-B1:** step 7 checks both the old and new points against all pass-1 graphic windows, hidden ones included (`graphicWindows`). `graphicLanded` and the `splitThenDropHidden` change are dropped.
- **R7-B2:** test 27 uses span boundaries.
- **R7-B3:** goal 4 gets a third exception; the known limit is corrected (`recut.ts` passes splits through); test 11e covers two runs.
- **S1:** one signature.
- **S2:** orphan predicate.
- **S3:** parity-harness expression.
- **S4:** `recut.ts` reason.
- **S5:** field-check repointing.
- **S6:** task 2 test list.

## Changes from draft 6

- **R6-B1:** splits produce's first pass applied to a graphic are never refreshed (`graphicLanded`); test 11d.
- **R6-B2:** goal 4 narrowed to landed splits; the 20752 case is stated.
- **S1:** known limit.
- **S2:** 58.467, inequality write test.
- **S3:** `recut.ts` path.
- **S4:** orphan wording test moved to the CLI (26b).
- **S5:** parity harness edit.
- **S6:** test 27 self-contained.
- **S7:** runnable field check.
- **S8:** rollback limits.
- **S9:** "unlike".

## Changes from draft 5

- **R5-B1:** take-split-only `at` refresh (step 7).
- **S1:** `RawRenderProps` and the binding named; the field is always written.
- **S2:** the `editorTakeClipStarts` helper.
- **S3, S4:** parity test and file lists.
- **S5:** the `takeClipStarts` guard.
- **S6:** Migration paragraph.
- **S7:** goal 4 narrowed.
- **S8:** `changed` is tracked; tests 6b and 6c.
- **S9:** edge rules.
- **S10:** take-half orphan wording.
- **S11:** per-split field expectations; binding names.
- **Citations:** 5572 and 5550.

## Changes from draft 4

- **R4-B1, R4-B2:** P2d (the `at` refresh) is removed and deferred.
- **R4-B3:** the mover is chosen from the input doc before any write; test 1b.
- **R4-B4:** `changed` return, gate on it, a materialization note, test 9.
- **R4-S1:** `splitCuesWithLanding` signature and its tests.
- **R4-S2:** guard rename, "moves up" removed, adoption and rebuild guards, print format, `refreshBackup`.
- **R4-S3:** whole-entry rule.
- **R4-S4:** P0, take clip starts in render-props.
- **R4-S5:** tests 5, 10, 13–16, 24 and 27 values.
- **R4-S6:** empty-entry definition.
- **R4-S7:** Create/Modify lists, `index.ts` only in task 2, test 27 in core.
