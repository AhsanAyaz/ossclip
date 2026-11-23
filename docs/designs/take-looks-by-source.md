# Take looks attached to source time

Status: draft 7, ready to plan (review round 6: 0 blocking, `~/ossclip-work/egm-short/take-looks-review-r6.md`). **The rulings sections at the end override earlier text; later rulings override earlier ones.** This design replaces `take-framing-phase-2.md` (paused) and supersedes parts of phase 1 (`take-framing-identity.md`). The author approved the direction on 2026-11-23: "things are attached to chunks, and chunks attached at the TS on the timeline", modelled on how other editors work.

## Why

ossclip never stores its takes. Each run, and the editor live, rebuilds them as the gaps graphics leave, cut at clip starts, and names them by position (`take-0`, `take-2-1`, `take-2@split`). A take's look is saved under that positional name: framing (`video`), picture-in-picture (`pip`), `layout`, `captionY` and `captionScale`. Anything that renumbers the takes moves that look onto other footage or drops it:

- a cut in front;
- a graphic added, removed or moved;
- a kept cleanup range.

Premiere, Resolve and Final Cut store clips as objects that point at source media. ossclip already keys cuts, splits and caption edits on **source seconds** (§155: key on the property the disruption cannot move). This design gives take looks the same treatment: a look belongs to a **source range**. A take piece shows the look of the footage it plays, wherever that footage lands on the output.

## Goals

- **The look stays on the footage.** A take piece's look stays on the same source footage across cuts anywhere, graphic changes, kept or dismissed cleanup ranges, and re-renders.
- **Edits stay local.** Editing one take piece never changes another. A ⌘B piece starts with the look of its footage.
- **Preview matches render.** The editor preview and the render resolve looks the same way.
- **Migration is invisible.** Existing projects render identically after a one-time migration.

Non-goals:

- graphic scenes (they keep their id keys and word anchors);
- the deferred graphic-split items in `take-framing-phase-2.md`;
- splitting takes at look boundaries (cut from v1, review S4). A piece shows the look with the largest overlap;
- take-keyed `hidden` and `timing`, which stay id-keyed and are re-keyed by phase 1 for halves (m11).

Declared limit: a graphic deleted between two differently-looked pieces merges them into one piece that shows the larger look, until the author splits it again.

## Design

### L1. Data and pure helpers (`packages/core/src/take-looks.ts`)

```ts
type SrcRange = { srcIn: number; srcOut: number };            // source seconds, ms-rounded
type TakeLook = Pick<SceneOverride, "video" | "pip" | "layout" | "captionY" | "captionScale">;
OverrideDoc.takeLooks?: Array<SrcRange & { look: TakeLook }>;
```

`video` includes `volume` and `autoZoom`, which are look fields too.

**Schema posture (S9).** The schema stays optional. Parsing normalizes instead of rejecting:
- drops entries that are non-finite, have `srcIn ≥ srcOut`, or carry an empty look;
- sorts the rest;
- resolves overlaps (the later entry wins on the overlapped part);
- coalesces neighbours whose gap is ≤ 1 ms and whose looks are deep-equal.

The helpers:

- **Windows** are `{ startSec, endSec }` on the given map's clock. Every helper rounds source seconds to the millisecond itself. "Later entry wins" means later in input order (m3).
- **`pieceSourceRanges(window, map): SrcRange[]`.** The source segments an output window plays. There is one per kept span it touches, and each is clipped to that span exactly. There is no inset (B7). A live-clock piece can cross a seam, which is why this returns a list (S7).
- **`lookAt(looks, ranges): TakeLook`.**
  - Picks the single look ENTRY with the largest total overlap with `ranges`. It works per entry, not per distinct look (m2). Overlaps under 1 ms are ignored (the floor), and ties go to the lower `srcIn`.
  - Returns `{}` when nothing overlaps.
- **`setTakeLook(looks, ranges, patch): looks`.** This is field-scoped (R4-S10).
  - It fragments entries at the range edges. Then, over every part of `ranges`, it merges `patch` into that part's own look (or into `{}` where nothing is there). `video` and `pip` merge field by field.
  - Fields the patch does not name keep their per-part values. So an edit on a mixed piece sets the edited field everywhere in the piece and leaves the minority look's other fields alone.
  - It normalizes at the end.
  - Choosing `full-bleed` explicitly stores `layout: "full-bleed"`.
- **`clearTakeLookFields(looks, ranges, fields): looks`.** It deletes `fields` over every part of `ranges`, which is a real reset for those fields. Then it normalizes.

### L2. Resolution: one place, both pipelines (B3)

**Only for migrated docs** (`doc.takeLooks !== undefined`, L3). A legacy doc skips this pass in both pipelines.

