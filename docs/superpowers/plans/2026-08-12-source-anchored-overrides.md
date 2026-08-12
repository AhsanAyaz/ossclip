# Source-Anchored Override Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-key caption edits and split-half scene ids to anchors that survive a re-cut, so a user cut can no longer silently discard the edits made before it.

**Architecture:** `remapOverridesThroughRecut` (`packages/core/src/recut.ts:52`) already re-anchors every absolute-output-seconds VALUE in the override doc through source time, and already reports anything it moves. Two KEY spaces were never wired into it: caption edits keyed by positional caption-word index, and split halves keyed by `${rootId}@${outputStartMs}`. This plan gives both a stable identity — caption edits keyed by the word's SOURCE time, split halves keyed by an id that is minted once and never recomputed — so the existing remap keeps working and the keys stop moving underneath it.

**Tech Stack:** TypeScript, zod schemas in `packages/core/src/overrides.ts`, vitest, React editor in `apps/editor`.

## The bug this fixes (field case, 2026-08-12)

Workdir `~/Downloads/.ossclip/Starship V2-e89a046b`. The user retyped four caption words and deleted one scene, saved, then rendered. Nothing applied.

- `overrides.json.bak` (their save) held `captions {0,1,2,39}` and `scene-0@600: hidden`.
- Their own cut (`cuts: [{startSec: 0, endSec: 0.6}]`) removed the word `batch,`.
- `applyUserCuts` re-anchored the doc: timings −0.6s, `splits 0.6 → 0`. Correct for values.
- But caption key `0` (`was: "batch,"`) now points at `status`, `1` at `edge,`, `2` at `power` — every `was` guard failed and all four edits were dropped.
- And `splits 0.6 → 0` is below `SPLIT_MIN_PIECE_SEC` (0.3), so `splitCues` skips it entirely; `scene-0@600` matches no cue and the deleted scene came back whole.
- `apps/editor/src/App.tsx:583` calls `applyCaptionEdits(...).lines` and discards `.dropped`, so the editor reverted the words with no explanation — making that function's "reported, not silently discarded" doc comment false.

## Global Constraints

- **No new npm dependencies.**
- **Every existing `overrides.json` on disk must keep working.** Both key spaces get a migration, and both migrations are pure and unit-tested. A user's saved work is their data — a schema change that drops it is a worse bug than the one being fixed.
- **Legacy split ids must keep matching.** The migration derives a legacy split's stable id from its ORIGINAL output-millisecond value, so an existing `scene-0@600` override still resolves after the upgrade. This is the whole reason the id format is `${rootId}@${id}` rather than something new.
- **Nothing is dropped silently.** Every edit that cannot be resolved is reported through the channel `remapOverridesThroughRecut` already established (`RecutRemap.reports`) or through `AppliedCaptionEdits.dropped`, and both must reach a human.
- Comments explain *why*, not what, and cite the findings section — this work is `§137`.
- Pure logic separated from I/O: every migration, key derivation and lookup is pure and testable without a filesystem or a TTY.
- Values that come from a user are parsed with zod, never coerced.
- **No version bumps, no release.** All four packages bump in lockstep later, bump last (`RELEASES.md`).

---

### Task 1: Carry the source timestamp on every caption word

A caption word currently knows only its OUTPUT time, which a re-cut changes. Its SOURCE time is the thing that never moves, and `buildCaptionLines` already holds it — it just throws it away.

**Files:**
- Modify: `packages/core/src/captions.ts:5-9` (`CaptionWord`), `:65-69` (the mapping loop)
- Test: `packages/core/test/captions.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `CaptionWord` gains `srcStart: number` — the word's start in SOURCE seconds. Every later task keys off it.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/captions.test.ts`. Match the file's existing helper style for building a `Transcript` and a `TimeMap`; if it has a fixture helper, reuse it rather than hand-rolling.

```ts
describe("CaptionWord.srcStart (§137)", () => {
  it("carries the SOURCE start, not the output start, so a re-cut cannot move it", () => {
    // One kept span starting 2.0s into the source: output 0 === source 2.0.
    // TimeMap's constructor takes a cutlist of `Segment` ({srcIn, srcOut});
    // it derives the output side itself.
    const map = new TimeMap([{ srcIn: 2, srcOut: 5 }]);
    const transcript = {
      text: "alpha beta",
      words: [
        { text: "alpha", start: 2.5, end: 2.9 },
        { text: "beta", start: 3.5, end: 3.9 },
      ],
    } as Transcript;

    const words = buildCaptionLines(transcript, map).flatMap((l) => l.words);

    expect(words.map((w) => w.text)).toEqual(["alpha", "beta"]);
    // output times are shifted by the cut...
    expect(words[0]!.start).toBeCloseTo(0.5, 3);
    // ...the source anchor is not.
    expect(words[0]!.srcStart).toBeCloseTo(2.5, 3);
    expect(words[1]!.srcStart).toBeCloseTo(3.5, 3);
  });
});
```

