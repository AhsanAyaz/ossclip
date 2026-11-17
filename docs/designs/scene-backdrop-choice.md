# Choosing what is behind a scene in 16:9

*   **Author:** Muhammad Ahsan Ayaz (drafted with Claude)
*   **Status:** Draft 2 for the author (2026-11-17). Revised after four reviews (design, scope, code accuracy, implementation readiness); the changes are listed at the end
*   **Builds on:** `docs/designs/explainer-video-patterns.md` (section 1.5 and Phase 2); FINDINGS §161 and §162

--------------------------------------------------------------------------------

## Overview

In a 16:9 script project, ossclip draws each generated scene over the full-frame speaker. The author watched the EGM render and wants a choice per scene:

1.  the graphic over the speaker (today);
2.  the graphic on a full background, with no speaker;
3.  the graphic on a full background, with the speaker as a small picture at the bottom right;
4.  the graphic moved or made smaller, so it sits below or beside the speaker's face.

The renderer already has most of this, built for 9:16: a layout that hides the footage, a layout that shrinks it to a picture, and a movable graphic box. In 16:9 these are wrong, unreachable, or silently ignored. This design repairs them for script projects and gives the author one place to choose: the editor.

It completes section 1.5 of the explainer design and ships on the explainer branch.

## Terms

*   **Script project.** A project whose `production.json` holds a stored script. This is true on the first `produce --script` run and stays true when the editor's Render or the kit's refresh replays the command, which they do **without** `--script`. Every rule below is keyed on the stored script, not on the flag.
*   **Backdrop.** What fills the frame behind a scene's graphic. Three values, each an existing layout:

| Backdrop | Layout | Footage | Behind the graphic |
|---|---|---|---|
| `speaker` | `full-bleed` | full frame | the footage |
| `solid` | `graphic-only` | hidden; its sound continues | the look's background colour |
| `bubble` | `pip-bubble` | a small round picture | the look's background colour |

*   **Full-frame component.** `CardRow`, `CtaCard`, `BugCard`, `PhoneDemo` and clip scenes: they draw on the whole frame and lay themselves out. None of them exists in a released version.
*   **Slot component.** The nine older components (`TerminalMock`, `TitleCard`, `StatCard`, …), which are scaled into a rectangle.
*   **Graphic box.** The rectangle a graphic is drawn in, in fractions of the frame (`graphicRect`). The editor's drag and resize write it.
*   **Landscape remap.** A step in `produce` that rewrites vertical-only layouts for every 16:9 run: `graphic-only` becomes `blurred-behind`; `pip-bubble` and `video-top` become `split-left`. It runs twice, once on planned scenes and once after scenes are routed around burned-in text.

## What is wrong today

*   **`solid` and `bubble` cannot survive a run.** The remap rewrites both. They render only when set in the editor, because editor changes are applied after the remap.
*   **The speaker picture is sized for a vertical frame.** In 1920×1080 it is a 576×182 px pill at the bottom centre, and the face inside it would be about 60 px tall, because the picture shows the footage's full height.
*   **Changing a scene's layout throws its graphic box away.** A terminal that was centred and large falls back to the layout's own small slot.
*   **A full-frame graphic cannot be moved.** The editor shows drag handles and saves the box; the component ignores it.
*   **The planner's layout is half-used.** In a script run the planner may return a layout; for a full-frame card, `graphic-only` comes out as the speaker blurred and dimmed under the card.

## Goals

*   **G1.** In a 16:9 script project the author can set any scene to `speaker`, `solid` or `bubble` in the editor, and it renders that way in the preview, the full render, a later Render from the editor, and a kit refresh.
*   **G2.** Changing the backdrop keeps the graphic's box.
*   **G3.** The author can move and resize every graphic, including full-frame components, and one click places a graphic below the speaker's head.
*   **G4.** In `bubble`, the speaker picture is a circle at the bottom right that shows the head at a readable size, and the graphic keeps clear of it.
*   **G5.** A kit clip for a `solid` or `bubble` scene carries the background, and never carries footage.
*   **G6.** 9:16 output, and 16:9 projects without a script, are unchanged.

## Non-goals

