# Captions in the clip kit

*   **Author:** Muhammad Ahsan Ayaz (drafted with Claude)
*   **Status:** Draft 2 for the author (2026-11-17). Revised after four reviews (design, scope, code accuracy, implementation readiness); the changes are listed at the end
*   **Builds on:** `docs/designs/explainer-video-patterns.md`, "Phase 3: clip kit"; FINDINGS §162; `docs/designs/scene-backdrop-choice.md`

--------------------------------------------------------------------------------

## Overview

`ossclip kit` hands a project to DaVinci Resolve: the cut footage on track 1 and one transparent clip per scene on track 2. It leaves the captions out. The author wants them as their own layer above everything, to show, hide or move.

There are two ways to give Resolve captions, and they are different amounts of work:

*   **Part 1, a subtitle file.** `captions.srt` beside the timeline. Resolve turns it into a subtitle track: one item per line, text editable, style set for the track or per line, the track switched on or off. Small, and certain to work once one import is checked.
*   **Part 2, a rendered caption layer.** ossclip's own animated captions (the active word lighting up, emphasis sizes, the caption themes) as transparent video on track 3. This costs a render as long as the video, and it rests on three things that are not known yet.

This design specifies Part 1 fully and ships it first, as a small pull request of its own. Part 2 is specified as far as it can be, with the three unknowns named. It is built only after they are resolved and the author still wants it.

## Terms

