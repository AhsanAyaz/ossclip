# Timeline lanes: footage on V1, graphics on V2

*   **Author:** Muhammad Ahsan Ayaz (drafted with Claude)
*   **Status:** Draft 4 (2026-11-24), revised after review rounds 1 (design, code accuracy, build readiness, scope), 2 (design, code accuracy, build readiness) and 3 (code accuracy, build readiness). The reports are `~/ossclip-work/egm-short/timeline-lanes-review-r{1,2,3}.md`. Approach B chosen by the author. Changes are listed at the end.
*   **Builds on:** FINDINGS §97 (take filmstrips), the precision-editing design (drag readout, snapping), take-looks-by-source R6-4 (look-mode piece selection), `docs/designs/editor-added-graphics.md`.
*   **Mockup:** `~/ossclip-work/mockups/timeline-lanes/index.html` (v2) and `v2.png`. Local only. Every value the build needs is copied into this doc. If the doc and the mockup disagree, the doc wins.

--------------------------------------------------------------------------------

## Overview

The editor timeline (`apps/editor/src/Timeline.tsx`) draws every scene cue in one 44 px row (`track`, `Timeline.tsx:1972-1980`). Graphic blocks and take blocks alternate along it. The author reports two problems:

1.  **Footage and graphics look alike.** A graphic block is `#1A1A21` with a `#2A2A33` border. A take block without a thumbnail is `#131318` with a `#22222a` border (`Timeline.tsx:1647-1672`). Both are labelled with the cue id. Kept takes are labelled `KEPT`.
2.  **What can be dragged or trimmed is unclear.** Graphic blocks move and resize (edge handles, `Timeline.tsx:1695-1706`). Take blocks never move: their window is derived, and a drag on one scrubs (`Timeline.tsx:1610-1631`). Every block has `cursor: "pointer"` (`:1988`), so the screen gives no hint which is which.

The single row also misstates how ossclip works. Take cues are the gaps between graphics (`fillPlainCues`, `packages/core/src/fill.ts:60-110`), so a graphic block seems to replace the footage. The recording does not stop under a graphic. Its picture plays under every layout except `graphic-only`, and its audio plays unless the graphic's `video.volume` is 0.

This design splits the track into two lanes. **V2** (top) holds graphic blocks. **V1** (bottom) holds take blocks over a passive footage strip. The data model, the overrides, produce and the render do not change.

## Terms

*   **Graphic block.** A cue with `kind !== "plain"`. A cue with no `kind` is a graphic (`scene-schema.ts:147-158`). This is the same test as `stored()` (`apps/editor/src/timing.ts:65-66`).
*   **Take block.** A cue with `kind === "plain"`. This includes revived `take-kept-*` pieces (`cue.kept`) and carved look-mode pieces that share an id.
*   **Footage strip.** One full-width, non-interactive background element in V1. It shows wherever no take block sits: under graphics, in slivers shorter than `MIN_PLAIN_SEC` (`fill.ts:32, 83`), under hidden split halves, and in veto holes. Nothing is computed to place it.
*   **Picture hidden.** `layout === "graphic-only"`, the one layout whose video slot has `opacity: 0` (`packages/scenes/src/stage.ts:811-828`, `layoutSlots`).
*   **Live cues.** The `cues` prop, `live.sceneCues` (`apps/editor/src/App.tsx:3733`).

## Goals

*   At a glance, footage and graphics are on different rows and look different.
*   Every block that can be dragged or trimmed is on V2. Nothing on V1 moves.
*   V1 shows where a graphic hides the recording's picture.
*   Every gesture on a block (select, drag, edge drag, snapping), every shortcut and every selection rule works as it does today. **One declared exception** is in §5: empty lane space seeks.

## Non-goals

