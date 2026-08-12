# Phase 1 — findings from the first real produced render

> **Status 2026-07-26: all six sections fixed** (see the commit that touches this line; 70 tests green, golden fixture re-rendered and frame-verified).
> §1 FlowDiagram: fit-to-width single row (font scales 26–44px with content), arrow+chip are one flex item, arrows enter *after* their chip. §2 captions never hidden — every layout reserves a caption band. §3 `MAX_SCENE_SEC = 5` in assembly. §4 StatCard/RuleCard default to `video-top`, prompt states the face-large policy, and `normalizeBeatSheet` deterministically demotes graphics beyond floor(N/2) (sparing hook + payoff). §5 TitleCard skips a title contained in `emphasis`, and the schema `.describe()`s steer the LLM. §6 `SAFE_AREA`/`SAFE_RECT` in `stage.ts`; all graphic slots + caption bands clamped inside and property-tested against overlap; caption lines split at scene boundaries with holds clamped, so a line can never carry one layout's anchor into another (the collision seen on the StatCard).
> Deferred, still open: the `--safe-area <preset>` CLI flag (the constant is single-source but not yet configurable per render), and deriving the caption band from live occupancy rather than per-layout hand-tuned anchors (the anchors satisfy the §6b property tests; full derivation can come with editable layers in Phase 2). The `startSec`/`endSec` debug mirror on `production.json` also remains open.

*First end-to-end `--produce --llm claude-cli` run on real footage (68 s portrait take, macOS, whisper `base.en`). The pipeline works: 7 scenes planned from 9 moments, all 5 layouts exercised, audio continuous across every transition, real numbers lifted from the take. These are the defects that run exposed, worst first, plus one new requirement (§6).*

The comparison frames (and the design notes they informed, `BRAINSTORM.md`) were working materials local to the author's machine and are not distributed with this repo. The produced frames referenced below came from `ffmpeg -ss <t>` on the render.

## 1. `FlowDiagram` breaks its own layout

At `fontSize: 44` with `flexWrap: "wrap"` (`packages/scenes/src/components/FlowDiagram.tsx:49`) three chips plus arrows overflow 1080 px: "1 AGENT → 1 LANE →" fills row one and "1 DOD" wraps to row two, leaving a **dangling arrow pointing at nothing**. The diagram also occupied the frame alone for 10.8 s with the speaker gone entirely.

Fix: no wrapping. Fit-to-width (scale the font/gap down until the row fits, floor ~28 px), or switch to a vertical stack with downward arrows past 3 nodes. Arrows must be rendered *between* nodes, never trailing.

## 2. Captions are hidden for ~85% of the video

`pip-bubble`, `graphic-only` and `blurred-behind` all set `captionAnchor: null` (`packages/scenes/src/stage.ts:58,64,70`). Every scene the producer picked used one of those three, so captions were visible for only ~10 s of 68 s.

That contradicts BRAINSTORM §4.5 ("muted-viewing complete — captions always"), which is the entire reason captions exist for this format. **Captions must never be hidden.** Every layout needs a real caption slot; see §6 for where they may live.

## 3. Scenes sit on screen far too long

Measured cue durations: TitleCard 10.1 s, FlowDiagram 10.8 s, ChatMock 9.3 s, TerminalMock 8.2 s. `assemble.ts:7` enforces `MIN_SCENE_SEC` but there is **no maximum**, so a scene occupies its entire moment. BRAINSTORM §4.5 asks for a pattern interrupt every 3–6 s; a static card held for 10 s is the opposite of that.

Fix: a `MAX_SCENE_SEC` (~5–6 s) in assembly. A graphic punches in, makes its point, and hands the frame back to the speaker for the rest of the moment — the graphic does not have to span the moment that motivated it. Scene coverage across the video should land near 50%, not 85%.

## 4. `video-top` never gets chosen

The producer picked `pip-bubble` ×3, `graphic-only` ×2, `blurred-behind` ×2 — and `video-top` zero times. `video-top` (face large on top, card beneath) is the reference's signature frame; without it the speaker is a small circle or absent for most of the video, surrounded by dead black.

Fix in two places: state a layout-mix policy in the beat-sheet prompt (`packages/core/src/producer/beats.ts` — default to `video-top`, reserve `graphic-only` for moments where the graphic genuinely is the point), and enforce a cap post-hoc so no single layout dominates. The speaker's face is the product; keep it big.

## 5. `TitleCard` prints the same string twice

The producer emitted `title: "861%"` and `emphasis: "861%"`; `TitleCard.tsx:40-55` renders both unconditionally, so "861%" appeared huge and then again small directly beneath it.

Fix: skip `title` when it equals (or is contained in) `emphasis`, and make the schema/prompt state that `emphasis` is the *number pulled out of* the title, not a duplicate of it.

## 6. NEW REQUIREMENT — platform safe areas, and captions must not collide

Two related constraints, neither currently modelled anywhere:

**a) Platform chrome.** Reels/TikTok/Shorts overlay their own UI on the video: a top strip (status/search/tabs), a bottom band (username, caption, audio ticker), and a right-hand action rail (like/comment/share/profile). Anything ossclip draws in those regions is covered by the app. Conservative union to adopt as the default safe area, as fractions of the 1080×1920 frame:

| Edge | Inset | What sits there |
|---|---|---|
| top | 0.12 | status bar, "Following / For You" tabs |
| bottom | 0.22 | username, caption, audio ticker, progress bar |
| right | 0.16 | like / comment / share / profile rail |
| left | 0.04 | breathing room only |

Make it a named constant (e.g. `SAFE_AREA` in `stage.ts`) with a `--safe-area <preset>` escape hatch (`reels` | `tiktok` | `youtube-shorts` | `none`) — someone exporting for a landing page wants the full frame. **Every** caption line and every graphic slot must be clamped inside it; the video slot itself may still bleed full-frame (it is fine for the face to sit under the chrome, it is not fine for text to).

**b) Captions must use free space, never overlap.** Today the caption anchor is a single hardcoded fraction per layout, so it can land on the face or on a card. The caption slot should be *derived* from the frame's current occupancy: given the active layout's video and graphic rects intersected with the safe area, place captions in the largest remaining free band, and only then fall back to the default lower-third position.

- `full-bleed` → below the face, above the bottom inset.
- `video-top` → in the gap between the video block and the graphic, or under the graphic if that band is taller.
- `pip-bubble` → between the graphic and the bubble.
- `graphic-only` → in whatever band the graphic does not use (this layout should reserve one).
- `blurred-behind` → the graphic is centred, so captions go below it, inside the bottom inset.

Because the video slot eases between layouts over `LAYOUT_TRANSITION_SEC`, the caption slot should be resolved per line from the *settled* layout at that line's start (as it is today), not animated — a caption sliding mid-word reads as a bug.

Worth property-testing: for every layout, the resolved caption rect intersects neither the graphic rect nor the safe-area insets.

---

# Round 2 — after the fixes (fresh plan, real footage, 2026-07-27)

> **Status 2026-07-26: §7–§11 fixed** (71 tests green, typecheck clean, golden fixture re-rendered and frame-verified).
> §7+§8 the floor(N/2) count cap is gone — `normalizeBeatSheet` now schedules against a single **coverage budget** (`GRAPHICS_COVERAGE_TARGET = 0.45` × runtime, with each survivor costed at `min(momentDuration, MAX_SCENE_SEC)` — the same 5 s constant assembly clamps with, now exported from `assemble.ts`, so the two limits can no longer stack). When over budget it demotes the candidate whose removal opens the *smallest* gap between its surviving neighbours, so survivors stay spread across the timeline instead of the middle hollowing out; hook and payoff are always spared. §9 same-kind adjacency makes a candidate maximally demotable during budgeting, and a separate variety pass demotes the later of any adjacent same-kind pair even within budget (the earlier if the later is the payoff; never the hook). The prompt states the coverage (40–50%, no >~10 s gap) and variety (never the same component twice in a row) policies instead of the old hard cap. Both behaviours are unit-tested (`producer.test.ts`).
> §10 FlowDiagram and TerminalMock both run in the golden fixture (`fixtures/scenes.json`) and frame-verify: FlowDiagram renders one fitted row with arrows *between* chips and none dangling; TerminalMock renders both windows inside the safe area with the caption in its free band — §1 can be called closed.
> §11 the video slot now carries an `objectPosY` crop bias (0 = top of source): `video-top` 0.12, pip/graphic-only bubble 0.22, full-bleed/blurred-behind 0.5, lerped through layout transitions and applied via `object-position` on the EDL video, so a short band shows the speaker's head, not their torso. Needs one confirming look on real footage (the fixture is a synthetic pattern), but the top-of-source bias is visible in the fixture render.

*Same 68 s take, cache cleared so the new prompt and the deterministic demotion actually ran. All six items above verify as fixed on the render: captions visible on `video-top`, `blurred-behind` and full-bleed; every cue capped at 5.0 s; both StatCards on `video-top` with the face large; "861%" printed once; nothing textual below ~78% or in the right rail; no caption/graphic collisions in any sampled frame. The demotion logged itself honestly (`⚠ moment 6: demoted RuleCard to "none" (graphics cap 4)`).*

**The tuning overcorrected.** Graphic coverage went 85% → **28%**.

Planned cues:

```
 0.2– 5.2s  StatCard            video-top
10.3–15.3s  StatCard            video-top
21.8–26.8s  StrikethroughReveal blurred-behind
63.4–67.6s  ChatMock            blurred-behind
        19.2s of 67.8s = 28% coverage
```

## 7. Two caps stack multiplicatively

`normalizeBeatSheet` demotes to `floor(N/2)` graphics (`beats.ts:98`) **and** `MAX_SCENE_SEC = 5` clamps each survivor (`assemble.ts:14`). Together, 9 moments → 4 scenes → 19 s of graphics. Each limit is individually reasonable; multiplied they gut the video.

Fix: make the cap target **coverage**, not moment count — aim for graphics on screen ~40–50% of runtime, and let the number of scenes fall out of that. With a 5 s cap and a 68 s take that is ~6–7 scenes, not 4.

## 8. A 36-second graphic drought

Between 26.8 s and 63.4 s nothing but talking head — more than half the video, failing the same "pattern interrupt every 3–6 s" rule (BRAINSTORM §4.5) that §3 set out to fix. The demotion drops *whichever moments come last in the overshoot list* (`beats.ts:100-105`), and here that removed moments 4 and 6 — exactly the middle.

Fix: when demoting, keep the survivors **spread across the timeline**. Sort candidates by position and drop so the remaining graphics stay roughly evenly spaced (or explicitly protect the largest gap), instead of dropping by list order. The existing carve-outs for hook and payoff are right; the middle needs the same care.

## 9. Same component twice in a row

`StatCard` at 0.2 s and again at 10.3 s — the opening 15 s shows the same card treatment twice. Variety is part of the pattern interrupt; a repeat reads as a template.

Fix: penalise consecutive identical `sceneKind` in the beat-sheet prompt, and/or de-duplicate deterministically in `normalizeBeatSheet` (demote or swap the second of an adjacent pair).

## 10. Coverage gap: `FlowDiagram` and `TerminalMock` never ran on real content

The two components that produced the worst (§1) and best frames last round were not exercised at all in this plan, so §1's fix is verified only against the golden fixture. Worth forcing one real run — e.g. a hand-authored `--scenes` file over this take using both — before calling §1 closed.

## 11. `video-top` crops the top of the head

`stage.ts:83` gives the video slot `h: 0.42` of the frame. Fed an already-portrait 1440×2560 source, that band is a horizontal slice through the middle of a 9:16 image, and the speaker's head is cut off at the top of frame (visible in the render at t≈3 s).

Fix: the video slot needs a crop bias, not just a rect — bias the source crop upward (or fit-height with a blurred backdrop) so a face lands inside the band. This is the small, non-face-tracking version of BRAINSTORM §4.3's reframing note; full face detection stays Phase 4.

---

# Round 3 — after the tuning fixes (fresh plan, real footage, 2026-07-27)

> **Status 2026-07-27: §12–§16 addressed** (94 tests green, typecheck clean, golden fixture re-rendered and frame-verified).
> §12 `flowLayout()` is a pure exported function: fit-to-width for a row, and when the row can't fit at the 26px floor the diagram becomes a **vertical stack with downward arrows** — wrapping is impossible (`nowrap` in both modes). The width model was also a real culprit and got fixed: 0.62em/char underestimated uppercase 900-weight (+letter-spacing), which is exactly why v3 wrapped at a size the math said fits; it is now a conservative 0.78em/char. The golden fixture's FlowDiagram uses 4×~15-char labels (renders as a stack) and a unit test pins the v3 copy ("1 AGENT / 1 DIR / 1 DONE BAR") to a fitting single row.
> §13 implemented the measured version, not the constant: `measureFace()` in core samples 9 frames via ffmpeg (raw grayscale), runs the **pico** face detector (~150-line MIT-licensed pure-JS runtime ported from picojs; pretrained cascade vendored in `packages/core/assets/facefinder`, also MIT), takes the median box across frames (≥3 detections required), and caches `face.json` in the workdir. The stage derives every slot's `objectPosY` from the face box so the face center sits ~42% down the band — chin in, headroom above — lerped through transitions; the fallback when no face is found is an assumed selfie framing (center 38% down). The port was verified against the original pico.js on a real photo: identical box, 5/5 frames. One unit note: "bias 0.05–0.08" below is in "amount above center" terms; in CSS `object-position` terms that is ≈0.30–0.35, which is what the face derivation produces for a face ~40% down the source — a raw `objectPosY` of 0.06 would have pushed the crop *further* from the mouth.
> §14 the props prompt now has hard GROUNDING rules (labels reuse the slice's nouns; number alone or the suggested copy when no noun exists; unfamiliar proper nouns treated as probable mishearings, never promoted to names) and the beat-sheet prompt carries the ASR warning too. `checkGrounding()` post-checks label-ish props (Stat/Title/Rule/Flow/Strike/Screenshot fields — chat/terminal copy is stylized by design) and flags tokens the take never says, printed at produce time and appended to `report.txt`. Whisper default is now `small.en` (README documents the model choice + download). Still open from §14: a transcript-repair pass that corrects the caption text itself.
> §15 `buildZoomPlan()` derives phrase boundaries from caption-word gaps ≥250 ms (merged under 1.6 s, subdivided over 4.5 s so long stretches still breathe, metronome fallback with no captions) and alternates 1.00↔1.08 with cosine easing — continuous by construction, unit-tested for range/continuity/coverage. `VideoStage` applies it damped by the slot state itself — `opacity × (1 − 0.6·cornerRadius)` — so it fades out exactly as `graphic-only` fades the bubble and stays gentle on the pip, continuously through transitions. It multiplies with the cut-driven punch-in rather than fighting it.
> §16 `ChatMockProps.keyword` marks the CTA word (schema-described so the producer sets it plainly); the component quote-and-caps it in messages (absorbing quotes the LLM already wrote), and the caption track does the same when the spoken word matches — `ctaKeyword` flows through render props. The fixture chat exercises it (`"UMS"`).

*Same 68 s take, cache cleared. The scheduling work landed:*

```
 0.2– 5.2s  StatCard            video-top
12.8–17.8s  TitleCard           pip-bubble
21.8–26.8s  StrikethroughReveal blurred-behind
39.1–44.1s  FlowDiagram         graphic-only
50.0–55.0s  RuleCard            video-top
63.4–67.6s  ChatMock            blurred-behind
        29.2s / 67.8s = 43% coverage · longest gap 12.4s · 0 adjacent repeats
```

| | v2 | v3 |
|---|---|---|
| Coverage | 28% | **43%** |
| Scenes | 4 | **6** |
| Longest drought | 36 s | **12.4 s** |
| Adjacent repeats | 1 | **0** |
| Distinct components | 3 | **6** |

§7–§9 are closed. `RuleCard` on `video-top` now reads like the reference. What follows is what the real footage still exposes, plus two additions to the reel grammar.

## 12. §1 is only half fixed — `FlowDiagram` still wraps on real copy

Rendered at t≈41 s: "1 AGENT → 1 DIR" on row one, "→ 1 DONE BAR" on row two. The arrow+chip grouping **did** work (no dangling arrow any more), but fit-to-width did not — the font hits its floor before the row fits, and it wraps anyway.

The golden fixture passed because its chip labels are short. Real LLM copy is longer, so **the fixture is not a hard enough test** — §10's "call §1 closed" was premature. Add a fixture case with deliberately long labels (3–4 nodes × ~12 chars), and when the row cannot fit even at the font floor, switch to the vertical stack with downward arrows rather than wrapping.

## 13. `video-top` crop bias overshot — the face is now cut at the chin

Was cutting the top of the head at bias 0; at `objectPosY = 0.12` it cuts the **mouth and chin** — the band shows forehead-to-nose (see the user-supplied frame at t≈52 s: eyes and glasses fill the block, the mouth is gone). Chopping the top of the head is bad; chopping the mouth on a talking-head video is worse, because the mouth is what makes it read as speech.

A constant cannot solve this — it trades one crop for the other depending on how the person framed themselves. **The system has to know where the face is.** Options in increasing order of effort:

1. Sample N frames, run a face detector (MediaPipe / OpenCV Haar via a small sidecar, or `ffmpeg`'s `facedetect` where available), take the median face box, and derive `objectPosY` so the box's **center sits ~40% down the video slot** — chin included, headroom above.
2. Fall back to the current constant when no face is found, and log which path ran.
3. Cache the measured face box in the workdir alongside the transcript — it is a property of the source, not of a render.

This is the "v0 shortcut" version of BRAINSTORM §4.3's reframing note: one static crop offset per source, measured rather than guessed. Full per-frame tracking stays Phase 4. Until it exists, bias ~0.05–0.08 is a less-bad constant than 0.12 for this framing.

## 14. Copy is not grounded in the transcript — and it inherits ASR errors

The hook StatCard rendered **"CODECHUN REVENUE · 861%"**. Two separate faults:

**a) Invented label.** The take says 861% is what happened to **code churn** when teams went all-in on agents. It is not a revenue figure. The scene-props call invented a noun the transcript slice does not contain, and it landed on the hook — the first thing a viewer reads. (v1 got this right with "AI AGENT ADOPTION".) `FlowDiagram`'s "1 DONE BAR" is the same weakness, lower stakes (probably a mangling of "1 DoD").

Fix: constrain the props prompt — **every label must reuse nouns present in the transcript slice**; if no supporting noun exists, use the number alone or fall back to the moment's `onScreenCopy`. Worth a cheap post-check: label tokens that are not in the slice (minus a stopword list) get flagged in the report, so bad grounding is visible without watching the video.

**b) ASR error propagated.** "code churn" was transcribed as "CodeChun" by whisper `base.en` — the speaker's accent, not a pipeline bug. But that error then appeared in the captions **and** was treated by the producer as a company name. Two mitigations, independent:

- Default to a larger model (`small.en` is a big accuracy step for accented English at modest cost) and make `--model` prominent in the README.
- Give the producer a transcript-repair pass, or at minimum tell it in the system prompt that the transcript is ASR output that may contain mishearings, and that an unfamiliar proper noun is more likely a mistranscription of a common phrase than a real entity. It should prefer the common-sense reading ("code churn") over inventing a brand.

Caption text should be corrected too, since a wrong word on screen is worse than a wrong word in audio — the viewer can hear what was actually said.

## 15. NEW — micro zoom punches inside a take (pattern interrupt without cuts)

`EdlVideo`'s punch-in only toggles **at cuts** (`punchThresholdSec`, removed gap ≥ 150 ms). This take has **zero cuts**, so the punch system never fires and the talking-head stretches are visually static for 8–12 s at a time.

Add an independent driver: a slow, subtle zoom that changes direction at speech-phrase boundaries — roughly every half-sentence.

- Scale range ~1.00 ↔ 1.08, eased (never linear), transition ~0.4–0.6 s.
- Trigger points from data we already have: caption line boundaries, or inter-word gaps above ~250 ms — a natural phrase break. Alternate in/out so it breathes rather than creeping one way.
- Suppress while a graphic owns the frame in `graphic-only`, and keep it gentle on `pip-bubble` (a zooming bubble reads as a wobble).
- Must compose with the existing cut-driven punch-in rather than fight it: one scale value per frame, whichever driver is active.

Rationale: it is the cheapest pattern interrupt there is, it costs no LLM call, and it is what makes a single-take clip feel edited.

## 16. NEW — the CTA keyword needs quote-and-caps treatment

The reference frames render the comment keyword as a chat bubble reading `"agents"` — quoted, visually isolated. Ours renders whatever the producer wrote, unstyled.

Rule: whenever a scene carries the comment/CTA keyword (`ChatMock` messages today, and any future CTA card), wrap it in **double quotes** and **capitalize** it — `"AGENTS"`. Two parts:

- The producer should mark which token is the CTA keyword (a `keyword` field on the relevant props, not a guess at render time).
- The component applies the treatment, so styling stays in the library and the LLM never writes formatting.

Also applies to the caption track when the speaker says the keyword in the payoff line — quoting it there reinforces the ask for muted viewers.

---

# Round 4 — after §12–§16 (clean run: `small.en` re-transcribe, face measured, fresh plan, 2026-07-27)