*   **Caption line.** A group of words shown together (`CaptionLine` in `packages/core/src/captions.ts`): the words with their times, and the line's start and end, in output seconds (after the cut). In 16:9 a line holds at most 6 words and 2.4 s, or 8 words and 3.2 s where the caption choreography marked a phrase.
*   **Lane.** FCPXML's word for a track above the main one. Scene clips are on lane 1.
*   **Kept span.** One uncut stretch of the source on track 1.
*   **In-point.** Where inside a media file a timeline item starts playing.
*   **Layer frame, sequence frame.** The caption layer is rendered at the output rate (30 fps). The kit's timeline runs at the source's rate (60 fps for the author's footage). One layer frame is two sequence frames there; for other pairs of rates the ratio is not a whole number.

## What exists today

*   `render-props.json` always holds `captionLines`, with the author's caption edits applied, **also when the run used `--no-captions`**, as the explainer command does. That flag, and the editor's "hide captions" setting, only stop the render from drawing them.
*   `srtFromCaptionLines` (`packages/core/src/export-premiere-project.ts`) writes an SRT from caption lines, in output seconds, one entry per line. The `premiere-project` export uses it.
*   `CaptionTrack` (`packages/scenes/src/CaptionTrack.tsx`) draws the captions and needs no footage. A caption's row is chosen from the scene on screen: it moves away from a graphic's box, or to a row the author set for that scene, and a hook line can move near the head.
*   **Captions do not keep clear of the new scenes.** The four full-frame cards have no box to move away from, and the large centred box that terminals and titles get in a 16:9 script project leaves no free row. In both cases the caption is drawn at its usual row, on top of the graphic. Nobody has seen this, because explainer runs use `--no-captions`.
*   The kit's exporter writes every clip to lane 1, from the start of its file, and rounds a clip's start and its length separately, in sequence frames.
*   The kit refreshes a project that was edited after its last `produce`, so caption edits made in the editor reach an export.

## Part 1: the subtitle file

### Goals

*   **G1.** Every kit export of a project that has caption lines writes `captions.srt`, which Resolve imports into a subtitle track in time with the kit's timeline.
*   **G2.** Nothing else about a kit changes: same clips, same timeline, same reuse of existing clips.

### Design

*   **When.** On every `ossclip kit` run, including with `--clips-only`. It does not depend on `--no-captions` or on the editor's hide setting: the file is for Resolve, where the author decides.
*   **Content.** `srtFromCaptionLines` over the project's caption lines, skipping a line with no words. One entry per line, the words joined by spaces. Times are output seconds, which are seconds from the start of the kit's timeline. UTF-8, no byte-order mark, Windows line endings.
*   **No lines.** No file is written, an older `captions.srt` in the kit folder is removed, and the report says so.
*   **Report.** `kit-report.json` gains an optional `captions` object, `{ srt: string | null, lines: number }`. The report's version stays 1, so a report written before this change still parses and existing clips are reused.
*   **Printed.** After the existing import line: `Subtitles: File → Import → Subtitle…, pick captions.srt, then drag it onto the timeline`.

### Verification

*   **Unit tests:** content for plain and edited lines; a line with no words is skipped; no lines means no file and a stale one removed; written with `--clips-only`; an old report without `captions` parses and clips are reused; line endings and encoding.
*   **The author's check, once:** import the SRT for the EGM kit. It passes if the first and the last subtitle each start within a quarter of a second of the words being spoken. Resolve timelines start at 01:00:00:00 and the SRT at zero; Resolve is reported to place a dropped SRT from the timeline's start, and this check confirms it. If it lands an hour off, the fix is a `--srt-start <timecode>` option that shifts every entry, added before the pull request merges.

### What the author gets from Part 1 alone

Show and hide (the subtitle track's switch), move and restyle (the track's style, or one line's), edit the words, delete a line. Not ossclip's animated look. Whether Resolve 21 can animate a subtitle track by itself is worth a look during the check; if it can, Part 2 may not be needed.

## Part 2: the rendered layer

### Goals

*   **G3.** `ossclip kit --captions` adds the animated captions on lane 2: one timeline item per caption line, all playing from one file, so a line can be deleted, moved or hidden by itself.
*   **G4.** A caption item never shows a frame of the line before or after it.
*   **G5.** A later export renders the layer again only when the captions, their rows, their look or the frame size changed. Editing a scene's text does not.
*   **G6.** A kit without `--captions` is unaffected.

### Three things to settle first

1.  **What captions do under a scene that fills the frame.** A layer rendered today would draw captions over the cards and terminals. The rule proposed here: in a 16:9 script project, a caption line is not drawn while a scene is on screen whose graphic leaves no free row for it (a full-frame component with no box, or a box with less than a caption's height free above and below it inside the safe area). This is a rule for the caption renderer, so it also changes the full render when captions are on in such a project. It needs the author's agreement, because the alternative is to keep captions always visible and shrink the graphics to leave a row.
2.  **Size and render time.** Neither is known. Scene clips with graphics measured 32 to 56 Mbit/s and about 2.5 s of rendering per second of clip; a mostly empty frame should be far smaller and faster, but the offline fixture is 11.6 s long and cannot show it. One prototype render of the EGM captions, by hand, gives both numbers.
3.  **Whether Resolve accepts the timeline shapes.** The scene-clip spike did not cover: an item whose in-point is not zero; many items playing from one file; an item on lane 2 above a span that has nothing on lane 1; and an item attached to a span other than the first. One hand-made timeline covers all four.

If the size is over 1 GB for the EGM video, or the in-point items fail in Resolve, the fallback is the same: cut the one rendered file into one small file per caption line with ffmpeg, without re-encoding (every ProRes frame stands alone), and place those. That costs seconds, and the timeline then needs no in-points.

### Design, given those three

*   **Flag.** `--captions`. Off by default, because it adds a long render. `--force` renders it again. With `--clips-only` the file is rendered and no items are placed.
*   **Render.** A new composition draws `CaptionTrack` on a transparent frame for the whole output duration, with the inputs the full render gives it. They come from `render-props.json`: the caption lines, the scene cues, the look, the caption theme (the default theme when the field is absent), the measured face, the call-to-action keyword and window, the source's text regions, the overlay cues (from which the windows that hide captions behind a card are derived, with the helper the full render uses), and the watermark flag. The hide flags are ignored: asking for the layer is asking for captions.
*   **In pieces.** The layer is rendered in stretches of at most 60 s and joined without re-encoding. A long single render has already failed once on the author's machine under load (FINDINGS §161), and pieces can be rendered again singly.
*   **Fonts.** The composition mounts the bundled-font loader. When a line needs the Nastaliq font, the kit stages it, because `produce` skips it when captions are hidden.
*   **Format.** ProRes 4444 with alpha at the output size and rate, no audio.
*   **Which lines get an item.** Every line that is drawn. A line hidden by a card window, or by rule 1 above, gets no item; the SRT still has it.
*   **Timing (G4).** For each line, take its first and last layer frame from the same frame rule the caption renderer uses (`frameWindow` at the layer's rate). With `r` = sequence rate ÷ layer rate:
    *   the item starts at sequence frame `ceil(first × r)`;
    *   it ends before sequence frame `floor((last + 1) × r)`, and its length is that end minus its start, never less than one frame;
    *   its in-point is layer frame `floor(start ÷ r)`, written in the layer file's own time base.
    Every sequence frame of the item then falls inside the line's own layer frames. Two lines that touch cannot overlap, because one's end and the next one's start are computed from the same boundary.
*   **Exporter.** A timeline clip gains optional `lane` (default 1) and an in-point in the file's own frames (default 0). Clips that carry an explicit end frame use it; scene clips keep today's rounding, so today's timelines do not change. An in-point plus length is limited to the file's length.
*   **Attachment.** Each item is attached to the kept span it starts in, as scene clips are.
*   **Reuse (G5).** The key is a hash of: each drawn line's words, times, emphasis and role; the row and scale each line resolves to; the caption theme; the three look values the caption renderer reads (display font, text colour, accent); the call-to-action keyword and window; the frame size and rate; and a version number of its own, separate from the scene clips' version. Scene props are not in it.
*   **Leaving the flag off later.** An existing `captions.mov` stays in the folder and is not placed. The report says the layer was not included.
*   **Report.** The `captions` object gains `layer: string | null`, `layerKey: string | null`, `layerStatus: "rendered" | "reused" | "not requested" | "failed"` and `items: number`.

### Verification

*   **Unit tests:** the timing rule at 60, 59.94, 30, 25 and 23.976 fps sequence rates against a 30 fps layer (no item frame outside its line; no overlap between touching lines; one-frame lines); in-points limited to the file; lanes in the XML; one asset however many items; lines without items; the reuse key ignores a scene's props and changes with a line's row; the report.
*   **Machine check on a real render:** for every item, the layer frame at its in-point has some opaque pixels and the frame before the line's first has none of that line's; the corner pixel is transparent throughout; the file's frame count is `round(output duration × rate)`.
*   **The author's check:** on the EGM kit with `--captions`, ten items spread through the timeline each show the line spoken under them.

## Non-goals

*   Captions as editable styled text in Resolve (Text+ or Fusion titles).
*   Captions inside the FCPXML (`<caption>` elements). Whether Resolve reads them is not documented; the SRT import is one menu action.
*   Word-level timing in the SRT.
*   Keeping captions clear of graphics the author moves in Resolve. The layer carries the rows ossclip chose.
*   Keeping captions clear of the speaker picture in the `bubble` backdrop (`scene-backdrop-choice.md`, NG4). If Part 2 goes ahead, rule 1 is extended to treat a `bubble` scene's picture as leaving no free row beside it, or captions are narrowed; that is decided then.

## Approaches considered for the layer

*   **One file per caption line, each rendered separately.** A 4-minute video has 110 to 200 lines and each render pays several seconds before its first frame: ten minutes or more.
*   **One file, one long timeline item.** The author cannot remove or move one line.
*   **One file, one item per line (chosen),** with per-line files cut from it as the fallback.

## Order of work

1.  Part 1, with the author's SRT check. Its own pull request.
2.  The author looks at what the subtitle track can do in Resolve and says whether Part 2 is still wanted.
3.  If so: the prototype render and the import spike; the author's answer on rule 1; then a plan for Part 2. Part 2 follows the backdrop work, because both change the kit and the caption rows depend on the backdrops.

## Decisions for the author

1.  The SRT is written on every kit export.
2.  Part 2 waits for your look at Resolve's subtitle track.
3.  Rule 1: under a scene that fills the frame, the animated caption is hidden, not squeezed in. The SRT still has the line.

## What the reviews changed

*   The work is split: the SRT ships alone and first. The first draft made the rendered layer the main route, on an assumed need: the author has not seen ossclip's captions on these videos.
*   Captions would have been drawn over the new scenes. The first draft said the layer "carries the positions ossclip computed around its own scenes"; for full-frame scenes there are none.
*   Item timing is defined on the layer's frames with an explicit rule. The first draft said the in-point "is the same time", which on a 60 fps timeline can show a neighbouring line for one frame, and lets touching items overlap.
*   The reuse key covers the captions and their rows only. "Everything the composition is given" would have re-rendered the layer for every scene text edit.
*   The report change is optional fields, so existing kits are not re-rendered once.
*   Size and render time are stated as unknown, with a prototype before any plan, and the layer is rendered in pieces.
*   The spike covers four shapes, and both failure outcomes have a stated fallback.
