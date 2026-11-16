# Explainer videos: script cues, clip scenes and pattern scenes

*   **Author:** Muhammad Ahsan Ayaz (drafted with Claude)
*   **Status:** Approved (2026-11-16)
*   **Date:** 2026-11-16
*   **Reference:** the author's Video Playbook (a private document) (style, patterns, script format) and the finished video `EGM_V2.mov`

--------------------------------------------------------------------------------

## Overview

ossclip can cut a talking-head recording and add captions, a few template graphics and sound. It cannot yet produce the video the author made for the EGM episode ("Design with an Elephant, Review with a Goldfish", about the Elephant-Goldfish Model plugin): a 4-minute, 16:9 explainer where about 60% of the runtime is covered by animated scenes built for the script.

That video was made by hand. Claude wrote one Python script per shot (24 shots in about 3 hours), each rendered to a transparent ProRes clip with its own sound. The author then placed the clips in DaVinci Resolve.

This design moves that work into `ossclip produce`, in three phases that each ship on their own:

1.  **Script cues and clip scenes.** `--script <file>` reads the script the author writes before recording. Each on-screen cue becomes a scene timed to the words as spoken. A cue can name a transparent clip made elsewhere. After this phase ossclip assembles the EGM video from the 24 existing clips with no manual edit.
2.  **Pattern scenes and the explainer look.** Scene components for the repeatable shot patterns, in the playbook's style, so most cues need no hand-made clip.
3.  **Scene-owned sound.** Each scene emits sound from the same timings that drive its animation.

Generating one-off scenes as code is a separate, later design.

## Terms

*   **Transcript words.** Whisper's word list with timings. **Kept words** are the ones that survive the cut (silences, fillers and bloopers removed).
*   **Moment.** The planner's unit: a span of words (`startWord`..`endWord`), a component to show (`sceneKind`), a layout and the on-screen copy.
*   **Beat-sheet call.** The first LLM call. It reads the transcript and returns the moments.
*   **Props call.** The second LLM call. It fills each moment's component props. A moment plus props is a **scene**.
*   **Assembly.** The step that turns scenes into timed cues for the renderer, after the cut is final.
*   **Scrim.** The frosted panel the renderer draws behind a graphic in the `lower-third` and `full-bleed` layouts.

## The problem

**The shots.** The 24 shots of the EGM video fall into 8 patterns:

| Pattern | Shots | Existing component |
|---|---|---|
| Caption demo (phone frame with captions, pills building beside it) | 6 | none |
| Bug card (numbered problem with a small mock) | 4 | none |
| Terminal replay (typed command, streamed output) | 3 | `TerminalMock`, without typing |
| Big statement (a number, command or tagline) | 3 | `TitleCard`, `StatCard` |
| Mascot scene (logo characters act the line out) | 3 | none; one-off by nature |
| Card row (three cards, one per beat) | 2 | none |
| CTA card (the action performed on screen) | 2 | none |
| Meme dialogue (two characters, bubbles, a twist) | 1 | `ChatMock`, without characters |

ossclip's nine components are `TitleCard`, `StatCard`, `RuleCard`, `StrikethroughReveal`, `BulletList`, `FlowDiagram`, `TerminalMock`, `ChatMock`, `ScreenshotFrame`.

**What blocks this video today:**

*   **No script input.** Every spoken line in the author's script has an on-screen cue. ossclip can take only `--intent` (one line) or `--scenes` (hand-written scene JSON), so the planner guesses instead.
*   **Short-form limits.** The beat sheet asks for at most 12 graphics, removes moments above 45% coverage, and removes adjacent moments of the same kind. The video has 24 shots at 60%, with four bug cards nearly in a row.
*   **No video clips.** The overlay library takes images and GIFs (20 MB cap), so finished clips cannot be placed.
*   **Landscape layouts are thin.** Only `lower-third` and the splits have 16:9 geometry. In 16:9, `graphic-only` is a 0.8 × 0.54 slot, `full-bleed` falls back to a 0.77 × 0.36 band, and the speaker bubble's rectangle is computed for 9:16.
*   **Sound is planned apart from scenes.** A separate LLM call places sounds on words, at least 1.5 s apart.
*   **The look is generic.** Eight colour roles, and three components still hard-code colours.

