# Each split cuts once, in one place

Status: draft 6. This is a rewrite: it replaces drafts 1–5, which took the exact-preservation route; their reviews are `~/ossclip-work/egm-short/split-positions-review-r1.md`…`r5.md`.

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