> **Status 2026-07-27: §17–§21 addressed** (152 tests green, typecheck clean, offline `--llm mock` run and golden fixture both re-verified).
> **§17 + §21 are one fix: repair the transcript once, up front.** A new pass (`packages/core/src/producer/repair.ts`) asks the provider for a sparse diff of mishearings, and one repaired transcript then feeds captions, the producer *and* the grounding check — so the check can no longer call a correct repair an invention, and a graphic can no longer disagree with the caption beneath it. The pass is strict, as agreed: a proposal is applied only if it quotes the span correctly, spans ≤4 words, changes word count by ≤1, keeps length within 2×, and **sounds like** what it replaces (`phonetics.ts` — a consonant skeleton plus an onset test; the onset is what separates a repair from a rewrite, since resegmentation drags a genuine "coach and"→"code churn" down to ~0.4 similarity, right where an unrelated noun sits). Everything refused is logged with its reason. Word timings are treated as measurements: an unchanged token count keeps the ASR's own boundaries, and only a count change splits a span. `reconcileCopy()` then catches the residue §21 reported — a label word that sounds like, but isn't spelled like, a word spoken under it corrects the caption — with guards against rewriting inflections ("SHIP" for "shipped") or words the speaker genuinely says elsewhere.
> Placement is deliberate: **after** the cutlist, so the edit is identical whether or not an LLM ran, and `production.json` keeps the **raw** transcript (which `analysis` and `cutlist` index into) plus the repairs as a diff, so what was rendered stays reproducible without a second, unindexed truth.
> No phonetic tolerance was added to `checkGrounding`, and that is deliberate. It was built, and it absolved the real hallucination: "CODECHUN REVENUE" reads as a repair of "code churn". Two mitigations pulling against each other is what produced §17 — so grounding stays exact-match and repair is the single fix. Consequence worth knowing: `--no-repair` brings §17's false positives back.
> **§18** the root cause was the diagnosis being right and the remedy being aimed at the wrong signal. `analysis.silences` cannot carry phrase breaks — `silencedetect` runs with a 0.35 s floor while real breaths are 120–300 ms — so driving off it would have logged `acoustic` while still pacing uniformly. `analyze()` now derives **`breaths`** from the 100 ms RMS series already measured for threshold derivation (runs ≥120 ms below speech − 10 dB): 8 breaths vs 4 silences on the 18 s fixture, and no extra ffmpeg pass. Reversals land at each pause's **midpoint**, where the eased curve is momentarily still; caption line starts subdivide anything longer than `maxPhraseSec`; the metronome remains only as a **reported** fallback (`▸ zoom: acoustic (N phrase boundaries)`). Tests use contiguous stamps — the fixture's synthetic transcript has real gaps, which is exactly why this looked fine there.
> **§19** `objectPosYFor` now models the **head**, not the detector's box: expanded 0.35× upward, then placed by a feasible interval (crown below the band top, chin above its bottom) instead of one tuned anchor. Margins are derived from `ZOOM_MAX_SCALE`, because the §15 zoom eats 3.0% off the top and 4.4% off the bottom at its peak and would otherwise silently undo this fix while the geometry tests passed. Honest limitation: on `video-top` (0.42 of frame height) a typical selfie head does **not** fit, so the interval is usually empty and the rule reduces to *keep the chin, lose some crown* — the right trade per §13, but the crop is a choice, not a solution. Property-tested across centres 0.25–0.55 and sizes 0.15–0.40.
> **§20** repeats now vary **layout**, not component (a component swap is an editorial call a lookup table shouldn't make). `SCENE_REGISTRY` gains `altLayouts`, property-tested never to move a component into a *shorter* graphic slot — components size their type against their default slot, so a smaller one would re-open §1/§12. Three components already sit in the tallest slot and therefore have no alternate. `--force-component <Id>` exercises a component the producer never picks, applied after normalization so the coverage/variety passes can't demote it to nothing, and folded into the scene cache key.
> Also: `--whisper-model` for A/B'ing `base.en` vs `small.en` vs `medium.en` on one clip (§17 asked for this; the default stays `small.en`), and the scene cache key now hashes the transcript **text** rather than its word count — a repair leaves the count identical and would otherwise silently reuse a stale plan.
> Still open from §14b: nothing repairs a mishearing the model doesn't propose. And §19's crop plus §17/§21's repairs need a real take and a real provider to confirm — the fixture can only exercise the no-face and no-repair paths.

*Whole workdir deleted first, so nothing was cached: new model, new face measurement, new plan.*

```
 0.2– 5.2s  StatCard            video-top
21.7–26.7s  StrikethroughReveal blurred-behind   << 16.5s gap
34.2–39.1s  RuleCard            video-top
44.4–49.4s  TerminalMock        graphic-only
50.1–55.1s  RuleCard            video-top
63.1–67.6s  ChatMock            blurred-behind
        43% coverage · face 9/9 frames, center 37.7% down · zoomPlan 16 segments
```

**Confirmed working:** §16 renders `"AGENTS"` quoted and capitalized. §15 is visibly live — frames at 10 s and 16 s are clearly different framings, so talking-head stretches breathe. §13's detector ran (9/9 frames) and put the mouth back in shot, which was the serious half of the regression. Grounding warnings surface in both the log and `report.txt`.

## 17. The grounding check now punishes the model for repairing ASR — §14a and §14b are in conflict

`small.en` transcribed "code churn" as **"coach and"** — *further from the truth than `base.en`'s "CodeChun"*. The producer nevertheless inferred the right phrase from context and wrote a correct label. `checkGrounding` then flagged it:

```
⚠ grounding: StatCard scene-0 label "code" — not in the take
⚠ grounding: StatCard scene-0 label "churn" — not in the take
```

The two §14 mitigations pull in opposite directions: the prompt tells the model to treat unfamiliar tokens as mishearings and repair them, and the check then reports the repair as an invention. As built, the pressure is back toward parroting "coach and" onto the screen — the exact failure §14 existed to prevent. Five warnings fired this run and **at least two are false positives**; a check that cries wolf gets ignored.

Fix, in rough order of preference:

1. **Ground against a repaired transcript, not the raw one.** If a transcript-repair pass exists (still open from §14b), the check compares against its output and the conflict disappears — repair becomes the single source of truth for both captions and grounding.
2. **Phonetic tolerance.** A flagged token that is a near-homophone of transcript text (Soundex/Metaphone/edit-distance on the surrounding window) is a *repair*, not an invention — report it as `repaired:` at most, not a warning. "churn" vs "and"/"chun" and "code" vs "coach" both land there.
3. Failing both, have the producer emit the transcript span it grounded each label in, and check *that* rather than guessing by token membership.

Separately: **the `small.en` bump did not deliver.** It is worth re-testing `base.en` vs `small.en` vs `medium.en` on this one clip and keeping whichever actually gets the phrase right, rather than assuming bigger is better. A model that produces "coach and" is not an improvement over one that produces "CodeChun" — both are wrong, but the second at least preserves the consonants a repair pass could work from.

## 18. §15 is running the metronome fallback — phrase detection never fires

Every zoom segment is exactly **4.2354166875 s** (= 67.77 / 16). That is the uniform fallback, not phrase-driven pacing.

Root cause is a bug we have already diagnosed once: whisper's `-ml 1` word stamps are **contiguous** (Phase 0, `docs/PHASE0.md` "Signal fusion" — 164/167 boundaries had `word[i].end === word[i+1].start`). Inter-word gaps ≥ 250 ms therefore essentially do not exist, so the trigger finds nothing every time. The same false assumption that broke the cut engine has now broken the zoom driver.

Fix: drive phrase boundaries from data that actually exists in this pipeline —

- **caption line boundaries** (75 of them this run; they are already grouped at ≤3 words / ≤1.2 s, which *is* a phrase), or
- **`analysis.cuttable`** — acoustically measured, already computed, and independent of whisper's stamp behaviour.

Worth a guard so this cannot regress silently: if the metronome fallback is chosen, log it (`▸ zoom: metronome fallback (no phrase boundaries found)`). A silent fallback is why this looked fine in the fixture.

## 19. §13 crop clips the crown — the detected box is not the head

The mouth is in shot now, but the top of the head is cut mid-forehead (`video-top` at t≈36 s). pico's box bounds the **face** — eyes, nose, mouth — and excludes hair and skull, so centring *that box* at 42 % of the band seats the whole head too low.

Fix: expand the measured box upward by ~0.3–0.4 × its height (a head extends roughly that far above the face box) before deriving `objectPosY`, or equivalently target the *expanded* box's center rather than the face box's. This is a one-line adjustment to a measured number, not a return to hand-tuned constants.

## 20. Minor — `RuleCard` twice, and `FlowDiagram` still unexercised

`RuleCard` appears at 34.2 s and 50.1 s. Not adjacent, so §9's rule correctly passes, but two identical card treatments in a six-scene video still reads as a template. Consider extending the variety pass from "no adjacent repeats" to "no component more than once unless the library is exhausted".

`FlowDiagram` was not picked again, so §12's fix remains **fixture-verified only** — the third consecutive run where the component that failed on real copy has not been re-tested on real copy. Worth forcing it once via `--scenes` over this take rather than waiting for the producer to choose it.

---

# Round 5 — after §17–§20 (clean run, repair pass live, 2026-07-27)

> **Status 2026-07-27: §22–§25 addressed** (162 tests green, typecheck clean, golden fixture re-rendered and frame-verified).
> **§22** the treatment is now scoped by **time**, not text. `ctaKeyword` and its window are read off the timed CUE rather than the untimed scene list — which also fixes a latent bug in the old derivation: `.at(-1)` over `scenes` could pick a keyword from a scene `assembleScenes` had dropped, or one that wasn't last in time. `CaptionTrack` styles a word only when the word's own timestamp falls inside the CTA cue's window (±0.4 s, because a near miss is glaring and the next occurrence is seconds away); with no window nothing is styled at all. Applied per **word**, so a caption line straddling the boundary styles only the word inside the ask. `ChatMock`'s own quoting is untouched — different function, already time-scoped by its cue. `ctaDisplay` is now exported and tested; it was module-private and completely untested, which is how §22 shipped.
> **§23** the stage scales every graphic to fill its slot. A new `packages/scenes/src/fit.ts` models each component's natural height analytically — the same em-relative style `flowLayout` already used, pure and unit-testable, rather than DOM measurement (layout is provably frame-invariant here, but `ScreenshotFrame`'s height depends on an image that may not have decoded). `SceneLayer` lays the component out at `slotW / scale` and scales by `scale`, so rendered width is exactly the slot width while type grows.
> Two things the survey turned up that §23 didn't mention, both now fixed: several components **overflowed** rather than under-filled — TerminalMock at its schema maximum rendered 169% of its slot, ChatMock 122%, ScreenshotFrame 105% — bleeding outside the platform safe area with nothing clipping them. The fit shrinks those, and the slot now clips as a backstop. And the fill scale is bounded by **width** as well as height: content that cannot reflow (`white-space: pre` terminal lines, a `nowrap` stat value) keeps its width when the box narrows, so a height-only scale ran `$ ossclip produce raw.mp4` off the edge and pushed `+100%` through its card — both caught in the render and fixed with a min-width model.
> `FlowDiagram` is self-fitting: a row is bounded by width, so scaling can never make it taller, and three chips in the 1037px `graphic-only` slot fill 8% no matter what. The slot's shape now picks the orientation — whichever fills more, subject to legibility floors. **Consequence worth knowing:** with current slot geometry that means tall slots get the vertical stack and the reference's horizontal flow appears only in short bands. Fill was the explicit ask; if the horizontal look matters more, the threshold in `flowMetrics` is the knob.
> **§25 decided: the tight `video-top` crop is the house style.** No geometry change. Chin and mouth stay in, the crop cuts into the hair, which is normal framing for the format — and it keeps the graphic slot at h: 0.24 for the fill work to use. The alternative (a 0.50 band) would have cost a third of the graphic slot's height.
> **§24 remains open by design**: FlowDiagram's long-copy stack is still fixture-verified only. `--force-component FlowDiagram` forces the component but not long copy, so this closes on a real take whose content needs it.

*Workdir deleted, `small.en`, repair on, fresh plan.*

```
 0.2– 5.2s  StatCard            video-top
13.0–18.0s  TitleCard           pip-bubble
21.7–26.7s  StrikethroughReveal blurred-behind
39.1–44.1s  TerminalMock        graphic-only
50.1–55.1s  FlowDiagram         graphic-only
63.1–67.6s  ChatMock            blurred-behind
        44% coverage · 6 distinct components · face 9/9
```

**§17 is solved, visibly.** The hook card reads **"CODE CHURN · 861%"** — correct, in the speaker's own words. Five repairs landed and the one rewrite was refused with a reason:

```
▸ repaired "coach and" → "code churn"      ▸ repaired "task shift" → "task shipped"
▸ repaired "incidence" → "incidents"       ▸ repaired "text," → "tax,"  (×2)
⚠ repair refused: "especially" → "a specialty" (rewrite, not a repair)
```

Grounding warnings fell 5 → 3 and the survivors ("hidden", "cost", "build") are genuine editorialising, so the check is informative instead of noise. **§18 is fixed** — `zoom: acoustic (26 phrase boundaries, 28 segments)`, segments irregular (2.1 / 2.6 / 2.1 / 3.2 s) instead of the uniform 4.235 s metronome. **§12 finally ran on real copy** — FlowDiagram was picked naturally and rendered "LOOP → BUILD → VERIFY" as one clean row, arrows between chips, no wrap. **§19 improved**: chin and mouth in, the clip has moved up to the hair.

## 22. The CTA keyword is quoted everywhere it is spoken, not where it is asked for

`ctaDisplay` (`packages/scenes/src/CaptionTrack.tsx:23-26`) matches the keyword by **text, anywhere in the video**. "agents" occurs 9 times in this take's captions — at 6.3 s, 30.3 s, 34.8 s, 44.9 s, 59.1 s, 65.3 s the speaker is simply using the word — and every one of them renders as `"AGENTS"`.

That inverts the meaning. Quoting marks *the thing you type in the comments*; applying it to ordinary speech makes the video look like it is shouting a brand name, and it devalues the one moment that matters. In the reference the treatment appears **only** at the call-to-action.

Fix: scope the treatment by **time, not text**. The keyword is styled only inside the CTA moment's window — the cue that carries the CTA (`ChatMock` today, any future CTA card) — and everywhere else the caption renders the word plainly. The producer already marks the keyword; it should also mark *which moment is the ask*, or the CTA cue's own `startSec`/`endSec` can define the window. Inside the `ChatMock` component itself the quoting is correct and should stay.

## 23. `graphic-only` (and the graphic slot generally) wastes most of the frame

FlowDiagram at t≈52 s is a thin strip floating in black: roughly 40% of the frame empty above it and 30% below. Same for TerminalMock, and for the StatCards in earlier rounds. The slot is `h: 0.54` of the frame, but components render at their **natural size and centre inside it** rather than scaling to fill.

The reference frames fill their space — that is a large part of why they read as designed rather than sparse. This is a component-sizing concern, not a layout one: the slot geometry is already right.

Fix: give components a fill contract — scale type and padding to consume the slot's height (within sane min/max), or have the stage scale the rendered graphic to fit its slot. A `FlowDiagram` of 3 chips should be visibly bigger than one of 6, not the same size with more air.

## 24. FlowDiagram's long-copy path is still untested

§12's real risk was long labels; this run's copy ("LOOP", "BUILD", "VERIFY") is short and takes the easy path. The vertical-stack fallback below the font floor has still never rendered from producer output — only from the fixture. Not urgent, but §12 should not be considered closed on the strength of this frame.

## 25. `video-top`'s band cannot fit a head — decide the trade explicitly

Per the §19 work: at `h: 0.42` a typical selfie head does not fit, so the rule reduces to keeping the chin and losing crown. That is the right call, but it is worth deciding deliberately rather than inheriting it — either accept the tight crop as the house style, or make `video-top`'s band taller (~0.50) and shrink the graphic slot to match, which the safe area can still accommodate.

---

# Round 6 — second source clip (720×1280, 31.9 s, pre-edited reel, 2026-07-27)

> **Status 2026-07-27: §26–§31 addressed** (200 tests green, typecheck clean, golden fixture re-rendered and frame-verified, including a `--source-is-edited` pass).
> **§26** `scanSourceText()` samples the take and reports which horizontal bands already carry burned-in text, cached beside `face.json` since it is a property of the source. `routeAroundSourceText()` then applies the asymmetric rule: a graphic tries its own layout, then the component's default, then its alternates, then — rather than being lost — **is moved into the tallest free band**, shrinking to fit if it must (which the §23 fill contract makes safe, since every component now sizes its type to whatever slot it is handed). Only a band too small to read gets a scene skipped, with a log line. Captions never skip: `captionAnchorAvoiding()` searches outward from the layout's anchor for a band clear of the source text, the graphic and the chrome, and falls back to the layout anchor rather than disappearing.
> Two things the build turned up. First, **a routed graphic was swallowing the only free band**, leaving captions to fall back on top of the source's own text — so placement now reserves a caption-sized gap before the graphic takes the band. The graphic yields because captions are mandatory and it is not. Second, **the first detector false-positived on the golden fixture**: edge density alone flags any high-frequency content, and a colour-bar pattern scored two "text" bands. Real footage has equivalents — blinds, bookshelves, a striped shirt. Detection now also requires **bimodal luminance** (glyphs pile up at black and white; scenery spreads across the midtones), which biases toward missing text rather than inventing it — the right way round, since a false positive silently skips a scene on clean footage while a false negative merely restores the old behaviour. Both cases are pinned as tests.
> **§27** `revealMetrics`/`revealRows` treat a reveal line as an unbreakable unit like a FlowDiagram row: it scales to fit, and only when it cannot fit at the floor does it break — at the arrow, with the arrow **leading** the next row. Each RENDERED row carries its own strike rule, which is what fixes the rule being drawn between two wrapped lines rather than through either.
> **§28** the bubble's own geometry is now the constraint, not the slot: `chatMetrics` sizes the type so the longest unbreakable word fits inside bubble-minus-padding (a single word has no wrap opportunity, so only the type size can keep it inside the rounded rect). And a CTA scene renders **one bubble carrying only the keyword** — the "link sent 🔗" reply is gone, per your reasoning, with the multi-message form kept for genuine conversation scenes.
> **§29** the short-take floor (`max(45%, 4 graphics)` under 45 s) outranks both the coverage budget and the variety pass, and surviving scenes hold ~3 s. The minimum is also capped at 15% of runtime so it stays sane on very short clips rather than eating half the video.
> **§30** the stopword list gained conjunctions, auxiliaries, prepositions and degree words. Domain nouns stay checkable — inventing one is the failure the check exists for.
> **§31** `<out>.cover.jpg` renders as a separate still via a new `cover` composition, with `--cover <path>` and `--no-cover`. The frame is chosen by scoring sampled frames on face-present (weighted highest — a cover without the speaker is the wrong cover), sharpness (variance of Laplacian, which rejects motion blur) and earliness. Banner text comes from a new `coverText` on the beat sheet, so no extra LLM call. **Your grid catch drove the geometry**: `COVER_GRID_SAFE` models the profile grid's centre-square crop, and because it is tighter top-and-bottom while `SAFE_AREA` is tighter on the right, neither contains the other — cover text uses `COVER_TEXT_RECT`, their intersection, and the banner centres inside it rather than sitting flush against the crop edge.
> **Not built: `--cover-in-video`.** Prepending a card means either offsetting every span, cue, caption and zoom segment inside the composition, or concatenating a still with silent audio in ffmpeg afterwards. Both are real work with real A/V-sync risk for the option you explicitly did not recommend, so I left it out rather than ship it fragile. "Eyes open" in frame selection is also not implemented — pico gives a face box with no eye state, and a landmark model is not worth the dependency for one thumbnail; `--cover <path>` is the escape hatch if a blink lands.

*A different take entirely: different speaker framing, different room, different audio, and — importantly — **already an edited reel with burned-in text**.*

```
 0.1– 5.1s  StatCard            video-top
10.6–12.8s  StrikethroughReveal blurred-behind
27.6–31.7s  ChatMock            blurred-behind
        35% coverage · face 7/9 frames · zoom: acoustic (9 boundaries, 11 segments)
```

**§22 verified on new footage** — CTA window 27.6–31.7 s, keyword plain everywhere else. **The best repair so far:** `▸ repaired "code with SM" → "Code with Ahsan"` — it recovered the speaker's channel name from a mangled span on a clip it had never seen. Levels re-derived per source (−29.0 dB here vs −26.3 dB on the other take), face found at 36 % down.

## 26. Pre-edited sources: ossclip stacks its layer on top of an existing one

The source already carries a burned-in title ("I got Claude Max(20x) for 6 months for free") in its top band. `video-top` cropped through it, and ossclip's own StatCard then said much the same thing in different words directly beneath — **two competing titles, one of them clipped**.

ossclip assumes raw footage. Fed a finished reel it has no idea anything is already on screen.

**Required behaviour (product decision):** when the source already has burned-in graphics, **captions still go in** — they are the accessibility layer and must always be present. But ossclip's own text, overlays and animations must **not overlap existing on-screen elements**: place them in genuinely free regions, or skip that scene entirely for the affected moment.

Implementation sketch:

- Detect burned-in text: sample frames, run edge/MSER text-region detection (or a light OCR pass) → occupancy rects with their time ranges. Cache in the workdir next to `face.json`, since it is a property of the source.
- Feed those rects into the same free-space model the caption band already uses, so graphics and captions both route around them.
- When no free region can hold a scene's graphic, demote that moment to `none` and log it (`⚠ moment N: source already has on-screen text here — skipped`).
- Consider a `--source-is-edited` hint so the user can force conservative mode without waiting on detection.

## 27. `StrikethroughReveal` breaks on wrapped lines

At t≈12 s: "PROMPT → OUTCOME" wrapped to two lines, the arrow stranded at the end of line one, and the strike rule drawn **between** the two lines rather than through either. Same class as §12's dangling arrow, different component — the fit contract scales but does not solve inline glyphs plus wrapping.

Fix: treat the line as an unbreakable unit like `FlowDiagram`'s row — scale to fit, and if it cannot fit at the floor, break at the arrow with the arrow leading the second line (never trailing the first). The strike rule must be drawn per rendered line, not per logical line.

## 28. The CTA bubble text bleeds outside its bubble — and the second bubble should not exist

Two things in the same frame (user-supplied, t≈29 s):

**a) Bleed.** `"AGENTS"` fills its white bubble edge to edge with the quotes touching the boundary, and the dark bubble beneath renders "link sent 🔗" overflowing its rounded rect. The fit work bounded the *slot*; it did not bound text inside a component's own bubble geometry. Bubbles need internal padding as a hard constraint — text box = bubble minus padding, and the type scales to that, not to the slot.

**b) The second bubble is noise.** When the ask is *comment "X" to get the link*, the screen should show **just `"X"`** — a single bubble with the keyword. The "link sent 🔗" reply is invented reassurance for something that has not happened, it competes with the keyword for attention, and it is not in the reference. Change `ChatMock`'s CTA usage to a single-bubble form (keyword only); keep the multi-message form available for non-CTA conversational scenes.

## 29. Short clips get proportionally starved

35 % coverage from 3 scenes on a 32 s take, one of them only 2.2 s. The coverage budget is a percentage, so a short take yields few graphics *and* the `MIN_SCENE_SEC`/gap rules eat into what is left. Short-form is exactly where density matters most.

Fix: a floor for short takes — e.g. target `max(45 % of runtime, 4 scenes)` under ~45 s, and do not let a surviving scene fall below ~3 s.

## 30. Grounding flags stopwords

`⚠ grounding: StatCard scene-0 caption "but" — not in the take`. "but" is a stopword and should never be checked. Extend the stopword list; the check's value is entirely in its precision.

## 31. NEW FEATURE — cover image (thumbnail) for Instagram/Facebook

Publishing needs a cover. Reference grid (user-supplied): each tile is a **video frame with a short high-contrast text banner over it** — white box with dark text, or dark box with white text, 4–9 words, consistently placed.

**Recommendation: generate a separate cover image file, not a burned-in intro.** Reasoning:

- Instagram and Facebook both accept a **custom uploaded cover**; nothing has to be pickable from the video's own frames.
- Burning a 2–3 s title card into the head of the reel spends the most valuable seconds in the video on something the platform already shows as a static tile — it directly fights the "hook in the first ~2 s" policy (BRAINSTORM §4.5).
- A separate file can be regenerated or restyled without re-rendering 30–70 s of video.

Spec:

- Output `<out>.cover.jpg` (1080×1920) alongside the video, plus `--cover <path>` and `--no-cover`.
- **Frame choice:** pick from the take automatically — prefer a frame inside the first ~20 %, with a detected face, eyes open, good sharpness (variance of Laplacian) and no motion blur. Fall back to the first face frame.
- **Text:** the beat sheet's `hook`, shortened to ≤ 9 words by the producer (it already writes the hook; add a `coverText` field rather than a new LLM call).
- **Styling:** reuse the existing theme tokens and the `TitleCard` banner treatment so the cover and the video look like one system.
- **Critical geometry:** the Instagram *grid* crops covers to a centre square/4:5. Text must sit inside the **central square** of the 1080×1920 frame or it is cut off in the profile grid — this is a different safe area from `SAFE_AREA`, and both apply.
- Offer `--cover-in-video` as an opt-in for anyone who does want a 2 s burned-in card, but default it off.

---

# Round 7 — §26–§31 on the pre-edited reel (2026-07-27)