*   Real tracks. Footage stays derived, not a placed clip. Stacking graphics, moving a graphic between lanes, and footage that can be dragged are out of scope.
*   Filmstrip frames under graphics. The footage strip is flat (round 1, B3).
*   Moving the SFX, overlay or removal-marker rows. They stay above the ruler.
*   Lane mute, solo, lock, hide or resize controls.
*   A hatch on take blocks set to `graphic-only`. Their filmstrip keeps showing footage the render hides, as it does today. This is a known limit, kept out to avoid covering the take's label, `KEPT` mark and badge (round 2, S1).
*   Any change to `packages/*`, `overrides.json`, `App.tsx`, `timing.ts`, `useTakeThumbs` or render output. This is editor-only: no version bump or release note of its own.

## Anti-goals

*   A V1 that suggests footage can be dragged, trimmed or slipped. It must read as fixed material.
*   A regression in any block gesture, cut band, restore seam, removal seam or look-mode selection.
*   A timeline so tall that the player loses more than the track's added height.

## Approaches

*   **A. One row, styled apart.** Accent colour, a component label and visible grips on graphic blocks. Small. It fixes problem 1 and part of problem 2, but it keeps the "graphic replaces footage" picture.
*   **B. Two lanes (chosen by the author, 2026-11-24).** As described here. It fixes both problems and draws the model correctly.
*   **C. Do nothing.** Rejected: the author wants the visual change, and A's scope is close to B's once B is built as below.

Inside B, the build has two shapes:

*   **B1. One track container, lanes as vertical offsets (chosen).** The `track` div (`trackRef`) keeps its role and its width. It grows taller. Each block's `top` and `height` come from its lane. All seek and drag maths divides by the track's width (`seekTrack`, `Timeline.tsx:720-728`, and the drag handlers), and nothing in the timeline hit-tests vertically (`clientY` only places context menus). So every block gesture keeps working unchanged. Cut bands, seams and the playhead are already children of the track, so they span both lanes.
*   **B2. Separate lane containers.** Rejected: each gesture would need a new width reference, and six e2e sites find the track as the playhead's parent (§2).

## Design

### 1. Geometry

All values are in px, inside the track's content box.

| Part | top | height |
| --- | --- | --- |
| V2 blocks | 3 | 28 |
| Divider | 34 | 1 |
| V1 blocks, footage strip and hatches | 38 | 36 |
| Track (`track.height`) | | 77 |

The track grows from 44 to 77 px, an increase of 33 px.

The `block` style keeps `position`, `borderRadius`, `boxSizing`, `display`, `alignItems` and `overflow`. Its `top: 3, bottom: 3` is replaced by two module constants in `Timeline.tsx`, `V2_BOX = { top: 3, height: 28 }` and `V1_BOX = { top: 38, height: 36 }`. The `cues.map` loop (`Timeline.tsx:1583`) picks one of them by `isPlain`.

`Timeline.tsx` also exports one pure predicate, `pictureHidden(layout: Layout | undefined): boolean`, which returns `layout === "graphic-only"`. No new module is added, and `timing.ts` is not changed (round 2, M5).

### 2. DOM-shape invariants

B1 relies on these, and the plan must keep them:

*   The playhead, cut bands, cut seams, drag readout and snap tick stay direct children of the `trackRef` div. Six e2e sites find the track as `getByTestId("playhead").locator("..")`: `interactions.spec.ts:18, 33, 192, 699`, `delete-scene.spec.ts:20` and `sliver-cut.spec.ts:56`.
*   The track stays the ruler's next element sibling (`Timeline.test.ts:123`).
*   Every new element (divider, footage strip, hatches) is a child of the track. There are no lane wrapper divs.
*   Each `cues.map` iteration returns a `<React.Fragment key={`${cue.id}:${cue.startSec.toFixed(3)}`}>` holding the block and, for a picture-hidden graphic, its hatch. The key moves from the block div to the Fragment, so the duplicate-id reasoning at `Timeline.tsx:1599-1606` still holds.

### 3. V2: graphic blocks

