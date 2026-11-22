# Framing that stays put, phase 2: root takes

Status: draft 3 — PAUSED for the author (2026-11-23). Review round 3 (`~/ossclip-work/egm-short/framing-phase2-review-r3.md`) found 3 blocking issues whose fixes are author decisions: how editor-created entries get their identity when the session's graphics renumber `take-N-k` pieces (B1), the rescue-loser and park-replace rules (B2, S6), and the first-run backfill/re-stamp rule (B3). Not built.

Previous status: draft 3. It revises draft 2 after review round 2 (`~/ossclip-work/egm-short/framing-phase2-review-r2.md`) and follows `take-framing-identity.md` (phase 1, commits 247cc20..d5be777). The author asked for the remaining framing drift to be closed, unattended (2026-11-22). Draft 1's Q1, Q2 and Q4 are deferred to the author (see the end).

**The big change from draft 2:** the editor no longer stamps anything. Produce records each root take's source span in render-props, and on the next run it re-keys entries from that record. That removes round 2's list and clock mismatch (S1), the browser export gap (S2), the dirty-save dependence (r1 S8), and the stale-stamp bounce (S9).

## Problem

A whole take (`take-2`, not a half) is keyed by its ordinal among the take clip starts. A cut in front of it renumbers it, so on the next render its entry lands on other footage, or becomes an orphan. That includes framing, `hidden`, layout and timing. Phase 1 fixed this only for split halves. A hidden take has the same weakness: after a cut in front, the next render can delete a different take.

## Goals

- After a render, a root-take entry stays on the same source footage across cuts elsewhere, and across graphic inserts or deletes that renumber takes.
- A project with no edits since its last render gives identical output and writes no overrides change.
- Kinds never mix. Root-take entries move only between plain root takes. Halves stay with phase 1's split landing.

### Output changes this phase makes on purpose (S8)

- An entry follows its footage when takes renumber. Today it stays on the ordinal.
- A cut through a framed take: the framing goes to the piece holding more of the footage, and the smaller piece is unframed. Today the second piece takes the next take's framing.
- A cut through a hidden take: every piece whose footage lies entirely inside the hidden span stays hidden (R3 "hidden fan-out"). So deleted footage stays deleted.

## Design

### R1. Produce records root-take spans in render-props

- **Pure helper.** `rootTakeSpans(cues, map): Record<string, { srcIn: number; srcOut: number }>` lives in `packages/core/src/take-halves.ts`. Its keys are plain root-take ids (`isPlainTakeKey`, no `@`). Each value is the union over every plain cue with that `splitRootId`: the minimum `srcIn`, the maximum `srcOut`.
  - `srcIn = map.toSource(start + 0.001)` and `srcOut = map.toSource(end − 0.001)`, both rounded to the millisecond.
  - The 1 ms inset keeps lookups off seams.
- **Produce.**
  - Compute `rootSpans = rootTakeSpans(filled, map)` right after `carveKeptTakes` (`produce.ts:~5561`). `filled` is post-carve and pre-drop, so hidden takes are included.
  - Write the result into render-props as `rootTakeSpans`, next to `takeClipStarts`.
  - It is always written. Its presence means an upgraded produce wrote this render.

### R2. Produce reads the previous render's spans

`readPriorRenderProps(path)` returns `{ map, rootTakeSpans }` and replaces `readPriorMap`'s single read (`produce.ts:745`). Both fields are null when absent or unreadable.

### R3. `rekeyRootTakes(doc, prior, current)`

Signature: `rekeyRootTakes(doc, prior: Record<string, Span> | null, current: Record<string, Span>): { doc, notes, changed }`, in `take-halves.ts`.

- **Stamping.** A root-take entry's identity is its `srcSpan`. Entries without one take it from `prior[key]` when present. This is how editor-made entries (keyed on the last render's numbering, which phase 1 made the editor share) get their identity. With no `srcSpan` and no prior span, the entry passes through untouched; that is the first upgraded run.
- **Schema.** `SceneOverrideSchema` gains `srcSpan?: { srcIn, srcOut }`: finite, non-negative, refined so `srcIn < srcOut`. An older build strips it, which is a rollback limit.
- **Entries considered.**
  - Every plain root-take key with a non-empty entry and a span: a mover.
  - Every parked root-take key (`take-N#orphaned`) with a `srcSpan`: rescuable.
  - Empty entries (`{props:{}, elements:{}}` and nothing else) are skipped, never stamped and never moved (S6).
- **Overlap.** `overlap(e, T)` is the integer milliseconds of the intersection of `e.srcSpan` and `current[T]`. The best target is the largest overlap > 0. Ties go first to the lower `current[T].srcIn`, then to the lower `plainTakeOrdinal` (S3).