## Goals

*   **G1.** `ossclip produce <video> --script <file>` turns each script cue into a scene anchored to the spoken words.
*   **G2.** A cue can place a transparent video clip, visible in both the editor preview and the render.
*   **G3.** 16:9 has full-frame layouts for a card, an overlay on the speaker, and a speaker bubble.
*   **G4.** Pattern components cover the repeatable shots, in the playbook's look.
*   **G5.** Scenes emit their own sound when `--sfx` is on.
*   **G6.** A run without `--script` produces the same output as today. The planner prompt, its menu and the sound menu do not change for those runs.

## Non-goals

*   **NG1.** Generating one-off scenes as code (mascot scenes). Clip scenes are the bridge.
*   **NG2.** Screen-recording inserts with zoom. A `screen:` cue is reported and left as talking head.
*   **NG3.** Writing the script. That stays with the playbook's script skill.
*   **NG4.** Adding a scene by hand in the editor. Editing, moving and hiding scenes keep working.
*   **NG5.** User-defined brand files. One built-in `explainer` look ships; the config `theme` still overrides colours.
*   **NG6.** A meme-dialogue component. One shot does not justify it; it goes through a clip.

## Anti-goals

*   A scene that states something the author neither said nor wrote in the cue.
*   A cue placed on the wrong words. An uncertain match is skipped and reported.
*   Any change in output for runs without `--script`.

## Approaches

**A. Extend the scene registry and drive moments from the script (chosen).** Script cues become moments; everything downstream is the existing path. One timeline, and scenes stay editable.

**B. Render every scene to its own transparent clip, then composite.** This copies the hand-made workflow. It doubles render time and scenes stop being editable or retimable after a recut. Rejected as the main path, kept for clips made elsewhere.

**C. Generate every scene as code first.** Needed eventually for mascot scenes. 21 of 24 shots do not need it, and it adds a compile-and-check loop before anything ships. Deferred.

