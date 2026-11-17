# Scene Backdrop Choice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a 16:9 script project the author can set any scene's backdrop in the editor (over the speaker, full background, background with a round speaker picture), move and resize every graphic, and get kit clips that carry the background.

**Architecture:** No new scene field. The three backdrops are three existing layouts (`full-bleed`, `graphic-only`, `pip-bubble`), repaired for 16:9 and protected from the landscape remap in projects that have a stored script. Geometry stays pure in `packages/scenes/src/stage.ts` and `packages/core/src/framing.ts`; `produce` and the editor only call it.

**Tech Stack:** TypeScript, zod 4, Remotion 4.0.499 (pinned), React, vitest.

**Spec:** `docs/designs/scene-backdrop-choice.md` (draft 2, approved by the author on 2026-11-17 with all listed decisions). FINDINGS §161 and §162 describe what it builds on.

## Global Constraints

- **Unchanged (design G6):** 9:16 output, and 16:9 projects with no stored script, render and plan exactly as before. `packages/core/test/planner-prompt-frozen.test.ts` and `reveal-props.test.ts` are not edited. The test that pins a non-script 16:9 run's layouts (`apps/cli/test/script-produce.test.ts` or its neighbour added in Phase 2: "no scene or cue gets a `graphicRect`") passes unchanged.
- **"Script project" means a stored script, not the flag.** The editor's Render and the kit's refresh replay `produce` with `--script` removed and `--scenes` pinned (`apps/cli/src/render-replay-args.ts`); the stored script record (`production.script`) is carried forward on those replays. Every rule in this plan is keyed on that record.
- The planner's reply schema and prompt do not change; `SCRIPT_PLAN_PROMPT_VERSION` and `PRODUCER_PROMPT_VERSION` are not bumped.
- Pure logic is separate from I/O; user input is parsed with zod; comments explain why and cite `§163` (written in Task 7).
- Every `@remotion/*` dependency stays at exactly `4.0.499`.
- This machine has 7 GB of RAM: one heavy command at a time (`pnpm test`, a render, `pnpm stills`).
- `pnpm test` and `pnpm typecheck` are green at the end of every task; re-run `apps/cli/test/plan-sees-cut-words.test.ts` alone if it times out. Commit at the end of every task. Do not push.
- Tests first: write the failing test, see it fail, then implement.

## Review Focus

1. **A backdrop set in the editor survives the editor's Render** (a replay without `--script`): the scene is still `graphic-only` or `pip-bubble` in the new `render-props.json`. Test: Task 1.
2. **A 16:9 project with no script whose author set `graphic-only` in the editor** renders as it did before Tasks 1 to 3, and with the new picture shape only for `pip-bubble` after Task 4. Tests: Tasks 1 and 4.
3. **A text-routed full-frame scene** (burned-in text in the source) draws on the whole frame as before; no box is written onto it. Test: Task 3.
4. **A box dragged to the frame's edge on a full-frame component** is kept inside the frame and is not shrunk to the caption-safe area. Test: Task 3.
5. **A speaker picture moved to the left half** cuts the graphic's box back on the left, and a box that would become narrower than the minimum is set to the minimum. Test: Task 4.

---

## File map

| File | Change | Task |
|---|---|---|
| `packages/core/src/framing.ts` | `BACKDROP_LAYOUTS`, `keepsBackdropLayout`, remap wrapper | 1 |
| `apps/cli/src/produce.ts` | both remap sites, planner layout ignored | 1 |
| `packages/core/src/overrides.ts`, `apps/editor/src/useEdits.ts` | box kept across backdrop changes | 2 |
| `packages/scenes/src/stage.ts` | full-frame box, frame clamp, picture rectangle, crop, cut-back | 3, 4 |
| `packages/scenes/src/source-fit.ts` | no routed box on full-frame scenes | 3 |
| `packages/scenes/src/fit.ts`, components | margin scales with the box | 3 |
| `packages/scenes/src/VideoStage.tsx` | head zoom in the picture | 4 |
| `apps/editor/src/Inspector.tsx`, `Overlay.tsx` | grouped list, "Below the face", drag on full-frame | 3, 5 |
| `packages/renderer/src/SceneClipComposition.tsx`, `packages/core/src/kit-plan.ts`, `apps/cli/src/kit.ts` | background in kit clips, notes | 6 |
| stills harness, `docs/PHASE1-FINDINGS.md` | speaker stand-in, §163 | 4, 7 |

