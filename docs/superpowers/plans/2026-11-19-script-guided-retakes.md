# Script-Guided Retakes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a script project, cut the earlier of two back-to-back takes of one script sentence.

**Architecture:** One pure module in core finds the takes from the script cues, the raw transcript, the silences and the words other detectors already claimed. `produce` calls it at the two places the other retake detectors run and passes its cuts to `buildCutlist`. A new field on the stored script record says the pass ran, so a replay repeats it and older projects do not get it.

**Tech Stack:** TypeScript, zod (`zod/v4`), vitest.

**Spec:** `docs/designs/script-guided-retakes.md` (approved 2026-11-19). Read it first. FINDINGS §128, §158, §165 are background.

## Global Constraints

- G7: a run with no script, and a `--scenes` replay whose stored script has no `retakePass`, build the same cutlist as today. No existing test is edited to pass.
- Never edit `planner-prompt-frozen.test.ts`, `reveal-props.test.ts`, or `llm-props-schemas.pre-reveal.json`.
- Pure logic takes no I/O. Values from a user or a file are parsed with zod.
- Comments say why, and cite `§166` (this feature's FINDINGS section) or the design section.
- Limits, exact: unit ≥ 4 tokens; twin ≥ 0.6 either direction; occurrence score ≥ 0.6 (`ALIGN_FLOOR`), ≥ 4 matched tokens, ≥ 2 content tokens (≥ 4 letters); window ≤ `ALIGN_SPAN_FACTOR` × unit tokens; silence ≥ 0.65 (`HALLUCINATION_SILENCE_FRAC`) drops an occurrence; kept take ≥ 0.7 and ≥ earlier take; ≤ 25 candidate words between takes; boundary snap ≤ 3 words; cut confidence 0.8.
- One heavy command at a time on this machine (7 GB). `pnpm test` and `pnpm typecheck` run one after the other, never together.

## Review Focus

- A window spanning two adjacent takes must not hide them (overlap order: density first). Test in Task 1.
- A unit said once between two takes of another unit blocks the cut. Test in Task 1.
- A replay of a project stored without `retakePass` gets no script cuts. Test in Task 2.
- `--cleanup exact` and the sanity valve: no report section and no "cut" claim. Test in Task 2 (pure gate).
- A script with no unit of 4 tokens, or only twins, yields no cuts and no error. Test in Task 1.

---

### Task 1: The pure detector

**Files:**
- Create: `packages/core/src/script/retakes.ts`
- Modify: `packages/core/src/script/align.ts` (export `scriptTokens`, `extendRow`, `inOrderMatches`; no behaviour change)
- Modify: `packages/core/src/retake.ts` (export `silenceFraction`; no behaviour change)
- Modify: `packages/core/src/index.ts` (`export * from "./script/retakes";`)
- Test: `packages/core/test/script-retakes.test.ts`

**Interfaces (Produces):**

```ts
export const SCRIPT_RETAKE_MIN_TOKENS = 4;
export const SCRIPT_RETAKE_TWIN = 0.6;
export const SCRIPT_RETAKE_MIN_CONTENT = 2;
export const SCRIPT_RETAKE_CONTENT_LEN = 4;
export const SCRIPT_RETAKE_KEPT_FLOOR = 0.7;
export const SCRIPT_RETAKE_MAX_GAP_WORDS = 25;
export const SCRIPT_RETAKE_SNAP_WORDS = 3;
export const SCRIPT_RETAKE_CONFIDENCE = 0.8;

export interface ScriptUnit { text: string; tokens: string[] }
/** Sentences of the cues' spoken lines (split after . ? !), ≥ 4 tokens, twins removed, script order. */
export function scriptUnits(cues: readonly ScriptCue[]): ScriptUnit[];

export interface ScriptRetake {
  unit: string;                       // the unit's text, for the report
  cut: { startWord: number; endWord: number; startSec: number; endSec: number };
  kept: { startWord: number; endWord: number };   // the later take's matched span
  wordsBetween: number;               // candidate words between the takes
}
/** Word indices no occurrence may use: every bloop span word, every word of every member of every retake group (kept, cuts, undecided, hallucinated). */
export function scriptRetakeExcluded(bloops: readonly BloopSpan[], groups: readonly RetakeGroup[]): Set<number>;
export function findScriptRetakes(
  cues: readonly ScriptCue[],
  transcript: Transcript,
  silences: readonly Span[],
  excluded: ReadonlySet<number>,
): ScriptRetake[];                    // ascending by cut.startWord
/** Two lines: `kept: "<kept take words>"` then `  cut (said again N words later; script: "<unit>"): "<cut words>"`. */
export function formatScriptRetake(transcript: Transcript, r: ScriptRetake): string;
```

All word indices are into the full `transcript.words`.

**Algorithm (design sections 2 to 5), where signature and tests leave a choice:**

- Candidate words: index not in `excluded`, token (`normalizeAlignToken`) non-empty. Windows are measured in candidate positions.
- For a unit with `n` tokens, a candidate window `[s, e]` (at most `ALIGN_SPAN_FACTOR × n` candidate words) is recorded when the in-order match count `m` rises at `e` and the window `[s+1, e]` scores less than `m` (so it starts and ends on a matched word). Keep it when `m / n ≥ ALIGN_FLOOR`, `m ≥ 4`, and at least 2 distinct unit tokens of ≥ 4 letters appear among the window's tokens.
- Drop a window whose time span (first word's `start` to last word's `end`) has `silenceFraction ≥ HALLUCINATION_SILENCE_FRAC`.
- Occurrences of the unit: sort windows by `m / (e − s + 1)` descending, then score descending, then start ascending; take each window that overlaps none already taken.
- For consecutive occurrences A, B of one unit: a retake when `B.score ≥ 0.7`, `B.score ≥ A.score`, candidate words strictly between them ≤ 25, and every occurrence of another unit that lies wholly between them has, for its unit, another occurrence starting at or after B's start.
- Cut start: A's first word; move back to the nearest earlier index where `isSentenceStart(transcript, i)` if it is at most 3 words back, else stay. Cut end bound: B's first word, moved back the same way; `endWord` is the bound minus 1. No retake when `endWord < startWord`. `startSec = words[startWord].start`, `endSec = words[endWord].end`.

- [ ] **Step 1: Write the failing tests** in `packages/core/test/script-retakes.test.ts`. Use a `speak(text)` helper as in `packages/core/test/blooper.test.ts` (0.5 s per word) and a `cue(spoken: string[])` helper building a `ScriptCue` with `hint: { kind: "none" }`. Tests, by name:
  - `scriptUnits splits spoken lines at sentence ends and drops units under 4 tokens`: spoken `["Three steps. The elephant never forgets. It works in every tool."]` → texts `["The elephant never forgets.", "It works in every tool."]`.
  - `scriptUnits drops twins in both directions`: `["One flag for the theme. One flag for the AI. The elephant never forgets."]` → only the elephant unit.
  - `cuts a reworded earlier take and its unscripted tail` (the EGM shape): transcript `"Intro line here. The elephant in this case never forgets. It always has the design in memory. The elephant never forgets. It always holds the context. Outro."`, unit `"The elephant never forgets."` → one retake; cut text `"The elephant in this case never forgets. It always has the design in memory."`; kept text `"The elephant never forgets."`.
  - `two adjacent takes are two occurrences, not one long window`: `"So first off I went into the terminal and typed. So first of all I went into a terminal and typed the command. Done."`, unit `"So first of all I went into a terminal and typed the command."` → one retake cutting the first sentence.
  - `a later take that scores lower than the earlier one is not kept`: full take then a 0.7 partial → no retake.
  - `kept take under 0.7 → no retake`, and `at 0.7 → retake` (unit of 10 tokens, 6 vs 7 matched in the later take; earlier take 6).
  - `26 candidate words between takes → no retake; 25 → retake`.
  - `a different unit said once between the takes blocks the cut`, and `the same shape with that unit said again after the later take cuts`.
  - `a match with one content token is not an occurrence`: unit `"So I was in the box."` against two stretches sharing only `so i was the`.
  - `excluded words are not candidates`: the earlier take's indices in `excluded` → no retake.
  - `an occurrence over dead air is dropped`: silences covering 70% of the later take's span → no retake; 60% → retake.
  - `three takes in a row cut the first two`.
  - `snaps a boundary back at most 3 words`: earlier take preceded by `"Now, "` in the same sentence → cut starts at `Now,`; preceded by 4 words in the same sentence → cut starts at the matched word.
  - `no units → no retakes, no throw` (cues with only short sentences).
  - `scriptRetakeExcluded collects bloop span words and every retake group member`.
  - `formatScriptRetake` exact string for the elephant case: `'kept: "The elephant never forgets."\n  cut (said again 7 words later; script: "The elephant never forgets."): "The elephant in this case never forgets. It always has the design in memory."'` (7 = candidate words between the takes; correct the number in the test if the fixture sentence gives another count, and say so in the report).
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/script-retakes.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the module and the three export-only changes.
- [ ] **Step 4: Run** the same test file, then `pnpm vitest run packages/core/test/script-align.test.ts packages/core/test/retake.test.ts`. Expected: all pass.
- [ ] **Step 5: Run** `pnpm typecheck`. Expected: clean.
- [ ] **Step 6: Commit** `feat: find retakes of a script sentence (pure)`.

---

### Task 2: Wire into produce, the stored record and the report

**Files:**
- Modify: `packages/core/src/schema.ts` (`ProductionScriptSchema`: add `retakePass: z.literal(1).optional()`, with a comment: design section 1, G6)
- Modify: `apps/cli/src/script-mode.ts`
- Modify: `apps/cli/src/produce.ts` (first detection site near the `findRetakeGroups` call, the clip-window re-derivation, `scriptRecord`, the `report.txt` block after "retakes collapsed")
- Test: `apps/cli/test/script-mode.test.ts`, `packages/core/test/production-script.test.ts`, `apps/cli/test/script-produce.test.ts`

**Interfaces:**
- Consumes: Task 1's `findScriptRetakes`, `scriptRetakeExcluded`, `formatScriptRetake`, `SCRIPT_RETAKE_CONFIDENCE`.
- Produces, in `apps/cli/src/script-mode.ts`:

```ts
/** The cues the retake pass reads, or undefined when it must not run (design section 1). */
export function scriptRetakeCues(run: {
  scriptCues: readonly ScriptCue[] | undefined;   // this run's --script cues
  scenesPinned: boolean;
  storedScript: ProductionScript | undefined;
}): readonly ScriptCue[] | undefined;
// scriptCues given → scriptCues. Else scenesPinned && storedScript?.retakePass === 1 → parseScript(storedScript.text). Else undefined.

/** Whether report.txt and the console may say the script cuts happened. */
export function scriptRetakesHonoured(cleanup: string, valveFired: boolean): boolean;  // cleanup !== "exact" && !valveFired
```

**Wiring:**
- Read the stored script once where `scriptProject` is computed (the existing `scenesPinned ? priorScript(work) : undefined`) and keep it in a variable for `scriptRetakeCues`.
- At both detection sites, after `retakeGroups`: `scriptRetakes = cues ? findScriptRetakes(cues, <raw transcript at that site>, silences, scriptRetakeExcluded(bloops, retakeGroups)) : []`, and `retakes = [...retakeCutsFor(retakeGroups), ...scriptRetakes.map((r) => ({ ...r.cut, confidence: SCRIPT_RETAKE_CONFIDENCE }))]`. The first site's variable is named `transcript` and is still raw there; the second uses `rawTranscript`.
- Console, first site, when cues exist: with `--cleanup exact` print nothing new; else `▸ script retakes: N take(s) cut` or `▸ script retakes: none found`, then each `formatScriptRetake` line prefixed `  ▸ `.
- `scriptRecord`: a `--script` run writes `retakePass: 1`; a replay carries the stored record unchanged (already so).
- `report.txt`: after the "retakes collapsed" block, when `scriptRetakes.length > 0 && scriptRetakesHonoured(opts.cleanup, valveFired)`: `\nretakes found with the script (FINDINGS §166):\n` + the formatted retakes joined by `\n` + `\n`. `valveFired` is computed at the first site; if the clip re-derivation rebuilds the cutlist, recompute it the same way there.

- [ ] **Step 1: Write failing tests.**
  - `script-mode.test.ts`: `scriptRetakeCues` returns the run's cues on a script run; parses the stored text on a pinned replay with `retakePass: 1`; `undefined` on a pinned replay without the field; `undefined` with no script and not pinned; `undefined` when not pinned even if a stored record has the field. `scriptRetakesHonoured("exact", false) === false`, `("standard", true) === false`, `("standard", false) === true`.
  - `production-script.test.ts`: the schema accepts `retakePass: 1`, accepts its absence, rejects `retakePass: 2`.
  - `script-produce.test.ts`: read the file first and follow its harness. Add one case: a transcript in which one script sentence is said twice back to back, run as a `--script` run with the mock provider and `--no-render` → `production.json`'s cutlist has a `retake` removal over the earlier take, `script.retakePass === 1`, and `report.txt` contains `retakes found with the script`. Add a second: the same workdir replayed with `--scenes` gives the same cutlist. If the harness cannot inject a transcript (`--transcript`), report that instead of building a new harness.
- [ ] **Step 2: Run** the three test files. Expected: FAIL on the new cases only.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three files, then `pnpm test`, then `pnpm typecheck`. Expected: all pass; no existing test edited.
- [ ] **Step 5: Commit** `feat: script runs cut the earlier take of a repeated script sentence`.

---

### Task 3: Recorded-transcript test and findings (main thread prepares the fixture)

**Files:**
- Create: `packages/core/test/fixtures/egm-retakes.json` (`{ words: [{text,start,end}], silences: [{start,end}], fillers: [...] }` from the 2026-11-18 re-transcription), `packages/core/test/fixtures/egm-patterns.script.md` (the cue script)
- Test: `packages/core/test/script-retakes-egm.test.ts`
- Modify: `docs/PHASE1-FINDINGS.md` (§166), `README.md` and `docs/site/index.html` only if they describe retake handling for script runs

- [ ] **Step 1: Write the test:** load the fixture, run `findBloopSpans(t, "blooper", silences)`, `findRetakeGroups(t, analysis, { transparentMarker: "blooper" })`, then `findScriptRetakes` with `scriptRetakeExcluded`. Assert the cut texts are exactly the takes the design lists for the cue script that §165's marker fix does not already remove, each beginning with `"The elephant in this case never forgets."` and `"So first off,"`; assert no other retake.
- [ ] **Step 2: Run it.** If the result differs from the design's "Measured" section, stop and report the difference; do not tune limits.
- [ ] **Step 3: Write FINDINGS §166:** what was built, the measured result, the limits and that they come from one recording.
- [ ] **Step 4: Run** `pnpm test`, then `pnpm typecheck`.
- [ ] **Step 5: Commit** `test: script retakes on the recorded EGM transcript; FINDINGS §166`.