*   **NG1.** Placing graphics around the face automatically. The face position is one point for the whole video; the author places the graphic, with the one-click help in G3.
*   **NG2.** Choosing the backdrop from the script (`@solid` on a cue) or from a flag for the whole run. Both are cheap to add later; they wait until the author has used the editor control and knows which default they want.
*   **NG3.** A size control for the speaker picture. One size, movable.
*   **NG4.** Captions keeping clear of the speaker picture. Explainer runs use `--no-captions`. It is recorded as a known gap and belongs with the kit captions design.
*   **NG5.** The speaker picture inside a kit clip, or any footage inside a kit clip (explainer design, 3.2).
*   **NG6.** The planner choosing a backdrop.

## Approaches

**A. A new `backdrop` field on a scene.** Readable, but the layout already says the same thing, and two fields that must agree are a standing source of bugs.

**B. Repair the three layouts that already are the three backdrops, for script projects (chosen).** No new scene field. The author-facing word is "backdrop"; underneath it is the layout the editor already stores.

**C. Leave it to Resolve.** A colour generator and a transform give `solid` and request 4 by hand. Picture-in-picture by hand on every scene is the work the author asked to be spared, and a re-flowed graphic (a card row that re-lays itself in a narrower box) is something a transform cannot do.

## Design

### 1. The three backdrops survive

*   In a 16:9 script project, both remap steps leave `full-bleed`, `graphic-only` and `pip-bubble` alone. Other layouts are remapped as before. Projects without a stored script are remapped as before.
*   In a 16:9 script project the planner's `layout` reply is ignored. The reply's schema and prompt do not change, so no cached plan is invalidated and 9:16 script runs, which use the field, are untouched.
*   Planned scenes still start as `speaker`.

### 2. The graphic box survives a backdrop change

*   When a scene's layout changes **between two of the three backdrop layouts**, its graphic box is kept: both the planned box and a box the author set. This applies in `applyOverrides` and in the editor's layout change. A change to or from any other layout drops the box, as today.
*   So a slot component keeps its large centred box (`SCRIPT_LANDSCAPE_RECT`) in all three backdrops.
*   In `solid` and `bubble` a slot component draws no frosted panel; the background is already plain.

### 3. Full-frame components use a graphic box

*   A full-frame component draws in its scene's graphic box when there is one, and on the whole frame when there is none.
*   Scenes are no longer given a box by the text-routing step when their component is full-frame. That step is the only automatic writer of a box onto such a scene, so after this change a box on a full-frame scene always comes from the author or from this design.
*   Full-frame components exist only on the unreleased explainer branch, so no released project changes.
*   The box of a full-frame component is limited to the frame's edges, not to the caption-safe area that limits slot components. Its smallest size is the existing minimum (8% of the width, 5% of the height).
*   These components lay themselves out from the width and height they are given. Their 100 px margin becomes the same fraction of the box that 100 px is of the full frame.
*   **"Below the face".** The Inspector's graphic box section gains a button that sets the box to the band from just under the measured head to 4% above the frame's bottom, across 92% of the width. It uses the existing head band (`headBand`). With no measured face the button is disabled.

### 4. The speaker picture in 16:9

*   **Shape and place.** A circle with a diameter of 28% of the frame height (302 px at 1080p). Its right edge is 4% of the frame width from the frame's right edge, its bottom 6% of the frame height from the bottom. The existing `pip.x` and `pip.y` move it.
*   **Crop.** The picture is zoomed so that the measured face height is 55% of the diameter, centred on the measured face. With no measured face it shows the centre of the footage at the existing crop.
*   **The graphic keeps clear.** In `bubble`, the box a graphic is drawn in is cut back at draw time so it does not enter the vertical strip the picture occupies: if the picture's centre is in the right half, the box's right edge is at most the picture's left edge minus 3% of the frame width; if in the left half, the mirror. This holds for planned and author-set boxes and follows the picture when the author moves it. A scene with no box gets the whole frame cut back the same way.
*   **9:16 is unchanged.** The picture's rectangle is computed from the frame's shape, and a vertical frame gets exactly today's numbers. The hidden footage in `graphic-only` uses the same rectangle as its fade target; that too is unchanged in 9:16.
*   **Scope.** The new shape applies to every 16:9 render of `pip-bubble`, including a project without a script where the author set it in the editor. Today that case draws the pill; no planner can produce it.
*   **Transitions.** The full render keeps today's 0.35 s ease: the footage shrinks into the picture and the background fades in, and the reverse at the end.