*   **Unchanged.** The element, handlers and test ids (`timeline-block-<id>`) stay as they are. The block div gains `data-lane="graphics"` and `title={cue.id}`. The title goes on the block div because the label span ignores the pointer (`:2004`).
*   **Style, unselected.**
    *   `backgroundColor: "#2c1828"`.
    *   `backgroundImage: "linear-gradient(#3a1f33, #2c1828)"`.
    *   `border: "1px solid #F472B6"`.
    *   Use the longhand properties, not the `background` shorthand (the React warning at `:2149-2151`).
    *   Pink is apart from every colour already in use: playhead `#FFE14D`, cut red, kept violet `#B78CFF`, SFX teal `#4ECDC4`, overlay orange `#F5A623` and selection blue `#5b8cff`.
*   **Style, selected.** Today's `2px solid #5b8cff` border and `#1c2333` background, with `backgroundImage` left out.
*   **Cursor.** `grab`. The handles keep `ew-resize`.
*   **Label.** Two spans inside today's `blockLabel` span:
    *   The component name (`cue.component`), with `fontWeight: 600` and `textTransform: "none"`. Its colour is `#FBCFE8`, or `#dbe4ff` when the block is selected. Component names are CamelCase, and uppercase would render `BULLETLIST`.
    *   The cue id, with `marginLeft: 6` and `opacity: 0.6`, keeping `blockLabel`'s weight and uppercase.
    *   The schema requires `component` on graphics (`scene-schema.ts:291-295`). A missing one falls back to the id span alone only as a type guard; no test covers it.
    *   `blockLabel`'s ellipsis still clips the whole line on narrow blocks.
*   **Grips.**
    *   Each existing `edgeHandle` div (10 px hit zone, `EDGE_HIT`, `:248`) gets `className="ossclip-edge"`. It also gets one child `<span className="ossclip-grip" />` with inline position only: `position: absolute`, `top: 5`, `bottom: 5`, `width: 3`, `borderRadius: 2`, `pointerEvents: "none"`, and `left: 2` on the start handle or `right: 2` on the end handle.
    *   The two `.ossclip-grip` rules go in `apps/editor/src/index.css`, near the hover pattern at `:66`: `.ossclip-grip { background: #F472B6; opacity: .8 }` and `.ossclip-edge:hover > .ossclip-grip { opacity: 1 }`. Opacity is set in CSS only, never inline (`index.css:41-48`).
    *   The grip sits inside the border, so it is 3 px from the outer edge, or 4 px when the block is selected.
*   **Badges.** On graphic blocks only, the PIN and volume badges get `right: 8`, clear of the end grip. The take volume badge keeps `pinBadge`'s `right: 3`. PIN and volume can still overlap each other on a pinned graphic with non-default gain. That overlap exists today and is accepted.

### 4. V1: footage

*   **Divider.** One element, `data-testid="timeline-lane-divider"`: `position: absolute`, `left: 0`, `right: 0`, `top: 34`, `height: 1`, `background: #22222a`, `zIndex: 0`, `pointerEvents: "none"`. It is the track's first child.
*   **Footage strip.** One element, `data-testid="timeline-footage"`, rendered second:
    *   `position: absolute`, `left: 0`, `right: 0`, `top: 38`, `height: 36`, `boxSizing: "border-box"`;
    *   `background: #15151b`, `border: 1px dashed #2f2f3a`, `borderRadius: 4`;
    *   `zIndex: 0`, `pointerEvents: "none"`.

    `left/right` with `border-box` keeps it inside the track. A 2 px overflow would turn on scrolling at zoom 1 (round 2, S9).
*   **Take blocks.**
    *   Unchanged: the element, handlers, filmstrip, `KEPT` styling, volume badge and test ids.
    *   They move to the V1 box and gain `data-lane="footage"` and `cursor: "default"`.
    *   A drag still scrubs. A click still selects without seeking. Look mode still selects by piece (`pieceSelection`). They have no grips.
