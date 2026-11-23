# Take Looks By Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take looks (`video`, `pip`, `layout`, `captionY`, `captionScale`) are attached to source-time ranges (`doc.takeLooks`), not to positional take ids. Produce migrates legacy docs once, and the editor writes looks by source range.

**Architecture:** One pure module, `packages/core/src/take-looks.ts`, holds ranges, lookup, writers, normalization and the `applyTakeLooks` resolution. Both pipelines (produce and the editor memo) call `applyTakeLooks` on migrated docs. `migrateTakeLooks` runs once in produce, gated by the presence of `takeLooks`. The editor addresses pieces by source extent and dispatches look actions.

**Tech Stack:** TypeScript, pnpm monorepo, zod v4, vitest, React editor.

**Spec:** `docs/designs/take-looks-by-source.md` (draft 7). It is the authority. Its rulings sections (R6-*, R7-*) override earlier text, and later rulings override earlier ones. Every task names the spec sections it implements; read those first.

## Global Constraints

- **Marker:** `doc.takeLooks` present (even `[]`) means migrated. Absent means legacy, and legacy behaviour is byte-for-byte unchanged in produce and in the editor.
- **Look fields (exactly these five):** `video` (including `volume` and `autoZoom`), `pip`, `layout`, `captionY`, `captionScale`.
- **Source seconds:**
  - rounded to the millisecond inside the helpers;
  - overlaps under 1 ms count as none;
  - resolver ties go to the lower `srcIn`; piece ties go to the earlier `startSec`.
- **Write units (R6-2 / R7-3):**
  - `{scale, dx, dy}` is one unit, `pip {x, y}` is one unit, and every other field is its own unit;
  - absent members are deleted, never defaulted;
  - coalesce keys are `look:${srcIn}:<unit>`.
- **Writes cover the piece's hull,** `[min srcIn, max srcOut]` (R6-3).
- **`isLookPieceKey(id)`** = `!isParkedOverrideKey(id) && (plainTakeOrdinal(id) !== null || /^take-kept-\d+$/.test(splitRootId(id)))` (R7-5).
- **Migration notes, exact:**
  - `moved the look of ${n} take piece(s) onto source time`
  - `left ${n} look edit(s) on takes not in this cut: ${keys}`
- **`take-looks.ts`** imports `overrides.ts` for types only (R6-8).
- **Comments** explain why and cite `take-looks-by-source` and its review ids.
- **Tests:** single files with `pnpm vitest run <file>`. The full suite only with `pnpm test --maxWorkers=2 --minWorkers=1`, once per task, with nothing else heavy running at the same time.
- **Git:** local commits only, never push.

## Review Focus

1. **Legacy docs are unchanged.** For a doc with no `takeLooks`, produce render-props and the editor memo must be identical to before. Task 1: a pipeline test proving the gate.
2. **Second produce run with no edits.** No rewrite of `overrides.json`, and `takeLooks` unchanged. Task 2: test 7, plus a two-run produce-level assertion.
3. **Carved lead/tail pieces sharing an id** must be addressed separately: selection, preview, writes. Task 3: the target and Inspector tests (R6-7).
4. **A live cut, keep or undo while a take is selected.** The selection follows its footage, or clears; it never jumps to the lead. Task 3: the `take-look-target` tests.
5. **A stale editor saving a legacy doc after produce migrated it.** The next produce migrates again with the same looks. Task 2: migration test 6.

---

### Task 1: Core take looks and gated resolution (spec L1, L2, R6-8, R7-5, R7-6, R7-11)

**Files:**
- Create:
  - `packages/core/src/take-looks.ts`;
  - `packages/core/test/take-looks.test.ts`;
  - `apps/editor/test/take-looks-wiring.test.ts`.