> **Status 2026-07-27: §32–§35 addressed, plus token/cost accounting and an aspect-ratio generalization pass** (249 tests green, typecheck clean, three fixtures re-verified, covers frame-checked).
>
> **§32 — detection rebuilt, and neither cause was the discriminator everyone suspected.** A reproduction of the clip was built as a fixture (`fixtures/edited-reel.mp4`, now in `scripts/make-fixture.mjs`) and instrumented, and the measurements settled it:
> 1. **A burned-in title is TRANSIENT.** It ran 6 s of 12 s, and the detector demanded a band be busy in half of ALL sampled frames — so a title occupying a third of the runtime was voted out by the frames it was never in. Regions are now **time-scoped** (`startSec`/`endSec`), which is both the fix and the more honest model: a title only conflicts with the scenes that share its window. `routeAroundSourceText` and the caption anchoring both filter through `regionsDuring` first.
> 2. **The edge threshold sat inside the background noise.** Measured on that clip: the title band scores `edge 0.345`, every other band `0.021–0.069`. The old cut at `0.055` ran straight through that noise band — which is what made the golden fixture false-positive, and the bimodality gate added to suppress it then got the blame for suppressing real text too.
>
> Three signals now have to agree, each rejecting a different impostor: **density** (is anything drawn), **bimodality** (glyphs sit at the luminance extremes, scenery spreads across the midtones), and **stroke structure** (text is many SHORT runs per row; colour bars are a handful of very wide ones — the SWT-style discriminator §32 suggested). Thresholds sit in the measured gaps, not at the edge of the noise, and per-band scores are written into `source-text.json` so the next threshold argument is settled with numbers. Verified: reel → one region at `y 17–21%, t 0.0–6.0s, conf 1.00`; golden fixture and a new 16:9 fixture → **0 regions**.
>
> **§33 — the cover banner routes around the face.** New `coverTextRect(face)` subtracts the head band from `COVER_TEXT_RECT` and takes the taller free band above/below, exactly as §33 asked. The head band is the pico box expanded (0.35× above, 0.2× below) — the §19 lesson reused, since pico bounds eyes/nose/mouth and a banner on the hair is still a banner on the subject. The band-splitting itself is now one shared `freeBands()` in `stage.ts`, which `placeInFreeBand` (§26 routing) also calls: same question, different occupant, one implementation. When a close-up leaves no band ≥ 0.13 tall the full rect comes back and the console says so — a banner over the face still beats a cover with no headline.
> The face is measured **on the cover frame itself**, under the same centre crop the cover uses (`COVER_CROP_VF`), not inherited from the video's median box. Previously cover sampling stretched the source to 9:16 while the cover cropped it — for a non-9:16 source those are different geometries, so the banner would have routed around a face box the cover did not have.
>
> **§34 — a source that carries its own title gets no banner.** When `regionsDuring` reports source text within ±0.5 s of the chosen cover frame, the frame ships as-is: no banner, and no scrim either (the scrim exists to make type legible, and darkening a bare photo for nothing reads as a mistake). Verified end-to-end on the reel fixture: `▸ source already has a title in this frame — shipping it without a banner`.
>
> **§35 — root cause was not the producer.** `normalizeBeatSheet` was **dropping `coverText` on the floor** — it returned `{ hook, moments }` — so however good a nine-word headline the producer wrote, the CLI fell back to `hook` verbatim. That is where the 13 words came from. `coverText` now survives normalization AND passes `coverHeadline()`, which prefers the clause before a dash/colon, truncates at a word boundary only if that is still too long, and refuses to end on a preposition or article. The cap is one exported constant used by the code, the schema `.describe()` and the prompt, so they cannot drift apart.
>
> **NEW §36 — token and cost accounting, surfaced in the output.** Every provider now records one `LlmUsage` per call (tokens, model, wall-clock) into `provider.usage`; pricing lives in one place (`producer/usage.ts`) rather than in four providers. The console prints one line and `report.txt` gets a per-call-type breakdown; both also land in `usage.json`. Two honesty rules are enforced in code and tested: **tokens a provider reports are marked exact, anything derived from text length is marked `(est)`**, and **a model with no known price is reported with tokens and NO cost guess**, naming the model and pointing at the `pricing` override in `~/.ossclip/config.json`. The `claude-cli` path — what a Claude Max subscriber actually runs — reports the CLI's own `total_cost_usd` as an **equivalent**, `billed: false`: the plan pays, but the number still says how much work the generation represents. A self-repair retry counts as a second call, because the tokens were spent. An offline `--llm mock` run says "no charge (offline provider)" rather than implying a subscription absorbed it.
>
> **Generalization pass ("works on a variety of tasks").** Three places assumed the v1 target — a 9:16 phone take — outright:
> - `objectPosYFor` computed the displayed height as `slotW × 1920/1080`, i.e. as if every source were 9:16. `FaceCrop` now carries an optional `sourceAspect`, and `cover` is modelled properly: a portrait source spills vertically (unchanged), a **landscape source is height-constrained** and has no vertical bias to apply.
> - …so a new `objectPosXFor` takes over there, biasing horizontally toward the measured `centerXFrac`. A 16:9 webcam take in a vertical slot loses ~70% of its width, and centring that blindly can crop the speaker out of their own video. Both omitted fields reproduce today's behaviour exactly, which is pinned by a test.
> - Source-text detection scaled every frame into a fixed 240×426 box. Aspect is preserved now (`scale=240:-2`): all three signals are geometric, and squeezing a 16:9 frame into a portrait box narrows every run — which is the shape of text. On the landscape fixture the verdicts happen to match either way, but the stroke score for plain colour bars reads **0.65 stretched vs 0.20 aspect-preserved** against a 0.25 threshold, i.e. the stretch was quietly neutralizing one of the three gates.
>
> **Not addressed:** §32's fallback suggestions (OCR pass, auto-enabling `--source-is-edited` by resolution/bitrate) — the heuristic detector now fires on the clip it was built for, so neither is needed yet. The "print a hint when zero regions are found" idea is superseded: `source-text.json` now carries per-band debug scores for every sample.

*Same 720×1280 clip with the burned-in title, clean workdir.*

**Improved:** §29's floor gave 4 scenes instead of 3 on this 32 s take, grounding warnings dropped to zero, and the repair caught "code with SM" → "Code with Ahsan" again. §31's cover pipeline produced a file: `cover from 0.3s (face, sharpness 835)`, banner inside the centre-square crop zone, themed correctly.

## 32. §26's routing works; its detection does not fire at all

`source-text.json` after a clean run on the clip §26 was built for:

```json
{ "regions": [], "framesSampled": 12, "assumed": false }
```

Zero regions — on footage whose title is **white text in a solid black box**, i.e. the highest-contrast, most bimodal case that exists. The rendered frame at t≈2 s is unchanged from before §26: the source's title clipped by the `video-top` band, ossclip's StatCard restating the same claim beneath it.

The routing half is fine. Forcing it proves the machinery works end to end:

```
▸ --source-is-edited: assuming burned-in text in the title and caption bands
  ▸ scene scene-0: graphic moved into the free band at 32-55%   (all 4 scenes)
```

So the defect is **detection sensitivity only**. The bimodality discriminator added to kill the golden-fixture false positive appears to have been tuned past the point where real text survives — the fixture's colour bars and a white-on-black title box are both bimodal, so that discriminator cannot separate them on its own.

Suggested direction:

- Debug against this clip specifically: log per-band edge density and bimodality scores so the thresholds can be set from real numbers rather than guessed. The clip is the ideal fixture — obvious text, known location, and a known false-positive source to keep failing.
- Separate the two signals rather than AND-ing them at fixed thresholds: text is *locally* bimodal in a **horizontally continuous band with sharp vertical stroke edges and interior gaps*, colour bars are bimodal but have no stroke structure. Stroke-width variance is the classic discriminator (SWT) and is cheap on a downscaled frame.
- Failing that, prefer a light OCR pass over hand-rolled heuristics; the cost is one pass over ~12 sampled frames, cached like `face.json`.
- Until it fires, consider defaulting `--source-is-edited` **on** when the source resolution/bitrate suggests a downloaded reel rather than camera output — or at minimum print a hint when zero regions are found, so silence isn't mistaken for "no text".

## 33. The cover's banner sits across the face

The generated cover puts the text box over the subject's mouth and beard. `face.json` is already measured (36 % down, 38 % tall) and the cover renderer knows it — the banner just isn't routed around it. Reference covers put the banner clear of the face, in the frame's dead space.

Fix: subtract the face box from the cover's usable area, the same way §26's routing subtracts text regions from the slot; pick the taller of the free bands above/below the face, still intersected with the centre-square crop zone.

## 34. The cover repeats the source's own burned-in title

Source says "I got Claude Max(20x) for 6 months for free"; the cover says "CLAUDE GAVE ME SIX MONTHS OF MAX PLAN FOR FREE — AND NOT FOR THE REASON YOU THINK". Same claim, twice, in one image.

This is §26 applied to the cover surface: once source-text detection works, the cover should honour it too — either place the banner clear of the existing title (it currently overlaps nothing, but duplicates), or, when the source already carries a title, **skip the banner entirely** and ship the frame as-is. A cover with one title beats a cover with two.

## 35. `coverText` is too long — it inherited the full hook

13 words across 5 lines. §31 specified ≤ 9 words, and the reference grid runs 4–9 words over 1–3 lines. The producer appears to be reusing `hook` verbatim rather than writing a distinct short `coverText`.

Fix: make `coverText` its own field with a hard word cap stated in the schema `.describe()` and enforced in code (truncate at a word boundary, or fall back to the first clause before the em-dash). A cover banner is a headline, not a sentence.

---

# Round 8 — the crop slice and the call count (fixed 2026-07-27)

## 36. The crop sliced the source's title — and the earlier diagnosis was wrong

**Correction first:** Round 7 reported that detection "fires on scenery and misses the title". That was wrong, and the mistake was mine — I read the title's position off the *rendered* frame, where `video-top` crops from ~12% and pushes it to the top edge. In the SOURCE it sits at y 13–24%, and the detector reported y 17–25% @ 0–3s. **Detection was right all along.**

The real defect was downstream: `objectPosYFor` positioned the crop window purely from the face, so nothing stopped its edge landing halfway through the source's own title box. The window ran 14.9–56.9% of the source while the title box started at ~12.5% — sliced along its top edge, exactly as rendered.

Two fixes, both measured rather than guessed:

- **`avoidSlicingText` in `stage.ts`.** A window that would cut a text band is nudged to either exclude the band or contain it whole, whichever moves the framing less — and **any shift that would push the chin out of frame is discarded**, so this cannot quietly re-open §13. `layoutSlots` and `videoSlotAt` thread the bands through, time-scoped, so the constraint only applies while the text is actually up.
- **Regions are padded by one band.** Detection localises *glyphs*; the plate behind them runs past the last row of type, and it is the plate a crop visibly slices (glyphs at 17–25%, box from ~12.5%). One band is the detector's own resolution, so this claims no more precision than the measurement has. Padding happens **after** merging, or it would fuse regions the evidence kept apart.

Result on the real reel: the source title is now excluded from the video slot entirely and ossclip's StatCard owns the messaging, with the face framing unchanged. A test pins the premise (the unadjusted crop *does* slice that clip's title) so the fix cannot silently rot.

Also fixed while in there: regions were produced in **source** time and consumed as **output** time — identical only while nothing is cut. They are now mapped through the TimeMap, and a region whose window is entirely removed drops with it.

## 37. 45,000 tokens per call was the harness, not the prompt

`llm: 6 calls · 269,818 in / 3,884 out · ~$1.71` on a 32 s clip — ~45k input per call against a ~600-word transcript. Measured directly with `claude -p`:

| what | cache_write | cache_read | cost |
|---|---|---|---|
| trivial prompt, default flags | 28,562 | 15,185 | $0.29 |
| `--system-prompt` + `--strict-mcp-config` | 25,668 | 0 | $0.26 |
| identical prefix, immediately repeated | 0 | 40,098 | **$0.02** |
| Sonnet / Haiku, same trivial prompt | — | — | $0.20 / **$0.04** |

So it is the Claude Code harness prefix — system prompt, tool definitions, project context — re-sent per invocation, with ossclip's own prompt a rounding error. Prompt trimming does nothing (`--allowed-tools ""` made it *worse*); a separate CLI invocation cannot reuse the previous one's cache. **The levers are call count and model tier.**

Fixed by batching: one `scene_props_batch` call covers every graphic moment, each entry validated separately on the way out so a malformed one simply isn't returned and that moment alone falls back to its own call. Isolation is unchanged — the batch is a fast path, never a new failure mode — and a single graphic moment skips batching entirely.

```
before: 6 calls · 269,818 in / 3,884 out · ~$1.71 · 37s
after:  3 calls · 137,664 in (100% cached prefix) / 1,023 out · ~$0.91 · 25s
```

The usage line now names the cached share, because a bare "270k in" reads like a runaway prompt when the real story is call count.

## 38. Model tiering — and the call it turned out NOT to apply to

Each call now declares a `tier` (`editorial` | `mechanical`) and a `TieredProvider` routes it. A wrapper rather than a flag inside each provider, so providers stay dumb about policy and two of *different* kinds compose — which is what would let a subscription CLI do the editorial call while a metered flash model does the rest. `--llm-fast-model` overrides the per-provider default; `same` opts out. The fast defaults are same-family siblings (`claude-haiku-4-5`, `gemini-2.5-flash`), so tiering changes cost without also changing who you are talking to.

**Then measuring it moved one call back.** With repair on the small model, the repair pass returned **zero repairs** on the reel where the large model recovers `"code with SM" → "Code with Ahsan"` every single run. Deciding what a person actually said is semantic work, not schema-filling, and it is the gate that keeps a mishearing off the screen (§17) — the wrong place to save $0.20. Repair is tagged `editorial` with that reasoning in the code, so nobody "optimises" it back.

Scene props stay mechanical: the schema validates every field on the way out, and a bad entry already falls back to its own call.

```
untiered                3 calls · ~$0.91 · 1 grounding warning · repair ✓
all-mechanical (haiku)  3 calls · ~$0.66 · 3 grounding warnings · repair ✗ EMPTY
final (repair=editorial) 3 calls · ~$0.85 · 1 grounding warning · repair ✓
```

Cumulative against where §37 started: **6 calls / $1.71 → 3 calls / $0.85.**

**Next provider to exercise: Gemini via Antigravity.** The seam is ready — `--llm gemini --llm-model <id> --llm-fast-model <id>` — and `DEFAULT_FAST_MODEL.gemini` is `gemini-2.5-flash` only because that is a model id this code can verify. A newer flash id should be passed explicitly rather than assumed here; if Antigravity is to be driven as a *CLI* (the way `claude-cli` rides the Claude subscription) that is a new provider implementing the same three-method seam, and `ClaudeCliProvider` is the template — envelope parse, one self-repair retry, usage recorded per attempt.

## Not defects, noted

- **0 cuts on the test take is correct** — longest silence 0.44 s, below `standard`'s 0.7 s threshold.
- **9 moments → 7 scenes** is by design: two moments were `sceneKind: "none"` (plain talking-head beats). Though 7 of 9 carrying graphics overshoots the prompt's own "at most half" guidance — see §3/§4.
- `startSec`/`endSec` stay `undefined` on `production.json` scenes while resolved times live only in `render-props.json`. That matches PHASE1 §2 ("never persist as the source of truth") but makes the doc harder to inspect by hand; consider writing them back as a debug-only mirror.
- The producer's editorial judgment was good: it pulled true figures (861%, +242%, +34%, 2,200 devs) rather than inventing them, and the `rationale` field reads like an editor's notes.

---

# Round 9 — first real editing session (`5 ClaudeCode.v8`, 2026-07-29)

*Author driving `ossclip edit` on `~/Downloads/.ossclip/5 ClaudeCode-07fbd090` for the first time. Seven items, all found by hand in ten minutes of use — none by a test.*

**Planned, not fixed:** [`docs/superpowers/plans/2026-07-29-editor-playback-and-captions.md`](./superpowers/plans/2026-07-29-editor-playback-and-captions.md).

**Improved this round (v8, verified):** the two `video-top` framing warnings are gone — `▸ framing: every scene fits its slot (tightest scene-9 at 93% of its band)`. The producer chose the layouts itself: `RuleCard` and `ScreenshotFrame` both default to `video-top` and both came back `pip-bubble`, which is neither their default nor their alternate, so it can only have come from the framing brief. The repair pass never had to fire. Provider was `claude-cli` (Opus 5 editorial, Haiku 4.5 mechanical), 3 calls, ~$0.72 API-rate equivalent on the subscription.

## 39. The player treats its whole surface as play/pause

`App.tsx` passes `controls` but not `clickToPlay`, and Remotion defaults `clickToPlay` to `controls`. §Task 2 of the usability round made the swallow SELECTIVE — clicks on editable elements are the editor's, everything else reaches the Player — which was right for that bug and is the wrong policy for an editor: the frame is a canvas, not a button. Decided: disable click-to-play entirely; transport is the play button, SPACE and (new) J/K/L.

## 40. No speed control, no J/K/L

Requested: `L` play forward and faster on repeat, `J` backward and faster on repeat, `K` stop/play toggle at 1×, `SPACE` toggle. `SPACE` already ships (§Task 5). **Open question that changes the design:** whether this Remotion `<Player>` honours a negative `playbackRate` for reverse, or whether `J` has to be a seek loop. Measure before designing.

## 41. The ruler above the timeline does not seek

It is two `<span>` labels with no handler, so every seek has to aim at a scene block — which also selects that scene. Navigating and selecting should not be the same gesture.

## 42. The safe area is invisible while dragging

`SAFE_AREA` is top 12% / bottom 22% / right 16% / left 4%. An element dragged under the chrome looks like it vanished. Show the outline faintly *during a drag only*, from the exported constant rather than a copy.

## 43. Every numeric inspector field rejects decimals

`NumberField` renders `<input type="number">` with no `step`, so HTML's default `step=1` makes `0.62` invalid and the value never commits. It bites hardest on the new video-framing `scale`, whose entire useful range is 0–1 — the field is unusable as shipped. The element `dx`/`dy`/`scale` fields have carried the same defect since they shipped.

## 44. The TIMING section tells the user nothing

It renders the time range only when a cue is pinned; an unpinned cue gets the bare string `Tracking transcript`. But an unpinned cue still has a resolved `startSec`/`endSec` — the user is looking at a scene on screen and being told nothing about when it is, or which words it is tracking.

## 45. NEW FEATURE — caption editing

Captions are DERIVED (`buildCaptionLines` over the repaired transcript through the `TimeMap`), so there is no caption layer in `overrides.json` for an edit to live in. Four constraints that make this a design task rather than a text box: word-level timings drive the kinetic highlight and must survive an edit (`applyRepairs` already solves that shape — proportional split inside the original span); scene copy and captions must keep agreeing (§21, `reconcileCopy`); cues anchor to word INDICES, so changing word count moves every downstream anchor; and the scope is genuinely three different projects — 1:1 retype, full re-timed transcript editing, or a Descript-style pane that also drives cutting. **Scope to be decided with the author before any code.**

## Not defects, noted

- The strict repair gate refused `"and that is double scape"` → `"double escape"` with "span of 5 words is a rewrite, not a mishearing". That is §17's rule working as specified; the cost of the strictness the author chose. A caption edit (§45a) is the intended escape hatch.
- 0 cuts on this take is correct — no silence crossed `standard`.
- The v8 pip bubble crops the head at ~121% of the circle. Measured and unfixable by any constant: the canvas is portrait (450×800), the bubble is a 324px circle, cover is width-bound, and that ratio is independent of bubble size. Zooming out inside a round mask leaves crescent gaps. Shipped as a per-scene `video: {scale, dx, dy}` override instead — the author's call: keep the constraint out of the code and fix it where it belongs.

# Round 12 — a landscape source, and text that does not fit (`Agents in 2026`, 2026-07-31)

*Status (remote session, same date): §46–§49 fixed. §46 — `estimateMinWidthPx` gains RuleCard and TitleCard longest-word cases, so `fitScale`'s width cap binds (pinned on the real scene-4 props). §47 — element boxes grew four corner handles (radial drag = uniform scale, one rounded patch per gesture) and the panel a scale slider; number fields stay as the precision fallback. §48 — fields are `type=text inputMode=decimal`: comma decimals commit, display rounds to 3 decimals, and every drag commit rounds at the source. §49 — the element inline input is deleted; the panel's TEXT field covers the array-backed ids via `buildArrayPatch`/`elementTextOf`, caption double-click kept. The Render button's title now states it replays the last completed produce. 491 unit tests, 17 e2e green.*

*First run against a LANDSCAPE source: 1920×1080, 12m21s, 2396 words, Gemini as the producer (~$0.10 for beats + props). Two full runs of the same take, one cover and one contain, plus the author editing the workdir by hand while the second rendered.*

**Shipped this round:** `--source-fit contain` — a landscape source rendered whole instead of cover-cropped. Measured reason: cover-cropping 16:9 into 9:16 displays the picture 3413px wide and keeps 1080 of them, **32% of the width**, with the head filling the frame top to bottom. Round 10 had quietly made that worse — plain takes are `full-bleed` and takes cover most of the timeline, so a landscape source spent most of its runtime in the one layout that ruins it.

**Still open from the analysis, not built:** the framing assessment (`assessCueFraming`, which already computes head-vs-slot) only runs when a normalization plan exists, i.e. for letterboxed sources. A uniform landscape file gets no assessment, so neither the producer's framing brief nor the repair pass ever learns that `full-bleed` is wrong for it. Plain-take layout is also picked without reference to source shape.

## 46. A single unbreakable word overflows its card

`RuleCard`, scene-4: kicker `NEEDED`, text `AI HARNESS`. It wraps to `AI` / `HARNESS`, and `HARNESS` is wider than the card's inner width — the glyphs run past the rounded rect and are clipped by the slot's `overflow: hidden`, so the card reads `HARNES` with a severed `S` floating on the backdrop.

Root cause is checkable, not a guess: `estimateMinWidthPx` (`packages/scenes/src/fit.ts`) has cases for `TerminalMock` and `StatCard` and `default: return 0`. RuleCard hits the default, so `widthCap` never binds and `fitScale` is free to magnify to `MAX_SCALE = 2.4` on the height model alone. The height model (`textHeight`) knows how text WRAPS but has no notion of a minimum unbreakable word — and a word cannot wrap. This is exactly the §28a rule (ChatMock: shrink until the longest WORD fits inside bubble-minus-padding), solved once for one component and never generalized.

Directions worth weighing, not a plan: derive a longest-word min-width for every text component rather than the two that have one; or fold the constraint into the fit solve so no scale that overflows a word is reachable; or add a render-time backstop so a miss clips inside the card instead of spilling onto the stage. Also worth deciding whether these estimates stay analytic (`CHAR_W_*` constants) or start measuring — every one of these misses has been an estimate being optimistic.

## 47. No good way to fix a graphic that does not fit

The author's repair for §46 was to select the element and type `scale 0.8` plus two pixel offsets into number fields. It works, and it is typing coordinates at a picture.

Asked for explicitly: **every scale should be a slider, at the least — and everything should be transformable, with edge nodes to adjust.**

The precedent is already in the codebase and this is the one place that missed it: R11 shipped a zoom SLIDER for video framing and eight transform handles for the graphic BOX; R10 shipped drag-to-pan for the video itself. Elements are the last thing still driven by number fields alone. Note the half-state to investigate — an element can already be DRAGGED to move, but there is no resize gesture and no handles, so position is direct manipulation while size is not.

## 48. Numeric fields show locale decimals and 13 decimal places

Observed on the author's machine: X reads `−76,7378281484908`, SCALE reads `0,8`. Two separate defects wearing one coat — the drag writes full float precision and nothing rounds it for display, and the decimal separator is a comma in the author's locale, which `<input type="number">` treats differently from a period. §43 fixed the `step` attribute, not either of these. Worth confirming whether a comma-locale value can commit at all, since that decides whether this is cosmetic or a second unusable-field bug.

## 49. Inline double-click editing overlays the thing it edits

Double-clicking an element opens a floating input positioned over that element. In the author's screenshot the input shows `HARNESS` while the un-edited tail `SS` is still painted behind it — you edit text while looking at a mixture of the old render and the new value, on top of the graphic you are trying to judge.

The Inspector ALREADY has a TEXT field for the selected element, so the overlay is a worse duplicate of a control that exists. **Author's call: editing should happen in the side panel, not by double-click.**

To investigate before removing anything: the panel's TEXT field only covers props whose `data-edit-id` names a top-level string. The array-backed ids (`line-N` / `node-N` / `message-N`, handled by `buildArrayPatch`) are reachable ONLY from the overlay today, so deleting the double-click path without extending the panel would take away the only way to retype a FlowDiagram node or a ChatMock message. Caption retype (§45a) is a separate double-click flow on the caption track, and whether that one follows the same rule is its own decision.

## Not defects, noted