*   **Hatch, for picture-hidden graphics only.** For a graphic cue where `pictureHidden(cue.layout)` holds, the iteration's Fragment adds one element after the block:
    *   **Id:** `data-testid="timeline-hatch-<cue.id>"` and `data-piece-start={cue.startSec.toFixed(3)}`. Both come from the cue, not the drag preview, so the element keeps its identity during a drag (round 2, S3).
    *   **Position:** the V1 box. `left` and `width` come from the same preview-aware `startSec`/`endSec` locals as the block (`:1586-1589`), so the hatch slides with a dragged card. The window it leaves shows plain footage strip until the commit.
    *   **Box style:** `position: absolute`, `display: "flex"`, `alignItems: "center"`, `overflow: "hidden"`, `boxSizing: "border-box"`, `borderRadius: 4`, `border: 1px dashed #2f2f3a`, `backgroundImage: repeating-linear-gradient(135deg, #15151b 0 6px, #1b1b22 6px 12px)`, `zIndex: 2`, `pointerEvents: "none"`.
    *   **Why z 2:** above unselected take blocks (1), so a dragged hatch paints over the neighbouring take instead of sliding under it (the R11 Task 1 bug, `:1636-1641`). It stays below cut bands and the selected block (3). The plan also changes the stacking comment at `Timeline.tsx:1640-1641` from "ghost 2", which no longer exists, to "hatch 2".
    *   **Label:** one span with `blockLabel`'s font, padding, `nowrap` and ellipsis, in `#5f5f6a`, `fontWeight: 400`, `textTransform: "none"`. The box's `overflow: hidden` clips the label on a short graphic, so it never spills onto the next take. The text is `audio only` when the cue's `video.volume` is absent or not 0, and `muted` when it is 0.
    *   **Not hatched:**
        *   a graphic with any other layout. Its picture plays, and a muted one already shows MUTE on V2;
        *   take blocks (Non-goals).
    *   **A `ClipScene` set to `graphic-only`** plays its own media over the hidden picture. The hatch is drawn the same way, and its label still describes the recording's audio.
*   **Filmstrip.** `takeThumbTimes` and `useTakeThumbs` do not change. The strip and the hatches request no frames. A committed graphic drag re-derives the takes and refetches their frames, as it does today.

### 5. Presses on empty lane space (declared exception)

Today, empty track space is the 3 px insets, slivers, hidden split halves and veto holes. A press on a graphic anywhere in its 38 px height selects it.

With lanes:

*   **Empty V2** (above a take) seeks and scrubs. This is the existing bare-track handler (`Timeline.tsx:1572-1581`), unchanged. It acts like the ruler.
*   **V1 under a graphic** (footage strip or hatch) seeks and scrubs too, because both ignore the pointer.
*   **Graphic blocks** are selected only on V2. Their hit height goes from 38 to 28 px.

The 2026-08-07 field report ("clicking a scene to edit it kept yanking the playhead") is about presses on blocks. Those still select without seeking. Seeking on empty space is what the author knows from Resolve.

### 6. No lane labels

The lanes have no `GFX`/`CAM` labels. The pink blocks on top and the filmstrip blocks below already tell the lanes apart. No other timeline row has a label (`Timeline.tsx:2095-2099, 2136-2140, 2203-2207`).

Two ways to place labels were tried and dropped:

*   **A gutter outside the scroller** cannot line up with the lanes, because the marker, SFX and overlay rows above the ruler come and go (round 1, S2).
*   **Sticky labels inside the track** cover the label of the first block in view. In mockup v2, `CAM` covered `take-0`'s label at scroll 0.

### 7. Stacking

| Element | z | Notes |
| --- | --- | --- |
| divider, footage strip | 0 | rendered first |
| block | 1 | |
| hatch | 2 | new |
| cut band, selected block | 3 | |
| dragging block, seam | 4 | |
| playhead | 5 | |
| snap tick, drag readout | 6 | |