**Decide, for each entry (input doc only):**
- **Stay:** an unparked key `K` whose `current[K]` overlaps and no `T` with a strictly larger overlap.
- **Claim:** if a best `T ≠ K` exists. For a parked entry, this is a rescue.
- **Park:** an unparked `K` still in `current`, but with no overlap anywhere (its id now shows other footage).
- **Pass:** otherwise. A key that is no longer in `current` stays as an orphan. A parked entry with nothing to return to stays parked, with no write (S4).

**Resolve, in this order (B1):**
1. **Stays and passes** take their keys first. Anchor-less entries (no span) also hold their keys.
2. **Claims.** A claim on a held key loses. Among several claims on a free key, the largest overlap wins; ties go to doc order.
   - **A loser falls back** to its own key if its own key overlaps, and that key is free or vacated (S7).
   - **Otherwise it parks.** The note: `edit for ${K} parked — ${T} already has its own edit` (S5).
   - Vacated keys can be claimed in the same pass, which handles a chain shift.
3. **Parks.** If `${K}#orphaned` is already taken, the newcomer REPLACES the old parked entry (B1). That entry is older and was already off-screen. Note: `edit for ${K} parked, replacing an older parked edit`. `changed` is true.

**Hidden fan-out (S8).** A winning or staying entry with `hidden: true` writes `{ hidden: true, srcSpan: current[T] }` to every other plain root take `T` whose `current[T]` lies entirely inside the entry's span and which holds no non-empty entry.
- Note: `deleted footage of ${K} also hides ${T}`.
- This is the hidden counterpart of the split rule: deleted footage stays deleted when a cut divides it.

**Re-stamp (S9).** After resolving, every root-take entry that sits on a key in `current` gets `srcSpan = current[key]`. Writing an equal value is not a change.

**Notes (exact):**
- `edit for ${K} re-keyed to ${T} — its footage moved there`
- `edit for ${K} parked — its footage is no longer in the cut`
- `edit for ${K} parked — ${T} already has its own edit`
- `edit for ${K} parked, replacing an older parked edit`
- `edit for ${K} rescued to ${T} — its footage is back in the cut`
- `deleted footage of ${K} also hides ${T}`

**`changed`** is tracked by writes. A no-edit second run gives `changed: false`, because its stamps equal its spans and nothing moves.

**`orphanEditLine`** (`produce.ts:~2751`) gains a branch for a parked plain root take (no `@`): `  ⚠ edit for take-2 is parked — it no longer matches a take in this cut`. The existing assertion at `apps/cli/test/scene-edit-remap.test.ts:~146` for `take-2#orphaned` changes to this string (S10).

### R4. Ordering with phase 1

- `rekeyTakeHalves` gains an optional last parameter `inheritDoc?: OverrideDoc`. Candidate materialization reads from it; the no-candidate branch reads from `doc`. This is round-1 B3, which round 2 confirmed.
- **Produce order,** after the carve:
  1. `rootSpans`;
  2. `const preRootDoc = overrideDoc`;
  3. `const rootRekey = rekeyRootTakes(overrideDoc, prior.rootTakeSpans, rootSpans)`, then `overrideDoc = rootRekey.doc`;
  4. `splitCuesWithLanding`;
  5. `rekeyTakeHalves(..., preRootDoc)`;
  6. rebuild `pinnedDoc` once.
- **Write gate:** OR in `const rootTakesChanged = rootRekey.changed`. Notes print as `  ▸ ${n}`.

**The editor needs no change.** It shows the written-back doc after a render. Its ids match the last render (phase 1 P0), so entries it creates are identified on the next produce through `prior`.

## Tests (inline values; spans are `[srcIn, srcOut]` seconds)

`packages/core/test/root-takes.test.ts` (new):