- **The editor's preview and the exported mp4 can be different generations, and nothing says so.** The author compared a preview showing the contained frame against an mp4 showing the cropped one and reasonably read it as an editor bug. Both were correct: a `produce` run had rewritten `render-props.json` in place at 20:29 while the page held a snapshot from mount, and the mp4 was the 19:46 export. Related and worth stating in the UI: **Render replays `command.json` — the flags of the last COMPLETED produce — not what is on screen.** Overrides are re-applied on top so hand edits always survive, but pipeline-level decisions (source fit, cleanup level, provider) come from the recorded command. A workdir whose last produce predates the recording feature has no `command.json` at all and the button is honestly disabled.
- **`contain` leaves the layout slots where they were.** Graphics still sit over the picture and the dead space above and below it goes unused, because every layout's geometry assumes the video fills the frame. A top-aligned "band" variant — picture at the top, graphics and captions in the freed space — is the podcast-clip look and is the obvious follow-up if the contain output is worth keeping.
- Gemini as the producer: repairs were strong (`cloud code` → `Claude Code`, `Revind` → `Rewind`, `cloud code incense` → `Claude Code instance`) and the strict gate refused a genuinely wrong rewrite of an unfamiliar product name twice on length. One longer span of the same rewrite DID land in an earlier run, which is the §17 heuristic ("unfamiliar proper nouns are usually mishearings") turning a correct new name into a wrong old one. A guard on names the speaker uses consistently, or that appear in `--speaker`/`--intent`, is worth considering.
- 0.1% removed from 741s. Nothing is wrong with the cut engine — it tightens pauses and drops fillers, and this take has neither to spare. It does mean a 12-minute source yields a 12-minute vertical: **there is no highlight selection anywhere in the pipeline**, and for long-form input that is a bigger gap than framing.

# Round 13 — the layout dropdown and the silent render (`Agents in 2026`, 2026-07-28)

*Status (remote session, same date): §50 and §51 fixed. §50 — `graphicSlotFor` is the one slot resolver (SceneLayer and the Inspector both draw from it); full-bleed falls back to `FULL_BLEED_GRAPHIC_SLOT`, and a layout override drops a rect `routeAroundSourceText` baked for the OLD layout. A sweep e2e switches a ChatMock through every layout and asserts the graphic keeps a footprint. §51 — the status endpoint stamps `startedAt`; the panel grew a spinner, an elapsed clock, a progress bar parsed from the render's own `NN%` lines, and pinned provider/cost lines. 509 unit tests, 19 e2e green.*

*Two reports from the author's session editing the `Agents in 2026` contain workdir by hand, sent with screenshots rather than logged as a round.*

## 50. Switching a scene's layout away from blurred-behind hides the graphic

A ChatMock scene on `blurred-behind`: pick anything else in the LAYOUT dropdown and the chat box, its text, and the selection box all disappear. The author's principle, stated with the report: **the component and the layout should work independent of each other.**

Root cause is checkable: `layoutSlots("full-bleed")` returns `graphic: null` — full-bleed was designed as "talking head only" back when only the planner assigned layouts — and `SceneLayer` returns null for a cue whose layout has no slot. So full-bleed is the one layout that silently DELETES a graphic instead of placing it; every other layout has an unconditional slot. The fix follows the author's principle: layout decides where the VIDEO sits, and a cue that has a graphic always renders it — full-bleed graphics float in a dedicated band (blurred-behind's geometry, minus the blur). Deliberately not added to the slot table itself: plain cues must not make captions dodge an empty band.

The same independence bug existed one layer down: a base cue can carry a `graphicRect` that `routeAroundSourceText` computed FOR its original layout, and under a layout override that stale rect kept winning over the new layout's slot. `applyOverrides` now drops it when the layout override differs — the mirror of what `patchLayout` already did to the override rect.

## 51. The render panel reads as stuck

After Render, the log tail shows `0%` and climbs in 10% steps that can be minutes apart — nothing moves in between, so it reads as hung. Asked for: a loading indicator, elapsed time, tokens and generation cost, the provider.

Everything asked for was already IN the stream — `produce` prints `▸ producing scenes (<provider>)…`, `formatUsageLine`'s `▸ llm: N calls · tokens · ~$` summary, and the render's own percentage steps; the panel just showed the last six raw lines. The fix is parsing, not plumbing: the server stamps the spawn time (server-side, so a mid-render page reload keeps an honest clock), and the panel shows a spinner that animates without new lines, elapsed `m:ss` off the 1s poll, a progress bar from the latest bare `NN%` line, and the provider/cost lines pinned above the scrolling tail. Honest by construction: a fully cached replay prints no `▸ llm:` cost line, and the panel pins nothing rather than fabricating one.

# Round 14 — asked-for features: timeline zoom, and the bubble's shape (2026-07-28)

*Status (remote session, same date): both shipped. §52 — a per-scene `pip` override (roundness 0–1, x/y placement) resolved inside `videoSlotAt` so the morph eases toward the bubble the user placed; Inspector grows a PiP section when the resolved layout is `pip-bubble`. §53 — the timeline zooms 1–16× (buttons + ctrl/cmd-wheel about the cursor) inside a horizontal scroller; every existing gesture self-calibrates because the drag math always divided by the track's own width. 525 unit tests, 21 e2e green.*

*Feature requests, not defects — asked for directly, with the author's own scope guard: the product is solid, don't overengineer.*

## 52. NEW FEATURE — pip bubble roundness and placement

Asked for: set the roundness of the pip mask, "maybe even placement". Shipped as a per-scene `pip` override — `cornerRadius` 0 (square card) to 1 (the stock circle), and the slot's x/y in frame fractions, clamped on-frame. Scoped to the `pip-bubble` layout at RENDER time, the same trap §50 closed for the graphic rect: a bubble property must not bend a full-frame layout, and because other layouts simply ignore it, the override survives a layout round-trip instead of needing to be cleared. Size stays the layout's own — placement and roundness were the ask. The morph machinery resolves each neighbour through its OWN override, so easing into a repositioned bubble heads where that bubble actually is.

## 53. NEW FEATURE — timeline zoom with horizontal scroll

Asked for: the usual video-editor zoom, horizontal scroll, easier dragging. The track now widens to `zoom × viewport` inside a scroller — and that is nearly the whole implementation, because every timeline gesture already divided by the track's OWN bounding width, so seek, scrub, edge-drag, and block-move all get proportionally finer without touching their math. Zoom is 1–16×: −/+/fit buttons (anchored about the viewport centre), ctrl/cmd+wheel about the cursor (native non-passive listener — a passive one cannot preventDefault the browser's own pinch-zoom), bare wheel pans while zoomed. The anchoring invariant — the moment under the cursor stays put through a scale change — is a pure function (`zoomedScrollLeft`) with its own tests, applied in a layout effect once the wider track has actually rendered, because setting scrollLeft before that clamps against the old width.

# Round 15 — landscape layouts, a preview worth looking at, and caption editing that works (2026-07-28)

*Status (remote session, same date): all six items of `docs/superpowers/plans/2026-08-01-editor-round-15-landscape-layouts-and-caption-editing.md` shipped — see that document for the requirements and per-item diagnosis; its checkboxes are ticked with implementation notes. Summary: §54 — `lower-third` and `split-left`/`split-right`, frame-aware in BOTH aspects (the split axis follows the frame's long edge), `landscapeLayout` remapping the vertical splits to `split-left`; verified by frame-extracting a real render of all three. §57 — the caption double-click resolved through the `elementBelow` walk instead of a bare `elementFromPoint`; mechanism confirmed by reverting the fix and watching the new small-preview landscape e2e fail (the Player's transport strip owns the caption band on a short preview). §55 — the preview sizes from the container (the 380px constant is gone), and view zoom works by resizing the Player inside the scrolling stage area, so `getScale()` stays authoritative and a view gesture (ctrl/cmd-wheel, Alt/middle-drag) can never write an override. §56 — `captionY` per scene, hand-set wins over the avoidance chain, with the cheap §56b: one "Apply to all scenes" fan-out in one undo step. §58 — the timeline pages by a viewport width when a live gesture reaches the scroller's edge; block/edge drags were converted to content-space deltas so the drag continues across the page. §59 — a transcript panel (search, click-to-jump, double-click 1:1 retype through the existing caption override), plus a latent bug fixed on the way: re-editing an already-edited word stored the live text as the `was` guard and the merge dropped the edit — `captionEditWas` keeps the guard anchored to the base. 544 unit tests, 28 e2e (a landscape project runs serialized after main against the same server, its workdir re-shaped per request).*

# Round 16 — the render you can walk away from, and an editor that answers the keyboard (2026-07-28)

*Status (remote session, same date): all six asks shipped. 553 unit tests, 33 e2e.*

## 60. A refresh orphaned a running render

