# Cutting retakes with the script

*   **Author:** Muhammad Ahsan Ayaz (drafted with Claude)
*   **Status:** Draft 2 for the author (2026-11-19). Revised after three reviews (design, scope, code accuracy); the changes are listed at the end
*   **Builds on:** FINDINGS §122 (spoken marker), §128 and §135 (retake collapse), §158 (script cues), §165 (the survivors this design answers)

--------------------------------------------------------------------------------

## Overview

A script run knows what the speaker meant to say. Today that knowledge is used only to place scenes. This design also uses it to cut retakes: when one script sentence is spoken twice in a row, the earlier take is cut and the later one is kept.

It answers the two retakes in the EGM render that no existing rule can catch (§165):

*   "The elephant in this case never forgets. It always has the design and context in its memory." then "The elephant never forgets. It always holds the context…"
*   "So first off, I went into the terminal and typed EGM." then "So first of all I went into a terminal titled…"

Both are reworded, so the similarity detector (§128) scores them under its bar, and the speaker said no marker. Both are takes of a sentence that is in the script.

**How strong the evidence is.** One recording. On it the pass makes three cuts, two of them new, and no wrong cut. Every limit below was chosen on that recording.

## Terms

*   **Script project.** A project whose `production.json` holds a stored script: a `--script` run, or a `--scenes` replay of one (`isScriptProject`). A replay has no `--script` flag.
*   **Unit.** One sentence of a `🗣️` line that belongs to a cue, with 4 or more word tokens. Shorter sentences are not used. Lines under `screen:` cues count. `🗣️` lines above the first cue of a section are not read by the script parser today, so they are not units.
*   **Occurrence.** A stretch of transcript words that says a unit, scored as cue alignment scores: unit tokens found in order, divided by the unit's token count.
*   **Content token.** A token of 4 or more letters.

## Goals

*   **G1.** In a script project, when a unit is spoken twice in a row, the earlier take is cut.
*   **G2.** The cut runs from the earlier take to the later one, so a short unscripted tail of the earlier take goes with it ("It always has the design and context in its memory.").
*   **G3.** No words that were said only once and belong to another unit are cut.
*   **G4.** Every cut is reported with the words kept and the words cut.
*   **G5.** The result is a pure function of the raw transcript, the analysis and the script text. No LLM.
*   **G6.** A replay builds the same cutlist as the run that planned its scenes. Projects planned before this feature keep their cutlist.
*   **G7.** Projects without a script are unchanged.

## Non-goals

*   **NG1.** Retakes of a sentence that is not a unit.
*   **NG2.** Choosing the better take. The later take is kept, the convention of §128.
*   **NG3.** Changing the similarity detector, its hallucination guard, or the short-keep fold (§165).
*   **NG4.** Retakes with other spoken material between them (more than 25 words). The marker is the tool for those.

## Approaches

**A. Lower the similarity bar of the existing detector.** The elephant pair scores 0.57 against a bar of 0.8. A bar that low matches parallel sentences that are not retakes; §128 records that failure.

**B. Lower that bar only when both sentences match the same unit.** It would reuse the detector's guards and report. It fails on shape: the detector compares sentences as whisper punctuated them, split again at pauses, and the takes of a unit do not line up with those pieces (the first "So first off" take is half a sentence). It would also put script logic inside a function whose rules carry an audit history (§128, §135).

**C. Ask an LLM which takes to drop.** It handles rewording and lines outside the script. It ends the guarantee that the same input gives the same cut, and a replay could cut differently from the run the author reviewed.

**D. Use the script as the reference, in a separate pure pass (chosen).** Two stretches that both say the same script sentence are takes of it, however they differ from each other.

## Design

### 1. Where it runs

*   In `produce`, after the marker spans and the similarity groups are found, on the **raw** transcript like both of them, and before `buildCutlist`. Its cuts are added to `buildCutlist`'s `retakes` argument with confidence 0.8.
*   The same function is called at the second place those detectors run (the clip-window re-derivation), on the sliced transcript.
*   It runs for a `--script` run, and for a `--scenes` replay whose stored script record says the pass ran when its scenes were planned (a new field on the stored record). A project planned before this feature has no such field, so its replays cut as before (G6).
*   It runs with or without `--blooper-marker`. The rule "no inferred retakes without the marker" exists because those cuts had no evidence from the author; here the script is the evidence. Decision 1.
*   The module is pure, in core beside `script/align.ts`. It reuses that file's token and in-order-match helpers (exported for it), `isSentenceStart`, and the silence-fraction helper of `retake.ts` (exported).

### 2. Units

*   From the cues' `spoken` lines, split at sentence punctuation, in script order.
*   **Twins are skipped.** If a unit scores 0.6 or more against another unit, in either direction, neither is used. "One flag for the theme." and "One flag for the AI." are each said once on purpose.

### 3. Occurrences

*   **Candidate words** are words not cut by a marker span and not a member of any similarity group, whatever that group decided. What §128 declined to cut stays declined.
*   A candidate window starts and ends on a matched word and holds at most 2 words per unit token.
*   It needs a score of 0.6 or more, 4 or more matched tokens, and 2 or more matched content tokens. The last rule stops a match made of "so", "the", "I", "was".
*   **Overlaps.** Windows of one unit are taken in this order: most matched tokens per window word, then higher score, then earlier start. A window that overlaps one already taken is dropped. Without the first key, one window spanning two adjacent takes outscores both and hides the retake; the prototype showed this.
*   An occurrence whose span is 65% or more silence is dropped (`HALLUCINATION_SILENCE_FRAC`, the existing measure): a line whisper repeated over dead air must not become the kept take.

