# Scene Anchor Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scene edits survive a re-plan by matching on the scene's word anchor when its positional id no longer means the same moment — and never silently apply to a different moment.

**Architecture:** Cues gain an optional `anchor` (copied from the plan's scene at assemble time). The editor stamps each scene override with the anchor of the cue the user was looking at, at save time. Produce runs a pure remap pass (`remapSceneOverrides`) over the override doc *before* `applyOverrides`: entries whose stored anchor disagrees with the cue currently holding their id are re-keyed to the cue whose anchor overlaps theirs, out loud; entries with no surviving anchor orphan with the existing warning. The remapped doc rides the existing sanctioned overrides.json write-back, so ids converge after one produce run.

**Tech Stack:** TypeScript, zod (v4), vitest. All logic pure in `@ossclip/core`; produce and the editor only wire it.

**Spec:** `docs/local/handoff-edit-anchoring.md` (design approved in principle there; §137 in `docs/PHASE1-FINDINGS.md` is the precedent whose shape this follows).

## Global Constraints

- All schema changes are additive + optional: an `overrides.json` or `render-props.json` written before this change must parse and behave exactly as today (the §137 posture — pre-migration docs keep id-only behaviour, they just don't gain the protection).
- User-supplied values parse with zod, never cast (CLAUDE.md).
- Pure logic separated from I/O — every new function testable without a filesystem (CLAUDE.md).
- Comments explain *why* and cite findings sections (`§137`, handoff) where the choice was forced.
- `pnpm test` and `pnpm typecheck` green before every commit.
- Branch: `fix/scene-anchor-identity` off `main`. Do NOT bump versions — releases are lockstep and cut separately.

## Design decisions already made (do not re-litigate in tasks)

1. **Remap-before-apply, not fallback-inside-apply.** The handoff proposed an anchor fallback inside `applyOverrides`. We instead re-key the doc once, up front, because (a) one pass handles every key space uniformly — root ids and `root@splitId` half ids rename together, so a hidden split half cannot resurrect under a renumbered root; (b) `applyOverrides` stays a pure id-join, unchanged, and the editor's live use of it (same-session doc, ids always current) is untouched; (c) the remapped doc rides the existing write-back (`produce.ts:4299`, `writeOverrideDoc`), which is exactly how §137/recut re-anchoring already persists (`save.ts:11-20` documents that write-back).
2. **Overlap, not equality.** Two anchors denote the same moment when their word ranges overlap. Boundary jitter from a re-plan must not orphan an edit; a fully disjoint range is a genuinely different moment and must not match.
3. **Prefer the anchor on conflict.** If `scene-3` exists in the new plan but the stored anchor for the `scene-3` entry overlaps a *different* cue, the entry moves to that cue and the run says so. Never leave it on a same-id-different-moment cue (the silent-misapply case — the whole reason for this work).
4. **Editor stamps at save time, from the cues in memory.** Not server-side at PUT: after a mid-session re-render, `render-props.json` on disk can describe a *newer* plan than the cues the user is looking at, and stamping from disk would write the wrong anchors — the exact bug this prevents. The cues in the editor's memory are, by construction, what the user made the edit against.
5. **Scope: graphic scene ids only.** `take-*` ids (plain fill cues) are positional by clip index — a different identity space, out of scope here. They carry no anchor, are never stamped, and never remap. Say so in the remap function's doc comment.

---

### Task 0: Empirical pre-flight — do anchors actually survive a re-plan? (MAIN THREAD, not delegable)

The handoff mandates this before building: "produce two real plans over the same transcript and diff their scene ids and anchors. If anchors turn out to move as much as ids do, this whole design is unfounded."

**Files:** none in-repo. Script in the session scratchpad.

- [ ] **Step 1:** Read `apps/cli/src/produce.ts:2790-2940` and `packages/core/src/producer/beats.ts` to find the exact planner entry point (the function that turns a transcript into moments with `startWord`/`endWord`) and how a real provider is constructed (`tiered.ts`).
- [ ] **Step 2:** Write a scratchpad tsx script that loads `~/Downloads/.ossclip/Handy-84fdf09a/transcript.json`, runs the planner twice with the user's configured provider, and prints per-run `(index, sceneKind, startWord..endWord)` tables plus a best-overlap pairing between runs.
- [ ] **Step 3:** Run it. **Abort criteria:** if paired moments' word ranges are mostly disjoint (overlap < 50% on most pairs), STOP — report to the user, do not proceed to Task 1. Expected: surviving moments keep overlapping ranges even when count/order shifts. Note the result in the PR description either way.
- [ ] **Step 4:** No commit (nothing in-repo changed).

### Task 1: Cues carry their anchor

**Files:**
- Modify: `packages/core/src/scene-schema.ts` (SceneCueSchema, ~line 60)
- Modify: `packages/core/src/assemble.ts` (`assembleScenes`, resolved-cue construction ~line 72)
- Test: `packages/core/test/overrides.test.ts` (or `assemble`'s existing test file if one exists — check `packages/core/test/` for the current home of `assembleScenes` tests and add there)

**Interfaces:**
- Produces: `SceneCue.anchor?: { startWord: number; endWord: number }` — present on graphic cues assembled from a plan, absent on plain fill cues and on pre-change `render-props.json`. Tasks 2-5 rely on this exact shape.

- [ ] **Step 1: Write the failing test**

```ts
it("assembled graphic cues carry the scene's anchor; plain fill cues carry none", () => {
  const scenes = [sceneFixture({ id: "scene-0", anchor: { startWord: 2, endWord: 5 } })];
  const { cues } = assembleScenes(scenes, transcriptFixture, mapFixture);
  expect(cues[0]!.anchor).toEqual({ startWord: 2, endWord: 5 });
  const filled = fillPlainCues(cues, { outputDurationSec: 10, clipStarts: [0] });
  expect(filled.find((c) => c.kind === "plain")!.anchor).toBeUndefined();
});
```

Use the fixture helpers the existing assemble/overrides tests already use — do not invent a parallel fixture style.

- [ ] **Step 2:** Run it: `pnpm --filter @ossclip/core test -- overrides` (adjust to the file you chose). Expected: FAIL — `anchor` undefined on the graphic cue.
- [ ] **Step 3: Implement.** In `scene-schema.ts`, add to `SceneCueSchema`:

```ts
  /**
   * The plan anchor this cue was resolved from — the scene's word range,
   * carried through so an edit made against this cue can be re-keyed when a
   * re-plan renumbers ids (handoff-edit-anchoring; §137 is the caption-side
   * precedent). Optional: plain fill cues have no plan anchor, and
   * render-props.json written before this field carries none — absence means
   * "id-only identity", exactly today's behaviour.
   */
  anchor: SceneAnchorSchema.optional(),
```

In `assemble.ts`, add `anchor: scene.anchor,` to the `resolved.push({...})` object (~line 72). `splitCues` spreads the root cue, so halves inherit the anchor with no change there — assert that in the test if `splitCues` is cheap to call, otherwise leave it to Task 4's tests.

- [ ] **Step 4:** Run the test — PASS. Then `pnpm typecheck` (strict TS will surface any exhaustive-cue construction sites that need the field considered; fix by omission, not by fabricating anchors).
- [ ] **Step 5:** Commit: `git commit -m "feat(core): assembled cues carry their plan anchor"`

### Task 2: Overrides can record the anchor they were made against

**Files:**
- Modify: `packages/core/src/overrides.ts` (`SceneOverrideSchema`, line 43)
- Test: `packages/core/test/overrides.test.ts`

**Interfaces:**
- Produces: `SceneOverride.anchor?: { startWord: number; endWord: number }`. Round-trips through `OverrideDocSchema.parse` (the PUT handler at `apps/cli/src/edit.ts:832` parses with it — additive optional field needs no server change).

- [ ] **Step 1: Failing test:** a doc with `scenes: { "scene-3": { props: {}, elements: {}, anchor: { startWord: 4, endWord: 9 } } }` parses via `OverrideDocSchema` and the anchor survives; a doc without it still parses.
- [ ] **Step 2:** Run — FAIL (unknown key stripped or type error).
- [ ] **Step 3:** Add to `SceneOverrideSchema`:

```ts
  /**
   * The word range of the cue this edit was made against, stamped by the
   * editor at save time (stampSceneAnchors). This is the edit's IDENTITY
   * across a re-plan: ids are positional (`scene-${i}`) and a re-plan can
   * hand an id to a different moment — matching on the anchor instead is
   * what stops that edit landing there silently (handoff-edit-anchoring).
   * Optional: docs written before this field keep id-only behaviour, the
   * same no-retroactive-protection posture §137 took for captions.
   */
  anchor: SceneAnchorSchema.optional(),
```

Import `SceneAnchorSchema` from `./scene-schema` (check the existing import block — several scene-schema names are already imported at the top of `overrides.ts`).

- [ ] **Step 4:** Run — PASS. `pnpm typecheck`.
- [ ] **Step 5:** Commit: `git commit -m "feat(core): scene overrides can record their anchor"`

### Task 3: `stampSceneAnchors` — pure, editor calls it at save

**Files:**
- Create: nothing new — add to `packages/core/src/overrides.ts` (it is doc surgery, same module as `applyOverrides`), export from `packages/core/src/browser.ts`
- Modify: `apps/editor/src/useEdits.ts` (the `save` function, ~line 926, and the hook's return)
- Modify: `apps/editor/src/App.tsx` (wire `syncCues` — find where the final cue memo is computed; App already derives the live cue list for the timeline)
- Test: `packages/core/test/overrides.test.ts`, `apps/editor/test/edits-keys.test.ts` (or the existing useEdits test home)

**Interfaces:**
- Produces: `stampSceneAnchors(doc: OverrideDoc, cues: readonly SceneCue[]): OverrideDoc` — pure, returns a new doc; and `useEdits().syncCues(cues: readonly SceneCue[]): void`.
- Consumes: `SceneCue.anchor` (Task 1), `SceneOverride.anchor` (Task 2).

- [ ] **Step 1: Failing tests** (core):

```ts
describe("stampSceneAnchors", () => {
  it("stamps a scene entry with its cue's anchor", () => {
    const doc = docWith({ "scene-3": { props: { title: "x" }, elements: {} } });
    const cues = [cueFixture({ id: "scene-3", anchor: { startWord: 4, endWord: 9 } })];
    expect(stampSceneAnchors(doc, cues).scenes["scene-3"]!.anchor).toEqual({ startWord: 4, endWord: 9 });
  });
  it("resolves a split half's root for the anchor", () => {
    const doc = docWith({ "scene-3@abc": { props: {}, elements: {} } });
    const cues = [cueFixture({ id: "scene-3@abc", anchor: { startWord: 4, endWord: 9 } })];
    expect(stampSceneAnchors(doc, cues).scenes["scene-3@abc"]!.anchor).toEqual({ startWord: 4, endWord: 9 });
  });
  it("re-stamps an entry whose cue anchor changed, and leaves anchor-less cues (takes) unstamped", () => {
    const doc = docWith({
      "scene-3": { props: {}, elements: {}, anchor: { startWord: 0, endWord: 1 } },
      "take-clip0": { props: {}, elements: {} },
    });
    const cues = [
      cueFixture({ id: "scene-3", anchor: { startWord: 4, endWord: 9 } }),
      cueFixture({ id: "take-clip0", kind: "plain" }),
    ];
    const out = stampSceneAnchors(doc, cues);
    expect(out.scenes["scene-3"]!.anchor).toEqual({ startWord: 4, endWord: 9 });
    expect(out.scenes["take-clip0"]!.anchor).toBeUndefined();
  });
});
```

Re-stamping on every save is deliberate: the cue on screen is always the freshest truth about what the user is editing. Note it in the function's doc comment.

- [ ] **Step 2:** Run — FAIL (function does not exist).
- [ ] **Step 3: Implement** in `overrides.ts`:

```ts
/**
 * Stamp every scene override with the anchor of the cue it currently targets
 * — the edit's identity across a re-plan (see SceneOverrideSchema.anchor).
 * Called by the EDITOR at save time, from the cues in its memory, never from
 * render-props.json on disk: after a mid-session re-render the disk can
 * describe a newer plan than the one the user is looking at, and stamping
 * from it would record the wrong identity — the misapply this exists to stop.
 * Cues without an anchor (plain takes, pre-anchor render-props) stamp nothing.
 */
export function stampSceneAnchors(doc: OverrideDoc, cues: readonly SceneCue[]): OverrideDoc {
  const anchorById = new Map(cues.filter((c) => c.anchor).map((c) => [c.id, c.anchor!]));
  const scenes: Record<string, SceneOverride> = {};
  for (const [id, entry] of Object.entries(doc.scenes)) {
    const anchor = anchorById.get(id);
    scenes[id] = anchor ? { ...entry, anchor } : entry;
  }
  return { ...doc, scenes };
}
```

(If `Object.entries`/record-rebuild patterns in this module guard `__proto__` — see the `/api/production` comment at `edit.ts:472` — copy the module's existing safe-record idiom instead of a bare object literal.)

Export from `browser.ts` alongside the other overrides exports.

- [ ] **Step 4:** Editor wiring in `useEdits.ts`: add `const cuesRef = useRef<readonly SceneCue[]>([]);` inside `useEdits`, return `syncCues: (cues: readonly SceneCue[]) => { cuesRef.current = cues; }`, and in `save()` stamp before the PUT:

```ts
const stamped = stampSceneAnchors(state.doc, cuesRef.current);
const res = await fetch("/api/overrides", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(stamped) });
```

After a 200, also `dispatch({ type: "load", doc: stamped })`? **No** — `load` clears undo (see the PUT handler comment). Instead keep the in-memory doc as-is; the stamp is recomputed on every save, so memory and disk converge without touching history. State only `{ type: "saved" }` as today.

In `App.tsx`, find the memo that produces the live cue list the timeline renders (search for the `applyOverrides`/`splitCues` live memo) and add an effect: `useEffect(() => edits.syncCues(liveCues), [liveCues])`. Use the cue list that includes split halves — it is what the user's edits address.

- [ ] **Step 5:** Editor test (jsdom style the suite already uses, or pure if `save` is reachable purely): saving a doc with a `scene-0` entry after `syncCues([cue with anchor])` PUTs a body whose `scenes["scene-0"].anchor` matches. Mock `fetch` the way the existing editor tests do.
- [ ] **Step 6:** `pnpm test` (workspace) + `pnpm typecheck` — green.
- [ ] **Step 7:** Commit: `git commit -m "feat(editor): stamp scene overrides with their cue's anchor at save"`

### Task 4: `remapSceneOverrides` — the misapplication guard, test-first

**Files:**
- Modify: `packages/core/src/overrides.ts` (new function + export; export from `index.ts` — produce imports from the package root)
- Test: `packages/core/test/overrides.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SceneRemapResult {
  doc: OverrideDoc;
  /** Human sentences for produce to print — one per re-keyed or blocked entry. */
  notes: string[];
}
export function remapSceneOverrides(doc: OverrideDoc, cues: readonly SceneCue[]): SceneRemapResult;
```

- Consumes: `SceneCue.anchor` (Task 1), `SceneOverride.anchor` (Task 2).

- [ ] **Step 1: Write the MISAPPLICATION GUARD test first** — this is the unproven claim in the handoff and the whole point:

```ts
it("an edit whose id survives but whose anchor moved does NOT stay on the impostor cue", () => {
  // Old plan: scene-3 was words 40..50. New plan renumbered: words 40..50 are
  // now scene-1, and scene-3 is a different moment (words 80..90).
  const doc = docWith({ "scene-3": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 50 } } });
  const cues = [
    cueFixture({ id: "scene-1", anchor: { startWord: 41, endWord: 49 } }),
    cueFixture({ id: "scene-3", anchor: { startWord: 80, endWord: 90 } }),
  ];
  const { doc: out, notes } = remapSceneOverrides(doc, cues);
  expect(out.scenes["scene-3"]).toBeUndefined();          // never left on the impostor
  expect(out.scenes["scene-1"]!.props.title).toBe("edited");
  expect(out.scenes["scene-1"]!.anchor).toEqual({ startWord: 40, endWord: 50 });
  expect(notes.some((n) => n.includes("scene-3") && n.includes("scene-1"))).toBe(true);
});
```

Then the rest of the matrix from the handoff:

```ts
it("renumbered plan: the edit follows its anchor to the new id", () => { /* scene-11 entry, anchor overlaps scene-7's — lands on scene-7, note printed */ });
it("shrunk plan, id also gone: entry survives untouched so applyOverrides orphans and warns as today", () => { /* entry stays under its old id (which matches no cue); result doc unchanged for it; NO note */ });
it("words gone but the id now belongs to a DIFFERENT moment: the entry is PARKED, never left to join the impostor", () => {
  // scene-3's stored anchor (40..50) overlaps nothing in the new plan, but a
  // cue named scene-3 exists with anchor 80..90. Leaving the entry keyed
  // scene-3 would silently misapply — the exact bug. Park it instead.
  const doc = docWith({ "scene-3": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 50 } } });
  const cues = [cueFixture({ id: "scene-3", anchor: { startWord: 80, endWord: 90 } })];
  const { doc: out, notes } = remapSceneOverrides(doc, cues);
  expect(out.scenes["scene-3"]).toBeUndefined();
  expect(out.scenes["scene-3#orphaned"]!.props.title).toBe("edited");   // data preserved, inert key
  expect(notes.some((n) => n.includes("parked"))).toBe(true);
});
it("a parked entry is rescued when a later plan has its words again", () => {
  // Round-trip of the case above: the anchor is still on the parked entry,
  // so a plan that brings words 40..50 back re-keys it onto that cue.
  const doc = docWith({ "scene-3#orphaned": { props: { title: "edited" }, elements: {}, anchor: { startWord: 40, endWord: 50 } } });
  const cues = [cueFixture({ id: "scene-1", anchor: { startWord: 42, endWord: 48 } })];
  const { doc: out } = remapSceneOverrides(doc, cues);
  expect(out.scenes["scene-1"]!.props.title).toBe("edited");
  expect(out.scenes["scene-3#orphaned"]).toBeUndefined();
});
it("anchor-less (pre-migration) entries behave exactly as today", () => { /* entry without anchor, id present-but-moved: untouched, no note — no protection, no new behaviour */ });
it("split halves re-key with their root", () => { /* doc has scene-3@abc with anchor 40..50; new plan has that anchor at scene-1 → entry becomes scene-1@abc */ });
it("id match with agreeing anchor is a no-op", () => { /* overlap between stored and current anchor for same id → untouched, no note */ });
it("two cues overlap the stored anchor: the larger overlap wins", () => { /* deterministic tie-break; on equal overlap prefer the cue whose id equals the stored id, else the earlier cue */ });
```

Write each of these out fully (real fixtures, real assertions) — the sketch above is the coverage list, not the test bodies.

- [ ] **Step 2:** Run — FAIL (function does not exist).
- [ ] **Step 3: Implement.** Shape:

```ts
const wordOverlap = (a: SceneAnchor, b: SceneAnchor): number =>
  Math.min(a.endWord, b.endWord) - Math.max(a.startWord, b.startWord) + 1;

export function remapSceneOverrides(doc: OverrideDoc, cues: readonly SceneCue[]): SceneRemapResult {
  // Root graphic cues only: take-* ids are positional by CLIP, a different
  // identity space, and carry no anchor by construction (Task 1).
  const anchored = cues.filter((c): c is SceneCue & { anchor: SceneAnchor } => c.anchor !== undefined && !c.id.includes("@"));
  const notes: string[] = [];
  const scenes: Record<string, SceneOverride> = {};
  for (const [key, entry] of Object.entries(doc.scenes)) {
    const at = key.indexOf("@");
    const rootId = at === -1 ? key : key.slice(0, at);
    const stored = entry.anchor;
    if (!stored) { scenes[key] = entry; continue; }                    // pre-migration: today's behaviour
    const current = anchored.find((c) => c.id === rootId);
    if (current && wordOverlap(stored, current.anchor) > 0) { scenes[key] = entry; continue; }  // id still means the same moment
    // id missing OR pointing at a different moment: follow the anchor.
    const best = anchored
      .map((c) => ({ c, ov: wordOverlap(stored, c.anchor) }))
      .filter((x) => x.ov > 0)
      .sort((a, b) => b.ov - a.ov || (a.c.id === rootId ? -1 : b.c.id === rootId ? 1 : a.c.startSec - b.c.startSec))[0];
    if (!best) {
      // No cue anywhere has these words. Two sub-cases:
      //  - the old id also matches nothing → leave the entry as-is; the
      //    applyOverrides orphan warning covers it, exactly today.
      //  - the old id now belongs to a DIFFERENT moment → the entry must not
      //    stay under a key that would join the impostor. PARK it under an
      //    inert key ("#" never appears in a cue id), keeping the data and
      //    its anchor so a later plan that brings the words back rescues it.
      if (current && !key.endsWith("#orphaned")) {
        notes.push(`edit for ${key} parked — its words left the plan, and ${rootId} now shows a different moment`);
        scenes[`${key}#orphaned`] = entry;
      } else {
        scenes[key] = entry;
      }
      continue;
    }
    const baseKey = key.endsWith("#orphaned") ? key.slice(0, -"#orphaned".length) : key;
    const baseAt = baseKey.indexOf("@");
    const newKey = baseAt === -1 ? best.c.id : `${best.c.id}${baseKey.slice(baseAt)}`;
    // Prefer the anchor on conflict, out loud (handoff design #4): the id
    // pointed at an impostor, and leaving the edit there is the silent
    // misapply this whole pass exists to prevent.
    notes.push(`edit for ${key} re-keyed to ${newKey} — the plan renumbered, its words moved there`);
    scenes[newKey] = entry;
  }
  return { doc: { ...doc, scenes }, notes };
}
```

Note the parked-key match arm: an entry keyed `…#orphaned` must skip the `current`/id-agreement shortcut (its root id is historical, not a claim) and match purely by anchor — restructure the flow accordingly while implementing; the sketch above compresses that.

Treat this as the shape, not gospel: while implementing, decide the collision rule explicitly (two entries re-keying onto one cue → keep the one whose stored anchor overlaps more, park the loser, note both) and write a test for it. Keep the function total — never throw on user data.

- [ ] **Step 4:** Run tests — PASS. `pnpm typecheck`.
- [ ] **Step 5:** Commit: `git commit -m "feat(core): remapSceneOverrides follows anchors across a re-plan"`

### Task 5: Produce wires the remap, warns only when both identities miss

**Files:**
- Modify: `apps/cli/src/produce.ts` — after `fillPlainCues` (~line 3408), before `splitCues` (~line 3420); the orphan warning at ~3441 keeps its text but now only fires post-remap
- Test: whichever `apps/cli/test/*.test.ts` currently exercises the produce override pipeline (search for the existing test asserting the `edit for ... dropped` line; extend beside it)

**Interfaces:**
- Consumes: `remapSceneOverrides` (Task 4) via `@ossclip/core`.

- [ ] **Step 1: Failing test:** a produce-pipeline-level test (same harness as the existing dropped-edit test) where the override doc holds an anchored edit for `scene-11` and the plan now calls that moment `scene-7`: assert the run prints the re-key note, does NOT print `edit for scene-11 dropped`, and the rendered cue `scene-7` carries the edit. Plus: the written-back `overrides.json` now keys the entry `scene-7` (the write-back at `produce.ts:4299` persists the remap — assert on the file the harness writes).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.** Insert after the `filled` list exists and before `splitCues`:

```ts
// Re-key scene edits whose positional id no longer means the moment they
// were made on (handoff-edit-anchoring; §137 is the caption precedent).
// BEFORE splitCues so `root@splitId` halves rename with their root, and
// BEFORE applyOverrides so its id-join — and its orphan warning — see the
// converged keys: after this, "dropped" really means both identities missed.
const sceneRemap = remapSceneOverrides(overrideDoc, filled);
overrideDoc = sceneRemap.doc;
for (const n of sceneRemap.notes) console.log(`  ▸ ${n}`);
```

Confirm `overrideDoc` is a reassignable binding at that point (it is reassigned at `produce.ts:3172` for `pruneHidesInsideCuts` — same pattern). Confirm the write-back at 4299 writes this same `overrideDoc` binding (it does — but verify no earlier snapshot is what's written).

Also: parked keys (`…#orphaned`, Task 4) surface in `applyOverrides`' orphan list every run. In the orphan warning loop (~3441), special-case them so the sentence stays honest:

```ts
for (const id of orphans) {
  if (id.endsWith("#orphaned")) {
    console.log(`  ⚠ edit for ${id.slice(0, -"#orphaned".length)} is parked — its words are not in this plan`);
  } else {
    console.log(`  ⚠ edit for ${id} dropped — the plan no longer has that scene`);
  }
}
```

Add a test case for the parked line (a doc with a parked entry produces the parked sentence, not the dropped one).

- [ ] **Step 4:** Run the new test and the whole suite: `pnpm test`. The existing dropped-edit test must still pass (a shrunk plan with no anchor match still warns).
- [ ] **Step 5:** `pnpm typecheck`. Commit: `git commit -m "feat(produce): re-key anchored scene edits across a re-plan, warn only when both identities miss"`

### Task 6: Findings entry + PR

- [ ] **Step 1:** Append a findings section to `docs/PHASE1-FINDINGS.md` (next free § number — check `git log`/the doc for the current max, §154 was the last known) recording: positional id + silent misapply case, the anchor identity, remap-before-apply decision, and the Task 0 empirical result. Follow the doc's existing section format.
- [ ] **Step 2:** `pnpm test && pnpm typecheck && pnpm build` — all green.
- [ ] **Step 3:** Push branch, open PR titled `Scene edits survive a re-plan` with the handoff linked, Task 0's evidence, and the note that pre-existing docs keep id-only behaviour.