The drag readout floats above the track (`dragReadout`) and is not affected.

## Edge cases

*   **No graphics.** V2 is drawn empty. *(Call 2: one layout, no conditions.)*
*   **Back-to-back graphics** with the assembler's 0.05 s gap (`fill.ts:29-31`). Each gets a hatch or none from its own layout. The footage strip shows in the gap.
*   **Overlapping graphic windows** come only from produce, pins or speed changes; the gestures clamp against neighbours (`timing.ts:75-92, 167-192`).
    *   V2 draws them overlapped, as today.
    *   A selected block (z 3) can cover a neighbour's grip.
    *   Where only one of the two is `graphic-only`, its hatch covers its whole window, whichever scene the render puts on top.

    All three are accepted.
*   **Kept ranges under a graphic** are not carved into takes (`kept-takes.ts:131-135`), so they show as footage strip. Today they show nothing either.
*   **Zoom.** Every element is inside the zoom-width content.
*   **Hidden graphics.** They are not drawn today; the take covering their window offers Restore (`App.tsx:3709-3712`). No change.

## Risks and mitigations

*   **Existing tests that aim at fixed y.**
    *   `interactions.spec.ts:215-221` scrubs at the track's mid-y. At 77 px that is y 38.5, the top edge of V1. Fix: aim at the take block's own box centre.
    *   `interactions.spec.ts:478-497` drags scene-2's start edge 60 px into take-0 and expects scene-2 to be topmost at `box.x - 30`.
        *   Under lanes, the two blocks no longer share a row.
        *   Keep the computed-z assertion at `:478`.
        *   Re-aim the `elementFromPoint` half. At scene-2's own y (V2), the topmost block is scene-2, because the preview grew. At take-0's box centre y (V1), the topmost block is take-0, because nothing under the graphic steals the take.
        *   The cross-lane paint check moves to new e2e step 4.
    *   **Checked, block-relative and safe:** `edit.spec.ts:30, 36`; `interactions.spec.ts:55, 202, 265, 835-841`; `clip-speed.spec.ts:112`; `graphic-editor.spec.ts:129, 275`; `landscape.spec.ts:65, 88`; `kept-take-framing.spec.ts:34`.
    *   **Checked, ruler-relative and safe:** `interactions.spec.ts:52, 139, 819, 1178`; `added-graphics.spec.ts:74`; `overlays.spec.ts:162, 170`; `sfx-preview.spec.ts:33`; `sliver-cut.spec.ts:81`.
    *   Unit tests mock x only.
*   **Vertical space.**
    *   The editor shell is `100vh` with `overflow: hidden`, the main row has `minHeight: 0`, and the stage area is `inset: 0; overflow: auto` (`App.tsx:3888-3901`).
    *   So a taller timeline shrinks the stage area. It never pushes the timeline below the fold.
    *   The stage is height-bound on portrait projects (`App.tsx:2582-2585`), so it loses exactly the track's 33 px. On landscape it loses nothing. That is the intended cost, and no test can fail on it, so there is no viewport step (round 3, S1).
    *   The comment at `playwright.config.ts:153` ("stage ≈676px") becomes "stage ≈643px", that is 676 minus 33.

## Files

*   `apps/editor/src/Timeline.tsx`:
    *   track height, `V2_BOX`/`V1_BOX`, `pictureHidden`;
    *   block styles, label spans, grips, badge offset, cursors;
    *   divider, footage strip, hatches, Fragment keys.
*   `apps/editor/src/index.css`: `.ossclip-grip` and `.ossclip-edge:hover > .ossclip-grip`.
*   `apps/editor/test/Timeline.test.ts`: new suite.
*   `apps/editor/e2e/interactions.spec.ts`: the two fixes above, plus a new `describe("timeline lanes")`.
*   `apps/editor/playwright.config.ts`: the comment at `:153`.
*   `docs/PHASE1-FINDINGS.md`: §175, once it ships.