- Modify:
  - `packages/core/src/overrides.ts`: `OverrideDocSchema.takeLooks` (optional, normalized through `normalizeTakeLooks`), and `isLookPieceKey`;
  - `packages/core/src/index.ts` and `packages/core/src/browser.ts` (export `take-looks`);
  - `apps/cli/src/produce.ts`: the gated `applyTakeLooks` right after `applyOverrides(split, pinnedDoc.doc)` (~5625), whose output feeds `resolveItemTimings`;
  - `apps/editor/src/App.tsx`: the gated look pass in the old-clock memo path (after `dropHiddenCues`, before `withStagePreviews`) and in `finishOnClock`'s main path (after `applyOverrides`, before `previewItemTimings`);
  - `apps/cli/test/scene-edit-remap.test.ts`: the Task 1 guard only (R7-6).

**Interfaces (produces):**
```ts
type SrcRange = { srcIn: number; srcOut: number };
type TakeLook = Pick<SceneOverride, "video" | "pip" | "layout" | "captionY" | "captionScale">;
type TakeLookEntry = SrcRange & { look: TakeLook };
pieceSourceRanges(window: { startSec: number; endSec: number }, map: TimeMap): SrcRange[]
lookAt(looks: readonly TakeLookEntry[], ranges: readonly SrcRange[]): TakeLook
setTakeLook(looks, ranges, patch: TakeLook): TakeLookEntry[]          // hull, unit-expanded, field-scoped
clearTakeLookFields(looks, ranges, fields: (keyof TakeLook)[]): TakeLookEntry[]
normalizeTakeLooks(raw: unknown[]): TakeLookEntry[]
inScope(o?: SceneOverride): TakeLook
applyTakeLooks(cues: readonly SceneCue[], looks: readonly TakeLookEntry[], map: TimeMap): SceneCue[]
isLookPieceKey(id: string): boolean                                    // overrides.ts
```

- [ ] **Step 1: Write the failing tests** in `take-looks.test.ts`, per the spec's "Core, take-looks.test.ts" list as amended by R7-11:
  - `pieceSourceRanges` (single span, across a seam, kept block);
  - `lookAt` (largest overlap, the floor, a tie, empty);
  - `setTakeLook`:
    - the patched unit is set across the hull and each part keeps its other fields;
    - the framing unit expands from each part's own values;
    - absent members are deleted;
    - fragmenting;
    - coalescing within 1 ms;
  - `clearTakeLookFields` is a real reset;
  - a 200-write fixed-seed invariant run;
  - schema normalization (drop, sort, later-wins, coalesce);
  - `applyTakeLooks` (SET semantics, layout base `full-bleed`, kept block, half, graphic untouched);
  - the `isLookPieceKey` table: `take-2`, `take-2-1`, `take-2@s`, `take-kept-5000` and `take-kept-5000@s` give true; `take-2#orphaned`, `scene-1` and `added-1` give false.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/take-looks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `take-looks.ts`, the schema field and `isLookPieceKey` per the spec.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Gated wiring** in produce and both editor memo paths, gated on `doc.takeLooks !== undefined`. Add a legacy-unchanged test in `packages/core/test/take-looks.test.ts` that runs a fill → split → `applyOverrides` → (gate) pipeline on a legacy doc and asserts cues identical to running without the gate code (Review Focus 1). Add the guards: `apps/editor/test/take-looks-wiring.test.ts` checks that `applyTakeLooks(` appears in both memo passes, before `withStagePreviews(` / `previewItemTimings(`; `scene-edit-remap.test.ts` checks that `applyTakeLooks(` comes after `applyOverrides(split`.
- [ ] **Step 6: Run** the touched files, `pnpm typecheck`, and the full suite once. Expected: green.
- [ ] **Step 7: Commit** `feat: take looks attached to source time (core, gated resolution)`.

---

### Task 2: Migration in produce (spec L3, L5, R6-9, R7-6, R7-10)

