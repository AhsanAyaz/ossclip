# Splits land where their source time says

Status: draft 2. It revises draft 1 after review round 1 (`~/ossclip-work/egm-short/split-positions-review-r1.md`). The author picked options 1B + 2A on 2026-11-23. Context:
- `take-looks-by-source.md` (built);
- `take-framing-identity.md` (phase 1, built);
- the phase-2 review `framing-phase2-review-r1.md` (its B1, B2 and S1 hazards).

Sites below are cited by symbol; line numbers drift.

## Problem

A ⌘B split stores `{at, src, id}`: `src` is the source second, and `at` is the output second at the time the split was made. `recut.ts` never re-anchors `{at, src}` splits, so `at` goes stale after a cut in front. Two readers still trust it:

1. **The render puts graphic splits at the wrong time.** Produce's first split pass (`splitThenDropHidden(editedCues, overrideDoc)` in `produce.ts`) uses the default `atSplitPoints`. After a cut in front, a graphic splits at the wrong time.
2. **The editor shows splits the render doesn't make.** Its take pass (`splitCues(filled, atSplitPoints(...))` in the `App.tsx` memo) and `ghosts.ts` also use `atSplitPoints`. A split the render margin-skips or finds inert still splits in the editor (FE Loop 20752). Phase 1's step 7 papers over this by writing `at` back, but only for landed take splits.

## Goals

- **G1.** A labelled graphic split renders at `toOutput(src)`, so it stays on the same footage moment after a cut in front.
- **G2.** After a render, the editor's old-clock split cues match produce's, except for the listed exceptions.
- **G3.** Output is identical on every run that has no new edit. That includes the label run AND the run after it (the drift is frozen, B4).
- **G4.** No deleted graphic half comes back.

**Exceptions to G2 (B5):**
- A `{at, src}` split inside a kept cleanup range is applied before the carve in the editor and after it in produce. It is rare: a split made before the range was kept.
- Produce's `reclampPinnedTiming` is not run in the editor (today's gap).
- During a live veto, a split that is inert on the old clock does not preview.

## Design

### Shared definitions and helpers (`packages/core/src/overrides.ts`)

**Schema.** The `SplitSchema` object arm gains `on: z.enum(["take", "graphic"]).optional()`. The legacy number arm's transform emits `on: undefined`. `remapOverridesThroughRecut` passes the split through whole (`recut.ts`), so `on` survives. "Plain" means `isLookPieceKey(id)`.

**`graphicSplitPoints(splits, map: TimeMap | null): ResolvedSplitPoint[]`.** These are the pass-1 (graphic) points:

| Split | Point |
| --- | --- |
| src-only (no `at`) | none (it stays in the post-carve pass) |
| at-only (legacy) | `at` |
| `{at, src}`, `on: "graphic"`, `map` set, `toOutput(src)` not null | `toOutput(src)` |
| `{at, src}`, `on: "graphic"`, inert or `map` null | `at` (keeps a deleted half hidden: r1 B2(a)) |
| `{at, src}`, `on: "take"` | none |
| `{at, src}`, unlabelled | `at` (today) |

**`takeSplitPoints(splits, map: TimeMap | null): ResolvedSplitPoint[]`.** These are the editor's old-clock take-pass points. Take every split with `at`, whatever its label. With a map, use `resolveSplitPoints(thoseSplits, map).points` (`src` wins; inert ones are dropped; at-only passes `at`). With no map, use `atSplitPoints` (today).

This matches produce's pass 2 (`resolveSplitPoints(overrideDoc.splits, map)` on `filled`), except that src-only splits stay in the editor's post-carve pass, as today (B1, B2). A graphic split in this set sits on a graphic joint, which is a no-op here, the same on both sides.

**`splitThenDropHidden(cues, doc, points?)`** additionally returns `landed: Map<string, string>`. Internally it switches to `splitCuesWithLanding`. The return field is additive, so existing destructures are unaffected.

### S1. Labels (`labelSplits`, run on every produce)