---

### Task 1: The three backdrops survive a run and a replay

**Files:**
- Modify: `packages/core/src/framing.ts` (beside `landscapeLayout`, line ~276), `apps/cli/src/produce.ts` (remap sites near 4710-4718 and 5119-5128; where a moment's `layout` from the script plan reaches a scene)
- Test: `packages/core/test/framing.test.ts`, `apps/cli/test/script-produce.test.ts`

**Interfaces:**
- Produces:
  - `BACKDROP_LAYOUTS = ["full-bleed", "graphic-only", "pip-bubble"] as const`; `isBackdropLayout(layout: Layout): boolean`.
  - `landscapeLayoutFor(layout: Layout, opts: { scriptProject: boolean }): Layout` — for a script project it returns a backdrop layout unchanged and remaps the rest with `landscapeLayout`; otherwise it is `landscapeLayout`.
  - In `produce.ts`, one boolean `scriptProject` computed once: true when this run has `--script` OR the project carries a stored script record (find how a `--scenes` replay carries `production.script` forward; `storedScriptFrom` in `apps/cli/src/script-mode.ts`). Report the exact expression.

- [ ] **Step 1: Failing tests.**
  - `landscapeLayoutFor("graphic-only", {scriptProject: true})` is `"graphic-only"`; with `false` it is `"blurred-behind"`. Same pair for `"pip-bubble"` (`"split-left"` when false). `"video-top"` is `"split-left"` in both. `"full-bleed"` unchanged in both.
  - Offline produce test (mock provider, the pattern used by `script-produce.test.ts`): a 16:9 script run whose mock script plan returns `layout: "graphic-only"` for a full-frame cue yields a scene with layout `"full-bleed"` (the planner's layout is ignored in a 16:9 script project), and the same run in 9:16 keeps using the planner's layout as it does today (assert today's value before changing code).
  - Replay test (Review Focus 1): produce a 16:9 script project offline; write an `overrides.json` that sets one scene's `layout` to `"graphic-only"` and another's to `"pip-bubble"`; run the replay the way the editor's Render does (`renderReplayArgs` path, `--scenes`, no `--script`, with `--no-render`); the new `render-props.json` has those two cues with those layouts. Before the change this fails only if the remap runs after overrides: check which it is, and write the test against the real failure. If overrides already survive because they are applied after both remap sites, say so in the report and make the test cover instead a PLANNED scene whose stored `layout` is `"graphic-only"` in `scenes-reviewed.json`, which the first remap site rewrites today.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use `landscapeLayoutFor` at both remap sites. Ignore the script plan's `layout` when the project is a script project and the output is landscape (drop it before it reaches the scene; the schema and prompt stay).
- [ ] **Step 4:** `pnpm test && pnpm typecheck`. Commit `feat: backdrop layouts survive the landscape remap in script projects`.

---

### Task 2: A backdrop change keeps the graphic's box

**Files:**
- Modify: `packages/core/src/overrides.ts` (`applyOverrides`, the layout branch near 1205-1260), `apps/editor/src/useEdits.ts` (`patchLayout`, 955-963)
- Test: `packages/core/test/overrides*.test.ts` (the file covering `applyOverrides` layout changes), `apps/editor/test/` (the test covering `patchLayout`)

**Interfaces:**
- Consumes: `isBackdropLayout` from Task 1 (export it from the browser-safe core entry the editor imports).
- Produces: one shared pure helper, `keepsBoxAcross(from: Layout, to: Layout): boolean` — true when both are backdrop layouts. Used by both places.

- [ ] **Step 1: Failing tests.** A cue with a planned `graphicRect` and layout `full-bleed`, overridden to `graphic-only`: the rect is kept. Overridden to `split-left`: dropped (today's behaviour, assert it). A hand-set override rect on a scene whose layout the editor changes from `full-bleed` to `pip-bubble`: `patchLayout` keeps the rect; to `lower-third`: dropped. `graphic-only` → `pip-bubble`: kept.
- [ ] **Step 2: Run.** Expected: FAIL on the kept cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Confirm from `packages/scenes/src/scrim.ts` that a slot component in `graphic-only` or `pip-bubble` draws no frosted panel (only `lower-third` and `full-bleed` do) and add a test if none pins it. `pnpm test && pnpm typecheck`. Commit `feat: a backdrop change keeps the graphic box`.

---

### Task 3: Full-frame components draw in a graphic box

**Files:**
- Modify: `packages/scenes/src/stage.ts` (`graphicSlotFor` ~662, `clampGraphicRect` ~370), `packages/scenes/src/source-fit.ts` (`routeAroundSourceText`, where it writes `graphicRect`, ~252 and ~286), `packages/scenes/src/fit.ts` (`PATTERN_MARGIN_PX` and the four metrics functions), the four component files if they read the margin directly, `apps/editor/src/Overlay.tsx` (drag and resize clamp, ~794-821, ~962, ~1057-1095), `apps/editor/src/Inspector.tsx` (graphic box section ~1737-1782)
- Test: `packages/scenes/test/stage.test.ts` (cases at 288-290, 310-319, 337-343 pin "ignores a routed or hand-set rect": replace them deliberately), `packages/scenes/test/fit.test.ts`, `packages/scenes/test/source-fit*.test.ts`, `apps/editor/test/scene-layer-structure.test.ts`, `apps/editor/test/Overlay.test.ts`
- Stills: `packages/scenes/test/stills.fixtures.ts`

**Interfaces:**
- Produces:
  - `graphicSlotFor(cue, frame)`: for a `fullFrame` component, `cue.graphicRect` limited to the frame by `clampToFrame`, else `FULL_FRAME_SLOT`. Slot components unchanged.
  - `clampToFrame(rect): Rect` — keeps `x`, `y` in 0..1, `w` ≥ 0.08, `h` ≥ 0.05, and `x + w ≤ 1`, `y + h ≤ 1` (move first, then shrink). It does not apply the caption-safe area.
  - `graphicClampFor(component): (rect) => Rect` — `clampToFrame` for full-frame components, `clampGraphicRect` otherwise; the editor's drag, resize and Inspector use it.
  - `patternMarginPx(widthPx: number, heightPx: number, frame: {width, height}): number` — `100 × min(widthPx / frame.width, heightPx / frame.height)` for landscape frames; report what the portrait rule is today and keep it. The metrics functions take the margin from it.

- [ ] **Step 1: Failing tests.**
  - `graphicSlotFor` for a `CardRow` cue with `graphicRect {x:0.1,y:0.5,w:0.8,h:0.4}` returns that rect; with no rect returns `FULL_FRAME_SLOT`; with a rect hanging off the right edge returns it moved inside the frame at the same size (Review Focus 4); a rect of the full safe-area size is NOT shrunk.
  - `routeAroundSourceText` on a full-frame cue returns it without a `graphicRect` (Review Focus 3); on a slot component it behaves as today.
  - `cardRowMetrics` (and the other three) in a 960×540 box of a 1920×1080 frame uses a 50 px margin, and the block stays inside the box at the pop peak.
  - `SceneLayer` structure test: a `BugCard` cue with a box is wrapped in an element positioned and sized to the box.
  - Editor: dragging a full-frame graphic writes a rect clamped by `clampToFrame`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Check how `SceneLayer` passes `widthPx`/`heightPx` to a self-fitting component inside a smaller slot (it passes the slot's size) and that the component's root fills that element, not the frame. `packages/scenes/src/fit.ts` comments say the metrics are "solved against the whole frame" at ~766, ~1020, ~1523, ~1936: read each and correct any use of frame constants.
- [ ] **Step 4: Stills.** For each of `CardRow` (dense), `CtaCard` (subscribe, dense), `BugCard` (lines, dense) and `PhoneDemo` (typical): a 16:9 fixture with `graphicRect {x:0.04,y:0.56,w:0.92,h:0.4}` (a "below the face" band) and one with `{x:0.04,y:0.06,w:0.72,h:0.88}` (the `bubble` box). Run `pnpm stills <Component>`, open each PNG with the Read tool, and fix overlap, clipping or unreadably small text. If a component cannot stay readable in the band (text under 26 px), report its smallest readable box; do not add a floor without reporting it. Existing committed stills must not change (`git status` after re-rendering them).
- [ ] **Step 5:** `pnpm test && pnpm typecheck`. Commit `feat: full-frame scenes draw in a movable graphic box`.

---

### Task 4: The speaker picture in 16:9

**Files:**
- Modify: `packages/scenes/src/stage.ts` (`PIP_RECT` ~500-511, `layoutSlots` `pip-bubble` and `graphic-only` cases ~526-628, `cueVideoSlot` ~729-745, `graphicSlotFor`), `packages/scenes/src/VideoStage.tsx` (the crop inside the picture), the stills harness (`packages/renderer/src/SceneStillComposition.tsx`, `scene-still.ts`, `scripts/render-scene-stills.ts`)
- Test: `packages/scenes/test/stage.test.ts` (pip tests at 151-192 and 438-499 pin today's numbers; keep them for 9:16), `packages/renderer/test/scene-still.test.ts`

**Interfaces:**
- Produces:
  - `pipRectFor(frame: {width, height}): Rect` — portrait frames: exactly today's `PIP_RECT`. Landscape frames: a square in pixels with side `0.28 × height`, right edge `0.04 × width` from the frame's right, bottom `0.06 × height` from the bottom. `PIP_RECT` stays exported with today's value for portrait callers.
  - `pipZoomFor(face: FaceCrop | null | undefined, pictureHeightPx: number, sourceHeightPx: number): number` — the extra scale so that the face height (`face.sizeFrac × source height`) is 55% of the picture's height; 1 when there is no face or no `sizeFrac`; never below 1; at most 4. Landscape only.
  - `clearOfPicture(box: Rect, picture: Rect): Rect` — if the picture's centre x is ≥ 0.5, the box's right edge is at most `picture.x − 0.03`; otherwise its left edge is at least `picture.x + picture.w + 0.03`. Width never below 0.08 (then the box keeps 0.08 at the cut edge). `graphicSlotFor` applies it for `pip-bubble` cues in landscape frames, after resolving the box, using the cue's actual picture rectangle (`cue.pip.x/y` when set).
  - Stills: `StillFixture` gains optional `backdrop?: "speaker" | "solid" | "bubble"`; when it is `solid` or `bubble`, the still composition draws `VideoStage` under `SceneLayer` with a stand-in for the footage: a flat mid-grey fill with a lighter head-sized ellipse at the fixture's face position (default face: centre x 0.52, centre y 0.38, size 0.3). No video file is involved.

- [ ] **Step 1: Failing tests.**
  - `pipRectFor({width:1080,height:1920})` deep-equals today's `PIP_RECT`. `pipRectFor({width:1920,height:1080})` is `{ x: (1920 − 76.8 − 302.4)/1920, y: (1080 − 64.8 − 302.4)/1080, w: 302.4/1920, h: 302.4/1080 }` (to 6 decimals).
  - `layoutSlots("pip-bubble", …, landscape)` video rect equals `pipRectFor(landscape)` with corner radius 1; the same call for a portrait frame equals today's values (existing tests unchanged).
  - `layoutSlots("graphic-only", …)` in portrait is unchanged; in landscape its hidden video rect equals `pipRectFor(landscape)`.
  - `pipZoomFor`: face `sizeFrac` 0.3 of a 1080 source in a 302.4 px picture gives `0.55 × 302.4 / (0.3 × 302.4)` = 1.8333 when the picture shows the full source height; verify how the picture maps the source (cover crop of a 16:9 source into a square) and correct the expected value from that mapping, stating the formula in the test. No face: 1.
  - `clearOfPicture` for a picture on the right and on the left (Review Focus 5); a full-frame box becomes `x 0 … picture.x − 0.03`; a `SCRIPT_LANDSCAPE_RECT` box is cut from 0.86 to the same edge.
  - `graphicSlotFor` for a `pip-bubble` cue in a portrait frame is unchanged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `cueVideoSlot` clamps `pip.x/y` against the picture's real size for the frame. The 0.35 s transition (`videoSlotAt`, `backdropOpacityAt`) is not changed. The Inspector's picture sliders read their maxima from `layoutSlots(...).video` (`apps/editor/src/Inspector.tsx` ~1706, ~1716) and the Overlay's picture drag from the same (`Overlay.tsx` ~854-860, ~1000-1001): confirm they pick up the new rectangle without edits, or fix them.
- [ ] **Step 4: Stills.** Fixtures in 16:9 for `CardRow` (dense), `PhoneDemo` (typical) and `TerminalMock` (the `script-landscape` fixture's props and rect) in `solid` and in `bubble`. Open each PNG: in `solid`, the frame is the background colour with the graphic where its box says; in `bubble`, a round picture at the bottom right showing the stand-in head at about half the picture's height, and no part of the graphic inside the strip above or below the picture. Commit them.
- [ ] **Step 5:** `pnpm test && pnpm typecheck`. Commit `feat: a round speaker picture for 16:9, and graphics that keep clear of it`.

---

### Task 5: The editor: "Behind the graphic" and "Below the face"

**Files:**
- Modify: `apps/editor/src/Inspector.tsx` (layout select ~1510-1522; graphic box section ~1737-1782), `packages/scenes/src/stage.ts` (a pure helper for the box)
- Test: `apps/editor/test/Inspector.test.ts`, `packages/scenes/test/stage.test.ts`

**Interfaces:**
- Consumes: `headBand(face)` (`stage.ts` ~459), `isBackdropLayout`, how the editor knows the project has a stored script (find the field the editor's production payload exposes; if none, add `scriptProject: boolean` to what the edit server already sends with the production, derived from `production.script`).
- Produces:
  - `belowFaceBox(face: FaceCrop | null | undefined, frame): Rect | null` — `null` with no face; otherwise `x 0.04`, `w 0.92`, `y` = the head band's bottom + 0.03, `h` = `0.96 − y`; `null` when `h` < 0.2.
  - In a 16:9 script project the layout select has the label "Behind the graphic" and two option groups: the three backdrops, named "Over the speaker", "Full background", "Background with speaker picture", then "Other layouts" with the remaining five under their current names. In every other project the control is exactly as today.
  - A "Below the face" button in the graphic box section, for every graphic scene in a 16:9 project: it writes `belowFaceBox` through the existing `patchGraphicRect`; disabled, with a title saying why, when the helper returns `null`.

- [ ] **Step 1: Failing tests:** `belowFaceBox` numbers for a face at centre y 0.38, size 0.3 (compute the head band from `headBand` and assert the resulting rect), `null` cases; the select's groups and labels in a 16:9 script project, and the unchanged flat list in a 9:16 project and in a 16:9 project without a script; choosing "Full background" calls `patchLayout(sceneId, "graphic-only")`; the button writes the rect and is disabled without a face.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test && pnpm typecheck`; `pnpm build` (the editor page the CLI serves) must succeed. Commit `feat: editor backdrop names and a below-the-face box`.

---

### Task 6: Kit clips carry the background

**Files:**
- Modify: `packages/renderer/src/SceneClipComposition.tsx`, `packages/renderer/src/scene-clip.ts`, `packages/core/src/kit-plan.ts` (`notesFor` ~75-82), `apps/cli/src/kit.ts` (notes for `clip:` scenes ~487-542)
- Test: `packages/renderer/test/scene-clip.test.ts`, `packages/core/test/kit-plan.test.ts`, `apps/cli/test/kit-command.test.ts`, `packages/scenes/test/stage.test.ts` (for the shared opacity helper)

**Interfaces:**
- Consumes: `backdropOpacityAt(cues, t)` (`stage.ts` ~833-847), `pipRectFor`, `clearOfPicture` (already applied by `graphicSlotFor`).
- Produces:
  - The scene-clip composition draws, under `SceneLayer`, a full-frame fill of `theme.bg` at `backdropOpacityAt([cue], t)` when the cue's layout is `graphic-only` or `pip-bubble`. Nothing is drawn for other layouts, so existing clips are byte-identical.
  - Notes (exact strings): for `pip-bubble`, `"speaker picture not included: scale and move the footage on track 1 for this stretch (picture at x <px>, y <px>, <size> px)"` with the picture's rectangle in output pixels; for a `clip:` scene in `graphic-only` or `pip-bubble`, `"background not included (clip: scenes are referenced, not rendered)"`. The existing `"speaker not reframed (pip-bubble)"` note is replaced by the new one; the other layouts' notes are unchanged.
  - A `graphic-only` or `pip-bubble` clip is rendered with the flat panel off for slot components (the background is already plain): confirm `slotBackdrop` gives `"none"` or `"panel"` today for these layouts under `flatPanel`, and make it `"none"`.

- [ ] **Step 1: Failing tests:** the note strings; the reuse key differs between `full-bleed` and `graphic-only` for the same cue (it already includes the layout: assert it); composition structure for the three layouts; a `clip:` scene in `pip-bubble` stays `kind: "source"`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: One real render** (nothing else heavy running). Render a `CardRow` cue in `graphic-only` and in `pip-bubble`, 4 s, explainer theme, 1920×1080, through `kitClipPlans` and `renderSceneClip`. Check with ffmpeg: at 2 s all four corner pixels are `3a4a5cff`; at frame 0 the corner's alpha is 00 and at 0.2 s it is between 01 and fe (the fade); in `pip-bubble` no opaque card pixel lies right of `picture.x − 0.03`. Render the same cue in `full-bleed` before and after this task's change and `cmp` the two files.
- [ ] **Step 5:** `pnpm test && pnpm typecheck`. Commit `feat: kit clips carry a solid or bubble backdrop`.

---

### Task 7: Offline proof and FINDINGS

**Files:**
- Modify: `.claude/skills/verify-ossclip/features/produce.md` and `kit.md`, `docs/PHASE1-FINDINGS.md` (new §163), `README.md` if it documents layouts for 16:9
- [ ] **Step 1:** On the pattern-scenes offline fixture in 16:9: produce with `--no-render`; write `overrides.json` setting one full-frame scene to `graphic-only`, one to `pip-bubble`, and one slot-component scene to `graphic-only`; run the editor-style replay (`--no-render`) and confirm the three layouts and the slot component's box in the new `render-props.json`; run `ossclip kit` and confirm the notes in `kit-report.json` and the corner-pixel checks on the two background clips. Record commands and expected output in the skill's feature files.
- [ ] **Step 2:** Write §163 in the style of §161 and §162: what was wrong (the five items in the design's "What is wrong today"), what was built, the decisions and their reasons (stored script not flag; no footage in a kit clip; planner layout ignored on read; box kept only between backdrop layouts; routing writes no box onto full-frame scenes; picture zoomed to the head), measured numbers from Tasks 3, 4 and 6, and known gaps (captions can land on the speaker picture; one picture size; no script word or flag; one face position for the whole video; any minimum readable box sizes found in Task 3). Verify each claim against the code or a commit.
- [ ] **Step 3:** `pnpm test && pnpm typecheck`. Commit `test: offline backdrop recipe; FINDINGS §163`.

---

### Task 8: Acceptance on the EGM project (main session, not delegated)

- [ ] On a copy of the EGM pattern project: set three scenes to `graphic-only` and three to `pip-bubble` in `overrides.json` (as the editor would), move one full-frame scene with the "below the face" box, and replay with a full render, alone.
- [ ] Machine checks on frames: corners equal the background colour mid-scene for the six scenes; a pixel at the picture's centre differs from it for the three `bubble` scenes; the moved scene's graphic lies inside its box.
- [ ] Look at one frame per changed scene; copy the render and a contact sheet to the author's Outputs folder; run `ossclip kit` and check the notes and the background clips.
- [ ] Record the numbers in §163.