**`applyTakeLooks(cues, looks, map): SceneCue[]`.** For every plain take cue (`kind === "plain"`, including `take-kept-*` and halves), with `look = lookAt(looks, pieceSourceRanges(cue window, map))`:

- `video`, `pip`, `captionY` and `captionScale` are SET from `look`, and deleted when `look` lacks them. They are the only source of these fields on plain takes, so nothing a carve or split copied from a neighbour can leak through.
- `layout` = `look.layout ?? "full-bleed"`. That is `fillPlainCues`' base layout. `carveKeptTakes` itself is unchanged (S13).
  - Declared look-mode change: a minted kept block with no plain neighbour used `"video-top"`; in look mode it is `"full-bleed"` unless its footage has a look.
  - Declared look-mode change (S14): kept and minted blocks stop borrowing their host's or neighbour's framing. They show their own footage's look.
- Graphic cues are untouched.

**Produce order (S14):**
1. cut remap (`produce.ts:~5133`);
2. fill;
3. carve;
4. `resolveSplitPoints`;
5. `splitCuesWithLanding`;
6. `rekeyTakeHalves`;
7. the second `applyOverrides`;
8. `migrateTakeLooks` (once, L3);
9. `applyTakeLooks(…, overrideDoc.takeLooks, map)`, when migrated;
10. `resolveItemTimings`;
11. drop hidden.

Steps 8 and 9 sit right after `applyOverrides(split, pinnedDoc.doc)` (`produce.ts:~5625`).

**Editor order (B8):**
- **Old-clock pass.** `splitCues` → `applyOverrides` → `dropHiddenCues` → `applyTakeLooks(cues, looks, oldClockMap)` → `withStagePreviews`. With no old-clock map (no spans: an unrendered workdir), the editor cannot place looks. It shows takes without looks and refuses look edits (L4). A migrated doc always has a prior render, because produce migrated it while writing one (N4).
- **`finishOnClock` main path.** `carveKeptTakes` → `splitCues` → `applyOverrides` → `applyTakeLooks(merged, looks, clockMap)` → `previewItemTimings` → `withStagePreviews`.
- **`finishOnClock` early exit.** This includes a live cut with no transcript loaded (S6). The cues are the old-clock pass's, retimed, so each piece keeps the look it resolved on the old clock. Under a live cut, a piece that straddles the new seam may show a look the render would split differently; that is the same class as every live-cut preview today. The parity test compares old-clock and kept-block cases by output time, not live seams.

`withStagePreviews` stays last, so a mid-drag preview shows over the look.

### L3. Migration: once, in produce, on the current pieces (N1–N4, N7, S1–S3)

**Marker.** `doc.takeLooks` being PRESENT (even `[]`) means "migrated". Absent means legacy.
- **Legacy docs:** everything behaves exactly as today in the editor and in produce. `applyTakeLooks` is not called, and the editor's look writes stay id-keyed.
- **The gate:** build step 1 is behaviour-neutral by this gate (N1). The editor never migrates (no load-time pass, no dirty-on-load: N7). It switches to look mode when it reloads a doc that produce has migrated.

**Where.** Produce runs `migrateTakeLooks(overrideDoc, overriddenCues, map, ownFramingSplitIds(overrideDoc.splits)): { doc, notes, changed }` once. `overrideDoc` is the doc after `rekeyTakeHalves`, not `pinnedDoc.doc`. `overriddenCues` is the output of the second `applyOverrides`. `changed` is true whenever it sets the marker, so even a project with no take looks saves `takeLooks: []` once (S5). It runs when `doc.takeLooks === undefined`. It runs right after the second `applyOverrides(split, pinnedDoc.doc)` (`produce.ts:~5625`), so it comes after:
- the cut remap;
- `resolveSplitPoints`;
- phase 1's `rekeyTakeHalves`;
- the splits.

The pieces are this run's pieces on this run's map, so they always exist (N3, N4).

**Rules.**
1. For each plain take cue P in `cues` (any id passing `isLookPieceKey`), compute `values = inScope(effectiveOverride(doc.scenes, P.id, ownFramingIds))`. This includes a half's inheritance from its root (N2). Only id-keyed values count, never plan values.
   - **One base exception (R4-S7):** when P's resolved `layout` is not `"full-bleed"` and `values` has no `layout` (a minted kept block with no neighbour, which got `"video-top"`), `values.layout = P.layout`. Output stays identical.
2. If `values` is non-empty, `takeLooks = setTakeLook(takeLooks, pieceSourceRanges(P window, map), values)`. The writes start from an empty list, so there is no precedence question (S3).
3. Strip the in-scope fields from every key that some plain cue P in `cues` resolves through: P.id and its root. Drop entries left empty.
4. Keys that name no current piece are left as they are: inactive `take-kept-*`, inert halves, orphans. They become dead data after migration, because look fields on takes now come only from `takeLooks`.
   - This is a declared loss (S1).
   - The note lists them: `left ${n} look edit(s) on takes not in this cut: ${keys}`.
   - The marker prevents any re-run (S2).