### 4. When two occurrences are takes

For consecutive occurrences A then B of one unit, all must hold:

*   B scores 0.7 or more, and at least as high as A. A restart that trails off never replaces a fuller take.
*   At most 25 candidate words lie between A's last word and B's first word.
*   No occurrence of a different unit lies between them, unless that unit occurs again at or after B (G3).

With three takes in a row, each consecutive pair is tested, so the first two are cut.

### 5. What is cut

*   From A's first matched word to the word before B's first matched word.
*   Each end moves back to its sentence start when that start is at most 3 words earlier. So "Now, the elephant…" is cut from "Now", and a B that begins "And the elephant…" keeps its "And".
*   Nothing else. The cut never reaches before A or past B's start.

### 6. Report

After "retakes collapsed", when the cutlist honoured the cuts (not with `--cleanup exact`, the same gate the other retake lines use):

```
retakes found with the script:
kept: "The elephant never forgets."
  cut (said again 10 words later; script: "The elephant never forgets."): "The elephant in this case never forgets. It always has the design and context in its memory."
```

### 7. Effects elsewhere

*   **Scene planning.** A `--script` run aligns cues on the effective cut, which now includes these cuts, so no scene is planned on a cut take. The script plan cache is keyed on the kept words, so the first run with this feature plans again (one LLM call).
*   **Restoring a cut.** `buildCutlist` merges touching removals. A veto in the editor restores the merged removal as one block, and switching the `retake` reason off restores these cuts with the marker and similarity cuts. That is how retake cuts behave today.
*   **Short words.** More retake cuts give the short-keep fold (§165) more places to drop a short word beside a cut. Not addressed here.

## Measured on the EGM recording

A prototype of sections 2 and 3 (without the similarity-group exclusion and the silence rule) ran on the kept words of the recording.

| Script | Units | Units with two occurrences | Pass section 4 | Wrong cuts |
|---|---|---|---|---|
| Cue lines only (22 cues) | 31 | 6 | 3 | 0 |
| Full script | 62 | 5 | 3 | 0 |

*   Cue script, cut: the elephant pair (1.00, 1.00; 10 words between), "So first off" (0.67, 0.75; adjacent), "Number two…" (0.67, 0.75; about 13 words between). The last is also fixed by §165.
*   Full script, cut: the elephant pair, "Number two…", "Before touching the real code." (0.80, 1.00; adjacent, also fixed by §165). The full script has no "So first of all" sentence.
*   Stopped: the two "One flag for…" units (twins, and one content token); "ossclip is open source and free." (0.67 for B, and minutes apart).
*   Two kept takes sit at 0.75 against a bar of 0.7. The margin is small.

## Verification

*   **Unit tests:** unit splitting; twins in both directions; the overlap order, with two adjacent takes; each limit pinned on both sides (0.6, 4 tokens, 2 content tokens, 0.7, B at least A, 25 words, 65% silence); a different unit between takes, said again and not said again; both 3-word boundary moves; three takes; marker-cut words and similarity-group members are not candidates.
*   **Recorded-transcript test:** the EGM transcript and analysis as a fixture, with the cue script. Expected cuts: the three above, no other.
*   **Unchanged output:** no script, same cutlist (existing tests). A script project with no repeated unit, same cutlist. A stored script record without the new field, same cutlist on replay.
*   **Replay:** a `--scenes` replay of a project planned with the pass builds the same cutlist as its first run.
*   **Real run:** a fresh EGM `--script` run; the author checks the two stretches.

## Risks

*   **A line repeated on purpose, back to back.** If the script repeats it, the twin rule skips it. If the speaker ad-libs it, the first is cut and the report shows it.
*   **Limits fitted to one recording.** A second recording may need other numbers. The recorded-transcript test keeps the first one working.
*   **The earlier take was the better one.** Keep-later is a convention; the editor restores the cut but cannot swap takes.

## Decisions for the author

1.  **On in every script run, also without `--blooper-marker`**, with no flag. Turning the `retake` reason off in the editor is the way out.
2.  **Build now, or wait for a second recording.** The pass is small (one pure module, two call sites, one report section), but it is proven on one video and gains two cuts there. Recommended: build, because the recorded-transcript test makes a later retune cheap.
3.  **A cue-only script may cut up to 25 unscripted words between two takes** (G2). The other choice is to cut only the earlier take's own sentence, which leaves "It always has the design and context in its memory." in the video.

## What the reviews changed

*   The cut no longer swallows everything up to 45 s before the later take. Takes must be at most 25 words apart with no once-said unit between them, and the cut is A to B only.
*   Sentence boundaries move at most 3 words; the first draft could walk back through an unpunctuated run.
*   The kept take must score at least as high as the earlier one.
*   A match needs two content tokens.
*   The overlap order changed after the prototype showed a window spanning two takes hiding the pair; the "So first off" pair is now measured, not expected.
*   Words in any similarity group are not candidates, and the dead-air rule is the existing 65% measure, not a new one.
*   Replays of projects planned before this feature are excluded; the first draft would have added cuts under pinned scenes.
*   The raw transcript, the second call site, the plan cache re-key, the `--cleanup exact` gate and the merged-restore behaviour are stated.
*   The report quotes the unit; script line numbers for spoken lines do not exist.
*   Sentence joining and "not cut" report lines are dropped. Approach B is recorded with the reason it fails.