## Test plan

### Component (`Timeline.test.ts`, new `describe("Timeline — lanes")`)

**Fixture:** `durationSec` 20. Cues:

| id | window | kind | layout | component | other |
| --- | --- | --- | --- | --- | --- |
| `take-0` | [0, 2] | plain | full-bleed | | `video: { volume: 0.5 }` |
| `scene-a` | [2, 6] | graphic | pip-bubble | BulletList | `pinned: true`, `props: {}` |
| `scene-b` | [6.05, 10] | graphic | graphic-only | TitleCard | `video: { volume: 0 }`, `props: {}` |
| `scene-c` | [10, 13] | graphic | graphic-only | StatCard | no `video`, `props: {}` |
| `take-1` | [13, 20] | plain | graphic-only | | |

The `Harness` at `Timeline.test.ts:91` hard-codes `selection: null`. It gains an optional `selection` prop for assertion 16.

Assertions:

1.  `scene-a`, `scene-b` and `scene-c` have `data-lane="graphics"`, `style.top === "3px"` and `style.height === "28px"`.
2.  The takes have `data-lane="footage"`, `style.top === "38px"` and `style.height === "36px"`.
3.  The track's `style.height === "77px"`.
4.  `scene-a`'s block has `title === "scene-a"`. Its first label span's text is `BulletList`, with `style.textTransform === "none"` and `style.fontWeight === "600"`. Its second span's text is `scene-a`, with `style.opacity === "0.6"` and `style.marginLeft === "6px"`.
5.  Each graphic has two `.ossclip-edge > .ossclip-grip`. The takes have none.
6.  No grip has an inline `opacity`.
7.  Cursors: `grab` on graphics and `default` on takes.
8.  Badges:
    *   `scene-a`'s PIN badge has `style.right === "8px"`.
    *   `volume-badge-scene-b` (text `MUTE`) has `style.right === "8px"`.
    *   `volume-badge-take-0` (text `50%`) has `style.right === "3px"`.
9.  `timeline-lane-divider` and `timeline-footage` exist, with `pointerEvents === "none"`. The footage strip has `boxSizing === "border-box"` and `style.top === "38px"`. Its `left` and `right` are set: jsdom reads React's numeric `0` back as `"0"` (`project-picker.test.ts:87`), so assert `"0"` or `"0px"`.
10. There are exactly two hatches:
    *   `timeline-hatch-scene-b`, with text `muted`;
    *   `timeline-hatch-scene-c`, with text `audio only`.

    Both have `pointerEvents === "none"`, `zIndex === "2"`, `style.top === "38px"` and `style.height === "36px"`. Each hatch's `style.left` and `style.width` equal its block's. Their `data-piece-start` values are `"6.050"` and `"10.000"`. `scene-a` and `take-1` have none.
11. `take-1` still shows its label text `take-1`, and no element covers it in the DOM: no hatch test id contains `take-1`. The filmstrip itself is not visible in jsdom, because the harness passes neither `toSourceSec` nor `videoSrc`. It is on the by-eye list.
12. With no graphic cues, the divider and the footage strip still render.
13. The playhead's parent is the track, and the track is the ruler's next element sibling.
14. `pictureHidden` returns true only for `graphic-only`. The test walks `LayoutSchema.options` and checks each against `layoutSlots(l).video.opacity === 0` from `@ossclip/scenes/geometry` (the import `overlayBox.ts:2` already uses). So the predicate is tested against the renderer's own table.
15. The existing suites pass unchanged.
16. With `selection` set to `scene-a`, its block has an empty `backgroundImage` and a `2px solid` border. Unselected, its border is `1px solid` with the pink colour, which jsdom reports as `rgb(244, 114, 182)`.

### E2E (`interactions.spec.ts`, new `describe("timeline lanes")`)

The fixture's graphics are scene-0 `video-top` (0.09-5.09 s), scene-2 `blurred-behind`, scene-3 `video-top` and scene-5 `blurred-behind` (`apps/editor/e2e/fixtures/workdir/render-props.json:801-869`).