5. Set `doc.takeLooks` (possibly `[]`).
6. Note: `moved the look of ${n} take piece(s) onto source time`.
7. `takeLooksMigrated = changed` is ORed into the write gate.

**Produce wiring (R4-S9).**
- `migrateTakeLooks` checks the marker itself and returns `changed: false` with the doc untouched when the doc is already migrated.
- `overrideDoc = migration.doc` is assigned before the reads at `produce.ts:~5633`, `~5643`, `~5992` and the write at `~7510`.
- `applyTakeLooks`' output replaces `overriddenCues` as the input to `resolveItemTimings`.

**Output unchanged.** Every current plain piece showed exactly `values` before. After migration, `applyTakeLooks` (L2) resolves the same ranges to the same `values`, on the same map. The test asserts deep-equal resolved cues.

**One-time.** The marker guarantees it. Phase 1's `rekeyTakeHalves` step 4 runs only on legacy docs, and the gate covers the whole `ownFraming !== true` block: materialization AND setting the flag (S4). After migration nothing reads take-keyed framing, and look-mode splits are never flagged. `addSplit` stops setting `ownFraming` and stops copying for takes, in look mode only. A legacy doc keeps phase 1's behaviour until it is migrated.

**A stale editor (S11).** A render that fails or is cancelled, or a produce run from the CLI, leaves an open editor holding the legacy doc. If the author saves it, the marker is dropped and the in-scope fields return to the take keys. The next produce migrates again, idempotently, from those fields. No look is lost, because the editor never wrote looks on that doc. Tested.

**Why `take-kept-<ms>` keys are not migrated from the source time in their id (m12).** That id encodes only `srcIn`. Its `srcOut` comes from the cleanup range, which may since have changed. An inactive kept block is footage the current cut removes, so a look on it would apply to nothing. Leaving it listed in the note is honest.

**Rollback limit.** An older build drops `takeLooks` and finds the take fields stripped, so takes render unframed. `.bak` is not refreshed (the existing posture).

### L4. Editor writes go to source ranges (look mode only)

**Clock (S5).** App passes `cueClock: TimeMap | null` (from `liveRetimed.cueClock`) to Inspector and Overlay, next to `toSourceSec`.

**Target piece (N5, R3-B1, R4-B1).** Carved lead and tail pieces share an id, so in look mode the selection names a piece by **source time**. That is the same principle as the looks, and it survives live cuts, undo, redo and reloads.
- `Selection` (`Overlay.tsx:11`) gains `pieceSrc?: number`: the source second at the selected piece's midpoint. It is `pieceSourceRanges(window, cueClock)`, at the middle of the longest range.
- **Every site that selects a plain cue sets it (R4-S2):**
  - Timeline click (`Timeline.tsx:~1574`);
  - stage click (Overlay hit test, from the clicked cue);
  - ⌥-arrow walk (`Overlay.tsx:~1398`);
  - ⌘-arrow (`Overlay.tsx:~1420`);
  - the hidden-scene remap (`App.tsx:~2373`).

  Selection equality, Timeline `isSelected` and keys (`Timeline.tsx:~1565`, `~1572`), and the ⌥-walk index all compare `(sceneId, pieceSrc)` for plain cues.
- **One resolver,** `selectedPiece(cues, selection, cueClock)` in `apps/editor/src/takeLookTarget.ts`. It returns the plain cue with that id whose `pieceSourceRanges` contain `pieceSrc`. If there is none, it returns **null**, never the lead silently.
- **Revalidation.** An effect keyed on `[liveCues, cueClock]` clears a selection whose piece no longer resolves. That covers reloads, renders and live cuts that remove that footage.
- **Users of the resolver** (look mode only; legacy mode keeps id matching, R4-S11):
  - `selectedCue` (`App.tsx:~2346`);
  - the Overlay drag bases (`Overlay.tsx:~879`, `~891`);
  - every look write.
- **Preview identity (R4-S1).** `VideoPreview` gains `pieceSrc?`, set by `Inspector.tsx:~1747` and `Overlay.tsx:~1057` from the resolved piece. `withStagePreviews` matches a plain cue only when its ranges contain `pieceSrc`. It already runs in both passes, so a match in either is correct. `selection` does not join the memo deps.

The range is `pieceSourceRanges(piece window, cueClock)`. With a null clock the site refuses: `onClockRefused("Can't edit this take's look yet — render once and try again.")`.