**Remotion stays.** A spike drew a playbook-style card row in Remotion beside the original Python-made clip, and the look matched. The same spike confirmed the renderer plays ProRes 4444 with alpha. A second renderer (for example HeyGen's HTML-based HyperFrames) would have no editor preview.

--------------------------------------------------------------------------------

## Phase 1: script cues and clip scenes

### 1.1 Script format

A markdown file in the playbook's script format. Example:

```markdown
## 0:15 Problem

🎬 Terminal: a huge prompt, then a wall of code
🗣️ Here's how most of us build with AI.
🗣️ Big prompt. Big pile of code.

🎬 clip: clips/php_misread_alpha_sfx.mov
🗣️ And the AI shares your assumptions.

✂️ tighten the pause here
🗣️ So nobody catches the gaps.
```

Rules:

*   `🗣️` starts a spoken line. `🎬` starts an on-screen cue. `✂️` lines, headings and everything else are ignored.
*   A cue covers the spoken lines after it, up to the next `🎬` or the next heading. Blank lines and `✂️` notes do not end it (so in the example, the last line belongs to the clip cue). A spoken line before any cue in its section belongs to no cue.
*   A cue with no spoken lines is reported and skipped.

The example yields two scenes: one over "Here's how … pile of code", one clip starting at "And the AI".

**Footage cues.** Real scripts describe footage in plain words ("Screen recording: …", "B-roll of …", "Back to your face"). In script mode the planner may answer "no graphic" for such a cue; it stays talking head and is reported.

**Hints.** A cue may begin with one of:

*   `[ComponentName]` forces that component. An unknown name is an error that lists the valid names.
*   `clip: <path>` places a clip. The path is relative to the script file and must stay inside its folder; a missing file is an error.
*   `screen: …` marks a screen recording. It is reported, never built.

### 1.2 Alignment

Each cue's spoken text is matched to the **kept** words, so a line said in a blooper that was cut can only match the take that survived.

*   Text is normalised: lower case, punctuation removed, numbers as spoken.
*   Cues are matched in script order and cannot cross: each search starts after the previous cue's last matched word.
*   **Score** = script tokens found in order within the candidate span ÷ script tokens in the cue. The span may be at most twice the cue's token count.
*   **Floor: 0.6.** Below it, the cue is skipped and reported with its text and best score. A repeated phrase resolves to the earliest span after the previous cue.
*   The scene starts on the first matched word and ends on the last.

`restamp.ts` already aligns two word sequences in order; the builder should reuse it if it fits. Parsing and alignment are pure functions.

### 1.3 Planning in script mode

*   Each cue gets a stable id: its position plus a hash of its text.
*   `clip:` cues skip the LLM entirely. `[Component]` cues skip the component choice.
*   One LLM call covers the remaining cues. Input per cue: cue text, spoken text. Output per cue: component, layout, on-screen copy. This is a new schema; the beat-sheet schema (which requires a hook and caps moments at 24) is not used.
*   A script with more than 40 cues is an error that states the count.
*   If the call fails after one retry, each unplanned cue falls back to a `TitleCard` built from its cue text, as the props call does today.
*   The existing props call then runs unchanged.
*   **Limits.** Normalisation takes a mode. In script mode only overlap repair runs: no coverage budget, no same-kind removal, no graphics cap.
*   **Duration.** The 1.2 s to 15 s bounds stay. A cue whose span is longer is capped at 15 s and reported as shortened.
*   **Grounding.** On-screen copy may come from the spoken text or the cue text, nothing else. The grounding and copy-repair field lists gain entries for every component used in script mode.
*   **Cache key.** Script text, kept transcript, prompt version and look.

### 1.4 Clip scenes

*   **Component.** `ClipScene`, props `{src, gainDb (default −13), muted}`. The registry gains a `plannerSelectable` flag; `ClipScene` sets it false, so it never appears in any planner menu.
*   **Import.** The source may be ProRes 4444 `.mov` or VP9 `.webm` with alpha, up to 500 MB. On import ossclip transcodes it to a VP9-alpha WebM in the project's work folder. Browsers do not decode ProRes, so the editor preview and the render both use that WebM. Import is its own path; the overlay library's image checks and 20 MB cap are not reused.
*   **Timing.** The scene starts on the cue's first matched word and lasts the clip's length. A clip longer than 15 s is trimmed and reported. If the clip is shorter than the cue's span, the talking head simply resumes.
*   **Audio.** The clip's own audio plays under the voice at `gainDb`. Nothing is ducked. It is part of the clip, so it does not depend on `--sfx`.
*   **Layout.** Full frame, no scrim (see 1.5).
*   **Recut.** If the anchor word is later cut, the scene is dropped, as other scenes are.

### 1.5 Landscape layouts

*   `graphic-only` in 16:9 fills the frame (card on the background colour).
*   A new full-frame overlay slot draws a scene over the speaker with no scrim. The scrim becomes a per-component setting in the registry instead of a per-layout rule; existing components keep it.
*   `pip-bubble` computes its rectangle from the real aspect, so the bubble is round in 16:9.

9:16 output is unchanged.

### 1.6 CLI, report, editor

*   `--script <file>` is parsed with zod; a missing file is an error that names it. It does not change aspect or captions; the playbook's command (`--aspect 16:9 --no-captions --no-watermark`) still requests an explainer.
*   After planning and before rendering, the run prints one line per cue: **placed** (component, start time), **skipped** (reason, score), **shortened**, or **reported** (`screen:`). The same list is written to the work folder as `script-report.json`.
*   The project stores the script text and resolved clip paths in `production.json`. The editor's Re-plan uses the stored text, so it works after the script file moves.

### Phase 1 acceptance

From the EGM script and raw footage, with all 24 shots as `clip:` cues:

*   At least 22 of 24 cues are placed, and none is placed on the wrong line (each scene starts within 0.5 s of its spoken line's first word, checked against a hand-made list).
*   Every clip is visible in the editor preview and in the render, with transparency.
*   A run of the same footage without `--script` is byte-identical in its plan to today's.

--------------------------------------------------------------------------------

## Phase 2: pattern scenes and the explainer look

### 2.1 Components

| Work | Covers | Props (sketch) |
|---|---|---|
| Extend `TerminalMock` | Terminal replay (3) | typed mode for the first line, optional counter badge ("+1,568 lines") |
| New `PhoneDemo` | Caption demo (6) | caption words with emphasis boxes in a 9:16 frame with a silhouette; up to 4 pills with tick or cross |
| New `BugCard` | Bug card (4) | number, headline, red sub-line, mock, closing sticker |
| New `CardRow` | Card row (2) | 2 to 4 cards (title, mono sub-line, optional icon), optional highlighted card |
| New `CtaCard` | CTA card (2) | action (`comment`, `subscribe`, `link`), text, optional keyword, channel name, logo path |
| Restyle `TitleCard`, `StatCard` | Big statement (3) | `StatCard` gains a count-up when its value is a plain number with optional `+`, `,` and `%` |

`CardRow` and `CtaCard` have only two shots each in this video. They are included because the playbook's structure puts a three-item list and a CTA in every video.

`BugCard`'s mock is one of a fixed set: `caption` (a caption line with one word struck or clipped), `lines` (up to 4 text lines, one marked wrong), or `none`. It is not free-form drawing.

**Planner visibility.** The new components and the new modes are offered only in script mode. Runs without `--script` see today's menu (G6).

**Each new component also needs**, because none of it is automatic:

*   an entry in the renderer's component map;
*   fit metrics, so content scales to its slot;
*   reveal text extraction, so items land on their spoken words;
*   array editing in the editor's Inspector (the schema-derived controls only cover booleans, enums and bounded numbers);
*   allowed layouts. All of them allow the full-frame card and the full-frame overlay in 16:9. In 9:16, `PhoneDemo` and `CardRow` stack vertically and `BugCard` drops its mock.

**Shared pieces.** Pill, card, sticker, number badge, terminal window and phone frame are shared primitives.

**Motion.** The playbook's motion rules become shared helpers beside `anim.ts`: pop with overshoot, slides, typing with a block caret, a slow idle bob. Exact values come from the playbook.

### 2.2 The explainer look

*   `Theme` gains six roles. Their defaults reproduce today's colours, so existing output does not change.

| Playbook colour | Theme role |
|---|---|
| Blue `#7CACF8` | `accent2` (new) |
| Orange `#FF8D41` | `accent` |
| Yellow `#FFE14D` | `highlight` (new) |
| Green `#3DDC84` | `success` |
| Red `#FF4D4D` | `danger` |
| Card `#14161C` | `cardBg` |
| Terminal `#0F1320` / bar `#1A2034` | `terminalBg`, `terminalBar` (new) |
| Ink `#0F1013` | `ink` (new) |
| Grey `#7C86A6` | `muted` |
| Cyan `#5FD7FF` | `info` (new) |
| Slate `#3A4A5C` (card background) | `bg` |

*   `--look explainer` (config `look`) applies those values. Order of precedence, lowest first: built-in defaults, look, config `theme`, project theme overrides. To restyle for another product, set `accent` and `accent2` in config.
*   Inter (800, 900; SIL Open Font License) and DejaVu Sans Mono (Bitstream Vera licence) are bundled and loaded as files **only when the look is `explainer`**, so other runs render as before.
*   The hard-coded colours in `TerminalMock`, `RuleCard` and `ScreenshotFrame` move to theme roles whose defaults equal the current values.

### Phase 2 acceptance

*   The 20 shots that have a pattern component (all but the 3 mascot shots and the meme dialogue), written as plain cues (no `clip:`), are all placed and use the intended component in at least 17 cases.
*   Reference stills of each component in both aspects are committed under `packages/scenes/test/__stills__/` and reviewed by the author against the matching frames of `EGM_V2.mov`.
*   Runs without `--script` or `--look` produce the same plan and the same pixels on the existing fixture.

--------------------------------------------------------------------------------

## Phase 3: scene-owned sound

*   **Gate.** Scene sounds play only when `--sfx` is on. (`--sfx` is opt-in today; there is no `--no-sfx`.) `--sfx-level` keeps its meaning, the density of LLM-placed sounds, and does not affect scene sounds.
*   **Source.** Each component may define a pure function in core: props and timing in, events `{atSec, soundId, gain?}` out. Events are derived at assembly every time, never stored, so they follow prop edits and recuts.
*   **Limits.** Scene events bypass the LLM plan's 1.5 s spacing and per-minute budget. Each scene may emit at most 8 events.
*   **Typing.** Typing is one event: a pre-rendered typing loop trimmed to the typed duration. One sound per character would mount hundreds of audio elements, which is what broke the editor's player before.
*   **LLM plan.** In script mode the LLM sound call does not run. Sounds come from scenes and clips only.
*   **Pack.** The generator `packages/core/assets/sfx/synthesize.sh` gains the missing sounds: typing loop, tick, swish, thunk, chord. `click`, `error-buzz`, `ding` and `pop` already exist. New sounds are tagged scene-only and left out of the LLM's sound menu, so its prompt and cache key do not change (G6).
*   **The author's pop.** A user sound pack in `~/.ossclip/sfx` already overrides `pop`.
*   **Editor.** The editor preview does not play sound effects today. That does not change here.

### Phase 3 acceptance

*   Unit tests give the event list for each component.
*   In a rendered EGM cut, each pop lands within one frame of its card.
*   The author listens to the render and signs off the mix. Levels can be checked by a machine; taste cannot.

--------------------------------------------------------------------------------

## Verification (all phases)

*   **Unit tests:** cue parsing; alignment (verbatim, paraphrased, line said only in a cut blooper, repeated phrase, no match, cue with no lines); script-mode limits; hint errors; each new props schema; sound events.
*   **No-LLM proof:** the mock provider (`producer/mock.ts`) returns a script-mode plan, and the `verify-ossclip` skill (which drives the real CLI on a synthetic fixture) gains a fixture script.
*   **Editor test:** a clip scene renders in the browser preview.

## Compatibility

*   New component ids extend the scene id enum. A project made with them cannot be opened by an older ossclip, which is already true whenever a component is added.
*   The script-mode prompt has its own version. The existing producer prompt version is not bumped.

## Left to the builder

*   The alignment implementation, as long as the score, floor and tests above hold.
*   Exact prop names and length caps.
*   File layout for primitives and helpers.

## Decisions made without the author (please check)

1.  Three phases, with clip placement first, so the existing clips become usable before any new component exists.
2.  `--script` does not imply 16:9 or no captions.
3.  A cue that matches below 0.6 is skipped and reported, never placed.
4.  Short-form limits are off in script mode.
5.  No meme-dialogue component (one shot), and no user brand files yet.
6.  `TerminalMock` is extended; there is no separate terminal-replay component.
7.  New components are hidden from non-script runs.
8.  Typing sound is one loop per scene.
9.  In script mode the LLM sound plan does not run.
10. Clips are transcoded to VP9-alpha WebM on import.

## Answers from the author (2026-11-16)

1.  **Script format.** Confirmed: the playbook's script doc, as markdown.
2.  **The EGM script.** Saved as `packages/core/test/fixtures/egm-script.md`. Two things it shows about real scripts:
    *   Spoken lines and cues carry inline bold and code (`🗣️ **One.** When you cut…`, `🗣️ I typed \`/egm:egm-brainstorm\`.`). The parser strips the markup; alignment uses the plain text.
    *   The recording departs from the script (lines were added and dropped), and a cue with no `🗣️` line after it exists ("Flash on screen: 4,494 tests passing"). Both are the skip-and-report cases in 1.1 and 1.2.