Import `TimeMap` and `Transcript` the way the file already imports them.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/captions.test.ts`
Expected: FAIL — `srcStart` does not exist on `CaptionWord` (typecheck error, or `undefined` at runtime).

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/captions.ts:5-9`:

```ts
export interface CaptionWord {
  text: string;
  start: number;
  end: number;
  /**
   * The word's start in SOURCE seconds (§137). `start`/`end` above are OUTPUT
   * times and a re-cut moves them; this does not, which is what lets a caption
   * edit survive one. The field the edit layer keys on — see
   * `captionKeyFor` in overrides.ts.
   */
  srcStart: number;
}
```

`packages/core/src/captions.ts:65-69`:

```ts
  const mapped: CaptionWord[] = [];
  for (const w of transcript.words) {
    const m = map.mapWord(w as Word);
    // `w.start` is source time, `m.start` output — both are needed, and only
    // the source one is stable across a re-cut (§137).
    if (m) mapped.push({ text: w.text, start: m.start, end: m.end, srcStart: w.start });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/captions.test.ts && pnpm typecheck`
Expected: PASS. `pnpm typecheck` will surface every other construction site of `CaptionWord` that now lacks `srcStart` — fix each by supplying the source time actually in scope there. If any site has no source time available, STOP and report it rather than inventing a value.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: green. Fixtures that build `CaptionWord` literals will need `srcStart`; add it from the fixture's own source times.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/captions.ts packages/core/test/captions.test.ts
git commit -m "core: caption words carry their source timestamp"
```

---

### Task 2: Key caption edits by source time, with a recovering migration

**Files:**
- Modify: `packages/core/src/overrides.ts:146-169` (`CaptionEditSchema`, `captionEditWas`), `:477-497` (`applyCaptionEdits`)
- Test: `packages/core/test/overrides.test.ts` (append)

**Interfaces:**
- Consumes: `CaptionWord.srcStart` (Task 1).
- Produces:
  - `captionKeyFor(srcStart: number): string` — `w${Math.round(srcStart * 1000)}`, e.g. `w2500`
  - `isLegacyCaptionKey(key: string): boolean` — true for a bare non-negative integer
  - `migrateCaptionKeys(edits: Record<string, CaptionEdit>, lines: readonly CaptionLine[]): { edits: Record<string, CaptionEdit>; unresolved: Array<{ key: string; was: string }> }`
  - `applyCaptionEdits(lines, edits)` — unchanged signature, now matching by key

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/overrides.test.ts`:

```ts
describe("source-anchored caption keys (§137)", () => {
  const line = (...ws: Array<[string, number]>): CaptionLine => ({
    words: ws.map(([text, srcStart], i) => ({ text, start: i, end: i + 1, srcStart })),
    start: 0,
    end: ws.length,
  });

  it("captionKeyFor is millisecond-quantised source time", () => {
    expect(captionKeyFor(2.5)).toBe("w2500");
    expect(captionKeyFor(1.7675)).toBe("w1768");
    expect(captionKeyFor(0)).toBe("w0");
  });

  it("applies an edit by source key, wherever the word has moved to", () => {
    const lines = [line(["status", 5.0], ["edge,", 6.0])];
    const { lines: out, dropped } = applyCaptionEdits(lines, {
      w6000: { text: "Zsh,", was: "edge," },
    });
    expect(out[0]!.words.map((w) => w.text)).toEqual(["status", "Zsh,"]);
    expect(dropped).toEqual([]);
  });

  it("still guards on `was` — a re-plan that changed the word drops the edit", () => {
    const lines = [line(["something-else", 6.0])];
    const { lines: out, dropped } = applyCaptionEdits(lines, {
      w6000: { text: "Zsh,", was: "edge," },
    });
    expect(out[0]!.words[0]!.text).toBe("something-else");
    expect(dropped).toEqual([{ key: "w6000", expected: "edge,", found: "something-else" }]);
  });

  it("an edit whose word the cut removed is reported, not applied", () => {
    const lines = [line(["status", 5.0])];
    const { dropped } = applyCaptionEdits(lines, { w1768: { text: "Bash,", was: "batch," } });
    expect(dropped).toEqual([{ key: "w1768", expected: "batch,", found: null }]);
  });

  it("migrates legacy positional keys by position when `was` still matches", () => {
    const lines = [line(["batch,", 1.7675], ["status", 5.0], ["edge,", 6.0])];
    const { edits, unresolved } = migrateCaptionKeys(
      { "0": { text: "Bash,", was: "batch," }, "2": { text: "Zsh,", was: "edge," } },
      lines,
    );
    expect(edits).toEqual({
      w1768: { text: "Bash,", was: "batch," },
      w6000: { text: "Zsh,", was: "edge," },
    });
    expect(unresolved).toEqual([]);
  });

  it("RECOVERS a legacy key whose position drifted, by finding its `was` nearby", () => {
    // The field case: the cut removed "batch,", so every stored index is off
    // by one. Position 1 now holds "edge,", but the edit's `was` is "status".
    const lines = [line(["status", 5.0], ["edge,", 6.0], ["power", 7.0])];
    const { edits, unresolved } = migrateCaptionKeys(
      { "1": { text: "Zsh", was: "status" } },
      lines,
    );
    expect(edits).toEqual({ w5000: { text: "Zsh", was: "status" } });
    expect(unresolved).toEqual([]);
  });

  it("refuses to guess when `was` is ambiguous nearby", () => {
    const lines = [line(["the", 1.0], ["the", 2.0], ["the", 3.0])];
    const { edits, unresolved } = migrateCaptionKeys({ "1": { text: "a", was: "the" } }, lines);
    expect(edits).toEqual({});
    expect(unresolved).toEqual([{ key: "1", was: "the" }]);
  });

  it("leaves already-migrated source keys alone", () => {
    const lines = [line(["edge,", 6.0])];
    const already = { w6000: { text: "Zsh,", was: "edge," } };
    expect(migrateCaptionKeys(already, lines).edits).toEqual(already);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/overrides.test.ts -t "source-anchored caption keys"`
