# Split Take Framing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split take pieces keep their own framing. A take half's framing survives cuts in front of its root. The editor and the render agree on take ids and take-split positions.

**Architecture:** The plan has three parts:
- **P0:** produce writes the clip starts it fills takes with into render-props, and the editor reads them.
- **P1:** a ⌘B on a take copies the framing into the new half and flags the split `ownFraming`, so the half stops inheriting `video`/`pip`.
- **P2:** produce re-keys take-half entries to the root their split actually landed in, migrates legacy take splits to `ownFraming`, and refreshes a landed take split's `at`. It never moves an `at` into or out of a graphic window.

**Tech Stack:** TypeScript, pnpm monorepo (`@ossclip/core`, `apps/cli`, `apps/editor`), zod v4, vitest.

**Spec:** `docs/designs/take-framing-identity.md` (draft 8). Every task implements the named spec sections. Read them first: "Design" (definitions, P0, P1, P2 steps 1–7, edge rules, `changed`, wiring) and "Tests".

## Global Constraints

- **Plain take key:** `isPlainTakeKey(key)` is `!isParkedOverrideKey(key) && /^take-\d+(-\d+)?$/.test(key.split("@")[0])`. Every take rule uses it; nothing re-spells the pattern.
- **Whole entries:** moving or parking an entry carries the whole entry (`hidden`, `timing`, `props`, `elements`, `component`, `video`, `pip`).
- **Empty entry:** no keys other than an empty `props` and an empty `elements`. Empty results are never stored.
- **Note texts** are exact, as in spec P2:
  - `split 66055 now owns its framing`
  - `edit for take-2@66055 re-keyed to take-3@66055 — its split now falls in take-3`
  - `edit for take-2@66055 parked — take-3@66055 already has its own edit`
  - `edit for take-2@66055 left as an orphan — its park slot is taken`
  - `split 66055 moved to 58.467s on this cut`
- **`at` refresh:** `at` is rounded to the millisecond, and written only when `round(resolvedAt, ms) !== at`.
- **Comments** explain why and cite this design (`take-framing-identity`) and its review ids, in house style.
- **Test runs:** run single files with `pnpm vitest run <file>`. The full suite runs only with `pnpm test --maxWorkers=2 --minWorkers=1` (7 GB machine).
- **Git:** commit locally only, never push.

## Review Focus

1. **A project opened in the editor before its first upgraded render:** no `takeClipStarts` and legacy splits. The editor must behave exactly as today. Test 25 covers the fallback; add the memo-level fallback assertion to Task 1.
2. **⌘B on a graphic or a `take-kept-*` block after the upgrade:** must behave exactly as today, with no copy and no flag. Tests 20 and 23; Task 1.
3. **Re-rendering a project twice with no edits in between:** the second produce must not rewrite `overrides.json`. Test 9 and test 11e, plus a produce-level assertion in Task 2 step 6 that `changed` is false on the second call.
4. **A hidden (deleted) take half whose split moves to a new root:** it must stay hidden. Test 8 covers it (`hidden` travels with the entry).
5. **A split very close to a take edge (the 20752 shape):** absent from `landed`, its doc entry untouched. Test 16 (margin-skipped) and the field check.

---

### Task 1: P0 clip starts + P1 split-time framing copy

**Spec sections:** P0, P1, definitions; tests 11–15, 17–25 and the `takeClipStarts` guard.

**Files:**
- Modify:
  - `packages/core/src/overrides.ts`: `SplitSchema` (~385), `effectiveOverride` (~1143, export it), `applyOverrides` call sites (~1239, ~1318);
  - `apps/cli/src/produce.ts`: the `fillPlainCues` call ~5548, the render-props object ~7219;
  - `apps/editor/src/App.tsx`: `RawRenderProps` ~166, memo ~1495;
  - `apps/editor/src/useEdits.ts`: action type ~139, reducer `addSplit` ~856, wrapper ~1937;
  - `apps/editor/src/Overlay.tsx`: ~1385;
  - `apps/editor/test/item-timing-parity.test.ts`: ~194-197.
- Create:
  - `apps/editor/src/takeClipStarts.ts`;
  - `apps/editor/test/take-clip-starts.test.ts`.