`labelSplits(doc, pass1Landed, pass1Cues, pass2Landed, map): { doc, notes, changed }`. It runs on every produce (S1), which makes it idempotent. Running it every time also re-labels a doc after a rollback strips `on`.
- **Where:** right after the second split pass (`splitCuesWithLanding(filled, ...)` and `rekeyTakeHalves`), before `pinnedDoc` is rebuilt and before `migrateTakeLooks`.
- **Write gate:** `splitsLabelled` is added to the produce reasons object and `overrides-write.ts` (`OverridesWriteReasons`, `REASON_PHRASES`: `splits labelled by what they cut`).

**Which splits it handles:** only splits without `on`, and with both `at` and `src`.

**Decision table (B3):**

| Pass 1 (stale `at`) landed on | Pass 2 (`src`) landed on | Label |
| --- | --- | --- |
| graphic G, with `toOutput(src)` inside G's pass-1 window | anything | `"graphic"`, freezing any drift (see below) |
| graphic G, with `toOutput(src)` outside G | anything | none (keeps `at` in pass 1, today) |
| nothing | a plain cue (`isLookPieceKey`) | `"take"` |
| nothing | a graphic joint, or nothing | none |

**Drift freeze (B4).** When a split is labelled `"graphic"` and `|toOutput(src) − at| > 0.001`, set `src = round(map.toSource(at), ms)`. Today's render therefore stays put on the next run, and later cuts move it with its footage. Note: `split ${id} kept at ${at}s (source moved to ${src}s)`.

The other note is `labelled ${n} split(s) by what they cut`. It is printed only when `n > 0`.

### S2. Produce

Pass 1 calls `splitThenDropHidden(editedCues, overrideDoc, graphicSplitPoints(overrideDoc.splits, map))`. Pass 2 is unchanged.

**The label run is output-identical.** On that run every split is still unlabelled, so `graphicSplitPoints` returns today's `at` points.

**The next run is output-identical too.** A labelled graphic split resolves `toOutput(src)`, and the freeze made that equal to `at`. A split labelled `"take"` gave no pass-1 point before (it landed nowhere in pass 1), and gives none now.

### S3. Editor

- **Graphic pass:** `splitThenDropHidden(graphicCues, doc, graphicSplitPoints(doc.splits, oldClockMap))`.
- **Take pass:** `splitCues(filled, takeSplitPoints(doc.splits, oldClockMap))`.
- **Post-carve pass:** src-only splits, unchanged.
- **Ghosts:** `ghostCues(..., clock)` gains a clock parameter and uses `graphicSplitPoints(doc.splits, clock)`. App passes `liveRetimed.oldClock` (S4).

### S4. Reducer label

`addSplit` with `targetId` sets `on: isLookPieceKey(targetId) ? "take" : "graphic"`. Without `targetId`, `on` stays undefined (S3).

### S5. Phase 1's step 7 removed

`rekeyTakeHalves` drops step 7 and its `points`/`graphicWindows` parameters. The produce call site and its tests change accordingly:
- `take-halves.test.ts` tests 11b, 11d and 11e are rewritten to assert that `at` is untouched;
- `take-looks-migration` and the fixtures are updated.

The editor no longer reads `at` for resolvable splits, so nothing depends on step 7's writes. Unlabelled splits still use `at` in pass 1, by design.

