# Phase 1 — findings from the first real produced render

> **Status 2026-07-26: all six sections fixed** (see the commit that touches this line; 70 tests green, golden fixture re-rendered and frame-verified).
> §1 FlowDiagram: fit-to-width single row (font scales 26–44px with content), arrow+chip are one flex item, arrows enter *after* their chip. §2 captions never hidden — every layout reserves a caption band. §3 `MAX_SCENE_SEC = 5` in assembly. §4 StatCard/RuleCard default to `video-top`, prompt states the face-large policy, and `normalizeBeatSheet` deterministically demotes graphics beyond floor(N/2) (sparing hook + payoff). §5 TitleCard skips a title contained in `emphasis`, and the schema `.describe()`s steer the LLM. §6 `SAFE_AREA`/`SAFE_RECT` in `stage.ts`; all graphic slots + caption bands clamped inside and property-tested against overlap; caption lines split at scene boundaries with holds clamped, so a line can never carry one layout's anchor into another (the collision seen on the StatCard).
> Deferred, still open: the `--safe-area <preset>` CLI flag (the constant is single-source but not yet configurable per render), and deriving the caption band from live occupancy rather than per-layout hand-tuned anchors (the anchors satisfy the §6b property tests; full derivation can come with editable layers in Phase 2). The `startSec`/`endSec` debug mirror on `production.json` also remains open.

*First end-to-end `--produce --llm claude-cli` run on real footage (68 s portrait take, macOS, whisper `base.en`). The pipeline works: 7 scenes planned from 9 moments, all 5 layouts exercised, audio continuous across every transition, real numbers lifted from the take. These are the defects that run exposed, worst first, plus one new requirement (§6).*

Reference frames for comparison live in `reference/`. The produced frames referenced below came from `ffmpeg -ss <t>` on the render.

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
