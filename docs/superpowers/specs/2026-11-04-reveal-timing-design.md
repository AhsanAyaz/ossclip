# Reveal timing: on-cue scene starts, word-synced items, pacing, entrance style

Date: 2026-11-04 · Status: decisions in; awaiting the author's approval.
§3's relative `itemSec` is superseded by absolute times — see "Builder-check
answers" — and the matcher runs at plan time, not in `assembleScenes` (§7).

## Why

Two complaints from the author's own takes, same root:

1. **Items land before they are said.** FlowDiagram chips pop in 6 frames
   (0.2s @30fps) apart, so a 3-chip diagram is fully on screen inside a
   second, while the speaker spends 5-10 seconds walking through it.
   ChatMock (8 frames), TerminalMock and StrikethroughReveal (6 frames) share
   the same hard-coded stagger, all on the one spring in
   `packages/scenes/src/anim.ts`.
2. **Scenes start too early.** The beat-sheet prompt
   (`packages/core/src/producer/beats.ts:153`) says a moment "spans the FULL
   stretch of speech about its beat — typically 5-15 seconds", and
   `assembleScenes` (`packages/core/src/assemble.ts`) starts the cue at the
   moment's first word. The graphic's content is usually the PAYOFF phrase
   near the end of that stretch. The author routinely drags scene starts later
   by hand, often cutting 30-70% of the scene. Field evidence, take
   `26-11-04 16-14-25 3337`:

   | scene | planned start | content is about | author's start |
   |---|---|---|---|
   | scene-12 ScreenshotFrame "SKILLS THAT STILL MATTER" | 89.5s ("need in your CV…") | "skill sets that actually are still valuable" ~99s | 99.07s (11.6s → 2.1s) |
   | scene-22 ChatMock keyword "slot" | 162.8s | "comment slot" ~170s | 169.91s (13.3s → 3.3s) |

   The END felt right in both ("mostly the start, end usually feels fine").

One mechanism fixes both: **find where the graphic's own words are spoken**,
and use it to time the scene's entrance and each item's entrance.

## Goals