Expected: FAIL — `captionKeyFor` / `migrateCaptionKeys` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/overrides.ts`, replace `applyCaptionEdits` and add the helpers:

```ts
/**
 * A caption edit's key: the word's source start, quantised to milliseconds
 * (§137). Positional indices were the original design and a user cut breaks
 * them — removing one word shifts every later index, so the `was` guard below
 * fires on every edit and the user's retypes vanish into the report nobody
 * printed. Source time is the one property of a word that a re-cut cannot
 * move.
 */
export function captionKeyFor(srcStart: number): string {
  return `w${Math.round(srcStart * 1000)}`;
}

/** A pre-§137 key: a bare non-negative integer, i.e. a caption-word position. */
export function isLegacyCaptionKey(key: string): boolean {
  return /^\d+$/.test(key);
}

/** How far either side of the stored index the migration will look for `was`. */
const MIGRATION_SEARCH_RADIUS = 8;

export interface CaptionKeyMigration {
  edits: Record<string, CaptionEdit>;
  /** Legacy edits no anchor could be found for — reported, never guessed at. */
  unresolved: Array<{ key: string; was: string }>;
}

/**
 * Upgrade pre-§137 positional keys to source-time keys.
 *
 * Position first — for a doc that never went through a re-cut it is exact.
 * When the word at that position is NOT the edit's `was`, the position has
 * drifted (a cut removed words before it), so search outward for the `was`:
 * that recovers the field case rather than discarding work the user already
 * did. A `was` that appears more than once inside the radius is ambiguous and
 * is reported instead — a wrong anchor silently rewrites the wrong word,
 * which is worse than an edit the user has to redo.
 */
export function migrateCaptionKeys(
  edits: Record<string, CaptionEdit>,
  lines: readonly CaptionLine[],
): CaptionKeyMigration {
  const words = lines.flatMap((l) => l.words);
  const out: Record<string, CaptionEdit> = {};
  const unresolved: CaptionKeyMigration["unresolved"] = [];

  for (const [key, edit] of Object.entries(edits)) {
    if (!isLegacyCaptionKey(key)) {
      out[key] = edit;
      continue;
    }
    const at = Number(key);
    if (words[at]?.text === edit.was) {
      out[captionKeyFor(words[at]!.srcStart)] = edit;
      continue;
    }
    const matches: number[] = [];
    for (let d = 1; d <= MIGRATION_SEARCH_RADIUS; d++) {
      for (const i of [at - d, at + d]) {
        if (words[i]?.text === edit.was) matches.push(i);
      }
    }
    if (matches.length === 1) {
      out[captionKeyFor(words[matches[0]!]!.srcStart)] = edit;
    } else {
      unresolved.push({ key, was: edit.was });
    }
  }
  return { edits: out, unresolved };
}

export interface AppliedCaptionEdits {
  lines: CaptionLine[];
  /**
   * Edits that did not apply. `found: null` means no word carries that source
   * anchor any more (a cut removed it); a string means the word is there but
   * says something else (a re-plan changed it).
   */
  dropped: Array<{ key: string; expected: string; found: string | null }>;
}

