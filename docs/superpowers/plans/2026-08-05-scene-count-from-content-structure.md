# Scene count should follow the content's structure

> **For agentic workers:** This document is REQUIREMENTS, not a design — the diagnosis below is verified fact read out of the source and reproduced across three real renders; the approach is yours to settle. Read §115.2 before choosing one: the asymmetry described there is the whole difficulty, and the obvious fix (a deterministic floor mirroring the existing ceiling) does not work as stated.

**Status:** captured 2026-07-30 from a real demo-recording session. Not started. Findings numbering continues at **§115** (R23 ended at §114).

**Verified state at capture:** `normalizeBeatSheet` (`packages/core/src/producer/beats.ts`) enforces a graphics-coverage **ceiling** and, below a 45-second runtime, a **count floor**. Above 45 seconds there is no floor of any kind.

---

## 115. Above 45 seconds, nothing stops the producer under-planning

### The gap

`packages/core/src/producer/beats.ts` prices graphics against a coverage budget:

```ts
export const GRAPHICS_COVERAGE_TARGET = 0.45;
export const SHORT_TAKE_SEC = 45;
export const SHORT_TAKE_MIN_GRAPHICS = 4;
```

and then, in `normalizeBeatSheet`:

```ts
const minGraphics = runtime < SHORT_TAKE_SEC ? SHORT_TAKE_MIN_GRAPHICS : 0;
```

The loop underneath it only ever runs in one direction: while `shown > budget`, `demote()` the least costly graphic to `sceneKind: "none"`. There is no corresponding promote. So for any take longer than 45 seconds `minGraphics` is **0**, and the pipeline's entire lower bound on graphics is whatever the LLM happened to propose. The 45% figure reads like a target; it is only a ceiling.

That is fine when the model over-plans — §7/§8/§9 exist because it used to. It is invisible when the model under-plans, which is the case this finding is about.

### The evidence (three renders, same 64s source, 2026-07-30)

Source: a talking-head take enumerating five features explicitly — "Number one… number two… and number five". The intended beat count is not ambiguous; the speaker counts it out loud.

| run | editorial model | intent/speaker | scenes planned |
| --- | --- | --- | --- |
| baseline | `gemini-3.6-flash` (default) | none | **3** |
| + steer | `gemini-3.6-flash` | `--intent` + `--speaker` | **3** |
| + model | `gemini-3.1-pro-preview` | `--intent` + `--speaker` | **5** |

45% of 64 seconds is ~29 seconds of graphics. **No run came close to the ceiling**, so the demote loop never executed once — every one of these counts is raw LLM judgement, unchecked in the low direction. In the baseline, features 1, 2, 3 and 5 received no graphic at all; the run spent most of its 64 seconds as a talking head with captions.

Two things worth separating, because they suggest different fixes:

- **A strong `--intent` did not move the count** (3 → 3). It changed *which* components appeared and improved their copy, but the model still declined to illustrate most beats. Prompt-side steering alone is weak evidence for a prompt-side fix.
- **Changing the editorial model did** (3 → 5), which says the count is a model-judgement property today, and therefore varies per provider and per release. That is not a property a showcase — or a user's video — should rest on.

### 115.1 What "right" looks like

The author's framing, and it is the correct one: **if the content discusses five points, five scenes is the expected output.** Scene count should be a function of what the take is structured as, not of how generous a given model felt. The enumerated case is the easy one — the transcript literally contains "number one/two/three/four/five", a free deterministic structural signal nobody is reading — but the general requirement is that a beat the speaker treats as a distinct point is a candidate for its own graphic.

- [ ] **115a. A floor that applies above 45 seconds.** Whatever form it takes, a 64-second take with five enumerated points must not render three graphics. Derive the target from the content's structure where a structural signal exists, and fall back to runtime where it does not.
- [ ] **115b. Report the decision.** `report.txt` should say how many graphics were expected and how many survived, the same way the cut report justifies every cut. A count that silently under-delivers is exactly the failure this finding is about; it should not be able to happen quietly twice.

### 115.2 Why the obvious fix does not work — read before designing

Demote and promote are **not symmetric**, and this is the entire difficulty:

- `demote()` sets `sceneKind: "none"`. That is always valid — every moment can legally have no graphic.
- Promote would have to **choose a component and author its props** for a moment the model explicitly declined to illustrate. That is an editorial act, not a deterministic one. There is no correct component to pick from a word range without judgement, and picking badly is worse than picking nothing — §14's grounding warnings exist because invented copy reaches the frame.

So a deterministic floor mirroring the ceiling cannot be the whole answer. Approaches worth weighing (pick one, justify it):

1. **Prompt-side target.** Compute an expected count and state it in `PRODUCER_SYSTEM` / the beat prompt. Free, no extra call — but the evidence above shows a strong `--intent` already failed to move flash, so this may not hold.
2. **Validate and retry.** If surviving graphics fall under the floor, make one repair round-trip naming the *specific* uncovered moments and asking for those. Costs one call, only when needed, and keeps the editorial choice with the model where it belongs. Mirrors how §14's repair pass already works.
3. **Read the structural signal.** Detect explicit enumeration in the transcript and pass the count as a hard constraint. Deterministic and free where it applies, silent where it doesn't — likely a complement to 1 or 2 rather than a standalone fix.

### 115.3 The constraint this must not break

§114 made every graphic hold its **whole** moment, and repriced the coverage budget so a 12-second card costs 12 seconds rather than a clamped 5. A floor stacked naively on top of that will fight the ceiling: more graphics × full spans can exceed 45% coverage, at which point the demote loop starts removing what the floor just required, and the two rules oscillate.

The floor and the ceiling have to be reconciled deliberately — decide which wins and say so in the code, as §29 already did for short takes. Reproducing §29's precedence ("the count floor outranks the percentage") is the obvious candidate, but it needs to be a decision, not an accident.

### 115.4 Related observation, not yet its own finding

The 5-scene render showed a **caption collision at ~46s** — one caption group drew before the previous had cleared ("And number five" over "your rules."). The 3-scene renders of the identical source at the identical timestamp were clean. Single ~1-second window; 43–45s and 47–48s render correctly.

Unproven, but the plausible mechanism is the one the Phase 1 header already lists as open: the caption band is positioned from per-layout hand-tuned anchors rather than derived from live occupancy, so more scenes means more band repositioning and more chances for two groups to occupy one band across a handoff. If 115a lands and scene counts go up generally, this gets more likely, not less — worth reproducing deliberately once the floor exists.

Also confirmed live during the same session: the `startSec`/`endSec` debug mirror on `production.json` is still all zeroes, as the Phase 1 header says.