**Actions (one commit each).** A write whose result equals the current looks is a no-op with no commit (S1). **Refused legacy actions (R4-S4).** `isLookPieceKey(id)` is `plainTakeOrdinal(id) !== null || /^take-kept-/.test(splitRootId(id))`, exported from `overrides.ts`. In look mode the reducer refuses `patchVideo`, `clearVideo`, `patchPip`, `clearPip`, `patchLayout`, `patchCaptionY`, `patchCaptionScale` and `clearCaptionStyle` whenever the target id passes `isLookPieceKey`. It returns the state unchanged and sets `lastRefusal`, which App shows as the existing clock-refused notice. So a drag that started before a reload cannot write to the old keys.

**Load clearing (R4-S3).** Drag starts capture their ranges up front. `useEdits` exposes `loadCount`, incremented by `load`. Effects in App and Overlay keyed on it clear `videoPreview`, `graphicPreview` and Overlay's drag refs. The file list moves this to `App.tsx` and `Overlay.tsx`.

**Old to new action mapping (m13):** `edits.patchVideo(id, patch)` → `edits.patchTakeLook(ranges, { video: patch }, coalesce)`; `clearVideo` → `clearTakeLookFields(ranges, ["video"])`; and the same pattern for `pip`, `layout`, `captionY`, `captionScale`, and `clearCaptionStyle` → `["captionY", "captionScale"]`.

**Action list:**
- `patchTakeLook { ranges, patch, coalesce? }`, coalesce key `look:${ranges[0].srcIn}:${field}` (S17).
- `clearTakeLookFields { ranges, fields }`.
- `patchCaptionStyleAll { sceneIds, takeRanges: SrcRange[][], y?, scale? }` (N6, S3).
  - In look mode, whatever cue is selected, the call site passes only the non-plain ids from `allSceneIds` (`App.tsx:~3503`, which today includes take ids), plus one range list per plain cue in `sceneCues` (R4-S5).
  - With a null clock, only the graphic part applies, and a refusal note shows for the takes.
  - Footage on no current piece is untouched (a limit).

**Dispatch sites (S10)** branch on `cue.kind === "plain" && doc.takeLooks !== undefined`:
- Inspector:
  - video scale, dx, dy and volume (`Inspector.tsx:~1755-1858`), including the zoom scrub preview;
  - the autoZoom toggle;
  - pip corner radius, x and y (`Inspector.tsx:~1912`, `~1922`);
  - layout select (`patchLayout`);
  - caption Y and scale;
  - Reset framing (`clearVideo`), Reset pip, Reset captions (`clearCaptionStyle` → fields `["captionY", "captionScale"]`);
  - "apply captions to all" (`patchCaptionStyleAll`).
- Overlay:
  - the video drag (base `Overlay.tsx:~891`, commit `~1151`);
  - the pip drag (commit `~1027`). There is no pip resize gesture.

  Overlay has no caption drag.

**Read sites and no-op guards (S4)** in look mode use `lookAt(doc.takeLooks, ranges)` instead of `doc.scenes[take].video` and the like:
- Reset-button visibility (`Inspector.tsx:~2042`, `~2125`);
- the reducer's no-op guards.

**⌘B (look mode).** It adds only the split. `addSplit`'s copy and flag apply only to legacy docs.

**Legacy mode.** Every site behaves exactly as today.

### L5. Phase 1 after this

- **Kept:**
  - P0 `takeClipStarts`: same pieces in the editor and the render.
  - Step 7's `at` refresh.
  - `rekeyTakeHalves` steps 1–3 and 5–6, which re-key half entries for non-look fields such as `hidden`.
  - Step 4 (materialization) and the `addSplit` take copy, **for legacy docs only.** In produce, step 4 runs in the same run as the migration, just before it, so a moved legacy half keeps its framing into the migration. After migration both are skipped (gated on `doc.takeLooks === undefined`).
- **Inert after migration:** the `ownFraming` reading in `effectiveOverride`/`applyOverrides`, because takes carry no look fields.
- **Existing tests (S7):** `useEdits.test.ts` tests 17–24, the `take-halves.test.ts` materialization cases and `item-timing-parity.test.ts:~542-571` all use legacy docs. They stay as legacy coverage, and look-mode versions are added.
- **Exports (S12):** `take-looks.ts` is exported from `packages/core/src/index.ts` and `packages/core/src/browser.ts`. The `takeLooks` schema lives in `OverrideDocSchema` (`overrides.ts`).

## Alternatives considered (S11)

- **Positional ids, re-keyed each render** (phase 1 halves, phase 2 drafts 1–3). Every review round found new identity cases, because ids depend on graphics, cuts and kept ranges. Rejected.
- **A stored clip list with minted ids** (Premiere-style registry). It works, but needs matching derived pieces to the registry and new UI identity. Rejected as more machinery than needed for five look fields.
- **Source-range looks (chosen).** This is the existing §155 posture, and nothing has to be matched.

