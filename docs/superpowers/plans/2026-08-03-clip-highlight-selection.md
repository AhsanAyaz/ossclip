# `--clip` — highlight selection for long-form input

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes. This document is REQUIREMENTS, not a design — the diagnosis is verified fact; the approach is yours to settle. Read §93.1 before writing any code: the ordering constraint there is the entire risk in this feature, and getting it wrong produces captions that point at words which no longer exist.

**Status:** requirements captured 2026-08-03. This is **§89 option A**, deferred at launch in favour of option B (narrowing the README's promise). Ship it only against real long-form footage — the whole point is behaviour the 30–70s test takes cannot exercise.

**Standing constraints:** develop on `claude/video-virality-generator-brainstorm-oci5fj`; never push to another branch. No PRs unless asked. Commit trailers as usual. Do NOT include a model identifier in any repo artifact. Findings numbering continues at **§93** (R18 ended at §92).

**Verified state at capture:** no `--clip`, no target duration, no moment scoring anywhere in `apps/cli/src/index.ts` or `packages/core/src`. `BeatSheetSchema` (`packages/core/src/producer/beats.ts`) already returns a `hook` plus 1–12 `moments` carrying word ranges — the selection signal exists and is already paid for.

---

## 93. `--clip <seconds>` — produce only the best window

**The gap (already logged, Round 12 "Not defects, noted"):**

> "there is no highlight selection anywhere in the pipeline, and for long-form input that is a bigger gap than framing."

Feed a 20-minute podcast in and you get a polished 20-minute vertical video. Long-form → short-form selection is the defining feature of this category; without it ossclip is a polisher, which is what the README now says.

### 93.1 The ordering constraint — read this first

Selection MUST happen **after transcript + repair, and BEFORE analyze / cut / captions / scenes**.

Everything downstream of the transcript indexes into it. Caption cues anchor to word **indices**; scene timings anchor to transcript **ranges** (`docs/PHASE1.md` acceptance criterion 5); the cutlist works in source time and `timemap` guarantees `outputDuration === Σ kept`. Select later than this and those anchors point at words that are no longer in the document — the same class of bug §17 fixed for repairs, and it will not announce itself: it renders, silently, with the wrong words highlighted.

Slice the transcript to the chosen window, then let the existing pipeline run **unchanged**. If you find yourself editing `captions.ts` or `timemap.ts` to accommodate this feature, stop — that is the signal you have put selection in the wrong place.

- [ ] **93a. The flag.** `--clip <seconds>`, parsed as a positive number (reject `0`, negatives, and non-numeric with a clear message — do not silently coerce).
- [ ] **93b. Requires `--produce`.** The window is an editorial judgement. Without `--produce`, fail with a message that says so. Do NOT fall back to a heuristic (longest uninterrupted speech run, loudest segment, etc.) — a heuristic will pick a bad 60 seconds, and a bad 60 seconds looks like a bug rather than a limitation.
- [ ] **93c. Short sources are a no-op, not an error.** If the source is already at or under the target (plus tolerance), log that the take is shorter than the requested clip and produce the whole thing. Nobody should have to remember to drop the flag.
- [ ] **93d. Reuse the beat sheet — do not add a second editorial call.** Extend `BeatSheetSchema` with an OPTIONAL highlight window (word range + a one-line reason), requested only when `--clip` is set. The producer is already reading the whole transcript and already ranking moments; asking it for a window in the same call costs approximately nothing, and a second call would let the two disagree.
- [ ] **93e. Validate the window before trusting it.** The model returns word indices; treat them as untrusted input like every other LLM output in this repo. In range, start < end, at least ~50% of the target duration, clamped to the transcript's bounds, snapped to word boundaries. An invalid window is a hard failure with the reason printed — not a silent fallback to the full take, which would quietly produce a 20-minute "clip".
- [ ] **93f. The cache key MUST include the clip target and the resolved window.** `produce.ts` keys the scene/beat cache on a sha1 of the transcript wording plus measured framing (`apps/cli/src/produce.ts:407`). A clip run and a full-length run of the same source would otherwise collide, and one would silently answer from the other's plan. This is the §75/§78 failure mode: a cached artefact describing a different configuration than the one requested.
- [ ] **93g. Pin the resolved window into `command.json`, exactly as §75 pinned the provider.** The editor's Render replays the recorded argv. If replay re-asks the model and it selects even a slightly different window, every saved override in `overrides.json` — anchored to scene ids and word indices — lands on the wrong words. The replay must reproduce the SAME window without an LLM call. Record the resolved word range, not just `--clip 60`.
- [ ] **93h. Say what it chose and what it dropped.** A line on the console and in `report.txt`: the window in `m:ss–m:ss` of the source's total, and the model's one-line reason. A tool that silently discards 19 of 20 minutes owes the user an account of why those 19.

### Tests

Unit only — no e2e needed, and no LLM in the loop:

- Window selection against a fixture beat sheet: in range; clamped to the take; minimum length enforced; refuses an empty, inverted, or out-of-bounds window.
- Cache key differs for different `--clip` values on identical input, and is stable across runs for the same value.
- The existing `timemap` property tests (monotonicity, roundtrip identity on kept ranges, `outputDuration === Σ kept`) pass against a **sliced** transcript. If they need changing, §93.1 was violated.
- A replayed `command.json` from a clip run reproduces the identical window with zero LLM calls.

### Author decisions — resolve before building

- [ ] **Boundary snapping.** Recommended: snap the window to the nearest sentence boundary within ±20% of the target rather than cutting hard at exactly N seconds. A clip that starts mid-sentence reads as broken regardless of how good the selection was. Confirm the tolerance.
- [ ] **Multiple clips.** `--clip` produces ONE window in v1. If several are wanted later that is a different shape (N output files, N workdirs, N covers) and should be its own round — do not smuggle it in.

### What NOT to do

- No heuristic selection path (93b).
- No multi-clip (above).
- No editor work. The editor already renders whatever the workdir contains; a clipped production is just a shorter one.
- Do not re-run selection on replay (93g).
- Do not touch `PRODUCER_SYSTEM`'s existing editorial instructions beyond adding the window request — that prompt is tuned and works.

---

## Verification before reporting done

`pnpm typecheck` · `pnpm test` · the editor build · the full Playwright suite (unchanged behaviour on short takes is the regression surface).

Then the one that actually matters: **run it on a real 10+ minute source** and watch the output. Check that the captions under the clip are the words being spoken, that scene graphics land on the moments they describe, and that opening the workdir in `ossclip edit` shows a timeline of the clip, not of the source. Report the chosen window and whether it was a defensible choice — that judgement is the feature.