**Oracles:**

*   "Selected": `timing-range` is visible (`:203`).
*   "Did not seek": `playheadFrac` changed by less than 0.02.
*   "Seeked": `playheadFrac` changed by 0.02 or more.

**Timing and isolation.** Steps 1, 2 and 4 are separate `test()`s, each on a fresh `page.goto("/")` and `settle(page)`. "Before" is read after the ruler park. "Seeked" is checked with `expect.poll`, because the seek lands asynchronously.

**Steps:**

1.  **A press on V1 under a graphic seeks and does not select.**
    *   Park the playhead on the ruler at scene-3's 0.2 width.
    *   Press at scene-3's 0.7 width, at the `timeline-footage` box's y centre.
    *   Assert: seeked, and `timing-range` is not visible.
2.  **A press on bare V2 seeks.**
    *   Park the playhead on the ruler at take-0's 0.2 width.
    *   Press at take-0's 0.7 width, at y = track box y + 1 + 3 + 14 (the V2 centre).
    *   Assert: seeked.
3.  **Removed.** Selecting a graphic without seeking is already covered at `interactions.spec.ts:201-205`.
4.  **A dragged hatch slides and paints over the next take.**
    1.  `selectBlockAt` scene-0.
    2.  `getByTestId("layout-select").selectOption("graphic-only")`, the pattern at `:645-650`.
    3.  Blur the select (`:421`).
    4.  Record the boxes of `timeline-block-scene-0` and `timeline-hatch-scene-0`.
    5.  Press at the block's 0.3 width, at its y centre. Move +40 px in 4 steps.
    6.  With the mouse still down, assert that the hatch's x delta equals the block's x delta (±1 px). Snapping may make that delta differ from 40.
    7.  With the mouse still down, check paint order with computed z, the pattern at `interactions.spec.ts:474-478`. `elementFromPoint` cannot work here, because it never returns a `pointer-events: none` element (round 3, B1).
        *   The hatch's box now overlaps the next take block's box (`timeline-block-take-0-1`, or whichever take follows scene-0 in the fixture; the plan names it).
        *   The hatch's computed `zIndex` (2) is greater than that take's (1).
    8.  Release. Press `Meta+z` twice, to undo the move and the layout change. Assert scene-0 has no hatch.

### By eye (the author, FE Loop project)

*   a hatch under a `graphic-only` graphic;
*   a selected graphic, with no pink showing through the selection colour;
*   label truncation on short graphics, and on short hatches, at zoom 1×;
*   take filmstrips still showing in V1;
*   grips on narrow blocks;
*   the 640×560 landscape run (`landscape.spec.ts`).

## Calls made in this draft (author to confirm)

1.  No lane labels (§6).
2.  V2 is always drawn, even with no graphics.
3.  The footage strip is flat, with no frames under graphics. Under a `graphic-only` graphic it is hatched and labelled `audio only` or `muted`. Takes set to `graphic-only` get no hatch.
4.  Presses on empty lane space seek (§5). Graphics are selected on V2 only. **Confirmed by the author, 2026-11-24.**
5.  The SFX, overlay and marker rows stay above the ruler.
6.  Graphic blocks are labelled by component name, with the id dimmed after it.

## Changes from draft 3

*   **Round 3, B1.** E2E step 4.7 checks paint order with computed z, not `elementFromPoint`.
*   **S1.** The viewport step is removed. Risks explains why the layout cannot push the timeline off screen, and gives the config comment its figure.
*   **S2.** The fixture renders the PIN badge and both volume badges, and assertion 8 checks all three.
*   **S3.** Assertion 11 checks only what jsdom can see. The filmstrip check moves to the by-eye list.
*   **S4.** The hatch box is flex with `overflow: hidden`, so its label clips.
*   **S5.** The `left`/`right` assertion accepts jsdom's `"0"`.
*   **S6.** Assertion 10 checks the hatch's position and `data-piece-start`.
*   **Minor.**
    *   M1, M2: label weight, selected colour and style assertions.
    *   M3: `props: {}` in the fixture.
    *   M4: the no-component branch is a type guard only.
    *   M5: the stale "ghost 2" comment.
    *   M6, M7: citations.
    *   M8: assertion 16 and the `selection` prop on `Harness`.
    *   M9: timing and isolation.
    *   M12: draft-1 entries marked as superseded.
    *   M13: the config comment.