**Files:**
- Create:
  - `packages/core/src/take-looks-migrate.ts`;
  - `packages/core/test/take-looks-migration.test.ts`;
  - `packages/core/test/take-looks-pipeline.test.ts`.
- Modify:
  - `packages/core/src/index.ts` (export `take-looks-migrate`);
  - `packages/core/src/take-halves.ts`: gate the whole `ownFraming !== true` block of step 4 on `doc.takeLooks === undefined`;
  - `apps/cli/src/produce.ts`: `migrateTakeLooks` after the second `applyOverrides` and before `applyTakeLooks`; `overrideDoc = migration.doc`; `takeLooksMigrated` ORed into the write gate;
  - `apps/cli/test/scene-edit-remap.test.ts`: the Task 2 guards.

**Interfaces:**
- Consumes everything from Task 1.
- Produces `migrateTakeLooks(doc: OverrideDoc, cues: readonly SceneCue[], map: TimeMap, ownFramingIds: ReadonlySet<string>): { doc: OverrideDoc; notes: string[]; changed: boolean }`. It checks the marker itself.

- [ ] **Step 1: Write the failing migration tests** (spec "Core, take-looks-migration.test.ts", fixtures (a) and (b), tests 1–7, plus the R6-7 flagged-half `captionY` case). The inputs are inline literals per R6-9 and R7-10:
  - the 10 spans from `~/ossclip-work/fe-loop/work/FE Loop-116d3cbc/render-props.json`;
  - splits from its `overrides.json`;
  - `takeClipStarts` from `~/ossclip-work/fe-loop/work-framing-test/FE Loop-116d3cbc/render-props.json`.