## Risks and limits

- **Merged pieces.** A take piece spanning two looks shows the one with the larger overlap. This happens when a graphic is deleted between two differently-looked pieces, when a cut removes the material between two such pieces, or when a ⌘B split is deleted. The author re-splits to separate them.
- **⌘B on a mixed piece (m7).** Splitting a piece that spans two looks gives each half the look with its own larger overlap, so the picture can change at the split.
- **Live-cut seams.** In the editor's early exit, a piece that crosses a live-cut seam may preview a different look than the render.
- **Dead data.** Inactive take keys that hold look fields become dead data at migration (listed in the note).
- **Unrendered workdirs.** A legacy-mode editor on a never-rendered workdir behaves as today.
- **Stale editor.** An editor still holding the legacy doc after a failed render or a CLI produce re-adds the take fields if the author saves it. The next produce migrates again (L3).
- **Rollback.** An older build drops `takeLooks`, and takes render unframed.
- **Existing drift.** It is frozen, not repaired: whatever a take shows at migration becomes its look. FE Loop's 17.95 s framing still needs a check by eye.

## Tests

**Core, `packages/core/test/take-looks.test.ts` (new):**
- `pieceSourceRanges`: a single span, across a seam, a kept block.
- `lookAt`: largest overlap, the 1 ms floor, a tie on `srcIn`, empty.
- `setTakeLook`:
  - a piece spanning two looks becomes uniform (`lookAt` plus the patch);
  - field-by-field `video` merge;
  - fragmenting at both edges;
  - coalescing within 1 ms.
- `clearTakeLookFields` resets a field over the whole piece.
- A fixed-seed random sequence of 200 writes keeps the invariants.
- Schema normalization drops bad entries, sorts, and resolves overlaps (the later entry wins).
- `applyTakeLooks`:
  - SET semantics: a cue arriving with `video: {scale: 2}` and no look ends with no `video`;
  - layout base `full-bleed`;
  - a kept block;
  - a half;
  - a graphic untouched.

**Core, `packages/core/test/take-looks-migration.test.ts` (new).** It uses two fixtures, run through a small in-test pipeline built from core functions: fill, carve, split, `rekeyTakeHalves`, `applyOverrides`, migrate, then `applyTakeLooks`.
- **(a) Pre-phase-1 shape**, as in the real FE Loop workdir: `take-2@66055` unflagged.
- **(b) Post-phase-1 shape:** `take-3@66055`, flagged.

"Before" means the resolved cues of the same pipeline with migration and `applyTakeLooks` skipped.
1. In both fixtures, migration gives two looks, the resolved cues deep-equal "before", and every in-scope take field is stripped. In fixture (a), "before" already shows `take-3@66055` framed, because `rekeyTakeHalves` runs in both (R4-S6).
   - Fixture inputs: spans `[0→1.30997…]` copied from the real workdir's `render-props.json` `spans`, `takeClipStarts` from the copy's render-props, splits as in its `overrides.json`, and `scenes` `take-2` / `take-2@66055` (a) or `take-3@66055` (b) with the values above.
2. A half inheriting from its root: the look comes from `effectiveOverride`, and both keys are stripped.
3. An inactive `take-kept-*` key is left as it is and named in the note.
4. The marker stops a second migration.
5. N2, the second case: a half with its own `dx` only, whose root has `scale`. The look gets both, and the resolved cue is unchanged.
6. Stale-editor round trip: drop the marker and restore the fields, then migrate again. Same looks, same cues.
7. A doc with no take looks gets `takeLooks: []` and `changed: true`, and a second run gives `changed: false`.

**Core, `packages/core/test/take-looks-pipeline.test.ts` (new):** a migrated doc with a look on `[66.055, 68.353]` = `{scale 2.2, dx -664.8}`.
- After the cut `src [2, 4]` the piece holding 66.055 shows it.
- A graphic inserted over `[67, 67.5]`: both visible pieces show it.
- A cut through at `[67, 67.2]`: both pieces show it.
- No edits: the second run is identical, and `takeLooksMigrated` is false.

**Editor, `apps/editor/test/useEdits.test.ts`:**
- In look mode: `patchTakeLook`; `clearTakeLookFields`; a coalesced drag with one undo; `patchCaptionStyleAll` with mixed ids and take ranges; `clearCaptionStyle` on a take; ⌘B adds only a split.
- In legacy mode: the existing behaviour is unchanged.