1. **No drift:** prior `take-2: [30,40]`, current is the same, and the entry is unstamped. It gets stamped once: `changed: true`, no move. A second call gives `changed: false` and no notes.
2. **Cut in front:** stored `[30,40]`; current `take-2: [20,29]`, `take-3: [30,40]`. The entry moves to `take-3`, with the exact note.
3. **Chain shift:** stored `take-1: [10,19]`, `take-2: [20,29]`, `take-3: [30,40]`; current `take-2: [10,19]`, `take-3: [20,29]`, `take-4: [30,40]`, `take-1: [0,9]`. All three move and none park.
4. **Own trim:** stored `[30,40]`, current `take-2: [31,40]`. It stays.
5. **Cut through:** stored `[30,40]`, current `take-2: [30,33]`, `take-3: [35,40]`. The entry moves to `take-3` and `take-2` gets no entry.
6. **Footage gone:** stored `[30,40]`, current `take-2: [50,60]` with no overlap anywhere. It parks, with the exact note.
7. **Held target:** `take-3` holds an anchor-less entry. The claimant from `take-2` (stored `[30,40]`, current `take-3: [30,40]`, `take-2: [20,29]`) parks.
8. **Two claimants:** stored `take-1: [30,36]` and `take-2: [30,40]` both claim `take-3: [30,40]`. `take-2` wins. `take-1` falls back to its own key if it overlaps, else parks, with the S5 note.
9. **Park slot taken:** `take-2#orphaned` exists, and `take-2` must park. The newcomer replaces it, with the exact note and `changed: true`.
10. **Rescue:** `take-2#orphaned` with stored `[30,40]`, current `take-4: [30,40]` and free. It is rescued, with the note. When there is nothing to return to: no write and `changed: false`.
11. **Kinds:** `scene-3`, `added-1`, `take-kept-151620` and `take-2@s` are untouched.
12. **Anchor-less with no prior:** passes through.
13. **Hidden:** hidden `take-2` stored `[30,40]`. Current `take-2: [30,33]`, `take-3: [34,40]`. The entry moves to `take-3`, and `take-2` gets `hidden: true`, with the fan-out note.
14. **Empty entry:** `{props:{}, elements:{}}` is skipped.
15. **`rootTakeSpans`:** cues `take-3 [10,12]`, `take-kept-5000 [12,14]`, `take-3 [14,16]` (carve lead and tail sharing an id), `take-3@s [16,18]`, with an identity map. The result is `take-3: [10.001, 17.999]`, with no kept or half keys.
16. **R4 ordering:** legacy unflagged `take-2@s` with no own framing. Stored `take-2` `{video:{scale:2}}` `[30,40]` moves to `take-3`, and the split lands in `take-3`. The half resolves to scale 2.

`apps/cli/test/scene-edit-remap.test.ts`:

17. **Source guards:**
    - `rootTakeSpans(filled` comes after `carveKeptTakes(`;
    - `rekeyRootTakes(overrideDoc` comes before `rekeyTakeHalves(`;
    - `preRootDoc` is passed;
    - `rootTakesChanged` is in the write gate;
    - `rootTakeSpans` is a props key;
    - plus the `orphanEditLine` string change.

`packages/core/test/take-halves-pipeline.test.ts`:

18. **Two-run pipeline, using the same fixture as test 27.**
    - **Run 1:** fill, spans, write.
    - **Then:** a cut of `[2, 4]` source seconds is added inside `take-0`.
    - **Run 2:** `rekeyRootTakes(doc, run1Spans, run2Spans)`. `take-2`'s entry is on the take holding source `[20.75, …]`, and resolves to `{scale 2.2, dx 814.4}`.
    - **Run 3:** with no edit, `changed: false`.

## Build

1. **One task: R1–R4 plus the tests above.**
   - Modify:
     - `packages/core/src/overrides.ts` (schema);
     - `packages/core/src/take-halves.ts`;
     - `apps/cli/src/produce.ts`;
     - `packages/core/test/take-halves.test.ts` (for `inheritDoc`);
     - `apps/cli/test/scene-edit-remap.test.ts`.
   - Create:
     - `packages/core/test/root-takes.test.ts`;
     - additions to `packages/core/test/take-halves-pipeline.test.ts`.
2. **Field check** on the FE Loop copy (`~/ossclip-work/fe-loop/work-framing-test`).
   - **Run A:** `produce --no-render` writes `rootTakeSpans`, and the log shows no moves.
   - **Then:** add one cut, `{"src": {"startSec": 2.0, "endSec": 4.0}}`, inside `take-0`, to `overrides.json` `cuts[]`, using the shape of the existing src-only cuts.
   - **Run B:** `produce --no-render` again.
   - **Expect:** `take-2`'s framing is on the take whose span equals Run A's `take-2` span, with the move note. `take-3@66055` keeps `dx -664.8`, and there are no dropped or parked lines.

   This proves that future drift is prevented. It cannot show whether FE Loop's earlier `take-2` drift happened (S13), so the author must still check 17.95 s by eye.

## Deferred, for the author (analysis in the phase 2 review reports)

- **Graphic splits render at a stale `at` after a cut in front.** Produce's first pass uses `atSplitPoints`. The fix changes output for inert, src-only and graphic-window splits (r1 B2).
- **Editor parity for skipped and inert splits.** Read-time resolution in the editor is recommended (r1 S1), and it would replace phase 1's step 7.
- **Graphic halves owning their framing.** There is no field case; the cheapest route is r1 B7.