- Right by default after `produce`; editor controls are the backup, not the
  workflow (author's call).
- Scene **starts** on cue: shortly before the first words its content refers
  to. The **end** stays where it is today (moment end, existing caps).
- Items (chips, messages, terminal lines, struck items) appear **when spoken**
  when their text is actually said.
- When it is not said — the diagram shows a concept, not a quote — items are
  **paced** across the scene instead, with a speed and a pacing curve.
- **Entrance style** per scene (pop, fade, rise, bounce), same round.
- All four staggered components (FlowDiagram, ChatMock, TerminalMock,
  StrikethroughReveal) through ONE shared helper.

## Non-goals

- Changing scene ends, the 15s cap, de-overlap, or moment segmentation.
- Re-planning: none of this needs a fresh LLM plan beyond the optional cue
  field below; it is deterministic matching on the transcript.
- Other components (StatCard, BulletList, TitleCard…) — BulletList is a
  natural follow-up through the same helper, but not this round.
- Per-item editor timing (dragging individual chips on the timeline).

## Anti-goals (failure even if it "works")

- **Half-synced diagrams.** Two chips on their words and one guessed at a
  random time reads as a bug. A scene is either synced or paced, never mixed.
- **Flicker graphics.** On-cue starts must not produce scenes too short to
  read; the existing min-duration floors still apply and win.
- **Undoing R23 §114.** That fix stopped graphics LEAVING while the speaker
  was still on the topic. This change only moves the entrance; never the exit.
- **Fighting the author's edits.** A scene with a `timing` override in
  `overrides.json` is the author's call and is never re-cued.
- **A wrong match that looks confident.** "framework" matching an unrelated
  "framework" 8s earlier is worse than no match; matching is confined to the
  moment's own word window.

## Design

### 1. The matcher (core, pure)

`locateSpoken(items: string[], words: Word[], window: [startWord, endWord])`
→ per item, the index of the first word where that item's text is spoken, or
null. Lives in `@ossclip/core`, pure, tested without a renderer.

- Normalize both sides: lowercase, strip punctuation, digits↔number words
  ("200K" ↔ "200,000"/"two hundred thousand") where cheap.
- An item matches when its content words appear in order within a small
  span (multi-word chips like "NEW IDEA" may be said as "new… idea" or
  "amazing ideas"). Stemming-level looseness (idea/ideas, block/blocked) —
  the builder picks the exact rule; the anti-goal above is the bar.
- Matches must be monotonic (item i+1 at or after item i); an out-of-order
  hit is treated as no match.
- The **sync decision** for a scene: synced when at least ⌈2/3⌉ of items
  match (and the first item matches); otherwise paced. *(My call — the
  threshold is a constant to tune on real takes.)*

### 2. On-cue scene start (core, `assembleScenes`)

The scene's start becomes: the first matched word of ANY of its text props
(for list-type components the first item; for single-text components such as
ScreenshotFrame `label`, TitleCard `title`, ChatMock `keyword`, the matched
key phrase), minus a lead-in of ~0.3s, clamped to never be before the
moment's start. *(Lead-in value is my call.)*

When nothing in the props is spoken, fall back to an optional **`cueWord`**
the beat-sheet LLM supplies per moment ("the word index where the graphic
should enter"), validated to lie inside the moment; failing that, the
moment's start exactly as today.

All of this happens in source word indices before mapping through the
TimeMap, so it composes with cuts the same way anchors do today. The
existing min-duration floor still applies after the start moves — if the
on-cue start leaves less than the floor before the moment's end, the start
moves back earlier until the floor is met (never past the moment's start).

`cue.anchor` (what edits key to) is unchanged; only `startSec` moves. A scene
with an editor `timing` pin keeps the pin.

### 3. Item timing carried to the renderer

`SceneCue` gains an optional `reveal` field computed in `assembleScenes`:

```ts
reveal?: {
  mode: "synced" | "paced";
  /** synced: per item, seconds from the cue's start. */
  itemSec?: number[];
}
```

Synced item times are matched-word start (output time) minus a small lead
(~0.15s, so the item is up as the word lands), relative to the cue start.

### 4. The shared helper (scenes)

`useReveal(count, cue.reveal, settings)` in `packages/scenes/src/anim.ts`
returns per-item entrance progress 0→1, replacing the hand-written
`delay={i * 6}` in all four components. Arrow-follows-chip and similar
intra-item offsets stay component-local.

**Paced mode**: items are distributed over a reveal window that starts at
the cue start and lasts `speed × scene duration`, shaped by the pacing curve:

- `even` — equal gaps (default)
- `accelerate` — long first gap, then quicker
- `decelerate` — quick, then a held pause before the last items
- `ease-in-out` — slow at both ends

**Entrance style**: `pop` (today's, default), `fade`, `rise`, `bounce` — the
style each item's 0→1 progress is drawn with. `pop`/`rise` helpers already
exist in `anim.ts`.

### 5. Settings, defaults, editor

New optional props on all four components' schemas
(`packages/core/src/scene-registry.ts`):

| prop | values | default |
|---|---|---|
| `reveal` | `auto` · `synced` · `paced` | `auto` (matcher decides) |
| `pacing` | `even` · `accelerate` · `decelerate` · `ease-in-out` | `even` |
| `revealSpeed` | 0.1-1.0 (share of the scene the reveal takes) | ~0.66 |
| `entrance` | `pop` · `fade` · `rise` · `bounce` | `pop` |

Defaults finish the paced reveal about two-thirds into the scene so the full
diagram holds before the cut *(my call)*. `synced` forced on a scene whose
items do not match falls back to paced per item that failed — the one place
mixing is allowed, because the author asked for it.

The editor Inspector already renders a dropdown for every enum/boolean prop
(`scalarPropControls`, §153), so `reveal`, `pacing` and `entrance` get
controls with no editor UI work. `revealSpeed` needs a numeric slider; if
`scalarPropControls` has no number kind, add one there (all numeric props
then gain sliders — check that is acceptable for existing numeric props, or
gate it to this key).

Changing a reveal prop in the editor must preview live: the player already
re-renders on prop patches, and `reveal.itemSec` is computed at produce time
— so a switch from `paced` to `synced` in the editor needs the item times
available client-side. Simplest: `assembleScenes` always computes `itemSec`
when matching succeeded, regardless of the chosen mode, and the helper
ignores it in paced mode.

### 6. Prompt change

Add to the beat-sheet prompt: the optional `cueWord` field and its meaning
("the word where the graphic should appear — where its content is first
said"). Do NOT shorten moments: the moment still spans the beat, so the END
keeps holding (R23 §114). The coverage budget wording may need a note that
on-screen time now starts at the cue — see open question 1.

## Constraints

- House style: pure logic in core with unit tests (matcher, sync decision,
  on-cue start, pacing curves); prop values parsed with zod.
- Old `production.json` / `scenes-reviewed.json` / cached beat sheets
  without `cueWord`, `scene.cue` or reveal props must parse and render
  byte-identically to today (§7) — a regression test pins this.
- Tests: `pnpm test`, `pnpm typecheck`, and the editor Playwright e2e
  (not part of `pnpm test`).
- Verify on the author's field take (scene-12, scene-22, scene-16) with
  before/after start times in `docs/verification/`.

## Left to the builder

- Exact normalization/stemming rule and number-word handling.
- How to pick the "key phrase" for single-text components.
- Bounce implementation (spring config vs. keyframes).
- Easing function shapes for the pacing curves.

## Decisions (author, 2026-11-04)

1. **New plans only.** A take already reviewed renders exactly as reviewed.
   Reason the risk is real: `splits[].at` is in seconds and `splitCues` drops
   a split outside the cue window, and scene-tied sfx fire at the cue's final
   start (`sceneStartSeconds`), so moving an old scene's start silently
   drops splits and moves whooshes.
2. **The prompt bump is accepted.** Adding `cueWord` bumps
   `PRODUCER_PROMPT_VERSION`, so the next terminal `produce` on an existing
   take re-plans it (new copy and ids, edits re-keyed through anchors).
   Editor Render is unaffected: it pins `scenes-reviewed.json`.
3. **Less coverage is fine.** No compensating graphics; the COUNT/COVERAGE
   prompt wording and the beat scheduler stay as they are.

### 7. Gating: the plan carries its timing (follows from decision 1)

The matcher runs ONCE, at plan time (where scenes are built from moments,
`scene-props.ts`), and its result is stored on the `Scene`:

```ts
cue?: {
  /** Source word index the graphic enters on (before the lead-in). */
  entryWord: number;
  /** Per item, the source word it is spoken on, or null. */
  itemWords?: (number | null)[];
}
```

`assembleScenes` applies on-cue starts and synced items ONLY when `scene.cue`
is present. Old plans, old `production.json` and old `scenes-reviewed.json`
have no `cue` → today's timing exactly, including today's 6/8-frame stagger
(the shared helper's legacy path). This makes "new plans only" structural
instead of a version check, and makes the editor's Render (which replays the
reviewed scenes) reproduce the cue that was reviewed. Prop edits in the
editor that change an item's text do not re-run the matcher (my call: the
item keeps its word if it had one; new items added in the editor are paced).

## Builder-check answers (my calls, marked for the author's review)

- **Items stay on their spoken words** wherever the final start lands
  (de-overlap, floor, editor drag, `timing` pin, split). So `reveal.itemSec`
  in §3 is replaced by absolute OUTPUT seconds per item, resolved against the
  cue's final start in the renderer; an item whose word is before the final
  start is visible from the scene's first frame. A split's second half shows
  items already revealed as already on screen, never a replay from zero.
- **TerminalMock reveals per window**, as today; a window matches on its
  title or any of its lines.
- **The LLM does not set** `reveal` / `pacing` / `revealSpeed` /
  `entrance`. They are parsed from the registry schemas but stripped from
  the copy of the schema sent to the prop-writing call (`scene-props.ts`),
  so that prompt and its cache are untouched.
- **Field verification:** scene-12's label is not spoken verbatim ("matter"
  is never said), so it lands on cue via the new `cueWord`, which needs a
  fresh plan. The matcher must NOT be loosened to make it match. Pass bar on
  the field take with a fresh plan: scene-12 enters ≈99s and scene-22 ≈170s
  (±1s of the author's own retimes); scene-16 FlowDiagram (NEW IDEA →
  FRAMEWORK → BLOCKED, 124.4-134.9s, "build a framework myself which stops
  me from creating more projects or even if I'm having some amazing ideas")
  is either synced on "framework"/"ideas" or cleanly paced — never mixed;
  no scene ends earlier than in the current plan.
- **`revealSpeed` slider:** no component has a numeric prop today, so a
  number kind in `scalarPropControls` affects only this key.