**Editor, `apps/editor/test/take-look-target.test.ts` (new):**
- a selection with `pieceSrc` in the carved tail resolves the tail, not the lead (R4-S8);
- after a live cut in front, the same `pieceSrc` still resolves the same piece;
- a `pieceSrc` whose footage is cut resolves null, and the revalidation effect clears the selection;
- the ⌥-walk from the lead goes to the tail, then to the next id;
- undo of a cut restores resolution.

**Parity (`apps/editor/test/item-timing-parity.test.ts` harness):** the editor pipeline and the produce pipeline resolve identical take looks, by output time, on the old clock and with a kept block.

**Source guards:**
- `apps/cli/test/scene-edit-remap.test.ts`:
  - `migrateTakeLooks(` and `applyTakeLooks(` both after `applyOverrides(split`, in that order;
  - `takeLooksMigrated` in the write gate.
- `apps/editor/test/take-looks-wiring.test.ts` (new): `applyTakeLooks(` in both memo passes, before `withStagePreviews(`.

## Build order (S8, S9, S10)

1. **L1 + L2.** No behaviour change, because no doc has the marker yet.
   - Create:
     - `packages/core/src/take-looks.ts` (types, `pieceSourceRanges`, `lookAt`, `setTakeLook`, `clearTakeLookFields`, `normalizeTakeLooks`, `applyTakeLooks`);
     - `packages/core/test/take-looks.test.ts`;
     - `apps/editor/test/take-looks-wiring.test.ts`.
   - Modify:
     - `packages/core/src/overrides.ts` (`OverrideDocSchema.takeLooks` with the normalizer);
     - `packages/core/src/index.ts` and `browser.ts`;
     - `apps/cli/src/produce.ts` (the gated `applyTakeLooks`);
     - `apps/editor/src/App.tsx` (the gated look passes in both memo paths);
     - `apps/cli/test/scene-edit-remap.test.ts`.
   - Tests: the take-looks unit tests, the `applyTakeLooks` tests, the wiring guards.
2. **L3 + L4, together**, so the editor is never in look mode without write support.
   - Create:
     - `packages/core/src/take-looks-migrate.ts` (`migrateTakeLooks`);
     - `apps/editor/src/takeLookTarget.ts` (`selectedPiece`);
     - `packages/core/test/take-looks-migration.test.ts`;
     - `packages/core/test/take-looks-pipeline.test.ts`;
     - `apps/editor/test/take-look-target.test.ts`.
   - Modify:
     - `packages/core/src/take-halves.ts` (step 4 gating);
     - `apps/cli/src/produce.ts` (the migration and its gate);
     - `apps/editor/src/useEdits.ts` (actions, no-ops, legacy refusal, `addSplit` gating, `load` clearing);
     - `apps/editor/src/App.tsx` (`selectedCue`, previews, `cueClock` prop);
     - `apps/editor/src/Inspector.tsx`, `Overlay.tsx` and `Timeline.tsx` (dispatch, read and selection sites);
     - `apps/editor/test/useEdits.test.ts`;
     - `apps/editor/test/item-timing-parity.test.ts`;
     - `apps/cli/test/scene-edit-remap.test.ts`.
   - Tests: migration, pipeline, editor and parity.
3. **Field check (S9, R4-S12).**
   - **Prerequisites:** `/mnt/c/Users/ahsanayaz/Videos/FE Loop/FE Loop` is mounted. Caches in the copied workdir mean no LLM call is expected; the copy run on 2026-11-23 took 1.1 s and made none. If one runs, record it.
   - **Setup:**
     ```sh
     rm -rf ~/ossclip-work/fe-loop/work-looks-test
     cp -r ~/ossclip-work/fe-loop/work ~/ossclip-work/fe-loop/work-looks-test
     cd ~/ossclip-work/fe-loop/work-looks-test/"FE Loop-116d3cbc"
     # rewrite every "/ossclip-work/fe-loop/work" in command.json args and "out" to ".../work-looks-test"
     cp render-props.json render-props.before.json
     ```
     The original workdir is never touched, so no restore step is needed.
   - **Run 1:** from the repo, `pnpm ossclip $(args from the copy's command.json) --no-render --no-open-editor > looks1.log 2>&1`. Expect:
     - the notes, exactly:
       - `split 66055 now owns its framing`
       - `edit for take-2@66055 re-keyed to take-3@66055 — its split now falls in take-3`
       - `split 66055 moved to 58.467s on this cut`
       - `moved the look of 2 take piece(s) onto source time`
     - no `left … look edit(s)` note;
     - `overrides.json` `takeLooks` has exactly 2 entries: `[20.752, 24.518] → {video: {scale 2.2, dx 814.4}}` and `[66.055, 68.353] → {video: {scale 2.2, dx -664.8}}`, ±1 ms;
     - split `66055` has `ownFraming: true` and `at: 58.467`;
     - `take-2` and `take-3@66055` have no `video` entry;
     - `sceneCues` compared to `render-props.before.json`: each before-cue matched to the after-cue covering its midpoint has an equal `video`, except the piece at 58.467–60.764, which is now `{scale 2.2, dx -664.8}`.
   - **Run 2:** append `{"startSec": 0, "endSec": 0, "src": {"startSec": 2.0, "endSec": 4.0}}` to `overrides.json` `cuts`, then run again into `looks2.log`. Expect:
     - the cue covering source 20.752 has `{scale 2.2, dx 814.4}` and starts at 15.950 (±0.002);
     - the cue covering source 66.055 has `{scale 2.2, dx -664.8}` and starts at 56.467 (±0.002);
     - no migration note;
     - no `dropped` or `parked` lines.