**Supersede notes are added to:**
- `take-framing-identity.md` (P2 step 7);
- `take-looks-by-source.md` (L5, and its field check's `at: 58.467` expectations).

### S6. Comments to rewrite (house rule)

Each of these comments becomes false and gets rewritten in the same commit:
- `SplitSchema`'s `src`/`at` comment;
- the `atSplitPoints` and `resolveSplitPoints` docs;
- the `splitThenDropHidden` default-points comment;
- `take-halves.ts`'s module and step docs;
- produce's comments on the src backfill, on pass 2 / step 7, and at the write gate;
- `App.tsx`'s comment on its pass-1 split.

## Tests (inline values)

**Core, `overrides.test.ts`:**
- schema: `on` is kept, and the legacy arm gives `undefined`;
- `graphicSplitPoints`, one case per table row;
- `takeSplitPoints` with a map, without a map, and with an inert split;
- `splitThenDropHidden` returns `landed`.

**Core, `split-labels.test.ts`** (new): one case per decision-table row.
- Graphic: G `[10, 20]` output, a split with `at 15`, `src` mapping to 15 → `"graphic"`.
- Drift: the same split, but `src` maps to 13 → `"graphic"`, `src` frozen to `toSource(15)`, and the note.
- Outside: `src` maps to 25 → unlabelled.
- Take: lands only in pass 2 on `take-2` → `"take"`.
- Joint or nothing → unlabelled.
- Idempotent: a second run gives no change.

**Core pipeline, `split-positions-pipeline.test.ts`** (new):
- the label run and the next run are both output-identical, for a fixture with a graphic split, a take split, a drifted graphic split and an inert graphic split with a hidden half;
- after a 2 s cut in front, the labelled graphic split lands at `toOutput(src)`;
- the hidden half stays hidden;
- a `"take"` split never splits a graphic in pass 1.

**Editor parity (`item-timing-parity.test.ts`):** the editor's old-clock pipeline and produce's yield the same split cue ids and windows for:
- the 20752 shape (margin-skipped);
- an inert split;
- a labelled graphic split after a cut;
- a src-only split.

With no clock, the editor falls back to `at`.

**`ghosts.test.ts`:** with a clock, a labelled graphic split resolves by `src`.

**`useEdits.test.ts`:**
- ⌘B on a take gives `on: "take"`;
- ⌘B on a graphic gives `"graphic"`;
- ⌘B with no `targetId` gives no label.

**Source guards (`scene-edit-remap.test.ts`, `caption-report.test.ts` gate regex):**
- `graphicSplitPoints(overrideDoc.splits, map)` is passed to `splitThenDropHidden(editedCues`;
- `labelSplits(` comes after `rekeyTakeHalves(` and before `migrateTakeLooks(`;
- `splitsLabelled` is in the write gate;
- the editor uses `takeSplitPoints(` and `graphicSplitPoints(`.

## Field check (B6)

A script, `~/ossclip-work/fe-loop/splits-field-check.sh`, modelled on `looks-field-check.sh`. It works on a fresh copy of the FE Loop workdir.

1. **Setup.** Add a graphic split inside `shot-s1` (its source window is 12.57–20.435 in `overrides.json`) at source 16.5. Write it as `{at: toOutput(16.5), src: 16.5, id: "fc1"}`, where `at` is computed from the copy's render-props `spans`. Then confirm that `shot-s1`'s render-props cue covers that `at`.
2. **Run 1.** Expect:
   - `fc1` gets `on: "graphic"`;
   - 66055 gets `on: "take"`;
   - 20752, 24518, 167648 and 176577 stay unlabelled (inert or src-only);
   - `shot-s1` and `shot-s1@fc1` cues exist at the split point;
   - no other cue changed against `render-props.before.json`.
3. **Run 2.** Add the cut `src [2, 4]` and run again. Expect `shot-s1@fc1` to start at the run-1 start − 2.000 (±0.002), and 66055's half to sit on its footage.
4. **Editor parity.** In a headless browser on the copy, the Timeline's block starts (`data-piece-start`) equal render-props' plain and graphic cue starts. The one known extra is the editor's src-only path, which is listed.

## Build

One task, then the field check.
- **Files:**
  - `packages/core/src/overrides.ts`, `take-halves.ts`, `overrides-write.ts`;
  - `apps/cli/src/produce.ts`;
  - `apps/editor/src/App.tsx`, `ghosts.ts`, `useEdits.ts`;
  - the tests listed above, plus `take-looks-migration.test.ts` and the fixtures;
  - the two design docs (supersede notes).
- **Tests:** everything in the Tests section.