Reported: start a render, refresh, and the logs are gone — no progress, no way to stop the run, while the child keeps rendering server-side. Fixed at both ends: the editor asks `/api/render/status` on mount and resumes the panel (progress, pinned cost lines, elapsed from the server's spawn stamp — never restarting at 0:00), and a new `POST /api/render/cancel` kills the replayed child, with the status carrying a `cancelled` flag so a deliberate stop reads as "render cancelled", not a dressed-up failure. The e2e plants a slow fake command.json, refreshes mid-run, and cancels.

## 61. NEW FEATURE — split a scene at the playhead (⌘/ctrl+B)

Splits stored as ABSOLUTE output times in the override doc (`splits`), applied by `splitCues` after the plain fill — so graphic scenes and takes split alike — and before the final override pass, so the halves' own edits land. The half starting at the cut is named `${rootId}@${ms}`: derived from the ROOT id and its own start time, so adding an EARLIER split can never rename later halves out from under their edits. Undo takes a split back like any edit; a cut that would mint a half under 0.3s is refused. Known trade: a split graphic's second half re-enters through its component's intro animation.

## 62. Keyboard selection and navigation

⌥+←/→ move the SELECTION to the neighbouring scene (the playhead stays — select, not navigate); ⌘/ctrl+←/→ move the PLAYHEAD to the previous/next scene's beginning, exactly as asked, with preventDefault keeping the browser's ⌘← history-back away. Backspace/Delete already deleted the selected scene restorably (R10 Task C) — verified, unchanged.

## 63. NEW FEATURE — the keybinds reference

"?" (or the top-bar `?` button) opens a modal in the style of the reference screenshot: grouped commands, key chips, `esc close`. The list is static data maintained beside the handlers it documents, and the e2e greps it for the bindings the suite itself exercises, so a stale row fails loudly. The modal's Escape closes on the capture phase so it cannot also clear the selection.

## 64. Caption scale

`captionScale` per scene (0.2–3×), the same shape as `captionY`: a slider plus precision field in the Captions section, resolved per line from the cue the line starts under, multiplying the track's base size. "Apply to all scenes" now fans out position AND scale in one undo step; Reset clears both.

## 65. The transcript pane scrolled sideways, and its width was fixed

Reported with a screenshot: caption lines ran off the pane's right edge behind a horizontal scrollbar. Root cause was subtle: the word spans were emitted with NO whitespace between them — a CSS margin is not a line-break opportunity — so each caption line was one unbreakable inline run, wrapping only at in-text hyphens (exactly the `in-` / `picture` break in the screenshot). Real spaces between the spans fix the wrap; `overflow-x: hidden` + `overflow-wrap: break-word` close off the pathological cases. And the pane ↔ stage boundary is now a drag divider (220–640px, remembered in localStorage); the stage's ResizeObserver refits the preview as it moves.

## 66. Only "ARCHITECTURE" was struck when the whole phrase was negated

Audio: "they can't really implement software architecture" — the producer struck only the last line. The component always supported striking EVERY line (per-line `struck`), so this was a content miss with no way to correct it from the editor. Three fixes: a Line style select on any selected reveal line (plain / struck / ✗ wrong / ✓ right) writing through the normal props override; per-line `mark: cross|check` on the schema (✗ in danger red, ✓ in a new `success` theme token — the editor's own "Saved" green), defaulting to none so existing productions render byte-identically; and the registry's `whenToUse` now tells the producer to strike EVERY line of a negated phrase — a half-struck claim reads as a typo.

## 67. NEW COMPONENT — BulletList, because enumerations kept getting miscast

Audio: "what you need is AI harness, … context engineering, … prompt engineering" — a three-item list bent into a title-plus-strike card that struck a thing the speaker RECOMMENDED. No component said "list", so the producer improvised one badly. `BulletList`: 2–5 nowrap bullet rows with an optional kicker title, accent ▸ glyphs, staggered entrance; self-fitting like the reveal (`bulletMetrics` solves type against both slot budgets — the §46/§23 lessons applied from birth, pinned by the fill-contract tests at sparse and schema-max content). Items are first-class editable elements (`item-N` joins the array-backed id family), and the registry steers the producer: use this for enumerations instead of bending TitleCard or StrikethroughReveal around them. Verified with a real render frame.

## 68. A split half fell back to default caption style

Reported: split a take whose captions were scaled down — the right half rendered at the default placement and scale. Root cause: halves get their overrides by ID, and the right half's `id@ms` has no entry; a take's edits only land in the post-split override pass, so they never reached it. Fixed in `applyOverrides` itself with `effectiveOverride`: a half resolves its own entry LAYERED OVER its split root's — everything inherits except `timing` and `hidden`, which describe the whole original scene, not a piece of it; the half's own keys win field-wise (nudging one field keeps the rest inherited). Two latent timing bugs fell to the same pass: the post-split pass used to re-apply a pinned scene's ORIGINAL window to its first half (undoing the cut), and to undo `reclampPinnedTiming`'s adjustments — `timing` now only applies to a cue that isn't already pinned.

## 69. Graphics exited abruptly

Entrances were designed (staggered rises); exits were a hard unmount — the split view would morph closed and the card then blink out. Every graphic now leaves through a uniform 0.3s fade-and-settle (`ExitFade`, at the SceneLayer so all components exit the same way), timed to the layout morph so the card departs WITH the slot instead of after it.

## 70. Playback keys died after touching a control

A freshly-scrubbed slider (or a select, checkbox) kept focus and swallowed SPACE/J/K/L. Now only TEXT ENTRY holds onto keys; every other control YIELDS — the key blurs it and drives the transport. Plain arrows still respect all inputs (arrows on a focused slider adjust the slider — that is what they are for).

## 71. Plain arrows step one frame

←/→ nudge the playhead a frame at a time, selection or none — ⌥+arrows select scenes, ⌘+arrows jump scene starts, the bare key is the fine-grained scrub every editor has.

## 72. The view follows the cursor — a general principle

The author's rule, applied everywhere it can matter: whenever the playhead leaves the timeline's visible window (playback at zoom, a ⌘-arrow jump, a frame step) the view scrolls to it; a block selected from the keyboard scrolls into view; the transcript's highlighted word follows playback (`nearest`, so reading elsewhere is only interrupted when playback truly moved on). And ⌘+arrows now SELECT the scene they jump to — cursor there, scene selected, play starts from that point.

## 73. ⌘+scroll on the preview never worked — not once

Reported with the keybinds modal open: the documented view-zoom gesture was dead. The wheel listener attached in a mount-time effect — which ran during the LOADING screen, against a stage area that did not exist yet, and never re-ran. The §55a ResizeObserver had hit the same trap and been fixed with a callback ref; the wheel listener was the second tenant of the same bug. The stage area node is React state now, and everything attaching to it re-runs when it actually mounts. The regression test dispatches a REAL ctrl-wheel at the stage — the zoom buttons could never have caught a listener that was simply absent.

## 74. NEW — a documentation page

`docs/site/index.html`: a single-page, self-contained reference in ossclip's own palette (the herdr.dev shape — hero, install, quick start, concepts, keybinds, component/layout/flag reference, config). No build step, no dependencies; open it locally or serve it via GitHub Pages. The keybinds section mirrors the in-app `?` modal.

## 75. Re-render pinned to the original configuration

Asked to double-check that the editor's Render uses the same configuration as the initial run. Flags always replayed verbatim (`command.json` records the argv) — but a provider AUTO-DETECTED from the produce shell's environment was re-detected in the EDIT SERVER's environment at replay, which could silently pick a different provider if the key wasn't exported there. The resolved provider is now pinned into the recorded args (`--llm <name>` — never the key itself; secrets stay out of the workdir): the replay uses the same provider or fails loudly asking for its credentials.

## 76. A landscape render shipped a PORTRAIT thumbnail

Reported with the cover from a 16:9 run: a 1080×1920 image, the wide frame centre-cropped back to vertical. The production composition tracks the output settings through `calculateMetadata`; the cover composition — registered at a fixed 1080×1920 — had none, so it stayed portrait no matter what was rendered. The still `produce` extracted was already 16:9, and `objectFit: cover` then cropped it to fit the portrait canvas: a portrait crop of a landscape frame. The cover composition now carries the output `frame` and follows it, and two geometry rules follow the aspect with it — the profile-GRID square crop is dropped in landscape (it models Instagram cropping a 9:16 cover; a 16:9 cover is a YouTube thumbnail shown whole, and applying the square would squeeze the banner into the middle 56% of an already short frame), and banner type is set against the SHORT edge, since that is the one deciding how much of the thumbnail a headline swallows. The face rule is unchanged: the banner still routes off the head, inside the landscape safe area. Verified by re-rendering the real `Agents in 2026_landscape` workdir's cover frame at both aspects.

## 77. `.env` was never read

The provider keys are the one thing ossclip takes from the environment rather than `config.json` — secrets do not belong in a file that gets pasted into issues — but the only supported way to supply them was `export` in the calling shell. That is a poor contract for a tool launched from an editor, a script, or a replayed `command.json`: the key existed in the shell that ran `produce` and nowhere else, so provider auto-detection quietly picked something different (the same class of drift §75 pinned for the recorded argv). `ossclip` now loads `.env` before anything reads a key: `$OSSCLIP_ENV_FILE` → `.env` walking UP from the cwd (nearest first) → `~/.ossclip/.env`, first hit wins per key, and a real environment variable always beats a file so an explicit `GEMINI_API_KEY=… ossclip produce` cannot be overridden by a stale checkout `.env`. The run prints which files it loaded — paths only, never values. The upward walk is not a flourish: `pnpm --filter @ossclip/cli exec …` sets the cwd to `apps/cli`, so a repo-root `.env` — the only place anyone puts one — was invisible to a flat `<cwd>/.env` lookup, and the first run after the fix still died on `GEMINI_API_KEY is not set`.

## 78. A cached re-run erased who planned the video

Asked which projects had used Gemini and which Claude, two of five workdirs could not answer: `usage.json` read `records: []` and `report.txt` had no `llm` block at all. Cause: both files describe ONE run and are rewritten every run, and a fully-cached re-run legitimately makes zero calls — so the accounting of the run that actually did the planning was overwritten with an empty one. Only `command.json` (R11, so absent from older workdirs) still carried the `--llm` flag.

Three fixes, all in the same direction — provenance travels with the artefact:
- **`usage.json` is append-only.** It grows a `runs` history, one entry per run with its own provider, models, `cached` flag, records and totals. The top-level `records`/`totals` now hold the last run THAT MADE CALLS rather than simply the last run, so every existing reader keeps working and stops being lied to. A pre-§78 file is a valid input: it becomes the history's first record instead of an error.
- **`production.json` carries a `producer` stamp** — provider, models (editorial first, so the tiering is visible), `cached`, timestamp — beside the scenes it explains.
- **`report.txt` names the provider on a cached run** (`llm: no calls this run — planned by gemini (…), reused from the workdir cache`) instead of falling silent.

A cached run inherits both the provider and the models it is reusing, so a re-run's stamp is a continuous account rather than a gap. Verified against the real `.ossclip-fable5` workdir: a cached re-run kept its two Gemini records, added a history entry, and stamped `production.json`.

## 79. `ossclip backfill` — built, then removed

§78 stops the erasure going forward; the workdirs already flattened stay flat, so a `backfill` subcommand recovered their provider from each one's recorded `command.json` argv. It worked and was idempotent — and it was cut the same day. The whole population of affected workdirs is two directories on one machine, already recovered by hand; a permanent subcommand for a one-off migration is a surface every future reader has to understand and every future refactor has to carry. Recorded here rather than silently reverted: if a pre-§78 workdir ever turns up again, the recovery is a dozen lines against `usage.json` and the provider is sitting in `command.json`'s `--llm`.

# Round 17 — an editor that opens on nothing, and the everyday verbs done properly (2026-07-29)

*Status (remote session, same date): all eight asks shipped. 588 unit tests, 45 e2e.*

## 80. Undo had no partner

⌘Z existed since round 9; redo never did — an undo one step too far was simply gone, which turns every undo into a small gamble. The reducer's history was a single `past` stack, so this is the textbook completion: undo now pushes the current doc onto a `future` stack, redo pops it back, and any NEW edit clears `future` — the universal abandon-the-branch contract that makes redo safe to offer without a confirmation. `dirty` stays honest across the boundary (redoing back to the exact saved document reads as clean). Both verbs are also in the top bar now as the standard curved-arrow icon pair, enabled exactly when their stack is non-empty — the request's other half: undo/redo you can SEE. Keyboard: ⌘⇧Z, with ⌘Y for the muscle memory that expects it.

## 81. Find without next

The transcript search highlighted every match at once and stopped there — with 30 hits, "which one?" was answered by scrolling. The usual finder contract is now in: ‹ › chevrons beside the box, Enter/⇧Enter doing the same from the keyboard, a `3/7 matches` counter, wrap-around at both ends, and the CURRENT match painted brighter than its siblings and scrolled to centre. The cursor resets to the first hit as the query narrows.

## 82. View zoom stopped at 100%

The §55b magnifier clamped at 1× on the low side, so the preview could never be made SMALLER than the fitted size — but "fit" fills the stage, which is exactly when there is no slack to pan against while arranging an element near an edge. The floor is now 25%. Same mechanism as zooming in (the Player's real width changes, so `getScale()` and every gesture stay calibrated), same anchor math around the cursor; `fit` remains one click back to 100%.

## 83. NEW — `ossclip edit` with no argument, and switching projects in place

`edit` demanded a workdir path on the command line — the one part of an otherwise direct-manipulation tool that required remembering where a hash-named directory landed. The argument is now optional, and the workdir is server state rather than server identity:

- **Server**: `startEditServer` holds a mutable current-workdir (possibly none). `GET /api/production` answers `{ noWorkdir, recent }` until one opens; `POST /api/workdir` validates and switches (refused mid-render — the running child belongs to the OLD project); `GET /api/fs` is a directories-only browser with "this one is a project" flagged (local tool, loopback-bound — the same trust as typing the path as an argument). Every workdir-touching endpoint 409s while none is open.
- **Recents**: every successful `produce` run and every open records the workdir into `~/.ossclip/recent-projects.json` (capped, deduped, best-effort — a read-only home never fails a render). Deleted workdirs drop off at read time instead of 404ing a click.
- **Client**: a bare launch opens on the picker — recents plus the folder browser — and the top bar grew an **Open** button that raises the same picker as a switcher, plus a label naming the open project. Switching resets selection/preview/render state, loads the new overrides (fresh undo history), and warns first when unsaved edits would be lost. No server restart at any point.

## 84. The render log was six lines, forever

The R13 panel showed the last six lines of the captured stream — fine as a liveness signal, useless the moment something scrolled past. The tail is now the FULL ring buffer in a bounded scroll box that sticks to the bottom while lines arrive and un-sticks when scrolled up to read (scrolling back down re-arms it — the terminal-emulator contract). And the whole log — pinned cost lines included — collapses behind a `▾ logs` toggle in the status row, because once the spinner/elapsed/percent row exists (§R13), the raw stream is a debugging surface, not something every render needs on screen.

## 85. The transform audit — every element, grabbable

Asked to ensure ALL on-screen elements have transform capability. Audited every component in the scene library against the §47 machinery (drag to move, corner handles to resize, scale slider, retype): the generic path covers any node carrying `data-edit-id`, and the sweep found exactly ONE without it — TerminalMock's fan-out caption. It now has one. The audit's real product is the invariant to hold new components to: every visible element carries an edit id.

On the request's other half — dropping side-panel controls now that dragging works: **kept, deliberately.** The panel fields are the precision path (§47/§48 — exact numbers, locale decimals, reset buttons) and the only keyboard-accessible one; the stage is the fast path. Two paths to the same override is the standard editor UX, not duplication.

# Round 18 — launch hygiene: what has to be true before strangers read this repo (2026-07-29)

*From the OSS strategy audit (plan: `docs/superpowers/plans/2026-08-02-oss-launch-hygiene-and-highlight-selection.md`). Not features — the work of making the repo publishable under the author's real name. The repo was verified PRIVATE before the §86 purge, so the purge is an erasure, not a mitigation.*

## 86. The working materials could not ship

`reference/` held 30 tracked PNGs (46MB) of a commercial product's UI, and `BRAINSTORM.md` — the founding document — read as a teardown of it. Legitimate analysis to have done; needless to publish. Both are untracked, gitignored, and purged from ALL history with `git filter-repo` (deleting in a new commit would have left them one `git log -p` away). The docs that pointed at them now say the frames and notes were local to the author's machine and are not distributed; the BRAINSTORM §-citations across code comments stay, as historical anchors to a private document. The safer §86d default was taken — BRAINSTORM.md left the public tree entirely rather than being rewritten; the author's own clone retains it and a cleaned design-rationale rewrite can be published later if wanted.

## 87. The licence implied something false

Root LICENSE said MIT, unqualified; the README said "MIT — see LICENSE". Together they implied any company can render video with this for free — but Remotion is source-available under a two-tier licence, and for-profit companies above its stated size need a paid company licence. ossclip's own code stays MIT; a Licensing section in the README, a clearly-separated note under the MIT text in LICENSE, and a new docs-site section now link Remotion's own terms. The threshold numbers are deliberately not restated anywhere, so the note cannot go stale.

## 88. The README promised the wrong category

"Virality-optimized" led the public promise — the wrong register for the developers who can actually clear the install requirements, and attached to an implied long-form → short-form capability the tool does not have (§89). Rewritten mechanic-first, with the actual differentiator in the first screenful: LLM-planned, code-rendered graphics against the Zod-typed scene registry with its `whenToUse` contracts and fit guarantees. `PRODUCER_SYSTEM`'s internal virality grammar is untouched — it steers editorial choices and it works; the fix is to the promise, not the prompt.

## 89. Highlight selection — option B, the honest scope

The defining feature of the clip-tool category is not in this pipeline, and the findings log already said so (Round 12: "there is no highlight selection anywhere in the pipeline"). The author decision was between building `--clip <seconds>` (window selection between repair and analyze — the same word-index-invalidation risk class §17 fixed) and narrowing the promise. **Option B shipped**, per the plan's own default: the README and docs site now state plainly that ossclip polishes a take you have already cut, and that long-form selection is out of scope today. Option A remains open post-launch, when real users' long-form footage exists to test against.

## 90. The install cliff

Seven preconditions stood between a first-time user and a first frame, all reachable only through a monorepo clone. Two answers: **`ossclip doctor`** (§90a — every prerequisite checked with the exact per-platform fix printed per line, provider check running after the `.env` load so a file-supplied key is not a false negative, non-zero exit when anything is missing) and **npm packaging** (§90b — the CLI becomes plain `ossclip`, name verified available; core/scenes/renderer become publishable with pnpm rewriting workspace ranges at pack; sources ship because Remotion bundles the composition from `.tsx` at render time; the bin registers tsx from its own dependencies; prepack builds the editor page into `editor-dist/` so `ossclip edit` needs no build step). Verified by packing all four, installing the tarballs into a scratch project, and running the installed bin end to end. Publishing itself is the author's launch-day action.

## 91. The dormant app

`apps/studio/` was one README describing a UI that was never built — in a published tree that reads as abandonment, not ambition. Deleted.

## 92. Nothing ran the tests but me

597 unit tests and 45 e2e in the repo, and no CI — so a contributor's PR could not prove itself and a reviewer had to take "works on my machine" on faith. Two workflows: `ci.yml` (typecheck + unit on one job, editor e2e on another, since e2e needs the Vite build and a Chromium download that the fast job should not wait on) and `pages.yml`, which publishes `docs/site/` as the Pages site root. Deliberately NOT Pages' deploy-from-`/docs` mode: that would serve PHASE0, PHASE1 and this findings log as raw markdown at public URLs. Only the site directory ships.

Writing them surfaced a real one: the first full macOS run failed `§69-71` (playback keys / frame steps / exit fade), and the same test passed alone and in two subsequent full runs — a timing flake, not a regression, on a suite that drives a video element mounting and a render child spawning. A flaky red build teaches contributors to ignore the build, so `retries: 2` and `forbidOnly` are now on **under `CI` only**: three failures is still a failure, a retried pass is reported as flaky, and locally retries stay off so a flake surfaces while the person who can debug it is watching.

`CONTRIBUTING.md` covers the same gap for humans — how to run it, what to verify, and the two invariants (`overrides.json` is never written by the producer; every visible element carries a `data-edit-id`) that a newcomer would otherwise have to reverse-engineer.

# Round 19 — `--clip`: long-form in, one short out (2026-07-29)

*§89 option A, built per `docs/superpowers/plans/2026-08-03-clip-highlight-selection.md` with the author's two decisions in: sentence snapping at ±20% of the target, one clip only.*

## 93. `--clip <seconds>` — produce only the best window

The ordering constraint (§93.1) held: selection slices the transcript AFTER repair and BEFORE analyze/cut/captions/scenes, and the pipeline runs unchanged on the slice — `captions.ts` and `timemap.ts` are untouched, and the existing timemap invariants pass against a bounded cutlist by construction (the bound keeps a full partition of the source, so `outputDuration === Σ kept` never had a chance to break). One wrinkle the plan called and the code confirmed: repairs may CHANGE the raw word count (`applyRepairs` splices), so the raw transcript slices by TIME while the repaired one slices by the window's word range — slicing raw by repaired indices would misalign the two spaces `production.json` stores as a reproducible pair.

The window is ONE editorial call (§93d): `--clip` extends the beat-sheet schema with a required `highlight` (word range + one-line reason) and instructs the producer to plan every moment inside it. Resolution treats the returned indices as untrusted (§93e): clamped, order-checked, snapped to the nearest sentence boundary within ±20% of the target, trimmed from the TAIL at the sentence end nearest the target when over-long (the hook lives at the start), and REFUSED with the reason when what remains is under half the ask — never a silent fall back to the full take. After slicing, the beat sheet re-normalizes against the sliced transcript, so the graphics coverage budget is the window's, not the 20-minute take's.

The two traps from this repo's own history, closed: the scene cache key now carries the clip target AND the resolved window, keyed post-resolution so a replay that derives the same window hits the same entries (§93f — without this, a clip run and a full run of the same source collide, the §78 failure mode); and the resolved word range is pinned into `command.json` as `--clip-window start:end` (§93g, the §75 move), so the editor's Render replays the SAME window with zero LLM calls instead of re-asking a model that might answer slightly differently under every saved override.

§93b/c as specified: no `--produce` → hard refusal (no heuristic fallback — a bad automatic 60 seconds reads as a bug, not a limitation); a source at or under the target (+20%) → produced whole, with a line saying so. §93h: the console and `report.txt` state the window in m:ss, its share of the take, and the model's reason.

Exercised end to end on a synthetic 10-minute source with an injected 1200-word transcript and the mock provider: selection → sentence-snapped 59.9s window → sliced captions/scenes/zoom → `production.clip` recorded → cached re-run and `--clip-window` replay both reproduce the identical window with zero LLM calls. **Not yet run against real long-form footage with a real model and a watched render** — that is the verification that actually matters, it needs the author's machine (whisper + footage + eyes), and until it happens the README sells `--clip` as the newest, least-proven part of the pipeline. Known niggle, deliberately unscoped: the cover frame is still picked from the WHOLE source, so a clip's cover can come from outside its window — same speaker, same scene in practice, but worth a look on real footage.

# Round 20 — the first real landscape run talks back (2026-07-29)

*Feedback from producing a real 16:9 promo (`Upwork Promo`, 1:05 via `--clip 60` on a 5:21 take) plus a mid-run field failure. §94–§97 from the author's editor session; §98 from the run's own console.*

## 94. Nothing catered for contrast — now the over-video band does

The author asked the right question: "do we cater the color contrast of the text elements against the background? I don't think so." Correct — nothing did. Legibility depended on WHICH component the producer picked (StatCard and RuleCard carry `cardBg`; TitleCard and StrikethroughReveal are pure typography) and on whatever pixels happened to be behind it — white type over a bright wall, as the run's first frame showed. The fix is at the LAYOUT level, not per component: layouts whose graphic slot sits over live video (`lower-third`, and `full-bleed`'s fallback band) now draw a frosted scrim under the slot — theme-bg tint at 0.55 over a 14px backdrop blur, theme radius. Slot-shaped rather than a broadcast bottom-gradient deliberately: it follows the box when the editor drags or resizes it, and one fix covers all nine components instead of nine backplates. Carded components layer on it harmlessly; everywhere else the graphic lands on the stage background, whose contrast the theme already owns.

## 95. All scenes were the same length because the cap said so

Observed on the timeline: every scene ~5s, and the lower-third stat card leaving before its sentence finished. By design — `MAX_SCENE_SEC = 5` is the §3/§4.5 pattern-interrupt rule — but the design reasons from a graphic that TAKES the frame, and a lower third never does: the speaker stays full-bleed the entire time, which is why broadcast lower thirds hold. The cap is now layout-aware: `lower-third` holds through its whole moment (the sentence) under a 15s ceiling; frame-taking layouts keep the 5s punch-out. Scene lengths now vary naturally with their moments.

## 96. The inputs learned the editor-native gesture

From the Filmora reference: every numeric field's LABEL is now a scrub handle — press and slide left/right to adjust, with per-field sensitivity (1px/px for element nudges, 0.002/px for frame fractions, 0.01/px for scales); a plain click still focuses the field for typing, and the §48 locale/draft semantics are untouched. Scrubs commit per move under the caller's fixed coalesce key, so one scrub is one undo step — the same contract the sliders already held. X/Y and W/H pairs sit on one line. Applied to every NumberField in the Inspector: element x/y/scale, video scale/dx/dy, pip x/y, graphic box, caption scale, theme radius.

## 97. The timeline reads like a timeline now

Two inspirations taken, not copied: a graduated ruler (major/minor ticks with labels, density chosen from the current zoom so labels keep ~70px of air) and filmstrip thumbnails on the plain takes — one frame per take at its midpoint, seeked from a detached video element through the spans (output→SOURCE time, so a thumbnail past a cut shows the right footage), drawn behind a dimming gradient so the label survives. Graphic scenes deliberately keep their flat card look: their block is not footage. Thumbnails are decorative and fail silent — a missing file just leaves the flat panel.

## 98. The repair call died of its own token budget — and said "JSON error"

Field failure on the first real long-form run: `transcript repair unavailable: Unterminated string in JSON at position 401`, after burning 5,952 in / 3,993 out tokens — over half the run's cost — on unusable output. Root cause was NOT malformed generation: the repair call's flat `maxTokens: 4000` was sized for 30–70s takes, and on a thinking model the thought tokens draw from the same budget — ~3,900 thinking left ~100 for the answer, truncating the JSON mid-string. Three fixes, none of them a framework: (a) the Gemini provider now sends a native `responseSchema` (converted from the zod schema to the API's OpenAPI subset — literal unions flatten to enums, nullables fold, records fall back to prompt-stated JSON mode; repair/beat/clip schemas are pinned convertible by test) so the decoder emits only schema-valid JSON — the guarantee the author asked genkit for, from the API itself; (b) a `MAX_TOKENS` finish is now reported as the truncation it is, with the thinking share named, instead of surfacing as a syntax error at some position; (c) the repair budget scales with the transcript (4000 + 10/word, capped 32k) and the call retries once before failing soft. The Anthropic provider already had all three properties (SDK structured output, explicit truncation error) — verified, untouched. Claude CLI structured output rides the CLI's own JSON mode as before.

# Round 21 — second pass on the real promo (2026-07-29)

*Seven items from continued editing of the Upwork promo. §99–§103 are editor behaviour, §104–§105 product honesty.*

## 99. The scrub belongs on the input

R20 §96 put drag-to-scrub on the LABEL; the reference (and the author) put it on the FIELD. Moved: an unfocused input is the scrub surface — press and slide adjusts, a clean click (≤2px) focuses for typing, and a FOCUSED input is a plain text field again (drag selects text) until blur. `preventDefault` on pointerdown keeps the browser from focusing mid-gesture; the §48 locale/draft semantics and every testid are unchanged.

## 100. The band had no air, and a list cannot live there

Two symptoms, one band: content touched the scrim's edges (zero visual padding), and a BulletList rendered clipped — its 36px legibility floor cannot fit four rows in 0.18 of frame height, and §6a clips rather than shrinking into illegibility. The band now insets its CONTENT (12% of slot height, capped 24px) while the scrim keeps the full slot, and the real fix for stacks is §101: they don't belong in a lower third at all.

## 101. Landscape variety — the producer had settled into one layout

The first real 16:9 run put nearly every graphic in a lower third. Legal, monotonous, and for stack components broken (§100). Two moves: the beat prompt now carries a landscape hint (vary across lower-third/split-left/split-right/blurred-behind, never twice in a row, no stacks in the band) — and because a prompt is a steer, not a guarantee, a deterministic variety pass after the landscape remap enforces both rules in time order. The editor's per-scene layout override still wins over everything.

## 102. Shortcuts that died with focus, and a walk with no starting point

Two real traps: ⌥+arrows did NOTHING with no selection (the walk had no entry point — it now starts at the first scene, ⌥← at the last), and a focused field held every shortcut hostage until a click elsewhere — Escape now blurs the field first (keeping the selection), so the keyboard always has a way back out. Text-entry guards otherwise unchanged: arrows in a field still move the caret, space still types a space.

## 103. The picker was listing every dotfile directory in $HOME

"I thought open would just be a folder picker." It is — but it listed hidden directories too, and a dev home has dozens, so the browse pane read as a wall of anonymous dots. Hidden directories are now omitted with ONE exception made useful: `.ossclip`'s projects surface INLINE (browsing ~/Downloads shows `▸ .ossclip/Upwork Promo-…` directly), so the convention directory never has to be known. A native OS picker is not available to a local web page that must hand the server a filesystem PATH — the in-app browser stays, decluttered.

## 104. The video now says who made it and what it cost

`GET /api/usage` serves the accounting `produce` already writes (usage.json totals + the production stamp), and the Inspector's no-selection view shows it: provider and models, calls, tokens (estimation flagged), cost — billed, or API-equivalent for subscription runs — and the clip window when there is one. Pricing research corrected one stale family: opus repriced at 4.5 to $5/$25 (was $15/$75), verified against current published rates; gemini-3.6-flash at $1.50/$7.50 was already right. The README's override example now shows the real numbers.

## 105. The standard honesty line

"AI can make mistakes. The cut, captions and graphics are generated — review before publishing." — in the editor's side panel (always, LLM run or not: the cut and captions are machine-derived either way), at the end of every report.txt, in the README, and on the docs site.
## 106. A failed repair pass cached itself as "nothing to repair"

Found while re-running the Upwork promo to verify §98. The §98 fixes were correct, and the re-run still skipped repair entirely — because the FAILED run had written its empty result to `repairs-<key>.json`. `repairTranscript` fails soft by design (a dead provider yields zero repairs, never a failed render), and zero repairs on disk is indistinguishable from "this take needed none": every later run read `[]`, reported `repairs cached (0)`, and never called the provider again. The failure was permanent and un-retryable short of deleting the file by hand — the same shape as §78, an artefact describing a state other than the one it was produced under.

A failure is now never cached; only a completed pass is. Verified on the real workdir: after clearing the poisoned entry, the pass ran and landed four corrections the first run never made — `"work!" → "world!"`, `"developers" → "Developer"`, `"5000 fortune" → "Fortune 500"`, `"codecs," → "Codex,"` — at 2,172 output tokens against the truncated run's 3,993. Note the report lists only the repairs inside the clip window (the report describes the CLIP), while the console lists every repair found across the take; both are honest about their scope.

## 107. The selected box should move from its boundary — and so should the bubble

Selecting a scene drew the blue dashed box with resize handles, but the only MOVE surface was an invisible 10px strip along the top edge — dragging the boundary the selection visibly draws did nothing. Now every edge of the boundary is a move grip with the move cursor; the body stays click-through on purpose (element selection inside the box depends on it). The audit for the same gap found one more: the PiP bubble had numeric x/y (R14 §52) but no direct manipulation — dragging it panned the video INSIDE the bubble. Plain drag now moves the BUBBLE (with the move cursor announcing it); ⌥-drag keeps the framing pan, consistent with ⌥ meaning "pan" everywhere else on this stage. Both drags coalesce to one undo step, like every other gesture.

# Round 22 — launch execution (2026-07-29)

## 108. The repo shipped its assets, its name and its package metadata

Launch runbook steps 0–2, executed. **Freeze check** green on macOS at the launch tip: typecheck, 626 unit tests, editor build, 45/45 Playwright; a fresh full clone carries no withdrawn material on any ref.

**Assets.** A produced frame heads the README and the docs site; an editor GIF sits where the editor is described. They live in `docs/site/assets/` — ONE copy, served as the Pages site root and linked from the README by repo-relative path, because Pages publishes only `docs/site/`. The recording masters stay out of git (`docs/assets/`, ignored): the UI moves every round, and each re-record would otherwise be another 17MB in history forever. The shipped editor asset is a GIF, not the MP4 master, for a mechanical reason — GitHub renders a GIF inline on a README, and a repo-relative MP4 in a `<video>` tag does not render at all. `CONTRIBUTING.md` carries the regeneration command and the ~8MB budget.

**`main` became the launch branch** by fast-forward, not force: the cleaned initial commit was an ancestor of the working branch, so nothing was discarded.

**The repo is now `AhsanAyaz/ossclip`** — the tool's name, matching the npm package a reader is told to install on the first line. Every `repository.url` follows it.

**Package metadata.** All four packages published blank-page-ready: none carried a README, which is what npm shows when a package has none. Each now ships one — the CLI's is a real landing page (absolute raw-GitHub image URL, since npm cannot resolve a repo-relative path), the three libraries' say what they are, that the CLI is the supported entry point, and that their APIs move between rounds. `homepage`, `bugs` and `author` added alongside. Verified by `npm pack --dry-run`: README present in every tarball, `editor-dist/` present in the CLI's.

## 109. Published

Steps 3 and 4 of the runbook, executed. `ossclip@0.1.0` plus `@ossclip/core`, `/scenes` and `/renderer` are on npm under a free (public-only) org; the repo is public at `github.com/AhsanAyaz/ossclip`; the docs site is live at `ahsanayaz.github.io/ossclip` via the Pages workflow, assets and all; CI runs green on main on free public runners.

Two things worth writing down. **A scoped package can be published, owned and public and still 404 on `npm view` for a few minutes** — the write path and the read replica are not the same system. `npm access get status` answered "public" while `npm view` was still 404ing, which is the pair of commands that separates "the publish failed" from "wait": one asks the registry, the other asks a cache. Nothing needed republishing. **The CLI published before its libraries**, so for those minutes `npm i -g ossclip` failed on a dependency that did not exist yet — harmless because pnpm had already rewritten `workspace:*` into exact `0.1.0` ranges at pack time, so publishing the libraries afterwards satisfied the CLI already on the registry. Publishing libraries first (as the runbook says) avoids the window entirely.

Verified from the registry on a clean shell: `npm i -g ossclip` then `ossclip doctor` — seven of seven checks pass, including the editor page resolving to the `editor-dist/` the `prepack` step bundles.

## 110. Nothing had a link preview

Neither surface a shared link lands on had one. The docs site carried a `<title>` and a description and no Open Graph tags at all — posting the URL anywhere would have rendered a bare blue link. GitHub had no social preview image, so a shared repo link fell back to the auto-generated owner-avatar card.

One asset serves both: `docs/site/assets/social-card.png`, 1280×640, rendered from a small HTML card through the Playwright chromium already in the repo — so it is reproducible, matches the palette exactly, and re-renders in seconds when the wording changes. The site's `og:image`/`twitter:image` point at it with ABSOLUTE URLs, deliberately: a relative `og:image` is ignored by most unfurlers, which fails silently and looks identical in local testing. The GitHub upload is manual — the social-preview image is the one repo setting with no API.

Caught while making the card, and worth more than the card: the README and the site were both captioning `render-example.png` as "a produced frame — the speaker full-bleed, word-timed captions, a stat card in a lower third". It is a screenshot of the TERMINAL during a produce run. The image was fine; the words under it described a different image entirely, on the two pages a stranger reads first. Fixed to say what it actually shows.

## 111. The published package was missing a file every real source needs

Found by the author running the PUBLISHED `ossclip` on a fresh source, minutes after launch: `ENOENT … @ossclip/core/assets/facefinder`. `@ossclip/core@0.1.0` shipped `files: ["README.md", "src"]`, and `face.ts` loads the vendored pico cascade from `../assets/facefinder` — 234KB that was never in the tarball.

Why nothing caught it: in this workspace `@ossclip/core` resolves through a symlink to the whole package directory, so the file is always there. Every local run, all 626 tests, the CI matrix and even the R18 tarball-install smoke test passed — that smoke test ran `doctor` and `--help`, which never touch face detection. The failure needs a real source AND the published layout at once. The mixed-framing path hit it immediately.

Fixed by adding `assets` to core's `files`, and guarded by a test that reads the SOURCE for every `new URL("../…", import.meta.url)` it loads and asserts each path is inside a `files` entry — so a future runtime asset that nobody packs fails in CI instead of in a stranger's terminal. All four packages go to 0.1.1 together: pnpm freezes `workspace:*` into EXACT versions at pack time, so a CLI pinned to `@ossclip/core@0.1.0` would keep resolving the broken tarball no matter what 0.1.1 contained.

The wider lesson for a first launch: a smoke test that installs the package and runs `--help` proves the bin resolves, nothing more. The install path is only really verified by doing the actual work on real input.

## 112. An invented filename killed the render four minutes in

Second failure on the published package, same first run: `Error loading image with src: http://localhost:3001/public/claude.md` — after transcription, repair, planning, framing normalization and 40% of the render. The take talks about `CLAUDE.md`, so the producer filled `ScreenshotFrame`'s optional `src` with `claude.md`, a file that exists nowhere near the video. Remotion treats an unloadable image as fatal, so a hallucinated seven-character string cost the entire run.

The component was already built for this: `src` is optional and its absence draws a styled placeholder frame — the intended look, used by every ScreenshotFrame the producer plans without a real image. The gap was that nothing checked the string pointed at anything. `produce` now drops any `src` it cannot find in either directory that can become the render's public dir (the workdir for the mezzanine path, the source's folder for `--no-mezzanine`), warns, and renders the placeholder. Same shape as the §22 CTA-keyword rejection: LLM output is untrusted input, validated where the pipeline can still degrade instead of at the point where it can only die. The schema's `.describe()` now tells the producer to omit `src` rather than guess, but the strip is the guarantee — a prompt is a steer.

The class is worth naming, because §111 and §112 are the same bug wearing different clothes: **a fatal failure that only appears on real input, late, after expensive work**. One was a file the packager forgot, the other a file the model invented. Both were invisible to 628 tests and a green CI, and both surfaced within minutes of a stranger-equivalent run. The check that catches this class is not another unit test — it is running the published thing on real footage before telling anyone about it.

## 113. `--version` reported the number a developer typed

`ossclip --version` said `0.1.0` on a machine with 0.1.2 installed — the string was a literal in `index.ts`, written once at R18 and never touched again, while `package.json` moved three times. The install was correct; the field a user reads to tell you what they are running was not. Every bug report from a stranger would have been filed against the wrong version, and the first debugging step — "are you on the latest?" — would have answered no when it meant yes.

Now read from the manifest at startup (npm packs `package.json` regardless of `files`, so it resolves in a published install), and guarded by a test that fails on any `.version("<digit>…")` literal in the CLI source. Same family as §111/§112 in the way it hid: correct in the repo, wrong only once installed, and invisible to every test that ran inside the workspace.

# Round 23 — post-launch: the graphic leaves before the point is made (2026-07-30)

## 114. Scenes span their moments now

The launch-week complaint, on real footage: a scene starts on the right context and then LEAVES while the speaker — and the captions — are still on it. Two mechanisms produced that, stacked. `MAX_SCENE_SEC = 5` clamped every frame-taking layout's cue to 5 seconds regardless of its moment's span (§3's fix for 10-second static cards; R20 §95 had already excepted lower thirds), and `PRODUCER_SYSTEM` itself asked for "5-10 seconds of speech" moments with graphics that "hold at most ~5 seconds, then hand the frame back" — so even a correctly-spanning cue was anchored to a moment that under-covered its own discussion.

Both ends fixed to one rule: **a graphic holds through the whole moment that motivated it.** Assembly clamps at a single 15-second ceiling for every layout (the lower-third exception generalized; the ceiling is a safety net for a rambling moment, not the normal exit), and the prompt now asks for moments that span the FULL stretch of speech about their beat — typically 5-15 seconds — with the graphic explicitly staying up until the speaker moves on. The pattern-interrupt rhythm the 5s punch-out used to enforce now comes from where it belonged all along: the coverage budget prices a graphic at its FULL span (the §7 scheduler stops pretending a 12-second card costs 5), which means fewer, longer graphics under the same 40-50% coverage — the trade §114 makes deliberately, and the §7/§8 test is repriced to match. Verified on the synthetic clip workdir: scenes that clamped at 5.0s now run their full 14.4s moments, and a scene straddling the clip's end still truncates at the output boundary.

Existing workdirs pick this up on their next `produce` run without re-planning — the cue spans are derived at assembly, so a cached plan gets the new durations for free; only NEW plans see the reworded prompt. Editor-retimed scenes (pinned timing) are untouched, as ever.

# Round 24 — two captions on one frame (2026-07-30)

## 115. Adjacent sequences overran by a frame

Spotted while recording a new demo: at 46.00s two caption lines rendered on top of each other, "And number five" stacked over "your rules." at two different heights. The obvious suspect was the caption timings, and they were innocent — all 77 lines were contiguous to the millisecond, zero overlapping pairs. §6b's breakpoints had done their job: the outgoing line ended at exactly 46.000 and the incoming one started at exactly 46.000.

The defect was one layer down, in the seconds→frames conversion:

```ts
const from = Math.round(line.start * fps);
const durationInFrames = Math.max(1, Math.round((line.end - line.start) * fps));
```

Two independent roundings. The last frame is `round(start·fps) + round(duration·fps)`, which is not `round(end·fps)` — when the start rounds down and the duration rounds up, the window reaches one frame past its end and lands on the next window's first frame. For the pair above: `round(45.25×30) = 1358`, `round(0.75×30) = 23`, last frame 1380; the next line's `from` is `round(46.0×30) = 1380`. Both drew on frame 1380.

**8 of that render's 76 caption transitions collided.** Only 3 were visible, and the reason is the interesting part: those 3 straddled a scene-cue boundary, so the two lines resolved to *different* anchors and stacked at different heights. The other 5 overlapped exactly and read as a one-frame bold flash — present in every render ossclip has ever produced, and invisible. Earlier 3-scene renders of the identical source looked clean at the same timestamp because they had fewer cue boundaries, not because they had fewer collisions. A latent per-boundary defect gets more *exposed* as scene counts rise, which is a trap waiting for the §116 floor.

The same idiom appeared at all three adjacent-`<Sequence>` sites, so all three are fixed, not just the reported one: captions (two lines), `SceneLayer` (**two graphics on screen**, the worst of the three) and `EdlVideo` (two video spans, plus a fade ramp measured against a length that was one frame long). The invariant now lives in one place, `frameWindow` in `packages/scenes/src/frames.ts`: **the end frame comes from the end time, never from a rounded duration.** Sub-frame windows still get one frame on purpose — a zero-length `<Sequence>` renders nothing, and a caption that never appears is worse than one that briefly shares a frame.

Guarded by `packages/scenes/test/frames.test.ts`, which asserts the invariant against the verbatim 45.25/46.00/46.76 timings, all 77 real line spans, and a cross-fps sweep — and asserts that the *old* idiom collided on exactly 8 of those transitions, so the regression cannot quietly stop testing anything. Verified on a re-render of the same workdir: 45.97s, 46.00s and 46.03s now each carry one caption.

## 117. `tar` on Windows is whichever tar PATH found first

The first three-OS `setup-e2e` run: macOS green, Linux green, Windows failed both archives with `tar exited 128`. The model downloaded fine and its path was written to `config.json`, so the download and config halves were never in doubt — only extraction.

`extractArchive` spawned a bare `tar`. On Windows that resolves through PATH, and any machine with Git for Windows installed — every GitHub runner, and most developer boxes — puts MSYS **GNU** tar ahead of the system bsdtar at `%SystemRoot%\System32\tar.exe`. GNU tar cannot read a zip; it exits 128. The §90 design note ("Windows 10+ ships tar.exe, which reads zip *and* tar.gz") was true about the OS and wrong about what `tar` means on a real box.

The fallback that existed for exactly this did not fire, which is the more instructive half. `Expand-Archive` was wired to the child's `error` event — that is ENOENT, "the binary isn't there". A binary that *is* there and exits nonzero takes the `exit` path, which rejected. So the recovery path was reachable only in the one scenario it was least needed for.

Now: on win32 the system bsdtar is tried by **absolute path first**, then bare `tar`, then `Expand-Archive` for zips — and a candidate failing for *any* reason (spawn error or nonzero exit) falls through to the next rather than throwing. `tarCandidates` is pure over an injected platform and env so the ordering is unit-tested without a Windows box.

One bug inside the fix, caught by that test on the first run: the candidate path was built with `join`, which uses the *host* separator, so a Windows path assembled on macOS came out `C:\Windows/System32/tar.exe`. `win32.join` is the correct API when the platform is a parameter rather than the environment.

Also fixed from the same run, in the workflow rather than the product: the end-to-end transcribe step passed a relative `sample.mp4`, and `pnpm --filter ossclip exec` runs with the cwd set to `apps/cli` — the identical cwd quirk `env.ts` documents for `.env` lookup. Linux's `setup` step had in fact fully succeeded; only the step verifying it was wrong.

# Round 25 — the producer was never told how many graphics to plan (2026-07-31)

## 118. Three limits stacked, and none of them was the coverage budget

Chased from a real complaint — "the graphics aren't good enough to show off". The measurable version: a 64s take that enumerates five features out loud got **three** graphics on the default model, and five on a stronger one. §116 blamed the missing floor above `SHORT_TAKE_SEC`. That was one third of it, and the least important third.

Three limits were stacked:

1. **Nothing stated a count.** `GRAPHICS_COVERAGE_TARGET = 0.45` reads like a target and is only a ceiling: the scheduler demotes when the model plans too many and is silent when it plans too few. On this take, 45% of 64s allowed roughly 29 seconds of graphics; three graphics used far less, so **the demote loop never executed once**. No existing mechanism had an opinion about under-planning.
2. **The prompt steered away from density.** The COVERAGE line said graphics "spend their whole moment against that budget, so **be selective**". §114 made every graphic hold its full moment and repriced the budget accordingly — and the prompt's advice for living within that reprice was to plan fewer graphics rather than shorter ones.
3. **`moments` was capped at 12.** With the mandated alternation between graphic and "none" moments, twelve moments is a hard ceiling of ~six graphics at any length. A five-feature take needs seven graphic beats — hook, five features, payoff — and therefore ~14 moments. **The schema cap was binding before the coverage budget ever was.**

Fixed at all three: the cap is 24; the prompt asks for shorter moments rather than fewer when the target is high; and the user prompt now states an explicit count. The count comes from `graphicsTarget` — the larger of runtime density (one per 9s, the density the prompt's own "no stretch longer than ~10s" rule implies) and structure. Structure is free and deterministic: `countEnumeratedBeats` reads the take counting itself ("number one… number two", "first/second", "step 3"), counts *distinct* ordinals so a repeat doesn't inflate, and requires at least two so "first of all" isn't a list.

**The floor was deliberately NOT extended above 45s**, against §116a's first instinct. A count floor that outranks the percentage at every length fights §114: more graphics × full spans exceeds 45%, the demote loop starts removing what the floor just required, and the two rules oscillate. It would also be aimed at the wrong failure — when the producer under-plans, that loop never runs, so no floor there could have helped. §29's short-take floor stands unchanged; above it the count lives in the prompt, and the scheduler's job is only to say when the result missed (§118b).

Verified on the same 64s take, same model, fresh plan: **3 → 6 graphics**, with `scene-12` present — a beat the old cap made structurally impossible. 679 tests green, including the §7/§8/§114 ceiling tests, which still pass unchanged: the ceiling was never relaxed.

**Deviation from §116b, stated plainly:** the shortfall is reported on the console with every other beat-sheet issue (`⚠ moment -1: graphics: 6 of 7 planned — the take enumerates 5 points`), not in `report.txt`. Putting it in the cut report would separate it from the issues it belongs with. If the report is where it is wanted, that is a small plumbing change, not a redesign. *(Closed in R26 — the report was where it was wanted.)*

# Round 26 — the accounting reaches the report, measured against the stated ask (2026-07-31)

## 118b. Closed — and the ask it measures against is now the ask that was made

The plumbing §118 deferred, plus one defect found while doing it.

`report.txt` now carries the graphics accounting on every produced run — `graphics: 6 of 7 planned — the take enumerates 5 points`, followed by the scheduler's demotions — next to the cut justifications, where §116b always wanted it. The line prints whether or not the run under-delivered: a count that merely *meets* its target is also a fact worth one line in the artefact people forward. It survives cached re-runs the same way the provider stamp does (the §78 posture): the accounting and the beat-sheet issues are cached alongside the beat sheet, so a re-render's report keeps saying what was asked and delivered instead of silently dropping the section. A pre-§118b cache simply omits the section rather than guessing.

The defect: the shortfall check measured against the wrong ask on `--clip` runs. `normalizeBeatSheet` derived its target from the transcript's own span — the FULL take — while the prompt had stated the clip-length target. A 5-minute source clipped to 60s would be measured against the span-derived cap of 12 when the model was asked for 7, reporting a shortfall the model never had; and the post-slice renormalization would then report it a second time. Now `generateBeatSheet` computes the ask once — the same number, from the same pure functions, that `buildBeatsUserPrompt` states — threads it into the check, and the pre-slice pass of a clip run skips the check entirely (the post-slice pass owns it). One formatter (`formatGraphicsAccounting`) builds the line for the console issue and the report alike, so the two can never disagree about the same run.

Also from this session, in the docs rather than the code: the authoring plan had reserved findings numbers ahead of the work (§118–§122), and R25 took §118 first. The plan's items are renumbered §119–§123, and the rule is now written where it was broken: a plan reserves no numbers; a finding takes the next free one when it lands. §116 stays a hole in the log for the same reason.

# Round 27 — the source was portrait all along (2026-07-31)

First real-footage run of a joined five-clip take ("What Is An Agent Loop", 85s). Four visible defects were reported off the render; three of them turned out to be two bugs, and the fourth was a feature the take asked for by name.

## 119. The rotation matrix was ignored, and everything compounded from there

The camera wrote a **portrait** recording as a 3840×2160 stream plus a `rotation=90` display matrix. The displayed frame is 2160×3840 — **already 9:16, the exact target aspect, needing no crop at all.**

`probe()` (`ingest.ts`) read `width`/`height` straight off `ffprobe -show_streams` and never looked at `side_data_list`, so the pipeline believed the source was landscape. But ffmpeg's *filter chain* auto-rotates, so every measurement taken through ffmpeg — cropdetect, face, the mezzanine — was already in the displayed space. Two orientations, one reconciliation:

- cropdetect honestly reported `crop=2160:3840:0:0`: the full frame, no bars (verified — minimum column luma 103, where a real bar is ~0–16).
- `stableContentRect` clamped that 3840-tall rect against a frame it believed was 2160 tall, and the union came out **2160×2160** — a square that was never on screen — logged as "source is letterboxed".
- The bottom 44% of the picture was then cropped away, `sourceAspect` went to the stage as 1.00, and `object-fit: cover` into 1080×1920 kept 56.25% of what was left.

Net **~1.8× magnification on a source that needed none**, which is the "over-zoomed" complaint. The animated layers were innocent all along: `ZOOM_MAX_SCALE` 1.05 × the 1.07 punch-in is 1.1235, and the diagnosis wasted time on them first.

Fixed at the source: `probe()` reads the display matrix (both the modern side-datum and the legacy `rotate` tag), normalizes to 0/90/180/270, and **swaps width/height on a quarter turn** so the whole pipeline sees what ffmpeg sees. `Probe` records the rotation so a workdir says why its geometry is what it is.

Second guard, at the place that produced the nonsense: `stableContentRect` now **refuses a measurement that does not fit the frame** and returns the whole frame instead. A rect that overhangs was taken in a different coordinate space, so nothing it says can be trusted — the same posture `MIN_CONTENT_FRAC` already takes toward an implausibly small rect. Clamping two disagreeing geometries together produced a plausible-looking number, which is worse than refusing.

## 120. The source-text scan fired on the room, and shrank every graphic

`scanSourceText` ran unconditionally; `--source-is-edited` only *added* assumed bands. On a raw take at a desk it read the background monitors as **45 bands** of "source text", and `placeInFreeBand` then moved and shrank every graphic to dodge them. The cost was not cosmetic:

| scene | authored slot h | routed to | consequence |
| --- | --- | --- | --- |
| BulletList | 0.36 | 0.15 | height budget 288px → font pinned at the 36px floor |
| ScreenshotFrame | 0.36 | 0.25 | slid onto the speaker's face |
| FlowDiagram | 0.54 | 0.27 | stack font 71 → 35 |

So the tiny bullets, the screenshot over the face and the tiny flow diagram were **one bug wearing three hats** — and none of them was a fit-contract bug, which is where the investigation would naturally have gone.

The detector cannot tell burned-in *graphics* from text that is merely in the room, and only the user knows which they have. The scan is now behind `--source-is-edited`. Routing around a hazard pays only when there is a hazard.

**Left open, deliberately, and pinned as a failing test:** routing never consults `layoutSlots(...).video`, so a dodging graphic can still land on a primary video slot. `blurred-behind`/`full-bleed`/`lower-third` intend that overlap; `video-top` and the splits author their graphic slot *clear* of the video, and routing violates it for all three. `source-fit.test.ts` asserts the separation holds today (it does) and uses `it.fails` to pin the violation — when routing is made video-aware the pinned test starts erroring, which is the reminder to promote it.

## 121. BulletList under-fills, and the reason is not tunable

With the routing bug gone the residual is real but small, and worth stating precisely rather than "fixing": in the motivating slot (842×806) the four real bullets solve to font 59 from the WIDTH term and 101 from the height term, so the stack fills ~55% and **the leftover height cannot be spent**. Items are `whiteSpace: nowrap` by design — a wrapped bullet stops reading as a list — so growing the font would overflow horizontally. `bulletMetrics` returning `min(widthFit, heightFit)` is correct.

Two genuine model errors fixed: the kicker title was charged `1.1em` of height while rendering at `0.36em` (≈0.88em with its gap), and its `0.28em` tracking was not modelled for width at all, so a long kicker could overrun the slot unbudgeted.

The fill test that should have caught the under-fill did not exist — the general fill assertions skip self-fitting components, and the one bullet test used 2-character items so width never bound. It exists now, and it pins the 55% as a documented trade-off rather than hiding it. **Spending the leftover height is a design decision** (allow a two-line item, or widen the slot), not a tuning one, and is not taken here.

## 122. Blooper removal by spoken marker — the deterministic subset

The take contained the pattern twice, unmistakably: a flubbed attempt, the word "blooper", another flubbed attempt, "blooper", then the good take. The marker *terminates* a bad attempt, so removal runs backwards from it to the start of the sentence it spoiled, and consecutive marked attempts collapse into one cut.

`--blooper-marker <word>`, off unless given. Opt-in matters here: this very take says "the cases where you can say blooper", so an always-on default would eat real content in a video *about* bloopers.

The authoring roadmap treats retake removal as inherently semantic and therefore as the thing that would end the guarantee that `buildCutlist` is a pure function of (raw transcript, analysis, duration, level). **A spoken marker is the third option that document did not consider** — not accepting a semantic stage, not approximating semantics deterministically, but letting the speaker supply the semantics at record time. The word is in the transcript or it is not. The spans arrive as an argument; `buildCutlist` stays pure.

Everything the roadmap predicted about the mechanics held. Removals are injected before the existing sort/merge, so they inherit merging with the silence bracketing the flub, `MIN_KEEP` sliver folding, and the partition emit; `reason: "retake"` was already in the schema with zero emitters; report, `TimeMap`, scene dropping, caption re-derivation and `EdlVideo` needed **zero changes**. The interior three-way split of a `keep` — the case `--clip` cannot do, since it only clamps against the two outer boundaries — falls out of the cursor walk for free.

Detection runs on the RAW transcript, before repair, and that ordering is load-bearing: the repair pass reads a bare "blooper." as an oddity and was observed proposing "break loop." for it twice. Detecting first means the marker cannot be rewritten out from under the detector. `--cleanup exact` still wins over the flag — "touch nothing" outranks a request to cut, and the more conservative flag wins rather than the one typed last.

Real run: 7.86s removed as one `retake` cut, both attempts gone, "That could be the exit condition." intact, and `report.txt` quotes the words it took — a cut that takes whole sentences owes more than a timestamp.

## 123. `.max()` on model copy was a die-here boundary

Two of three real produce runs exited 1 at Zod with `moments.N.onScreenCopy: expected string to have <=60 characters`. The model returned 61 characters and the run threw away transcription, analysis, the cut, and the whole beat sheet.

§112 says LLM output is untrusted input, "validated where the pipeline can still degrade instead of at the point where it can only die". A bare `.max(n)` on free text is exactly the second kind, and truncating an over-long headline is an obviously safe degradation. `cappedText(n)` wraps the constraint in `z.preprocess`, which **keeps `maxLength: n` in the JSON schema handed to the provider** — the model is still asked for the limit — while truncating at a word boundary if it misses. Applied to `hook`, `coverText`, `purpose`, `onScreenCopy` and `rationale`.

This was logged in R26 as deserving its own round and deferred; it then blocked the R27 verification run twice, which is its own argument. Frequency was the thing the first sighting got wrong — "non-deterministic" read as "rare", and it is not.

**Carried forward:** truncation is silent. The provider seam has no channel for a repair note, and inventing one was out of scope here. If a truncated headline ever reads wrong on screen, that silence is the first thing to revisit.

## 124. A 0.37s wordless sliver survived between two silence cuts

Field report: a silent chunk visible near a scene around 0:32 of a 90.50s output (`anthropic-ci-compiler-03857547`, 122.33s → 90.50s, `--cleanup standard`). `production.json`'s `cutlist` pins it exactly: `{srcIn: 50.009125, srcOut: 50.379375, kind: "keep"}`, sandwiched between two `silence` removals (`44.38875→50.009125`, `-5.62s`; `50.379375→54.119188`, `-3.74s`). Summing removed duration ahead of it places the surviving sliver at output `31.956s–32.326s` — "around 0:32" to the frame.

Not §(a): scenes don't touch `buildCutlist` at all — `cutlist.ts` has no notion of a scene, and scenes anchor to *word indices*, computed downstream. The bracketing scenes here (`scene-5`, words 77–87, ending 44.32s; `scene-6`, words 88–114, starting 54.08s) sit entirely outside the whole 44.32–54.08s dead-air stretch, not overlapping it. There is no pin to refuse.

Not really §(b) either, despite the letter of it: `deriveThreshold` measured this take's threshold at −27.56dB (`speechDb −12`, both headroom bounds satisfied — a well-behaved calibration, not a globally "hot" floor; the other 12 cuts in the same report prove the take-wide threshold works). What actually happened is local: `ffmpeg silencedetect` (operating near-instantaneously, not on the 100ms RMS windows this codebase measures elsewhere) caught a ~150ms transient peaking at −24.18dB inside an otherwise dead 9.76s stretch (44.32–54.08s) that holds **zero transcript words** (confirmed against `transcript.json` directly — word 87 ends 44.32, word 88 starts 54.08, nothing between). The same instant is invisible to `detectBreaths`, whose coarser 100ms windows report one continuous breath run clear across 44.2–54.2s. Three independent signals (transcript, breaths, the take's own noise-floor calibration) agree this is dead air; only the fine-grained silencedetect pass saw a blip — most likely a knock or click, not sustained room tone (a second, smaller peak at 50.26–50.29s and a full decay in between argue against a steady "hot fan").

§(c), then: `deriveThreshold` and `silencedetect` did their jobs — the two-way split of the silence is a correct read of a real, if tiny, amplitude event. The bug is downstream, in `cutlist.ts`'s merge step (~line 201): `r.start - prev.end < MIN_KEEP && !hasProtectedWordInside(...)` ANDs the wordless check to the duration check, so `hasProtectedWordInside` only gets asked when the gap is *already* short. A wordless gap that happens to clear `MIN_KEEP` (0.25s) — this one is 0.37s — is never asked the question at all and is kept by default, even though it holds no word and sits between two removals whose own `reason` is `silence`. The comment on `MIN_KEEP` ("kept fragments shorter than this, holding no word, are folded into the cut") already states the intended rule; the code just doesn't apply it to fragments that are wordless but not short.

No threshold was retuned to produce this reading — `MIN_KEEP`, `deriveThreshold`'s constants and `d=0.35` in `detectSilences` are all unchanged and, on their own terms, correct on this sample. Fix task is mechanism-only: decouple the wordless check from the length gate in the merge condition, not raise `MIN_KEEP` past 0.37 — the plan (Task 5 brief) forbids single-sample threshold tuning, and 0.37s is not a ceiling anything else in this file would want to defend.

## 125. The blooper marker's sound-alike arm cut 86.8% of the first real video

§122 shipped `findBloopSpans` accepting a marker word on normalized-exact match OR `soundsSimilar` OR Levenshtein distance ≤2 (marker ≥6 chars), reasoning that the two fuzzy arms "catch different ASR failure shapes." First field run of `--blooper-marker blooper` disproved that pairing on both sides at once: on a 125.9s take, the marker matched the unrelated word "builds" 14 times and removed 86.8% of the video.

The mechanism: `soundsSimilar("builds", "blooper")` returns true — both start with "b", and the shared-onset scoring puts the pair at 0.500, over the 0.34 floor (`phonetics.ts`, `SOUNDS_LIKE_FLOOR`). Levenshtein distance between the same pair is 6, well outside the ≤2 edit-distance arm, so `soundsSimilar` was the only reason "builds" ever matched. Meanwhile the actual field mishearing this feature exists to catch — Whisper writing "blooper" as "looker" — is *rejected* by `soundsSimilar`'s own onset test (b/l differ) and only ever matched through the Levenshtein arm (distance 2). So on the one real transcript exercised so far, the sound-alike arm admitted the false positive and contributed nothing to the true positive: net harmful, not just redundant.

Fix is deletion, not retuning: `matchMarker` (`blooper.ts`) now accepts only normalized-exact OR (marker ≥6 chars AND Levenshtein ≤2). Verified against both data points — "looker" (distance 2) still matches, "builds" (distance 6) no longer does. The trade this reopens: "blogger" is also distance 2 from "blooper" and would still match a marker typo or ASR slip nobody said. That is accepted, not fixed here — `formatBloopSpan` already puts every fuzzy hit in `report.txt` by name (§122's design), which is the safety net this class of false positive is supposed to fall into. Levenshtein-only narrows the failure mode from "cuts unrelated dialogue silently-ish" to "occasionally fuzzy-matches a real near-miss word, visibly, in the report" — the latter is the one the report line was built for.

**Shipped fix (Task 6):** the merge condition folds a wordless gap up to `policy.pauseMin`, not unboundedly — `overlapping || (wordless && gap <= max(MIN_KEEP, policy.pauseMin))`. The cap isn't there to protect short gaps; it turns on what a wordless gap *longer* than `pauseMin` sitting between two removals implies. The interior-pause branch a few lines above already emits its own removal for every genuinely silent stretch longer than `pauseMin` (`pauseDur <= policy.pauseMin` is the only case it skips) — so a wordless-per-transcript gap that long, still standing as bare space between two *other* removals, means the acoustic detector looked at it and did not call it silence: a breath, laughter, room action, or b-roll audio the transcript can't see. Folding on word-count alone would eat that. A gap at or under `pauseMin` carries no such signal — it's debris left once both neighbors are already cut, exactly the field bug's shape (0.37s, well under standard's 0.7s `pauseMin`). `Math.max` with `MIN_KEEP` is defensive, not load-bearing: every current `pauseMin` (0.5–1.2s) already exceeds `MIN_KEEP` (0.25s).

## 126. A stale editor-dist shadowed a whole shipped feature

Field report, same day the cuts UI shipped: "there's still no way of deleting a section (split or not). Looks like you forgot implementing it?" The feature existed — `Inspector.tsx`'s "Delete this chunk", the timeline's struck bands and seam markers, all merged and green that morning. The user never saw any of it, across two separate editing sessions, because `ossclip edit` never served it: `resolveEditorPageDir` (`edit.ts`) preferred `apps/cli/editor-dist/` (a prepack leftover from the previous day, untracked, one feature-round old) over `apps/editor/dist` (rebuilt minutes earlier with everything). Verified by driving the served page: `[data-testid="cut-chunk"]` absent from the DOM while present in the source and in the fresh build.

The order was right for its original purpose (R18 §90b: npm installs have ONLY `editor-dist`, clones have ONLY the sibling `dist`) and wrong the moment both exist — which any local `npm pack`/prepack makes true forever after, silently. This class of bug is nasty precisely because every layer looks healthy: the build is fresh, the server starts, the page renders, and the missing feature reads as "not implemented" rather than "not served" — it burned a debugging session on the false premise before anyone thought to ask which files the server was reading.

Fix: when both candidates exist, the newer `index.html` wins (mtime comparison in `resolveEditorPageDir`), and the stale leftover is deleted. npm installs are untouched (single candidate). The residual trap — a dev runs prepack, then edits the editor WITHOUT rebuilding, and gets the prepack copy — is the same trap inverted and accepted: the mtime rule serves whichever page is newest, which is the best available proxy for "the one you meant".

## 127. (number-only)

Cited by the shipped lead/tail-by-position rule (`cutlist.ts`, `cutlist.test.ts`) before an entry was ever written here — a dangling reference this stub exists to resolve, not a retroactive write-up. The rule's own rationale lives in the `cutlist.ts` comments themselves (the `LEAD_KEEP`/`TAIL_KEEP` doc comment and the `isLead`/`isTail` branch), not here.

## 128. Retake collapse without a spoken marker — and the guard a real hallucination forced

§122 shipped the half of retake removal that needs the speaker to say a word out loud. What was left — collapsing a retake the speaker did NOT mark — turned out to have a deterministic formulation too, the same way §122's marker did: not an LLM adjudicating which take is "good", but token-similarity matching on the raw transcript, which `buildCutlist` can still consume as a pure function of its arguments.

**The predicate.** Segment the raw transcript into sentences by punctuation (`isSentenceEnd`/`isSentenceStart`, same as §122's marker walk-back). A sentence that runs into the next without a period is the abandoned-partial case — the speaker stopped mid-line and restarted, and ASR never inserted punctuation for the half they didn't finish — so a candidate sub-split point exists wherever a silence of at least `RESTART_SPLIT_MIN_SIL` (0.35s) sits inside it. Finding that silence CANNOT rely on inter-word gaps alone (audit fix): whisper `-ml 1` emits contiguous stamps and `parseWhisperJson` clamps `next.start = w.end` (§18), so on a real transcript the gaps are ~always zero — a field probe measured 241 of 254 at exactly 0 — and a gap-only trigger is inert exactly where the feature matters. The pause survives in `analysis.silences`, stamped INSIDE a stretched word interval (the same physics the hallucination guard exploits), so the sub-split reads silence spans against the STAMPED intervals: a span overlapping the sentence by at least `RESTART_SPLIT_MIN_SIL` marks a candidate split after the last word whose stamp begins before the silence does — whether the dead air was stamped into that word's own tail, across two contiguous stamps, or into the next word's head. A split landing after the sentence-FINAL word is a no-op and is dropped: a trailing inter-sentence pause is routinely stamped into that word's stretched tail (the field probe's "Linux."/"gate." shape), and treating it as a restart would fragment a finished sentence around a pause that is actually after it. The gap-based check is kept alongside (a real gap, where one exists, is still direct evidence). Two instances (fragments, or whole sentences) count as the same line when their normalized token sequences score `RETAKE_SIM_THRESHOLD` (0.8) or higher on `1 − tokenEditDistance/max(len)`. The comparison runs full-sequence when both instances are complete; when exactly one is incomplete, it runs as a PREFIX comparison — the incomplete instance's own tokens against the OTHER instance's same-length prefix — but ONLY when the incomplete instance is also the SHORTER side, falling back to full-sequence otherwise. The direction is load-bearing: a restart/abandoned attempt says FEWER words than the take it restarts, by construction, but a continuation or a `--clip` slice ending mid-sentence can say MORE — and picking the prefix role by raw token count instead of by which side was actually incomplete truncated a shorter COMPLETE sentence down to match: a verified repro, "Let me show you this." against the unpunctuated continuation "Let me show you this whole thing in detail", scored a spurious 1.0 and got the longer, more complete continuation cut instead of the short line. Token equality is exact-match OR (both tokens ≥ `TOKEN_FUZZ_MIN_LEN` (5) chars AND Levenshtein distance ≤ `TOKEN_FUZZ_MAX_DIST` (1)) — catches an ASR letter-flip on a long word ("condiiton" for "condition") without opening a phonetic channel. Below `RETAKE_MIN_TOKENS` (3) compared tokens, a match is not evidence: "Yes. Yes. Yes." is deliberate emphasis, not three attempts at one line, and at one token apiece it would otherwise score a trivial 1.0.

**Deliberately NOT `soundsSimilar`.** §125 is the whole reason: `soundsSimilar("builds", "blooper")` scored 0.500 on shared onset alone and cut 86.8% of a real video. A retake pair needs to be *the same words*, not phonetically adjacent ones — this detector never reaches for a sound-alike heuristic, verified by a same-onset-unrelated-sentences regression test ported directly from §125's shape.

**Chaining.** Comparison runs against the anchor — the most recent live (non-empty, non-hallucinated) COMPLETE instance in the chain, or the instance that founded the chain when nothing complete has joined yet. Anything that matches the anchor extends the same chain, and takes over as anchor only if it is itself complete, which is what lets a three-take chain collapse to one cut. An incomplete fragment is matchable and cuttable but never becomes the anchor (audit fix — the wildcard-bridge failure): matching is non-transitive, and a 3-token abandoned fragment prefix-scores 1.0 against ANY sentence sharing its opening, so an anchoring fragment turned "Let me show you this." / "Let me show—" / "Let me show you how deploys work here." into one chain and cut the first real, distinct sentence at a printed 50% match. Partial-then-complete ordering still works: a partial can found a chain as its original anchor, and the complete take arriving after it matches by the prefix rule and takes over. Anything that does NOT match starts a fresh anchor, and that single rule is also what makes an unrelated sentence in between BLOCK a chain: the next candidate compares against the un-matching sentence, not the attempt behind it. Filler words and a lone `--blooper-marker` word (when the flag is also given) normalize to zero tokens and are skipped outright — never compared, never become the anchor — so they bridge a chain for free, the same as any length of silence. Rephrasing a line (different words, same idea) scores well under 0.8 and never matches, on purpose: that residual stays semantic (ROADMAP.md).

**Keep-last, and its stricter survivor bar.** Kept = the last live COMPLETE instance in a chain — one that ends at real sentence punctuation, not a sub-split boundary — and ONLY if its own `silenceFrac` clears `RESTART_SPLIT_MIN_SIL` (0.35). When that instance fails the bar — including when the chain has no complete instance at all — the group goes report-only: `kept` is `null`, nothing cuts, and every real instance in the chain is listed with its own `silenceFrac` so the report can say WHY nothing was decided. The detector never falls back to an EARLIER complete instance (audit fix): doing so silently inverts keep-last — an executed probe showed a last complete take at silenceFrac 0.375 dropped in favor of an earlier cleaner attempt at a printed 100% match, with nothing in the report saying the documented convention had flipped — and "last complete regardless" would elect the gappiest instance available, exactly the failure the bar exists to catch, just moved one level up. When the survivor does clear the bar, chain membership alone is still NOT permission to cut (audit fix — the cut-validation rule): matching is non-transitive, so every other member is re-scored against the KEPT instance, and only those clearing `RETAKE_SIM_THRESHOLD` cut; a member below it (chain drift — adjacent hops each clearing 0.8 while the endpoints score 0.4) is listed in the report as "not cut", with its similarity, and left alone. Clearing the threshold is still not enough for a sub-split FRAGMENT (audit fix — the abandonment rule, probe C1): parallel-structure rhetoric repeats a sentence opening on purpose, so "If it fails, we retry. If it fails, [dramatic pause] we give up." shears at the pause and the fragment "If it fails," prefix-scores a GENUINE 1.0 against the kept first sentence — no similarity gate can catch a match that is legitimately perfect, and cutting it hard-cuts live mid-sentence audio and orphans the remainder "we give up.". A fragment is therefore only ABANDONED — hence cuttable — when (a) the kept survivor starts AFTER it (a restart superseded by a later attempt), or (b) it is the FINAL fragment of its coarse sentence, with nothing of its own sentence surviving past it. A NON-final fragment whose kept match sits earlier is a clause boundary, not an abandoned take: its own sentence continues without it, so it is reported ("not cut … a clause boundary, not an abandoned take", with its match) and never cut. One consequence: the wildcard-bridge fragment ("Let me show—" between two distinct sentences) is now also report-only rather than cut — it shares C1's exact geometry, and its match to the EARLIER sentence never proved it was a false start of that sentence rather than of the one that follows it. Keep-last is a convention, not a proof — the true best take isn't always the last one recorded — and is documented as a known limit, the same posture §122 already takes toward its own marker-based removal.

**The hallucination guard.** The 2026-08-05 field failure this exists to prevent: a real take early in the recording, then whisper hallucinating near-verbatim repeats of it over what is actually dead air, much later. Naive keep-last would elect the LAST matching instance — the hallucination — and cut the only real take that exists. Per instance, `silenceFrac` is the fraction of its own span covered by `analysis.silences` (not `cuttable`: `cuttable`'s transcript veto is exactly the mechanism that would suppress this signal, and it is defeated outright in the `windowsDb: []` fallback path — `analyze.ts` — a problem `silences`, measured straight off the audio, does not have; not `LevelStats` either, since it is never persisted onto `Analysis`). At `HALLUCINATION_SILENCE_FRAC` (0.65) or above, an instance is hallucinated: never kept, never cut, transparent for chaining (compared against the anchor so it can be recognized and reported, but never becomes the anchor and never resets it — the anchor stays pinned to the real take), and reported with its fraction. Boundary-pinned at 0.64 (an ordinary gappy retake, cut normally) and 0.66 (hallucinated, spared) to keep the threshold itself honest.

One consequence of the guard needed its own fix, not a tuning pass: a coarse sentence that is ALREADY silence-dominated end-to-end is the hallucination shape, not the restart shape — its silence spans clear `RESTART_SPLIT_MIN_SIL` all over (against sparse-stamp gaps and stamped intervals alike), so the ordinary sub-split logic would shred it into one-or-two-token fragments, each permanently below `RETAKE_MIN_TOKENS` and therefore invisible to the very guard meant to catch it. The fix is a whole-sentence check ahead of the sub-split: a sentence whose OVERALL span already scores at or above `HALLUCINATION_SILENCE_FRAC` is emitted as one instance, not sub-split, and caught by the ordinary per-instance check that follows. Anti-tuning note per §124: this is a structural fix — deciding WHEN sub-splitting is allowed to run — not a threshold nudged to make one sample pass; both constants involved keep the values this section already commits to.

**Opt-in, and the promotion criterion.** `--collapse-retakes`, off by default in v1 — the same posture §122 took for `--blooper-marker` and for the same reason: an always-on detector risks a video that is legitimately ABOUT repetition. Promotion to default-on, if it ever happens, is earned the way every opt-in flag in this document earns it: clean field runs recorded in `report.txt`'s appendix (kept / cut with similarity / ignored-as-hallucination with its fraction, quoting the actual words — same audit-trail shape as §122's blooper lines), not a single passing test suite.

**Known limits, both a direct consequence of the fixes above.** A trailing abandoned restart that says MORE words than the complete take it follows — the mirror image of the prefix-direction fix — now scores below `RETAKE_SIM_THRESHOLD` and is never collapsed. Accepted, not solved: the alternative is the wrong-cut bug the fix exists to prevent, and a missed collapse is visible and editor-fixable in a way a wrong one is not. A chain where every real instance is incomplete — no complete instance ever forms — is report-only by construction, for the same reason as the survivor-bar case above: there is no instance the bar could even evaluate, so nothing is kept or cut, and every instance is listed instead.

## 129. command.json recorded the invocation, not the parse — every re-entered run wrote a replay that cannot run

Field artifact, the bare-path route's first real run (`.ossclip/Anyhropic c Compiler-926494ff/command.json`): `args: ["./Anyhropic c Compiler", "--llm", "gemini"]` — no `produce`. The editor's Render replays that argv verbatim, which is `ossclip <path> --llm gemini`, and the child dies at commander's front door with `error: unknown option '--llm'`. The Render button — the editor's whole reason to exist — was broken for the exact runs the front door now produces by default.

The mechanism: `produce()` recorded `process.argv.slice(2)` (R11 Task 4), which is the truth for exactly one entry point — a directly typed `ossclip produce …`. The wizard has always BUILT a produce argv and re-entered `program.parseAsync(["node", "ossclip", ...argv])`, and the 0.1.9 bare-path route does the same; in both, process.argv still holds the ORIGINAL invocation — no `produce` literal, none of the wizard's answers. The §75/§93g pins then appended `--llm`/`--clip-window` onto that wrong base, producing a record that LOOKS complete (provider pinned, window pinned) and is unparseable. Latent for every wizard run since the wizard shipped — nobody had pressed Render on a wizard-produced workdir until the bare-path route made the wizard the default first-run experience, which is how it surfaced the same day.

The fix has two layers because the damage does too. Going forward (`replay-argv.ts`): every parseAsync re-entry in program.ts stashes the argv it is about to parse (`setReplayArgv`), and the recording reads stash-or-`process.argv` (`recordedProduceArgs`, which also owns the §75/§93g pins). The stash is consume-on-read: commander 12 keeps option state across parseAsync calls (the bare-`produce` refusal in program.ts exists because of it), and a stash surviving its parse would be the same trap one layer up — a menu choice that never reaches `produce` must not leave its argv behind for a later recording. Direct invocations record byte-identically to before. At replay (`edit.ts` `/api/render`): the server prepends the `produce` literal to any recorded args that lack it — produce is the only command that ever writes command.json, so an args array not starting with `"produce"` can only be this bug, and a legacy directly-typed record already starts with it and is untouched. The field workdir renders again without re-producing anything.

Residual, accepted: a legacy record only holds what process.argv held. Wizard answers that never reached the command line — `--produce` and everything downstream of it — are unrecoverable from command.json alone, so a healed legacy replay runs the plainest `produce <path>` over the same input, with only the pins the recorder appended at record time (`--llm`, `--clip-window`) surviving. Records written after this fix carry the full re-entered argv and do not have the gap; the first healed replay also rewrites command.json in the modern shape, so the heal is one-shot per legacy workdir.

## 130. whisper.cpp `-ml 1` splits multi-byte characters across segments — at the byte level, and the utf8 read was where they died

First real non-Latin transcription (Urdu field test 2026-08-05, 941 words, ggml-medium-urdu): the captions showed `��اپک` where the speech says `ٹاپک` ("topic"). The whisper.json itself, read as bytes, is the whole story: with `-ml 1` whisper emits ~one byte-level BPE token per segment, and BPE has no reason to respect character boundaries — the field file's segment at 5.86s ends its text on the bare LEAD byte `0xD9` (`"text": " \xd9"`), and the next segment (5.86–6.13s) opens with the continuation `0xB9` followed by ا (`"text": "\xb9ا"`). `0xD9 0xB9` is ٹ (U+0679). The file as a whole is NOT valid UTF-8 — 35 invalid byte positions in this one transcript, every one of them this shape, always paired ~160 bytes apart (one JSON segment object) plus a couple of lone danglers.

The instinct-level fix — detect U+FFFD in `parseWhisperJson` and merge segments — cannot work, and knowing why matters: the replacement characters do not EXIST in the file. They are manufactured by `readFile(path, "utf8")`, whose decoder replaces each unpaired half with U+FFFD *before any parsing runs*, and at that point the two halves of ٹ are unrecoverable — merging `" �"` with `"�ا"` yields `"��ا"`, not `" ٹا"`. The character dies in the read, so the fix must happen below it: `parseWhisperOutput` takes the raw bytes, and only when a strict UTF-8 decode fails (valid files — every English run to date — take the old path byte-identically) round-trips through latin1, which is byte-transparent and cannot corrupt JSON structure since continuation bytes are ≥0x80 and JSON's structural characters are all ASCII. In byte space the split is trivially healable: a segment ending on an incomplete sequence whose successor begins with continuation bytes merges with it, offsets spanning both, re-checked so a 3–4 byte character split across three one-byte tokens still closes. Only that exact shape merges; a dangling half with no continuing neighbor is genuinely gone — the field file has one, a lone `0xDA` at 161.70s between two complete characters whose continuation whisper never emitted at all (data loss at the source, not a split) — and decodes to U+FFFD. Since a replacement character is never displayable speech, `parseWhisperJson` strips it from the assembled word (`سپی�جس` → `سپیجس`, one letter short but showable); a word left EMPTY by the strip folds its time span into a neighboring word rather than shipping a literal `�` caption.

The residue this leaves on already-produced workdirs: transcript.json files written before this fix carry the FFFDs baked in (the field workdir's does), and nothing downstream can restore them — re-transcribing is the only cure, and the transcript cache key doesn't change with parser fixes. Accepted: the parse is cheap relative to whisper itself, and a stale-parse invalidation scheme is not worth building for one transition.

## 131. Two workdirs for "the same" folder — the drift was a rename, not iCloud mtime churn

Field observation (2026-08-05): two produce runs ~10 minutes apart against `~/Downloads/Fulfillment As Developer` (4 clips) landed in different workdirs — `Fulfillment As Developer-1addff5a`, then `-202e2b55`. Reported as "same untouched folder", which made it look like the failure class this whole day was spent closing: a folder workdir identity that drifts under the user orphans `overrides.json` (the editor's edits live in the workdir). Leading suspect going in: Downloads is iCloud-synced, and `folderManifestKey` folds `mtimeMs` into the identity — cloud sync perturbing mtimes on untouched files would re-key silently and unboundedly.

The recorded manifests exonerate mtimes byte-for-byte. Both workdirs' `source-concat.json` survived, and each records the entries its run saw. Run 1 saw four camera-export UUID names (`05B96FC5-….MP4`, `52924DE0-….MP4`, `754D3FF1-….MP4`, `E6820A81-….MP4`); run 2 saw `1.MP4`–`4.MP4` — with the SAME four sizes and the SAME mtime values (`1785938022000` ×3, `1785938850000`) in both manifests AND in a fresh stat of the folder today. Every value is an integer millisecond count — no float-precision or serialization angle either, and no symlinks in play. Recomputing `sha1(folderManifestKey(entries, "name")).slice(0, 8)` over run 1's recorded entries yields exactly `1addff5a`; over run 2's, exactly `202e2b55`; over today's stat, `202e2b55` again — the key is perfectly stable now and was perfectly deterministic then. The folder was not untouched: the clips were renamed between the runs (UUID exports → `1`–`4`, matched pairwise by size and recorded duration).

The re-key was not merely correct on identity grounds — it was mandatory. Under `--sort name` the rename CHANGED the concat order: run 1 concatenated 81.6s / 31.5s / 18.6s / 126.8s; run 2, 18.6s / 31.5s / 81.6s / 126.8s (the rename to `1`–`4` looks like the user forcing the order the UUID sort had gotten wrong). Different clip order means different `source-concat.mp4` bytes, and everything existence-keyed in the workdir — transcript, mezzanine, content-rect cache — would have been stale against the new concat. Reusing the old workdir is exactly the captions-against-a-previous-edit bug the content-addressed key was built to prevent (see `folderManifestKey`'s own comment block in `concat.ts`).

No code change: mtimes stay in the key. The considered alternative — dropping `mtimeMs` from the identity so cloud-sync mtime churn can never orphan edits, at the cost of an in-place same-name same-size re-export going undetected — stays on the shelf for a run where recorded manifests actually show external mtime drift. This run showed none, and removing a change-detection input to acquit a suspect the evidence already cleared would open that blind spot for nothing. The field case is pinned in `concat.test.ts` from the recorded manifest values, deriving both observed workdir hashes, so the next "same folder, different workdir" report can be checked against it instead of re-litigated from suspicion.

## 132. Google Antigravity's `agy` — the provider the knowledge cutoff hid

The original provider survey never considered Google Antigravity because it could not have: `agy` shipped in June 2026 as the Gemini CLI's replacement, after the assistant model's knowledge cutoff (January 2026). Not a gap in diligence — a survey run by a model that had never heard of the tool. The lesson generalizes: a "which providers exist" question answered from training data has a freshness horizon, and everything below is instead verified against a local agy v1.1.11 install and the official docs.

**The envelope, as measured on 1.1.11.** `agy -p "<prompt>" --output-format json` writes one JSON object to stdout: `{conversation_id, status, response, error?, duration_seconds, num_turns, structured_output?, json_schema?, usage: {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}}`, with `status` one of `SUCCESS | ERROR | CANCELED | INTERRUPTED | INVALID | WAITING | RUNNING`. Notably absent: a model id. The provider therefore records the requested `--model` slug or, when the editorial tier runs agy's own configured default (the deliberate choice — no default slug is imposed), the honest placeholder `antigravity-default`, which the cost report declines to price rather than guess. The older third-party report of empty stdout on a non-TTY (agy issue #76) does not reproduce on 1.1.11 with `--output-format json` — smoke-tested before any provider code was written, since that bug would have sunk the whole approach.

**`--json-schema`, and why zod still runs.** Passing a JSON Schema gets server-enforced structured output — the parsed object arrives in `structured_output`. The provider prefers it over the prose `response` and still `schema.parse()`s it: server enforcement is not our contract, and §112's rule (LLM output is untrusted input) does not get waived because the vendor promises to have checked. The schema also rides inside the prompt text — the prompt copy is what makes the self-repair retry meaningful, since the correction message has to point at constraints the model can actually see.

**The prompt rides argv only.** agy has no stdin path, and macOS caps ARG_MAX around 1MB, so a transcript-heavy prompt dies at spawn with E2BIG — a kernel error naming nothing the user typed. `MAX_AGY_PROMPT_BYTES` (700,000) refuses pre-spawn instead, with a directed error naming `--llm claude-cli` and `--llm gemini` as the providers that can take a prompt that long. Two more flags are load-bearing: `--disable-slash-commands`, because a transcript prompt that happens to begin with `/` must not expand as an agy skill, and `--print-timeout 10m` (over agy's 5m default), because core's `run()` has no timeout of its own — this flag is the only clock on the spawn, and with it a stuck call surfaces as retry-then-throw rather than a hang.

**~24k tokens of harness per call, unbilled.** Measured: a prompt of "reply ok" cost 23,838 input tokens — agy sends its own agent context ahead of every print-mode call, the same shape claude-cli's harness prefix takes. Usage lines look heavy; nothing is charged (`billed: false`, subscription auth, and agy reports no cost of its own to forward). The baseline is also why `isNonRetryableAgyFailure` exists: a missing login or an unknown model slug is deterministic, and the generic retry loop would burn another ~24k-token call to learn the same thing — auth and bad-slug failures fail fast on the first attempt instead. Token mapping into `LlmUsage` has two judgment calls, both commented at `parseAgyEnvelope`: `thinking_tokens` folds into `outputTokens` (thinking is output-side spend and `LlmUsage` has no thinking field), and whether `input_tokens` already includes cache reads is undocumented, so it is resolved at runtime by cross-checking `total_tokens` — if input + output + thinking + cache_read exceeds the reported total, input is already cache-inclusive and stands alone; the worst case is a conservative over-count, the safe direction for a number a user might budget against.

**The detection-order reversal (2026-08 decision).** Auto-detection now runs `agy` bin → `claude` bin → `GEMINI_API_KEY` → `ANTHROPIC_API_KEY` → claude-cli as the unconditional fallback — subscription CLIs beat ambient API keys, reversing the key-first order `defaultProviderName` had shipped with. The reasoning: a logged-in CLI is an explicit, already-paid choice the user made on this machine, while a key in the environment may just be lying around — and picking the key spends real per-token money the subscription would have covered. A key-only user with no CLI installed sees no change at all; a key-holder who also has a CLI installed silently moves to the subscription path, which is the accepted shift, mitigated twice: the detection line always prints and names the trigger that won (`detectionLine` — the same change that fixed produce.ts printing the ANTHROPIC line for a gemini-detected run), and `command.json` pins `--llm`, so an existing workdir's replay never re-detects.

## 133. The blooper marker's fuzzy arm ate the word "bloopers" said as content

The third field run of `--blooper-marker` produced the failure the fuzzy arm's own §125 rewrite had warned about in miniature. The announce take SAYS the word "bloopers" — "use your terminal … it automatically edits, it removes the bloopers" — describing the very feature. Levenshtein distance from "bloopers" to a "blooper" marker is 1, comfortably inside `FUZZY_MAX_DISTANCE`, and removal runs backwards to the spoiled sentence's start by design — so the matcher cut 7.08s of good content and the published-vs-rerun diff showed up as "the video cuts abruptly right after 0:07". The report.txt disclosure line (`matched "bloopers" ~ "blooper"`) did its §125 job — the cut was visible, not silent — but visible-in-a-report is a weak defense for a 7-second hole in an otherwise-good take.

The distinction the matcher was missing: fuzzy exists for ASR **mishearings of the spoken marker** ("looker" for "blooper" — the §125 motivating pair), and a mishearing is a non-word landing near the marker by transcription accident. A plain English inflection of the marker is the opposite case — a REAL word the speaker can say on purpose, and saying it is overwhelmingly more likely to be content than a marker. So `matchMarker` now rejects the plain s/es plural pair in both directions (`isPluralPair`) before the Levenshtein arm runs: "bloopers" never fuzzy-matches a "blooper" marker, "blooper" never fuzzy-matches a "bloopers" marker, and an EXACT marker hit still always wins first — a speaker who says the literal marker word as content was never protected, by contract. The regression is pinned in blooper.test.ts from the announce take's words, next to the "builds" §125 guard.

Timeline note for anyone diffing old outputs: the accepted v3 render of that take predates the fuzzy arm entirely (produced 2026-07-31, exact-only matching; fuzzy landed 2026-08-04), which is why the same command produced different cutlists across the gap. Same input, same `--cleanup`, same flags — but not the same code, and `buildCutlist`'s determinism guarantee is per-version, not forever.

## 134. Telemetry: opt-out under a loud notice, and the placeholder key that keeps the suite hermetic

The problem was total blindness. Fifteen releases in, every product decision — is `--clip` used at all? does anyone run `16:9`? which provider do real installs actually resolve to? — was being answered from the handful of field reports that happened to arrive, which is a sample of people annoyed enough to write. npm download counts say nothing about completed runs, and a tool whose defaults are tuned findings-first (§14b, §37, §132) had zero findings about usage itself.

**Opt-out, under a loud one-time notice — and why not opt-in.** The brand promise is "your footage never leaves your machine", and the telemetry design is built to keep that sentence true rather than lawyered: anonymous counts, durations-as-buckets and provider *names*, never content. Opt-in was considered and produces near-zero data from exactly the population that matters (people who never read docs), which is indistinguishable from the blindness it was meant to cure. The honest shape of opt-out is a notice that cannot be missed: printed before any command output on first run, stating what is sent, what never is, and both off switches in the same four lines. `DO_NOT_TRACK=1` is honored alongside ossclip's own `OSSCLIP_TELEMETRY=0` and `ossclip telemetry off` — a user who already told every tool on their machine not to track should not have to tell this one again.

**The placeholder key is a hard off, and that is a testing decision as much as a shipping one.** `POSTHOG_KEY` ships as `phc_REPLACE_ME` until a maintainer pastes the project's write-only key, and while it is the placeholder, telemetry is a no-op with teeth: no network, no notice, and no state file — `bootstrapTelemetry` returns an inert instance without touching disk. The third clause is the load-bearing one for the repo itself: every program-level test builds the REAL `buildProgram()`, and because the checked-in key is the placeholder, all of those tests get inert telemetry without a single mock — no fetch to stub, no `~/.ossclip` to guard, no notice text polluting captured output. telemetry.test.ts pins the invariant by name (a default-key `Telemetry` whose `record()` no-ops) precisely so nobody deletes the guard casually; if that test ever fails, someone pasted a real key and the hermeticity assumption needs re-checking before ship.

**`FORBIDDEN_PROP_KEYS` is the privacy promise as a drift guard.** The dangerous version of a telemetry leak is not the launch-day event set — those got reviewed — it is the prop somebody adds in month six (`source_path` for debugging, `intentText` "just to see what people ask for"). `assertSafeProps` runs inside `buildEvent` and throws on any prop key containing `path`, `file`, `dir`, `transcript`, `intent`, `prompt`, `key`, `hook` or `text`, case-insensitively — so the future event fails a unit test the day it is written. In production the same trip is swallowed by `record()`, which drops the event instead of throwing at the user: fail closed, because no data beats wrong data in exactly one direction.

**A metrics POST gets 2500 ms, once, and then it is gone.** `flush()` sends one batch with an AbortController cap and no retries, and the abort is *raced*, not merely passed as a signal — an injected or polyfilled fetch that ignores `signal` must still resolve inside the cap, because "telemetry never slows a run beyond the cap" is a promise about the await, not about the socket. Every error class — offline, refused, DNS, 4xx — is swallowed silently: a failed metrics request that prints a warning is a failed metrics request that just cost more attention than the metric was worth.

## 135. The restart split hid a textbook retake from its own detector

The first true voice-over run through `--collapse-retakes` (the 2026-08-11 VO recording) reported "no retakes found" on the exact shape the feature was built for: "The kernel I optimized takes half a **second**." followed by the corrected "…half a **millisecond**." — whole-sentence similarity 0.875, comfortably over `RETAKE_SIM_THRESHOLD`. Reproduced pure: with an EMPTY silence list the detector finds the pair instantly; with the run's real silences it finds nothing; removing just the two MID-sentence silences (54.2–57.2s and 65.8–66.6s) brings the pair back. The restart split (`RESTART_SPLIT_MIN_SIL`, §128) was the culprit by design: it shears a sentence at any internal pause ≥0.35s to expose unpunctuated abandoned partials, so each take fragmented into "…takes half" / "a second" — and fragments of take one never score against fragments of take two. Talking-head speech flows; read-aloud VO delivery pauses INSIDE sentences for effect, and that ordinary delivery style made every paused take invisible to the collapse pass.

The fix is a second pass, not a retuning: `findRetakeGroups` still runs the fragment pass first and unchanged (its splits, abandonment rule, cut-validation, and keep-last conventions carry the §128 audit history and are not renegotiated here), then re-runs the SAME chain algorithm (`chainGroups`, extracted verbatim) over whole coarse sentences. A sentence-level group is admitted only when (a) at least one member's sentence actually WAS split — an unsplit sentence was already compared whole by the fragment pass, so acting on it again could only second-guess that pass — and (b) none of its members' words are claimed by any fragment-pass group, where "claimed" includes `undecided` members, so a cut that §128's rules deliberately DECLINED (C1's clause-boundary spares, below-threshold members) stays declined. C1-style parallel rhetoric cannot resurface here: those are genuinely different sentences, and whole-sentence comparison scores the divergence the fragment prefixes concealed ("If it fails, we retry." vs "…we give up." lands at 0.67, under the bar). Pinned three ways in retake.test.ts: pauses in both takes, a pause in one take, and the C1 shape asserting zero cuts survive the new pass.

## 136. The wizard's first question demanded a typed path — the one step a non-technical user could not take

Every question the produce wizard asks is a menu of the answers that make sense, except the first one, which was a blank text field wanting a filesystem path. That is where non-technical users stopped: not with an error, just by not knowing what to type, and a stall leaves no trace in a report or a work directory. The tool already knew better elsewhere — `ossclip edit` never had this problem, because `resolve-workdir.ts` auto-discovers and `pick-workdir.ts` offers a `select` over recent runs — so the one prompt that faced a first-time user was the one prompt that assumed shell fluency. The 0.1.9 bare-path front door made that route the default first contact (`ossclip` → menu → produce), which is what turned a rough edge into the funnel's floor.

**The ladder, ordered by how little the user has to know: suggestions → native picker → typing.** The rows above `Browse…` are the newest videos already on the machine, offered by name — a person who has just hit record wants the file they made thirty seconds ago, and naming it beats any dialog. Below that is the operating system's own file chooser, which is the interface that population already knows. Typing is never removed and is always last: it is the only branch that works over SSH, and it is what every branch above degrades into.

**Suggestions are stateless on purpose.** `scanLikelyDirs` looks at the working directory, `~/Downloads`, and `~/Movies` (`~/Videos` off darwin — the OS's own recording default), ranks by mtime, and keeps nothing. A recents file was the obvious alternative and is worse where it counts: a recents list is EMPTY on the first run, which is the exact run a new user needs help on, and it would also have to be migrated and privacy-audited (§134). `*.ossclip.mp4` is excluded — cutting an already-cut video compounds the trims and is never what somebody means from this menu. Two label details that only showed up against real files: size thresholds are the ROUNDING boundary (999_500) rather than the unit boundary, because `Math.round` carries and a 999.7 MB screen recording printed "1000 MB" beside a sibling's "1.1 GB"; and a negative age is clamped to "just now" rather than filtered, because a clip copied off a camera with an unset clock carries an mtime in the future and is still a real file.

**The scan's costs, in the order they actually bite.** It runs before the first prompt paints, so it is non-recursive — a deep walk of somebody's Downloads is indistinguishable from a CLI that hangs on startup — and the per-file `stat`s go out in parallel, because awaited one at a time a 400-clip folder on an SMB share or an iCloud "Optimize Storage" `~/Movies` is seconds of dead terminal that non-recursion alone does not prevent. `MAX_STATS_PER_DIR` (2000) sits AFTER the extension filter, which is the placement worth writing down: `readdir` has already materialised every dirent, so capping the listing saves no I/O and discards videos in filesystem order — readdir order is not mtime order, so the take recorded 30 seconds ago is as likely to land in the discarded tail as anything else. Capping after the filter bounds the only real cost, the stat. Symlinks are followed, matching `listFolderVideos` in concat.ts, because a folder of symlinks onto another drive is a normal way to stage takes; a symlink to a DIRECTORY named `takes.mp4` passes the dirent test and stats fine, so it is dropped after the `stat` resolves — the same resolution concat.ts:346-353 does, and the parity is the point.

**Backend facts, dated 2026-08-12 — the macOS ones measured on macOS 26.3, the zenity and kdialog ones against their own interfaces, and the PowerShell one from documentation only: no Windows machine was involved at any point, the same gap §117 records about `tar`.** osascript: `choose file … of type {"mp4","mov",…}` accepts BARE extensions, keeps matching files selectable and dims the rest — the UTI form `{"public.movie"}` was tried and rejected, because its mkv coverage is unconfirmed and mkv is in `VIDEO_EXTENSIONS`. zenity: filters are `--file-filter=NAME | PATTERN…`, pipe-separated, and a start directory only reads as a directory when `--filename=` ends in a slash, otherwise it is a pre-filled filename. kdialog: filters are `Name(*.ext)` — parentheses, a genuinely different shape from zenity's — and `--getexistingdirectory` takes a start directory and nothing else, where passing a filter is an error rather than an ignored argument. PowerShell: `-STA` is mandatory, because a WinForms dialog deadlocks on the MTA thread `powershell -Command` uses by default and a deadlock here looks exactly like a hung CLI; `powershell` (5.1, in-box) rather than `pwsh`, which is not installed by default.

**Cancel is empty stdout on all four backends, which is why the parser keys on emptiness and not the exit code.** zenity and kdialog exit non-zero when dismissed; PowerShell exits 0 and emits nothing, because the `if` guarding `ShowDialog()` simply does not fire. One rule reads all four: pass `allowNonZero`, read stdout, empty means no path. What emptiness cannot distinguish is a cancel from a backend that failed silently — osascript hitting -1743 in a launchd or tmux context that sets neither SSH variable, `Add-Type` failing on a locked-down Windows box. That conflation is deliberate: no backend reports the difference machine-readably (stderr is prose that varies by version and locale), and the recovery is identical either way — return to the menu and let the user choose again.

**Availability is probed, not attempted, and the platform gate is deliberately asymmetric.** A `Browse…` row that cannot work is worse than no row at all, so `pickerAvailable` decides before the menu is built and the row simply does not exist when the answer is no. `OSSCLIP_NO_PICKER` is checked first, ahead of any platform logic — truthiness rather than presence, matching `isInteractive`'s treatment of CI — so there is one switch that works everywhere regardless of what the probe concludes. darwin **and** win32 then gate on `SSH_CONNECTION`/`SSH_TTY`: neither OS exposes anything that answers "is there a reachable window server", so a remote-session hint is the best available stand-in. Windows is the reason that is a hard gate rather than a macOS courtesy — macOS fails loudly (`choose file` returns -1743, not authorized), but Windows ships an in-box OpenSSH server and `ShowDialog()` on a non-interactive window station blocks forever on a window nobody can see, and core's `run()` has no timeout, so that is a CLI hung until Ctrl-C. Linux is EXEMPT from that proxy on purpose, and this is the non-obvious half: `ssh -X` sets `DISPLAY=localhost:10.0` and zenity genuinely draws on the caller's local screen through the tunnel, so the SSH hint would override real evidence with a guess and break a configuration that works. Linux decides on `DISPLAY`/`WAYLAND_DISPLAY` **and** an installed `zenity` or `kdialog` instead; that conjunction is what covers WSL without WSLg, where zenity may well be installed and still draw nowhere.

**Every branch converges on one validator, and the picker's result is not privileged.** `pickPath` returns its path deliberately unvalidated — `validateInputPath` owns existence and file-or-folder for typed text, suggestions and dialog results alike. A dialog result is not more trustworthy than typed text: the file can be deleted between the dialog closing and the path arriving, a suggestion is a snapshot taken before the keypress, and "Browse for a folder of clips" happily returns a folder with no video in it. No branch applies an extension whitelist either, because typing never did and ossclip accepts whatever ffmpeg can read — a list here would reject legitimate containers. That convergence is also why `VIDEO_EXTENSIONS` became an export from core's concat.ts: the dialog filters and the folder-concat listing have to be one list, since a picker that offers a file `concat` will later refuse is a trap, and two copies drifting apart is exactly how that ships.

**The same seam three times, because a dialog blocks on a human.** `pickerCommand` and `parsePickerResult` are pure over `PickerDeps`, so the platform matrix is a table test rather than something a Linux or Windows user discovers — the split `openCommand`/`openInBrowser` uses, for the reason the 0.1.4 `ossclip edit` crash taught (it shipped broken to every non-macOS user for a whole release). `askInput` takes an optional `AskInputDeps` for the same reason one layer up: the branch rules are what is worth pinning — a cancelled dialog re-asks instead of abandoning the run, a stale suggestion re-asks, each branch records its own source — and none of that is reachable through a real `select` waiting on a keypress. Both interfaces declare structural signatures (`hasBin`, not `typeof binOnPath`; a narrowed `select`, not clack's generic one) because a fake cannot satisfy an unresolved type parameter.

**Measuring whether it helped — and the run boundary that was nearly wrong.** `produce_completed` carries `input_source`: `suggestion | picker | typed | argv`, a branch NAME and never a path (§134's `assertSafeProps` rejects any prop key containing `path`). "argv" is a real answer, not a null: `ossclip <path>` prefills the input and `askInput` never runs. The trap is the reset. The value is module state, so something has to declare when a RUN begins, and the produce action is not it — every wizard route re-enters that same action through `program.parseAsync` (§129), so a reset there fires on the re-entered parse, AFTER `askInput` recorded the branch, and `input_source` would read "argv" for every wizard run: the metric would measure precisely nothing it was added to measure. The process is not the boundary either, since a batch or REPL driver produces more than once and the second run would report the first one's branch. `buildProgram()` is the boundary: commander 12 keeps option state across `parseAsync` calls (the bare-`produce` refusal exists because of it), so any batch has to rebuild the program per run anyway, which makes one reset per construction exactly one per run in both cases. That placement has a price, stated here because it is easy to "clean up": `buildProgram` cannot await, so the ask-input import had to become static, and ask-input.ts plus everything under it (clack, picker.ts, suggest-inputs.ts) is now eager on every invocation including `--version` and `doctor`. Measured at ~14 ms on a ~320 ms startup, against a graph that already loads @ossclip/renderer and @ossclip/scenes eagerly through produce.ts — cheap enough not to trade for a racy fire-and-forget import, and a standing cost on anything added to that module later.

Left alone deliberately: the output-file prompt keeps typing because it has a computed default, and the whisper-model prompt keeps typing because it takes a bare model name far more often than a path. No in-terminal directory browser either — it roughly doubles the work to serve the population (SSH, dialog-less Linux) that can already type a path.

## 137. Override keys have to survive a re-cut — the values were re-anchored and the keys were not

Field case, 2026-08-12, workdir `Starship V2-e89a046b`. The user retyped four caption words, deleted a scene, saved, then cut 0.6s out of the video. Every one of those edits was silently discarded, and the deleted scene came back in the render. `remapOverridesThroughRecut` is supposed to make exactly this safe: it maps every stored absolute-output-seconds VALUE old-output → source → new-output, and reports anything it moves. It did its job. The bug was that an override is a key AND a value, and two KEY spaces were outside the function entirely. Caption edits were keyed by the caption word's POSITION, so a cut that removes one word shifts every later index and the edit's own `was` guard fires on all of them — the guard doing its job, on the wrong word. Split halves were named `${rootId}@${outputStartMs}`, recomputed from the split's CURRENT time, so re-anchoring the split renamed the half and orphaned the `hidden` override sitting on it. Nothing in the doc was corrupt; every edit was a correct statement about a video that no longer existed.

**Why the deleted scene came back specifically, which is a second failure stacked on the first.** The re-anchor moved that split from 0.6s to 0. `splitCues` only cuts a cue at `at >= startSec + SPLIT_MIN_PIECE_SEC`, output time starts at 0, so no cue could match and the split was skipped outright — the half named `scene-0@600` stopped existing, and the `hidden: true` the user had saved against it applied to nothing. Renaming alone would have orphaned the override; this made the half vanish before the override was even consulted. Both ends of the timeline have this shape (a split at 9.5s of 10s with 9.6–10.0 cut is stranded identically), and both are now reported by name. The two guards look mirrored and are not symmetric: the END bar slides with `outputDuration`, so a pure shift can never trip it, while the START bar is absolute 0 and does not slide — which is why the field case, a pure front trim, fires it and must.

**The fix is to key on something a cut cannot move.** Caption edits are keyed `w<ms>` by the word's SOURCE time (`captionKeyFor`), carried on `CaptionWord.srcStart` — the one deliberately source-timed field in a structure that is otherwise entirely output time. Split halves take an id minted once when the split is created (`mintSplitId`) and NEVER recomputed; `at` still moves under a re-cut, `id` does not. Decoupling the two made an id collision reachable that had been structurally impossible (`SPLIT_MIN_PIECE_SEC` used to forbid two splits within 0.5ms, so time-derived ids could not clash) — a split minted at 1.2s and re-anchored to 0.6s still holds `"1200"`, and ⌘B at 1.2s again asks for an id that is taken — so the mint disambiguates with a counter rather than a nonce, because the value is persisted in the user's file and has to be reproducible from the doc alone. The legacy derivation is load-bearing in the opposite direction: a pre-§137 split upgrades to an id computed from its ORIGINAL output milliseconds, precisely so an existing `scene-0@600` in someone's `overrides.json` keeps matching the half it always named. A "cleaner" mint for legacy splits would have discarded saved work on every project on disk.

**The migration's recovery rule, and the one place it deliberately does not ask for more evidence.** Positional keys are upgraded by looking at the stored index first, and an exact hit there — the word at that position IS the edit's `was` — wins OUTRIGHT. That is not a guess: the index is what the editor recorded when the user made the edit, and `was` matching the word now sitting there is that record confirming itself, two independent facts agreeing. A duplicate of the same word nearby must not veto it, or a document that never drifted at all would stop migrating just because the user happened to edit a common word. Only when the position is PROVEN wrong does the search walk outward for the `was`, and ambiguity gates that search alone: two candidates it cannot tell apart are reported, never picked, because a wrong anchor silently rewrites a word the user never touched, which is worse than an edit they have to redo. Two legacy edits resolving to the same word are that same ambiguity one level up and both are refused — the output is a `Record`, so a function that wrote as it went would have the second edit overwrite the first and report nothing, which is the original bug wearing a different hat. A legacy key colliding with an already-source-keyed one is NOT a tie and refusing both was itself a bug: a doc holding both key spaces at once is the normal shape of any project edited before and after this change, and the source-keyed edit is newer and its anchor is not in doubt, so it wins and the legacy claim is retired as `superseded`.

**Nothing is dropped silently, and the invisibility is what let this reach a rendered video.** `migrateCaptionKeys` reports every edit it would not commit through `unresolved`, with a reason (`not-found`, `ambiguous`, `unanchorable`, `collision`, `superseded`) because each one asks something different of the user — blaming the cut for all of them sends somebody hunting for a word still sitting on screen. `applyCaptionEdits` reports through `dropped`. Both channels existed in some form before; the editor threw `applyCaptionEdits(...).dropped` away, which made the function's own "reported, never silently discarded" comment false at its only real call site, and that is the whole reason four vanished retypes looked like nothing had happened. The repair also has to REACH DISK: the editor's migration ran in a `useMemo` and `edits.load` leaves the doc undirty, so a user could open the old project, see every retype back on screen, click Render, and ship a video with none of them — a state strictly more convincing than the truth. So `produce` migrates too, through the one sanctioned `overrides.json` write with its `.bak` and atomic rename. A legacy key's resolvability DECAYS — it is found by the word it names, so the next re-plan that rewrites that word retires it for good — which makes the produce-side write the only durable repair in the product.

**Three blind spots this plan was bitten by, written down because they will bite again.** (1) `apps/*/test/**` and `apps/*/e2e/**` are outside every tsconfig — `apps/editor/tsconfig.json` is `"include": ["src"]`, and only packages/core includes its tests — so `pnpm typecheck` cannot see construction sites there. Adding a required field to a shared type and getting a clean typecheck means nothing about those trees; they need a grep. (2) `pnpm test` does not run the editor e2e suite, only CI does, which is how a change that white-screened the app on the repo's own checked-in fixture stayed green locally. `pnpm --filter @ossclip/editor e2e` now exists so that suite is one command away rather than a remembered Playwright invocation; it is deliberately NOT in the root `pnpm test`, which must not require browsers to be installed. (3) A test that reaches a guard through only one branch proves nothing about the other — two tests here exercised a new guard exclusively via the exact-hit path, so deleting the guard's search-path arm left them both green, and only a mutation pass found it.

**What is still untested, stated rather than implied.** Nothing in the repo invokes `produce()`, and the editor's `renderflow.spec.ts` render is a fake child process, so the two lines that wire this fix into the actual product — the `reconcileCaptionEdits` call, and `captionKeysChanged` in the override write gate — are executed by no test at all. Deleting either left the whole suite green. They are held for now by a source-text assertion in `caption-report.test.ts`, the same crude shape as the version-literal check (§113) and justified the same way: a behavioural test needs ffmpeg, a transcript, a workdir and a render, and what is being guarded is silent data loss. That is a stand-in for a `produce()`-over-`pnpm fixture` harness, not a substitute for one.