*   **Not applied.**
    *   M10: the build follows the existing `zoom-in` control. With the viewport step gone, no 8× step remains.
    *   M11: z decides the stacking, so child order needs no test.

## Changes from draft 2

*   **Round 2, S1.** Take blocks get no hatch (Non-goals). That removes the take-label, badge and selection conflicts.
*   **S2.** The hatch is at z 2, and e2e step 4 checks paint order with `elementFromPoint`.
*   **S3.** The hatch id and key come from `cue.startSec`, inside a keyed Fragment (§2).
*   **S4.** The 478-497 check is re-aimed per lane.
*   **S5.** The grip hover rule moves to `.ossclip-edge:hover`, with opacity in CSS only.
*   **S6, S7.** The e2e steps are written out with a scene, coordinates and oracles. Step 3 is removed.
*   **S8.** The viewport check asserts the timeline stays in view and nothing scrolls vertically. The 30 px fallback is dropped.
*   **S9.** The strip and hatches use `border-box`, and the strip uses left/right.
*   **S10.** Every visual value is in §3, §4 and §7.
*   **Minor.**
    *   M1, M2: citations.
    *   M3: the full empty-space list in §5.
    *   M4: `pictureHidden` is tested against `layoutSlots`.
    *   M5: no new module, and `timing.ts` is unchanged.
    *   M6, M7: exact-value assertions and a complete fixture.
    *   M8: the badge offset applies to graphics only.
    *   M9: the title goes on the block div.
    *   M10: the `ClipScene` wording.
    *   M11: the overlap case is accepted.
    *   M12: muted graphics with a visible picture are not hatched.
    *   M13: goal 3 is reworded.
    *   M14: call 3 is aligned with §4.
    *   M15: §175, and criteria for the by-eye check.
    *   M16: the editor-only release note.

## Changes from draft 1

*   **Round 1 B1, B3, S4, S5 (the computation is gone).** `underlaySpans` is replaced by one passive footage strip and one hatch per picture-hidden cue. There is nothing to segment, merge or clamp, and no frames to fetch.
*   **B2.** The press rules are declared in §5 as an exception to the goals.
*   **S1.** Every pixel and colour value is in the doc. The mockup is updated to v2.
*   **S2.** The labels are dropped (§6). The gutter could not line up, and the sticky version covers block labels.
*   **S3.** The hatch label follows `video.volume`. The `ClipScene` behaviour is stated.
*   **S6.** `pictureHidden` is used for take blocks too. *(Superseded in draft 3: take blocks get no hatch.)*
*   **S7.** The DOM invariants are in §2.
*   **S8.** The tests have a fixture, jsdom-checkable assertions, and numbered e2e steps.
*   **S9.** The hatch follows `dragPreview`. Selection adds nothing to V1. The thumbnail refetch on commit already happens today.
*   **S10.** The fixed-y test list, the file list and a numeric viewport check are in the doc.
*   **Minor.** The citations are fixed (M1). The divider renders first (M2). The lane boxes are named (M3). The grip is a pointer-inert child (M4). The badge offset is set (M5). The cursors are set (M6). `isGraphic` is shared with `stored()` (M7; *superseded in draft 3: no `isGraphic`, and `timing.ts` is unchanged*). The overlap source is stated (M8, M9). Vertical scroll is in the viewport check (M10). C's rejection gives a reason (M11).