- Test:
  - `packages/core/test/overrides.test.ts`;
  - `apps/editor/test/useEdits.test.ts`;
  - `apps/editor/test/take-clip-starts.test.ts`;
  - `apps/cli/test/scene-edit-remap.test.ts`.
- No change: `packages/core/src/recut.ts`.

**Interfaces:**
- Produces (core, exported):
  - `isPlainTakeKey(key: string): boolean`;
  - `ownFramingSplitIds(splits: readonly Split[]): Set<string>`;
  - `effectiveOverride(scenes: Record<string, SceneOverride>, id: string, ownFraming?: ReadonlySet<string>): SceneOverride | undefined`;
  - `Split` gains `ownFraming?: boolean`.
- Produces (editor):
  - `editorTakeClipStarts(props: { spans?: ReadonlyArray<{ outIn: number }>; takeClipStarts?: number[] }): number[]`;
  - action `{ type: "addSplit"; at?: number; src?: number; targetId?: string }`;
  - wrapper `addSplit(split: { at?: number; src?: number; targetId?: string })`.
- Produces (render-props): `takeClipStarts: number[]`.

- [ ] **Step 1: Write the failing core tests** in `packages/core/test/overrides.test.ts`:
  - `isPlainTakeKey`: `take-2`, `take-2-1` and `take-2@s` give true; `take-kept-1@s`, `scene-1`, `added-1` and `take-2#orphaned` give false.
  - `ownFramingSplitIds([{id:"a",ownFraming:true},{id:"b"}])` gives `{"a"}`.
  - Schema: `SplitSchema.parse({at:1,src:2,id:"x",ownFraming:true}).ownFraming === true`; the legacy `at`-only number arm gives `undefined`.
  - `remapOverridesThroughRecut` keeps `ownFraming`.
  - `applyOverrides`:
    - a doc with `take-0: {video:{scale:2}}`, `take-0@s` own `{captionY:0.2}` and split `s` flagged: half `video` is undefined, `captionY` is 0.2, and the half still inherits the root's `layout`;
    - the same doc unflagged: half `video.scale` is 2;
    - a graphic `scene-1@s` with a flagged split still inherits `video`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/overrides.test.ts`. Expected: FAIL (missing exports or field).
- [ ] **Step 3: Implement the core changes** in `overrides.ts`, per spec P1:
  - the schema field: the object arm keeps it, and the legacy transform emits `ownFraming: undefined`;
  - `isPlainTakeKey`;
  - `ownFramingSplitIds`;
  - the exported `effectiveOverride` with the set: `video`/`pip` are not inherited when `isPlainTakeKey(id)` holds and the split id after `@` is in the set;
  - `applyOverrides` builds the set once and passes it at both call sites.
- [ ] **Step 4: Run** the same file. Expected: PASS.
- [ ] **Step 5: Write the failing editor reducer tests** in `apps/editor/test/useEdits.test.ts` (tests 17–24):
  - **17:** `addSplit({at:5,src:5,targetId:"take-1"})` with `take-1: {video:{scale:2,dx:10}}` gives `scenes["take-1@<id>"].video` = `{scale:2,dx:10}` and the split flagged. One undo restores the prior doc exactly.
  - **18:** target `take-1@s1` (flagged, own `video:{dx:-5}`) gives `take-1@<id>` with `video` `{dx:-5}` only.
  - **19:** target `take-1@s1` unflagged with no own entry gives the root's `video`.
  - **20:** a root with no framing: no `take-1@<id>` entry, the split flagged, and after `patchVideo("take-1",{scale:3})` the half resolves (through core `applyOverrides`) to no `video`.
  - **21:** `clearVideo` on the half leaves the root's `video`, and `clearVideo` on the root leaves the half's.
  - **22:** a duplicate within 1 ms leaves the doc unchanged.
  - **23:** `targetId:"scene-2"` and `targetId:"take-kept-5000"`: no entry, no flag.
  - **24:** an existing stale `take-1@<id>` with `{captionY:0.3, video:{dx:1}}`: `video` is replaced by the copy and `captionY` is kept.
- [ ] **Step 6: Run** `pnpm vitest run apps/editor/test/useEdits.test.ts`. Expected: FAIL.
- [ ] **Step 7: Implement the reducer, wrapper and `Overlay.tsx` changes** per spec P1. `Overlay.tsx` passes `targetId: target.id`.
- [ ] **Step 8: Run** the editor tests. Expected: PASS.
- [ ] **Step 9: Write the failing test 25** in `apps/editor/test/take-clip-starts.test.ts`:
  - the helper returns `takeClipStarts` when present, and `spans.map(s=>s.outIn)` otherwise;
  - spans `[{outIn:0},{outIn:10}]` with `takeClipStarts:[0,4,6,10]` and a 12 s fill give take ids `take-0..take-3`;
  - without `takeClipStarts`, `take-0`/`take-1`;
  - memo fallback (Review Focus 1): props with no `takeClipStarts` give the same ids as today's `spans`-only call.
- [ ] **Step 10: Implement `takeClipStarts.ts`.** Use it in the `App.tsx` memo, add the `RawRenderProps` field, and switch the parity harness `clipStarts:` to `editorTakeClipStarts({ spans })` (spec P0; hoist `spans` if it is declared after the fill line).
- [ ] **Step 11: Produce.**
  - Bind `const takeClipStarts = [...map.spans.map(s => s.outIn), ...keptEdgeStarts]` and pass it to `fillPlainCues`.
  - Add `takeClipStarts` to the render-props object next to `spans`.
  - Add a guard in `apps/cli/test/scene-edit-remap.test.ts`: the source contains `clipStarts: takeClipStarts` and `takeClipStarts,` inside the props object, after `spans: [...map.spans]`.
- [ ] **Step 12: Run** the four test files, then `pnpm typecheck`. Expected: all PASS, typecheck clean.
- [ ] **Step 13: Commit.**

```bash
git commit -am "feat: split take pieces copy their framing; editor uses produce's take clip starts"
```

(Add the new files with `git add` first.)

---

### Task 2: P2 take-half re-keying, legacy migration, `at` refresh

**Spec sections:** P2 (all steps, edge rules, `changed`, wiring, orphan wording); tests 1–10, 6b, 6c, 11b, 11d, 11e, 16, 26, 26b, 27.

**Files:**
- Modify:
  - `packages/core/src/overrides.ts`: add `splitCuesWithLanding`, and make `splitCues` its thin wrapper;
  - `packages/core/src/index.ts`: `export * from "./take-halves"`;
  - `apps/cli/src/produce.ts`: `pinnedDoc` ~5470 becomes `let`; split ~5572; `orphanEditLine` ~2749; write gate ~7448.
- Create:
  - `packages/core/src/take-halves.ts`;
  - `packages/core/test/take-halves.test.ts`;
  - `packages/core/test/take-halves-pipeline.test.ts`.
- Test:
  - `packages/core/test/overrides.test.ts` (16);
  - `apps/cli/test/scene-edit-remap.test.ts` (26, 26b).

**Interfaces:**
- Consumes: `isPlainTakeKey`, `effectiveOverride`, `ownFramingSplitIds` and `Split.ownFraming` from Task 1.
- Produces:
  - `splitCuesWithLanding(cues: readonly SceneCue[], splits: readonly ResolvedSplitPoint[]): { cues: SceneCue[]; landed: Map<string, string> }`, where the value is the host's root id (`host.id.split("@")[0]`);
  - `rekeyTakeHalves(doc: OverrideDoc, landed: ReadonlyMap<string, string>, points: readonly ResolvedSplitPoint[], graphicWindows: ReadonlyArray<{ startSec: number; endSec: number }>): { doc: OverrideDoc; notes: string[]; changed: boolean }`.

- [ ] **Step 1: Write the failing test 16** in `overrides.test.ts` for `splitCuesWithLanding`:
  - landing on a root maps to that id;
  - a second split inside an existing half maps to the ROOT id;
  - a split within 0.3 s of an edge is absent;
  - `.cues` deep-equals `splitCues(...)` for the same input.
- [ ] **Step 2: Write the failing tests 1–10, 6b, 6c, 11b, 11d and 11e** in `take-halves.test.ts`, with the exact inputs and expectations in spec "Tests". The note strings are the exact Global Constraints texts. Test 9 asserts that a second call on the output returns `changed: false` and a deep-equal doc (Review Focus 3).
- [ ] **Step 3: Write the failing test 27** in `take-halves-pipeline.test.ts`. All values are inline:
  - clip starts `[0, 8.21438, 17.94988, 21.71588, 60.76448]`, output 70;
  - no graphics;
  - split `{at: 58.784, src: 66.055, id: "66055"}`, resolved point 58.467;
  - doc `take-2: {video:{scale:2.2,dx:814.4}}`, `take-2@66055: {video:{scale:2.2,dx:-664.8}}`.

  Pipeline: `fillPlainCues` → `splitCuesWithLanding` → `rekeyTakeHalves` → `applyOverrides`. Assert:
  - `take-3@66055` resolves to `{scale:2.2,dx:-664.8}`;
  - `take-2` resolves to `{scale:2.2,dx:814.4}`;
  - no key `take-2@66055`;
  - `orphans` is empty;
  - the split has `ownFraming: true` and `at: 58.467`.
- [ ] **Step 4: Run** the three core files. Expected: FAIL.
- [ ] **Step 5: Implement** `splitCuesWithLanding` and `take-halves.ts` per spec P2 steps 1–7 and the edge rules. Steps 3–6 choose before writing: incumbent and mover are taken from the INPUT doc. `changed` is tracked by writes, never deep-compared. Run the core files until PASS.
- [ ] **Step 6: Wire produce** per spec "Wiring in produce":
  - `const { cues: split, landed } = splitCuesWithLanding(filled, resolvedSplits.points)`;
  - `const takeRekey = rekeyTakeHalves(overrideDoc, landed, resolvedSplits.points, editedCues.map(c => ({ startSec: c.startSec, endSec: c.endSec })))`;
  - print notes as `  ▸ ${n}`;
  - `overrideDoc = takeRekey.doc`;
  - rebuild `pinnedDoc = resolveSrcTimingPins(overrideDoc, map)` without re-printing its reports;
  - `const splitHalvesChanged = takeRekey.changed` ORed into the write gate, with `refreshBackup` unchanged;
  - a code comment on why the late position is safe;
  - the `orphanEditLine` take-half wording (predicate per spec).
- [ ] **Step 7: Update and add guards** in `apps/cli/test/scene-edit-remap.test.ts` (test 26):
  - `indexOf("splitCuesWithLanding(filled")` replaces `splitCues(filled`;
  - `rekeyTakeHalves(overrideDoc, landed`, `overrideDoc = takeRekey.doc` and `pinnedDoc = resolveSrcTimingPins(overrideDoc` all come before `applyOverrides(split`;
  - `splitHalvesChanged` appears in the write-gate condition.

  Test 26b: the exact `orphanEditLine` strings from spec test 26b.
- [ ] **Step 8: Run** the five test files, `pnpm typecheck`, then the full suite with `pnpm test --maxWorkers=2 --minWorkers=1`. Expected: all green.
- [ ] **Step 9: Commit.**

```bash
git commit -am "feat: produce re-keys take halves by where their split lands and migrates them to own framing"
```

(Add the new files first.)

---

### Task 3: Field check on a copy of FE Loop

**Spec section:** Build order step 3. The main thread runs this task, not a subagent.

- [ ] **Step 1: Copy and repoint.**
  - Run `cp -r ~/ossclip-work/fe-loop/work ~/ossclip-work/fe-loop/work-framing-test`.
  - In the copy's `FE Loop-116d3cbc/command.json`, rewrite `--workdir`, `--out`, `--scenes` and the top-level `"out"` to point at the copy.
- [ ] **Step 2: Run produce** from the copy's command args plus `--no-render`, saving the output to `~/ossclip-work/fe-loop/work-framing-test/field.log`.
- [ ] **Step 3: Check the results against the spec's expectations:**
  - `take-3@66055` resolves to `{scale 2.2, dx -664.8}` in render-props;
  - split 66055 has `at: 58.467` and `ownFraming: true`;
  - splits 20752, 24518, 167648 and 176577 are untouched;
  - `take-2` at 17.95 s is unchanged;
  - `takeClipStarts` includes 161.291;
  - `field.log` has no `dropped`/`parked` line.
- [ ] **Step 4: Check the editor.**
  - Run `pnpm ossclip edit "<copy>/FE Loop-116d3cbc" --no-open --port 5181`.
  - Fetch `/api/...` render-props, or load the page.
  - Confirm `take-10` starts at 161.29 s and `take-3@66055` is framed.
  - Stop the server.
- [ ] **Step 5:** Record the results in FINDINGS as a new section, with commit `docs: FINDINGS §172 …`. Any deviation stops the work until it is understood.