## Draft 6 rulings (round 5)

These override the sections above where they differ.

**R6-1. The selection anchor is a source extent (S1).**
- **The anchor.** In look mode, `Selection` gains `pieceExtent?: { srcIn, srcOut }`, replacing `pieceSrc`. It is the hull of `pieceSourceRanges(window, cueClock)`.
- **The resolver.** `selectedPiece(cues, selection, clock)` returns the plain cue whose ranges overlap the extent most. It does not depend on ids. Overlaps under 1 ms count as none, and with no overlap it returns null.
- **Revalidation.** `revalidateSelection` rewrites the extent to the resolved piece's own hull, or clears the selection when nothing resolves.
- **After ⌘B,** the selection follows the half that holds more of the old extent.
- **A selection from legacy mode** that has no extent gets one at the first revalidation in look mode, by id match (first cue with that id). This is the only place an id is used.

**R6-2. Framing is one write unit (S5).** Any patch that touches `scale`, `dx` or `dy` writes all three. It takes the piece's currently resolved values and lays the patch over them. `volume` and `autoZoom` stay separate fields. `pip` `{x, y}` is also one unit; `cornerRadius` stays separate.

**R6-3. Writes cover the piece's hull (S6).** `setTakeLook` and `clearTakeLookFields` write over the hull `[min srcIn, max srcOut]` of the piece's ranges, including any material a live cut removed in between. So restored material (`restoreChunk`) shows the look of the footage around it, and an older look cannot come back.

**R6-4. Plumbing (S2, S3, S4).**
- **Helpers.** `pieceAnchor(cue, clock)`, `revalidateSelection(sel, cues, clock)` and `walkPiece(cues, sel, dir, clock)` are exported from `apps/editor/src/takeLookTarget.ts`, and the call sites use them.
- **Timeline.** It gets a `cueClock` prop (`App.tsx:~3570`).
  - `isSelected(cue)` is `selectedPiece(...) === cue`.
  - Block keys and testids are `${cue.id}:${cue.startSec.toFixed(3)}`.
  - The scroll query (`Timeline.tsx:~690`) goes through the resolver.
- **Stage click.** It resolves `activeCueAt(cues, frame / fps)` at mousedown, before the drag bases are read.
- **Gating.** Every extent behaviour is gated on `takeLooks !== undefined` and applies to plain-cue selections only. Legacy mode is unchanged.

**R6-5. The refusal notice (S7).** It is `lastRefusal: { message: string; seq: number } | null`, held as hook state outside the doc. App shows it once per `seq`. Tested.

**R6-6. Apply captions to all (S8).** A single branch rule applies: in look mode, App passes an `allTakeRanges: SrcRange[][]` prop, with one entry per plain cue in `sceneCues` computed on `cueClock`. The reducer also drops any `isLookPieceKey` id from `sceneIds` in look mode.

**R6-7. Tests (S9).**
- `take-look-target.test.ts` tests the pure helpers:
  - the tail resolves;
  - a live cut in front;
  - footage cut gives null and clears the selection;
  - the walk;
  - undo;
  - ⌘B follows the larger half;
  - a legacy selection gets an extent.
- Task 2 adds `Inspector.test.ts` and `Overlay.test.ts` cases. Each look control in look mode dispatches only the look actions, legacy mode is unchanged, the Inspector shows the tail's values, and a scrub previews only the tail.
- The migration tests add a flagged half that inherits `captionY`.

**R6-8. Module boundary (S10).**
- `isLookPieceKey` lives in `overrides.ts` (task 1).
- `inScope(o?: SceneOverride): TakeLook` picks the five keys and drops `undefined` values and empty records. It lives in `take-looks.ts`.
- `isEmptyEntry` moves from `useEdits.ts:491` to `take-looks.ts` and is re-exported.
- `take-looks.ts` imports `overrides.ts` for types only, because the schema imports `normalizeTakeLooks`.
- Task 2 adds `export * from "./take-looks-migrate"` to `index.ts`.