/**
 * Apply retyped caption words. Text only, never timing — the stamps drive the
 * kinetic highlight and the 1:1 constraint is what keeps scene anchors and
 * §21's copy/caption agreement intact.
 *
 * Keyed by source time since §137, so a user cut earlier in the video no
 * longer shifts every later edit onto the wrong word. An edit that does not
 * apply is REPORTED — callers must surface `dropped`; the editor discarding it
 * is what made this failure invisible in the field case.
 */
export function applyCaptionEdits(
  lines: readonly CaptionLine[],
  edits: Record<string, CaptionEdit>,
): AppliedCaptionEdits {
  const dropped: AppliedCaptionEdits["dropped"] = [];
  if (Object.keys(edits).length === 0) return { lines: [...lines], dropped };

  const seen = new Set<string>();
  const out = lines.map((line) => ({
    ...line,
    words: line.words.map((w) => {
      const key = captionKeyFor(w.srcStart);
      const edit = edits[key];
      if (!edit) return w;
      seen.add(key);
      if (w.text !== edit.was) {
        dropped.push({ key, expected: edit.was, found: w.text });
        return w;
      }
      return { ...w, text: edit.text };
    }),
  }));

  // An anchor no word carries any more — the cut removed the word the user
  // edited. Silence here is exactly the field case, so say it.
  for (const [key, edit] of Object.entries(edits)) {
    if (!seen.has(key)) dropped.push({ key, expected: edit.was, found: null });
  }
  return { lines: out, dropped };
}
```

Also update `captionEditWas` (`:163-169`) to take a `key: string` instead of `index: number`, keeping its doc comment's reasoning intact:

```ts
export function captionEditWas(
  captions: Record<string, CaptionEdit>,
  key: string,
  seen: string,
): string {
  return captions[key]?.was ?? seen;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/overrides.test.ts && pnpm typecheck`
Expected: the new block passes. `pnpm typecheck` will flag every caller of `applyCaptionEdits` that reads `dropped[].index` and every caller of `captionEditWas` — Tasks 3 and 6 own those; for now make them compile without changing behaviour.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overrides.ts packages/core/test/overrides.test.ts
git commit -m "core: key caption edits by source time, with a recovering migration"
```

---

### Task 3: Give split halves an id that is minted once

`splitCues` names a half `${rootId}@${Math.round(t * 1000)}` from the split's CURRENT output time, so re-anchoring the split renames the half and orphans every override on it. The id must be data, not a recomputation.

**Files:**
- Modify: `packages/core/src/overrides.ts:190-197` (`splits` schema), `:392-412` (`splitCues`), `:458-463` (`splitThenDropHidden`)
- Test: `packages/core/test/overrides.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `SplitSchema` → `{ at: number; id: string }`, and `OverrideDoc["splits"]: Array<{ at: number; id: string }>`
  - The schema accepts a legacy bare `number` and upgrades it in place
  - `legacySplitId(at: number): string` — `String(Math.round(at * 1000))`
  - `splitCues(cues: readonly SceneCue[], splits: readonly Split[]): SceneCue[]`

- [ ] **Step 1: Write the failing test**

```ts
describe("stable split ids (§137)", () => {
  const cue = (id: string, startSec: number, endSec: number): SceneCue =>
    ({ id, startSec, endSec }) as SceneCue;

  it("a legacy numeric split parses into {at, id} with the id derived from its ORIGINAL ms", () => {
    // Load-bearing: an existing overrides.json has `scene-0@600` hidden, and
    // that key must still match after the upgrade.
    const doc = OverrideDocSchema.parse({ splits: [0.6] });
    expect(doc.splits).toEqual([{ at: 0.6, id: "600" }]);
  });

  it("names the second half from the id, not from the split time", () => {
    const out = splitCues([cue("scene-0", 0, 6)], [{ at: 0.6, id: "600" }]);
    expect(out.map((c) => c.id)).toEqual(["scene-0", "scene-0@600"]);
  });

  it("re-anchoring the split time does NOT rename the half — the field-case fix", () => {
    // Same id, moved earlier by a re-cut. The half keeps its name, so a
    // `hidden` override on it survives.
    const out = splitCues([cue("scene-0", 0, 6)], [{ at: 1.2, id: "600" }]);
    expect(out.map((c) => c.id)).toEqual(["scene-0", "scene-0@600"]);
    expect(out[1]!.startSec).toBeCloseTo(1.2, 3);
  });

  it("derives a half id from the ROOT id, never chaining", () => {
    const out = splitCues(
      [cue("take-0", 0, 10)],
      [{ at: 3, id: "3000" }, { at: 6, id: "6000" }],
    );
    expect(out.map((c) => c.id)).toEqual(["take-0", "take-0@3000", "take-0@6000"]);
  });

  it("still hides the half the user deleted, matched by the stable id", () => {
    const doc = OverrideDocSchema.parse({
      splits: [{ at: 1.2, id: "600" }],
      scenes: { "scene-0@600": { hidden: true } },
    });
    const { cues, hidden } = splitThenDropHidden([cue("scene-0", 0, 6)], doc);
    expect(cues.map((c) => c.id)).toEqual(["scene-0"]);
    expect(hidden).toEqual(["scene-0@600"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/overrides.test.ts -t "stable split ids"`
Expected: FAIL — `doc.splits` parses to `[0.6]`, a number, not `{at, id}`.

- [ ] **Step 3: Write minimal implementation**

Replace the `splits` field in `OverrideDocSchema` (`:190-197`):

```ts
/**
 * The id a pre-§137 split gets when it is upgraded: its ORIGINAL output
 * milliseconds. Load-bearing for the migration — a saved doc hiding
 * `scene-0@600` must still match the half after the upgrade, and that only
 * holds if the derived id reproduces the old name exactly.
 */
export function legacySplitId(at: number): string {
  return String(Math.round(at * 1000));
}

export const SplitSchema = z.union([
  z.object({ at: z.number().nonnegative(), id: z.string().min(1) }),
  // Legacy: a bare number, upgraded in place so every overrides.json written
  // before §137 parses and keeps its split-half overrides attached.
  z.number().nonnegative().transform((at) => ({ at, id: legacySplitId(at) })),
]);
export type Split = z.infer<typeof SplitSchema>;
```

and in `OverrideDocSchema`:

```ts
  /**
   * Scene split points. `at` is ABSOLUTE output seconds (R16 §61 — Cmd/Ctrl+B
   * at the playhead) and moves when a re-cut re-anchors the doc; `id` is
   * minted once when the split is created and NEVER recomputed (§137). The
   * split half is named `${rootId}@${id}`, so re-anchoring `at` cannot rename
   * the half out from under a `hidden` (or any other) override on it — the
   * bug that resurrected a deleted scene in the field case.
   */
  splits: z.array(SplitSchema).default([]),
```

Rewrite `splitCues` (`:392-412`) — keep the whole existing doc comment and add the id note:

```ts
export function splitCues(cues: readonly SceneCue[], splits: readonly Split[]): SceneCue[] {
  const out = [...cues];
  for (const s of [...splits].sort((a, b) => a.at - b.at)) {
    const i = out.findIndex(
      (c) => s.at >= c.startSec + SPLIT_MIN_PIECE_SEC && s.at <= c.endSec - SPLIT_MIN_PIECE_SEC,
    );
    if (i === -1) continue;
    const cue = out[i]!;
    out.splice(
      i,
      1,
      { ...cue, endSec: s.at },
      // The id comes from the SPLIT, not from `s.at` — that is the §137 fix.
      { ...cue, id: `${cue.id.split("@")[0]}@${s.id}`, startSec: s.at },
    );
  }
  return out;
}
```

`splitThenDropHidden` (`:462`) needs no change — it already passes `doc.splits` straight through.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/overrides.test.ts && pnpm typecheck`
Expected: the new block passes. Typecheck will flag `recut.ts:59`, `produce.ts:1604-1606`, `App.tsx:562`, `useEdits.ts:303-306` and `ghosts.ts:33` — Tasks 4 and 5 own the first two and the editor ones; make them compile now by reading `.at` where a number was read, without changing behaviour.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/overrides.ts packages/core/test/overrides.test.ts
git commit -m "core: split halves get an id that survives re-anchoring"
```

---

### Task 4: Remap `at`, keep `id`, and say when a split dies

**Files:**
- Modify: `packages/core/src/recut.ts:59` (splits remap), `:320` (the drift comparison)
- Test: `packages/core/test/recut.test.ts` (append)

**Interfaces:**
- Consumes: `Split` (Task 3).
- Produces: `remapOverridesThroughRecut` returns splits as `{at: remapped, id: unchanged}`, and pushes a report for any split whose remapped `at` can no longer produce two pieces.

- [ ] **Step 1: Write the failing test**

```ts
describe("split remapping keeps ids (§137)", () => {
  it("moves `at` through source time and leaves `id` alone", () => {
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 10 }]);
    const newMap = new TimeMap([{ srcIn: 0.6, srcOut: 10 }]);
    const doc = OverrideDocSchema.parse({ splits: [{ at: 1.2, id: "600" }] });

    const { doc: out } = remapOverridesThroughRecut(doc, oldMap, newMap);

    expect(out.splits).toEqual([{ at: expect.closeTo(0.6, 3), id: "600" }]);
  });

  it("reports a split the re-cut squeezed below the minimum piece size", () => {
    // The field case: split at 0.6 re-anchors to 0, splitCues then skips it
    // silently and every override on the half is orphaned.
    const oldMap = new TimeMap([{ srcIn: 0, srcOut: 10 }]);
    const newMap = new TimeMap([{ srcIn: 0.6, srcOut: 10 }]);
    const doc = OverrideDocSchema.parse({ splits: [{ at: 0.6, id: "600" }] });

    const { doc: out, reports } = remapOverridesThroughRecut(doc, oldMap, newMap);

    expect(out.splits[0]!.at).toBeCloseTo(0, 3);
    expect(reports.join("\n")).toMatch(/split "600".*too close to the start/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/recut.test.ts -t "split remapping keeps ids"`
Expected: FAIL — `out.splits` are bare numbers, and no report is emitted.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/recut.ts:59`:

```ts
  // `at` moves through source time like every other output-seconds value;
  // `id` is deliberately untouched (§137) — recomputing it from the new time
  // is exactly what orphaned `scene-0@600` when a cut pushed its split to 0.
  const splits = doc.splits.map((s) => {
    const at = remapPoint(`split "${s.id}"`, s.at, oldMap, newMap, reports);
    // A split needs SPLIT_MIN_PIECE_SEC of cue on both sides or `splitCues`
    // skips it — silently, until §137. The override on the half then applies
    // to nothing, so the deleted half comes back. Say so.
    if (at < SPLIT_MIN_PIECE_SEC) {
      reports.push(
        `split "${s.id}" is now ${at.toFixed(3)}s — too close to the start to divide a scene, ` +
          `so any edit on its second half will not apply`,
      );
    }
    return { at, id: s.id };
  });
```

Import `SPLIT_MIN_PIECE_SEC` from `./overrides` at the top of `recut.ts`.

`:320` needs NO change: `closeEnough` (`recut.ts:103-117`) is already a generic deep compare — it recurses through arrays and objects, compares numbers with `EPS` and falls back to `===` for strings. So `{at, id}` pairs compare correctly as-is. Verified before writing this; do not "fix" it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/test/recut.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/recut.ts packages/core/test/recut.test.ts
git commit -m "core: re-anchor a split's time without renaming its half"
```

---

### Task 5: Editor writes the new keys

**Files:**
- Modify: `apps/editor/src/useEdits.ts:303-306` (`addSplit`), `:433-451` (`patchCaption`), `apps/editor/src/App.tsx:562`, `apps/editor/src/ghosts.ts:33`
- Test: `apps/editor/test/useEdits.test.ts` (append; if the editor has no test file for this reducer, create `apps/editor/test/edits-keys.test.ts` and import the reducer directly)

**Interfaces:**
- Consumes: `captionKeyFor` (Task 2), `Split`/`legacySplitId` (Task 3).
- Produces: `patchCaption` actions carry `srcStart: number` instead of `index: number`; `addSplit` writes `{at, id}`.

- [ ] **Step 1: Write the failing test**

```ts
describe("editor writes source-anchored keys (§137)", () => {
  it("patchCaption stores the edit under the word's source key", () => {
    const doc = OverrideDocSchema.parse({});
    const next = editsReducer(
      { doc, past: [], future: [] },
      { type: "patchCaption", srcStart: 1.7675, was: "batch,", text: "Bash," },
    );
    expect(next.doc.captions).toEqual({ w1768: { text: "Bash,", was: "batch," } });
  });

  it("retyping back to the original still clears the override", () => {
    const doc = OverrideDocSchema.parse({ captions: { w1768: { text: "Bash,", was: "batch," } } });
    const next = editsReducer(
      { doc, past: [], future: [] },
      { type: "patchCaption", srcStart: 1.7675, was: "Bash,", text: "batch," },
    );
    expect(next.doc.captions).toEqual({});
  });

  it("addSplit mints an id once", () => {
    const doc = OverrideDocSchema.parse({});
    const next = editsReducer({ doc, past: [], future: [] }, { type: "addSplit", t: 1.2 });
    expect(next.doc.splits).toHaveLength(1);
    expect(next.doc.splits[0]!.at).toBeCloseTo(1.2, 3);
    expect(next.doc.splits[0]!.id).toBe("1200");
  });

  it("does not add a second split at the same moment", () => {
    const doc = OverrideDocSchema.parse({ splits: [{ at: 1.2, id: "1200" }] });
    const next = editsReducer({ doc, past: [], future: [] }, { type: "addSplit", t: 1.2005 });
    expect(next.doc.splits).toHaveLength(1);
  });
});
```

Match the reducer's real name and state shape by reading `useEdits.ts` first — the names above are indicative, the file on disk is authoritative.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/editor/test/edits-keys.test.ts`
Expected: FAIL — the action still carries `index`, and splits are numbers.

- [ ] **Step 3: Write minimal implementation**

`useEdits.ts` `patchCaption` — keep the existing comment block explaining the clear-on-revert rule and `captionEditWas`, changing only the key:

```ts
    case "patchCaption": {
      const key = captionKeyFor(action.srcStart);
      const was = captionEditWas(state.doc.captions, key, action.was);
      if (action.text === was) {
        const { [key]: _dropped, ...rest } = state.doc.captions;
        return commit({ ...state.doc, captions: rest });
      }
      return commit({
        ...state.doc,
        captions: { ...state.doc.captions, [key]: { text: action.text, was } },
      });
    }
```

`useEdits.ts` `addSplit`:

```ts
      if (state.doc.splits.some((s) => Math.abs(s.at - action.t) < 0.001)) return state;
      return commit({
        ...state.doc,
        // Minted here, once, and never recomputed (§137).
        splits: [...state.doc.splits, { at: action.t, id: legacySplitId(action.t) }].sort(
          (a, b) => a.at - b.at,
        ),
      });
```

Update the `patchCaption` action type to carry `srcStart: number`, and update its call site in `TranscriptPanel.tsx` to pass `word.srcStart` — find it by searching for `patchCaption`.

`App.tsx:562` and `ghosts.ts:33` need no logic change; `splitCues` now takes the new shape and they already pass `doc.splits` through.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/editor && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/editor/src apps/editor/test
git commit -m "editor: write source-anchored caption keys and minted split ids"
```

---

### Task 6: Migrate on load, and make every dropped edit visible

The migration has to run where the doc is read, and the two places that already compute `dropped` have to stop throwing it away.

**Files:**
- Modify: `apps/cli/src/edit.ts:262-265` (server-side doc load), `apps/editor/src/App.tsx:579-583`, `apps/cli/src/produce.ts:1938`
- Test: `apps/cli/test/edit-server.test.ts` (append), `apps/editor/test/edits-keys.test.ts` (append)

**Interfaces:**
- Consumes: `migrateCaptionKeys` (Task 2), `AppliedCaptionEdits.dropped` (Task 2), `RecutRemap.reports` (Task 4).
- Produces: no new exports — this is wiring.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/edit-server.test.ts` — follow the file's existing pattern for standing a workdir up in a tmpdir and hitting the server:

```ts
it("migrates legacy caption keys when the doc is loaded (§137)", async () => {
  // A pre-§137 overrides.json, positional keys, against caption lines whose
  // words carry source times.
  await writeFile(
    join(work, "overrides.json"),
    JSON.stringify({ captions: { "0": { text: "Bash,", was: "batch," } } }),
  );
  const res = await fetch(`${url}/api/production`);
  const body = await res.json();
  expect(Object.keys(body.overrides.captions)).toEqual(["w1768"]);
});
```

The endpoint is `GET /api/production` (`edit.ts:255`) and it returns `{renderProps, overrides, workdir, videoFileName, canRender, recent}` — verified, not guessed. Note the no-overrides branch calls `emptyOverrideDoc()`, not `OverrideDocSchema.parse({})`; keep that call as it is.

Append to the editor test:

```ts
it("surfaces dropped caption edits instead of silently reverting (§137)", () => {
  const lines = [
    { words: [{ text: "status", start: 0, end: 1, srcStart: 5 }], start: 0, end: 1 },
  ];
  const { dropped } = applyCaptionEdits(lines, { w1768: { text: "Bash,", was: "batch," } });
  expect(dropped).toEqual([{ key: "w1768", expected: "batch,", found: null }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/cli/test/edit-server.test.ts -t "migrates legacy caption keys"`
Expected: FAIL — the server returns the doc with its `"0"` key untouched.

- [ ] **Step 3: Write minimal implementation**

In `edit.ts`, after parsing the override doc (`:262-265`), migrate against the render props' base caption lines and log anything unresolved:

```ts
          const overrides = existsSync(overridesPath())
            ? OverrideDocSchema.parse(JSON.parse(await readFile(overridesPath(), "utf8")))
            : emptyOverrideDoc();
          // §137: pre-§137 docs key caption edits by position, which a user
          // cut shifts. Upgrade them against the pristine base lines the
          // editor is about to render, so a doc saved before this change
          // keeps its edits instead of dropping them one guard at a time.
          const baseLines = renderProps.baseCaptionLines ?? renderProps.captionLines ?? [];
          const migrated = migrateCaptionKeys(overrides.captions, baseLines);
          if (migrated.unresolved.length > 0) {
            for (const u of migrated.unresolved) {
              console.log(
                `▸ caption edit "${u.was}" could not be re-anchored — retype it if you still want it`,
              );
            }
          }
          const doc = { ...overrides, captions: migrated.edits };
```

and serve `doc` where `overrides` was served.

In `App.tsx:579-583`, keep the drop report and render it. Capture it into the memo's return value and display it wherever the editor already shows transient notices (find that surface by reading `App.tsx`; if there is none, `console.warn` each dropped edit and add a one-line note next to the Transcript heading):

```ts
    const applied = applyCaptionEdits(baseCaptions, edits.doc.captions);
    // §137: `dropped` used to be discarded here, which is why a retype that
    // could not be anchored just silently reverted in front of the user.
    return {
      ...renderProps,
      sceneCues: previewed,
      captionLines: applied.lines,
      droppedCaptionEdits: applied.dropped,
      ...
```

In `produce.ts:1938`, `staleCaptionEdits` is already captured — verify it is printed, and if it is not, print one line per dropped edit using the same `▸` prefix, naming the word rather than the key.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/edit.ts apps/cli/src/produce.ts apps/editor/src/App.tsx apps/cli/test apps/editor/test
git commit -m "migrate legacy caption keys on load and surface every dropped edit"
```

---

### Task 7: Recover the field case, and write it down

**Files:**
- Modify: `docs/PHASE1-FINDINGS.md` (append §137)
- Test: `packages/core/test/overrides.test.ts` (append one regression test built from the real field data)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-facing.

- [ ] **Step 1: Write the regression test from the real failure**

```ts
describe("§137 field case: Starship V2, 2026-08-12", () => {
  it("recovers the four edits a 0.6s cut orphaned", () => {
    // Caption words as they stood AFTER the cut removed "batch,".
    const lines = [
      {
        words: [
          { text: "status", start: 0, end: 1, srcStart: 2.3675 },
          { text: "edge,", start: 1, end: 2, srcStart: 2.9 },
        ],
        start: 0,
        end: 2,
      },
    ];
    // The doc as saved BEFORE the cut: positional keys, one index too high.
    const legacy = {
      "1": { text: "zsh", was: "status" },
      "2": { text: ",", was: "edge," },
    };
    const { edits, unresolved } = migrateCaptionKeys(legacy, lines);
    expect(unresolved).toEqual([]);

    const { lines: out, dropped } = applyCaptionEdits(lines, edits);
    expect(out[0]!.words.map((w) => w.text)).toEqual(["zsh", ","]);
    expect(dropped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run packages/core/test/overrides.test.ts -t "field case"`
Expected: PASS (the machinery landed in Tasks 2-6; this pins the actual bug).

- [ ] **Step 3: Append §137 to `docs/PHASE1-FINDINGS.md`**

Check the current highest section number first; if something other than 136 is highest, use the next free number and update every `§137` citation in the code to match. Match the existing heading format. Record:

- The field case: workdir `Starship V2-e89a046b`, four caption retypes and one deleted scene, all silently discarded after a 0.6s user cut.
- The mechanism: `remapOverridesThroughRecut` re-anchors every output-seconds VALUE through source time and reports what it moves, but two KEY spaces were outside it — caption edits keyed by caption-word position, and split halves named `${rootId}@${outputStartMs}`.
- Why the deleted scene came back specifically: the re-anchor moved the split from 0.6 to 0, below `SPLIT_MIN_PIECE_SEC`, so `splitCues` skipped it entirely and `scene-0@600` matched no cue.
- The fix: caption edits keyed by source time (`w<ms>`), split halves keyed by an id minted once at creation. Legacy split ids are derived from the ORIGINAL output ms precisely so existing `scene-0@600` overrides keep matching.
- The migration's recovery rule, and why an ambiguous `was` is reported rather than guessed: a wrong anchor rewrites the wrong word, which is worse than an edit the user redoes.
- That `App.tsx` discarded `applyCaptionEdits(...).dropped`, making the function's own "reported, not silently discarded" comment false — and that this invisibility is what let the bug reach a rendered video.

- [ ] **Step 4: Commit**

```bash
git add docs/PHASE1-FINDINGS.md packages/core/test/overrides.test.ts
git commit -m "docs: §137 — override keys have to survive a re-cut"
```

---

## Manual verification (after Task 7)

The real proof is the user's own workdir, which still has the broken data.

1. `pnpm test && pnpm typecheck` — green.
2. Copy the field workdir so the original is preserved:
   `cp -R ~/Downloads/.ossclip/'Starship V2-e89a046b' /tmp/starship-check`
3. Restore the user's ORIGINAL save over the re-anchored one:
   `cp /tmp/starship-check/overrides.json.bak /tmp/starship-check/overrides.json`
4. `ossclip edit /tmp/starship-check` — the four retyped words must show as retyped, and `scene-0`'s deleted half must stay deleted.
5. Render from the editor and confirm both hold in the output.
6. Confirm the console named anything it could not re-anchor, rather than staying silent.

## Explicitly out of scope

- Re-anchoring `doc.cuts` — deliberately not remapped (`recut.ts:74`), and that decision is unchanged here.
- Any change to the 1:1 retype rule. A caption edit still replaces one word with one word; only its KEY changes.
- No release. Version bumps happen in a separate lockstep commit, last, per `RELEASES.md`.
