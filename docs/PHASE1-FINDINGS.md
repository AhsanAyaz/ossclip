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

## Not defects, noted

- **0 cuts on the test take is correct** — longest silence 0.44 s, below `standard`'s 0.7 s threshold.
- **9 moments → 7 scenes** is by design: two moments were `sceneKind: "none"` (plain talking-head beats). Though 7 of 9 carrying graphics overshoots the prompt's own "at most half" guidance — see §3/§4.
- `startSec`/`endSec` stay `undefined` on `production.json` scenes while resolved times live only in `render-props.json`. That matches PHASE1 §2 ("never persist as the source of truth") but makes the doc harder to inspect by hand; consider writing them back as a debug-only mirror.
- The producer's editorial judgment was good: it pulled true figures (861%, +242%, +34%, 2,200 devs) rather than inventing them, and the `rationale` field reads like an editor's notes.