**R6-9. Migration fixture (S11).**
- Spans: the 10 literal spans from `work/FE Loop-116d3cbc/render-props.json:3-63`. The first is `{srcIn 1.30531, srcOut 9.51969, outIn 0}`.
- Splits: as in `overrides.json:108-131`.
- Clip starts: `spans.map(s => s.outIn)`. This equals produce's list here, because the kept-edge starts are already span `outIn`s.
- The "1.30997" text above is wrong; these values replace it.

**R6-10. Field check (S12).**
- **Setup:** a script, `~/ossclip-work/fe-loop/looks-field-check.sh`. It:
  - copies the workdir;
  - rewrites `command.json` with python (the args and `"out"`);
  - runs `pnpm ossclip` from the repo with the args passed as a bash array read from JSON, so paths with spaces stay intact (`--no-render` is added, and `--no-open-editor` is already present);
  - writes logs into the copy;
  - has no cleanup step, since the copy is disposable.
- **Probes:** source 20.8 and 66.1.
- **Run 2 expects, in addition:**
  - the note `split 66055 moved to 56.467s on this cut`;
  - `at: 56.467`;
  - `takeLooks` byte-equal to run 1.

## Draft 7 rulings (round 6)

**R7-1. Revalidation also updates the id (SF-1).** `revalidateSelection` returns `{ sceneId, pieceExtent }` taken from the resolved cue, and App applies it with a functional `setSelection`. So the Inspector header, writes and previews follow the piece after a renumber or ⌘B. `VideoPreview` carries `pieceExtent`, not `pieceSrc`, and `withStagePreviews` matches a plain cue by the same largest-overlap rule in each pass.

**R7-2. The restore wording is qualified (SF-2).** Writing over the hull means material restored from INSIDE a piece takes that piece's look. Material restored at a piece's EDGE (outside its hull at the time of the write) shows whatever look it had before it was cut. That can be an older look, and it is added to Risks and limits. Two pipeline tests cover the inside case and the edge case.

**R7-3. The framing unit in detail (SF-3).**
- `setTakeLook` expands a patch that touches any of `scale`, `dx` or `dy` (and likewise `pip` `x` or `y`) using each part's own current value from `lookAt` over that part.
- A unit member absent in the current look and absent in the patch is deleted, not written as a default.
- Coalesce keys are per unit: `look:${srcIn}:framing`, `look:${srcIn}:pipPos`, and so on for the other fields.

**R7-4. Timeline test ids (SF-4).** Only the React `key` becomes `${cue.id}:${cue.startSec.toFixed(3)}`. The `data-testid` stays `timeline-block-${id}`, and a new `data-piece-start` attribute holds `startSec.toFixed(3)`.

**R7-5. `isLookPieceKey` (SF-5)** is defined as `!isParkedOverrideKey(id) && (plainTakeOrdinal(id) !== null || /^take-kept-\d+$/.test(splitRootId(id)))`.

**R7-6. Source guards split by task (SF-6).** Task 1's guard asserts only the gated `applyTakeLooks(` placement. Task 2 adds the `migrateTakeLooks(` and `takeLooksMigrated` guards.

**R7-7. `isEmptyEntry` (SF-7)** moves in Task 2. Task 2's Modify list adds `packages/core/src/take-looks.ts`, `apps/editor/src/Inspector.tsx`, `Overlay.tsx` and `Timeline.tsx`, and their tests.

**R7-8. Helper signatures and test expectations (SF-8).**
- `pieceAnchor(cue, clock): { srcIn, srcOut } | null` returns null with no clock.
- `walkPiece(cues, sel, dir, clock): Selection | null`. From the lead, +1 gives the tail, then the next plain or graphic cue. Either end returns null.
- Undo test: after a keep in front of the piece is undone, the same extent still resolves the tail.
- After a ⌘B redo, the selection follows the larger half.
- Resolver tie: if two cues overlap the extent equally, the earlier `startSec` wins.

**R7-9. The field-check script (SF-9).** One script, `looks-field-check.sh`, does setup, run 1, the cut edit and run 2. A python checker asserts every expected line and value (the probes come from `sceneCues` × `spans`) and exits 1 on any failure.

**R7-10. Fixture clip starts (SF-10).** Use produce's real list: the span `outIn`s plus the kept edges, including 161.29118, as written in `work-framing-test/FE Loop-116d3cbc/render-props.json` `takeClipStarts`. R6-9's "equals spans" reason is withdrawn.

**R7-11. The test that contradicted field-scoped writes.** The earlier tests list says "`setTakeLook`: a piece spanning two looks becomes uniform". That is replaced: "sets the patched unit across the hull, and each part keeps its other fields".