- [ ] **Step 2: Write the failing pipeline tests** (spec "Core, take-looks-pipeline.test.ts", plus R7-2's inside-restore and edge-restore cases).
- [ ] **Step 3: Run both.** Expected: FAIL.
- [ ] **Step 4: Implement** `migrateTakeLooks` per L3, including the minted-kept layout exception and the dead-key note; the step-4 gate; and the produce wiring per L3's "Produce wiring".
- [ ] **Step 5: Run** the files, the `take-halves` tests (legacy behaviour unchanged), `pnpm typecheck`, and the full suite once. Expected: green.
- [ ] **Step 6: Commit** `feat: produce migrates take looks onto source time once`.

---

### Task 3: Editor look mode (spec L4, R6-1 … R6-7, R7-1, R7-3, R7-4, R7-7, R7-8)

**Files:**
- Create:
  - `apps/editor/src/takeLookTarget.ts` (`pieceAnchor`, `selectedPiece`, `revalidateSelection`, `walkPiece`);
  - `apps/editor/test/take-look-target.test.ts`.
- Modify:
  - `packages/core/src/take-looks.ts` (receives `isEmptyEntry`, re-exported);
  - `apps/editor/src/useEdits.ts`:
    - actions `patchTakeLook` and `clearTakeLookFields`;
    - the new `patchCaptionStyleAll` payload;
    - no-op guards;
    - legacy-action refusal plus `lastRefusal`;
    - `loadCount`;
    - `addSplit` copy and flag only in legacy mode;
    - `isEmptyEntry` import;
  - `apps/editor/src/App.tsx`:
    - `selectedCue` through the resolver;
    - the revalidation effect;
    - preview `pieceExtent`;
    - `cueClock` props to Inspector, Overlay and Timeline;
    - `allTakeRanges`;
    - the refusal notice;
    - `loadCount` effects;
  - `apps/editor/src/Overlay.tsx`: `Selection.pieceExtent`, the stage-click resolve, drag bases, dispatch, the ⌥/⌘-arrow walk;
  - `apps/editor/src/Inspector.tsx`: look-mode dispatch for every listed control, and read sites;
  - `apps/editor/src/Timeline.tsx`: click sets `pieceExtent`; composite React key; `data-piece-start`; `isSelected` and scroll through the resolver;
  - the editor tests:
    - `apps/editor/test/useEdits.test.ts`;
    - `apps/editor/test/Inspector.test.ts`;
    - `apps/editor/test/Overlay.test.ts`;
    - `apps/editor/test/item-timing-parity.test.ts`.

**Interfaces:**
- Consumes the Task 1 helpers and the Task 2 marker semantics.
- Produces:
  - `pieceAnchor(cue: SceneCue, clock: TimeMap | null): SrcRange | null`
  - `selectedPiece(cues: readonly SceneCue[], sel: Selection, clock: TimeMap | null): SceneCue | null`
  - `revalidateSelection(sel: Selection, cues: readonly SceneCue[], clock: TimeMap | null): Selection | null`
  - `walkPiece(cues: readonly SceneCue[], sel: Selection, dir: 1 | -1, clock: TimeMap | null): Selection | null`
  - actions:
    - `{ type: "patchTakeLook"; ranges: SrcRange[]; patch: TakeLook; coalesce?: string }`
    - `{ type: "clearTakeLookFields"; ranges: SrcRange[]; fields: (keyof TakeLook)[] }`
    - `patchCaptionStyleAll { sceneIds; takeRanges: SrcRange[][]; y?; scale? }`

- [ ] **Step 1: Write the failing pure-helper tests** in `take-look-target.test.ts` (R6-7 as amended by R7-8):
  - the tail resolves;
  - a live cut in front;
  - footage cut gives null and clears;
  - the walk from the lead goes to the tail, then the next cue, and an end gives null;
  - undo of a keep in front;
  - ⌘B (and redo) follows the larger half;
  - a legacy selection gets an extent;
  - the tie rule.
- [ ] **Step 2: Write the failing reducer tests** in `useEdits.test.ts`, look mode:
  - patch and clear;
  - a coalesced drag gives one undo;
  - the framing-unit expansion;
  - `patchCaptionStyleAll` with mixed ids and ranges;
  - `clearCaptionStyle` on a take;
  - legacy actions on look-piece ids are refused with `lastRefusal`;
  - ⌘B adds only a split;
  - a no-op write makes no commit.

  Legacy-mode tests 17–24 stay as they are.
- [ ] **Step 3: Write the failing Inspector and Overlay tests** (R6-7):
  - each look control in look mode dispatches only look actions;
  - legacy mode is unchanged;
  - the Inspector shows the tail's values when the tail is selected;
  - a scrub previews only the tail.
- [ ] **Step 4: Run** the four files. Expected: FAIL.
- [ ] **Step 5: Implement** per L4, R6-1 … R6-7 and R7-1 … R7-8.
- [ ] **Step 6: Parity.** Add to `item-timing-parity.test.ts`: for a migrated doc, the editor and produce pipelines resolve identical take looks by output time, on the old clock and with a kept block.
- [ ] **Step 7: Run** the touched files, `pnpm typecheck`, the editor e2e for kept-take framing (`kept-take-framing.spec.ts`, if it runs headless in this environment), and the full suite once. Expected: green.
- [ ] **Step 8: Commit** `feat: the editor edits take looks by source range`.

---

### Task 4: Field check on a copy of FE Loop (spec R6-10, R7-9; main thread)

- [ ] **Step 1:** Write `~/ossclip-work/fe-loop/looks-field-check.sh` plus its python checker. It does setup, run 1, the cut edit and run 2, and asserts every expected line and value from spec "Field check" and R6-10. It exits 1 on any failure.
- [ ] **Step 2:** Run it, then read both logs and the checker's output.
- [ ] **Step 3:** Rebuild the editor (`pnpm build`), restart it on the copy at port 5181, select the 58.467 piece, and confirm the Inspector shows `{scale 2.2, dx -664.8}`. Then stop it.
- [ ] **Step 4:** Add FINDINGS §173 to `docs/PHASE1-FINDINGS.md` with the results and limits, and commit.