### 5. The editor

*   In a 16:9 script project, the Inspector's layout list is headed "Behind the graphic" and shows the three backdrops first, by name ("Over the speaker", "Full background", "Background with speaker picture"), then the remaining layouts under "Other layouts". It is the same control and writes the same override.
*   A scene whose layout is one of the others shows that layout selected, under "Other layouts".
*   The existing picture controls (position, roundness) appear in `bubble`, as today.

### 6. The kit

*   **`speaker`.** As today.
*   **`solid`.** The clip is the graphic on the background colour, over the whole frame. The background fades in and out over the same 0.35 s as the full render, so the clip's first and last frames are partly transparent and its middle is opaque.
*   **`bubble`.** The clip is the same as `solid`, with the graphic in its cut-back box. It contains no footage. The report notes, for that scene: "speaker picture not included: scale and move the footage on track 1 for this stretch". The picture's rectangle in pixels is written in the note.
*   **Clip scenes** (`clip:` cues) are still referenced, not rendered, in every backdrop, so they keep their quality and their sound. For `solid` and `bubble` the report notes that the background is not included.
*   The layout is already part of a clip's reuse key, so a backdrop change re-renders the clip.

## Verification

*   **Unit tests:** the remap skips the three layouts only for a 16:9 script project, at both remap steps, on a replay without `--script`; the planner's layout is ignored only there; box kept across backdrop changes and dropped otherwise; a full-frame component uses its box; routing writes no box onto a full-frame scene; the picture's rectangle and crop in 16:9, and today's numbers in 9:16; the cut-back box for a picture on either side; the "below the face" box; kit notes per backdrop.
*   **Unchanged output:** the test that pins a non-script 16:9 run's layouts still passes; 9:16 default-theme stills stay byte-identical; `packages/scenes/test/stage.test.ts`'s current "ignores a routed or hand-set rect" cases are replaced deliberately, and the pull request says so.
*   **Stills:** each full-frame component and one slot component in each backdrop, 16:9. The stills harness has no footage, so it gains a flat stand-in picture for the speaker; this comes first.
*   **Machine checks on a real render:** in `solid`, the four corner pixels mid-scene equal the background colour; in `bubble`, a pixel at the picture's centre does not, and the corners do.
*   **Editor test:** dragging a full-frame graphic moves it; changing the backdrop keeps the box.
*   **Acceptance on the EGM project:** the author sets three scenes to `solid` and three to `bubble` in the editor, renders, and reviews; a kit export has transparent, background and noted clips.

## Risks

*   **One face position for the whole video.** If the speaker moves, the picture can cut them off. The editor's per-scene video offset is the escape.
*   **A re-flowed graphic in a small box** may hit minimum text sizes. The stills decide whether a floor on the box size is needed for some components.

## Decisions for the author

1.  One place to choose, the editor. No script word and no flag yet (NG2).
2.  Planned scenes stay `speaker`.
3.  A `bubble` kit clip has the background and the cleared space, not your face. You add the picture in Resolve; the report gives its rectangle.
4.  The speaker picture is one size (28% of the frame height), movable.
5.  With captions on, captions can still land on the speaker picture (NG4).

## What the reviews changed

*   Rules are keyed on the stored script, not `--script`: the editor's Render and the kit refresh replay without the flag, and would have undone every backdrop.
*   No footage in a kit clip. The first draft baked the speaker picture in, which reverses the explainer design and can show stale footage after a recut.
*   The flag, the config key, the script word, the second editor control and the picture size control are cut or deferred.
*   The planner's layout is ignored on read, not removed, so cached plans and 9:16 runs do not change.
*   The graphic box is kept across backdrop changes, and slot components are kept clear of the picture; the first draft lost the box and let them overlap.
*   The text-routing step no longer writes boxes onto full-frame scenes, so honouring a box cannot change an existing render.
*   The picture is zoomed to the head; at the existing crop the face would be about 60 px.
*   Caption placement around the picture is out of this design.
