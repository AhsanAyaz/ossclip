# Editor round 11 — selected block on top, a graphic box you can transform, chat bubbles that read, and Render from the editor

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Status:** planned 2026-07-31 from the author's third editing session, on the round-10 build (`25434d3`); not started. Task order 1 → 2 → 3 → 4; 2 and 3 are coupled (see Task 3's rationale).

**Evidence this was planned from:** a `v9` run of `5 ClaudeCode.mp4` (5 graphic scenes + 5 plain takes, framing clean at 93% of band) plus three screenshots from the author — a selected `scene-8` block clipped by `take-0-3`, and `scene-11`'s ChatMock rendering "Which one didn't you know?" as five one-word lines inside a box with no resize affordance.

## Context

Round 10 made the timeline full, the picture grabbable and scenes deletable. Editing a real clip immediately surfaced three things, plus one question about what `Save` even does:

1. **A selected block is painted over by its neighbour.** `apps/editor/src/Timeline.tsx` sets no `z-index` anywhere — paint order is DOM order, and DOM order is time order (`fill.ts:109` sorts by `startSec`). So a later block always covers an earlier one. The selected block's 2px blue border is clipped by the adjacent `take-*` block at rest, and during an end-edge drag the block grows *underneath* the take — worse because `clampTiming` deliberately ignores plain takes (`timing.ts:30-31`), and takes butt flush with zero gap (`fill.ts:69-73`).

2. **No way to reshape the graphic box.** The blue dashed box IS the graphic slot (`SceneLayer.tsx:57`, `data-edit-scene`), but it has `cursor: default` and no handles — deliberately, because a click inside it must fall through to element selection (`Overlay.tsx:318-334`). The renderer already honours a per-cue rect (`SceneLayer.tsx:43`, `cue.graphicRect ?? layoutSlots(...)`), so only an override field and the UI are missing.

3. **The chat bubble is a one-word column.** Diagnosed, not guessed: `fitScale` magnifies a graphic until it fills 94% of the slot's HEIGHT (`fit.ts:396-397`, `MAX_SCALE = 2.4`). The component lays out at `slotW/scale`, so magnifying *narrows* the layout box; `ChatMock`'s bubble is capped at 82% of that shrunken box (`ChatMock.tsx:36`), and `chatMetrics` then sizes type so the longest word fills the bubble (`fit.ts:311-320`). For scene-11's single 26-char message in `blurred-behind` (slot `0.77 × 0.36`) the solver lands at k≈2.4 → a ~6-character line width → five one-word lines. **Resizing the box alone cannot fix this**: widening the slot lets the solver magnify further, and the wrap comes out the same. The box handle would be a lie without Task 3.

4. **`Save` only writes `overrides.json`.** `apps/cli/src/edit.ts` has exactly two endpoints (`GET /api/production`, `PUT /api/overrides`) and no render path — regenerating means re-running `ossclip produce` in a terminal.

**Decisions taken with the author, do not re-litigate:** transform handles (drag corners/edges to resize, drag to move) as the primary mechanism — "the most familiar and flexible"; fix the automatic sizing as well as adding the handles; add a Render button rather than printing the command.

## Global constraints

- `pnpm vitest run` (465 green today), `pnpm -r --parallel exec tsc --noEmit`, `pnpm --filter @ossclip/editor build`, 12 Playwright e2e stay green.
- Editor imports only `@ossclip/core/browser` and `@ossclip/renderer/composition`. zod specifier exactly `zod/v4`.
- On macOS run e2e with plain `npx playwright test` from `apps/editor`.
- Don't regress rounds 9/10 — read their status blocks first.

---

## Task 1: the selected block paints on top

`apps/editor/src/Timeline.tsx` only.

- [ ] **1.1** Add explicit stacking levels to the `block` style at the three call sites, replacing today's implicit DOM order. Small integers, matching the codebase habit (`App.tsx:405` uses `zIndex: 5` locally):
  - live block: `1`
  - ghost block (`ghosts.map`, ~:300-331): `2` — keeps today's "ghost paints above the take that took over its window" property as a *stated* rule rather than an accident of DOM order.
  - selected (`isSelected`, any kind): `3`
  - actively dragging (`dragPreview?.sceneId === cue.id` or the block under `blockPressRef`): `4`
  - playhead (:332): `5`.
- [ ] **1.2** The edge handles (`edgeHandle`, :285-296) are children of the block, so they inherit its level — no separate rule, but confirm by hand that the selected block's `right: 0` handle is now grabbable where it meets the next take.
- [ ] **1.3** e2e in `apps/editor/e2e/interactions.spec.ts`: select `scene-8`, assert its computed `z-index` exceeds the adjacent `take-0-3`'s; drag its end edge right and assert the block is the topmost element at a point inside the overlap (`document.elementFromPoint` → closest `[data-testid^="timeline-block-"]`).

Not in scope: making plain takes re-derive live during a drag (they are stale until `patchTiming` commits). z-index makes that invisible; live re-derivation is a bigger change for no user-visible gain.

---

## Task 2: transform handles on the graphic box

### 2a. The override (core)

- [ ] **2.1** `packages/core/src/overrides.ts` — `SceneOverrideSchema` gains, beside `video` (:62):
  ```ts
  graphicRect: z.object({
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    w: z.number().min(0.08).max(1), h: z.number().min(0.05).max(1),
  }).optional(),
  ```
  Validated here even though `SceneCueSchema.graphicRect` (`scene-schema.ts:82`) is unvalidated: this one is hand-editable user data, and §35's lesson is that validators are the constraint.
- [ ] **2.2** `applyOverrides` (:157-180) — one more conditional spread beside `video` at :175: `...(o.graphicRect ? { graphicRect: o.graphicRect } : {})`. Because it lands after `...cue`, a user rect correctly WINS over one that `routeAroundSourceText` baked into `baseSceneCues` (`source-fit.ts:160`).
- [ ] **2.3** `clearGraphicRect(doc, sceneId)` mirroring `clearTiming` (:281-286) — delete the key, never write a sentinel.
- [ ] **2.4** Clamp helper, exported from `packages/scenes/src/stage.ts` next to `SAFE_RECT` (:281-286) and re-exported through `packages/renderer/src/ProductionComposition.tsx` (which already re-exports `SAFE_AREA` at :28) so the editor can reach it:
  ```ts
  export function clampGraphicRect(rect: Rect): Rect   // into SAFE_RECT, min size enforced
  ```
  Used in BOTH places: the editor while dragging, and `SceneLayer.tsx:43` defensively, so a hand-edited `overrides.json` can't push a graphic off-frame. `stage.test.ts:55-58` asserts every layout's slot sits inside `SAFE_RECT`; the clamp keeps user rects under the same invariant.

### 2b. Captions must route around the moved box

- [ ] **2.5** `packages/scenes/src/CaptionTrack.tsx:166-176` currently passes `active?.graphicRect` **only when `sourceTextRegions.length > 0`**; the other branch (`captionAnchorAt`, `stage.ts:544-547`) resolves purely from the layout and never sees the rect. On a clean source — the common case — a user-moved box would silently sit on top of the captions. Route both branches through the rect-aware path, and drop `captionAnchorAvoiding`'s `regions.length === 0` early-out (`source-fit.ts:185`) so a rect alone can move the anchor. Behaviour is unchanged when the rect equals the layout default (the default anchors are already clear of their own slots — the same `stage.test.ts` invariant), so this is additive.

### 2c. Editor UI

- [ ] **2.6** `apps/editor/src/useEdits.ts` — `patchGraphicRect(sceneId, rect, coalesce?)` and `clearGraphicRect(sceneId)` next to `patchVideo` (:128-135, :255-260). `patchLayout` (:178) must ALSO clear the rect: a layout swap picks a new slot, and a stale rect would silently win at `SceneLayer.tsx:43`.
- [ ] **2.7** `apps/editor/src/Overlay.tsx` — 8 handle nodes (4 corners + 4 edges) rendered inside `boxRef` **only for a scene-level selection of a cue that actually draws a graphic**, each `pointerEvents: "auto"` with its own cursor (`nwse-resize`/`nesw-resize`/`ew-resize`/`ns-resize`). The box BODY stays click-through — the comment at :318-334 is load-bearing: any press inside the box must keep falling through to `elementBelow` or element selection breaks. Moving the box is a drag on a handle-free inner "move" strip along the box's top edge (a titlebar-style grip), not the whole body, for the same reason.
- [ ] **2.8** Drag math mirrors the video pan (:385-441): `pageToComposition()` via `playerRef.getScale()`, then divide by `settings.width`/`settings.height` for frame fractions. **No `compensateEdits` division** — the slot lives outside the fit-scaled wrapper, exactly like `cue.video.dx/dy` (:426-431 says so). rAF-throttled live preview through a new `graphicPreview` state in `App.tsx`, applied at the very END of the `live` memo beside `videoPreview` (:150-157); ONE `patchGraphicRect` on mouseup = one undo step. Clamp every preview frame with `clampGraphicRect`.
- [ ] **2.9** Reuse the existing dashed safe-area guide (`Overlay.tsx:672-692`) during a box drag — it already renders whenever a drag is in progress; extend its condition to the rect gesture.
- [ ] **2.10** `apps/editor/src/Inspector.tsx` — a "Graphic box" section for graphic scenes: four `NumberField`s (x/y/w/h, step `any`, min/max matching the schema, coalesce keys like `box:<sceneId>:x`) plus **Reset box** when an override exists. Same shape as the existing Video framing section.

Full-bleed cues and plain takes render no graphic (`SceneLayer.tsx:43-44` returns null), so they have no box to grab — the feature cannot invent a graphic where the layout has none. Say so in a comment; it's the obvious "why not here?" question.

---

## Task 3: chat bubbles sized to read, not to fill

Without this, Task 2's handle scales the one-word column instead of rewrapping it.

- [ ] **3.1** `packages/scenes/src/fit.ts` — add `ChatMock` to `SELF_FITTING` (:27). A component whose inner box is capped at 82% cannot be magnified to fill height without narrowing its own text; `FlowDiagram` and `StrikethroughReveal` are already exempt for the same reason.
- [ ] **3.2** Rewrite `chatMetrics` (:311-320) to take the real slot (`{ widthPx, heightPx }`) and size by LINE LENGTH rather than by "longest word fills the bubble":
  - target measure ≈ 22 characters per line (overlay-caption typography, not body text);
  - hard upper bound: the longest word must still fit inside bubble-minus-padding — §28a's invariant, kept exactly;
  - clamp to `[CHAT_MIN_FONT, CHAT_MAX_FONT]` where `CHAT_MAX_FONT` is expressed in COMPOSITION px (~96 — today's `CHAT_FONT = 40` is a layout-space number that only made sense pre-magnification);
  - shrink until the estimated stack height fits `heightPx * FILL_TARGET`.
- [ ] **3.3** Keep `estimateHeightPx`'s `ChatMock` branch (:152-160) in lockstep with the new metric — one function, two callers, no chance of disagreement.
- [ ] **3.4** `packages/scenes/src/components/ChatMock.tsx` — accept and forward `heightPx` (it currently destructures only `widthPx`, :64).
- [ ] **3.5** Tests in `packages/scenes/test/fit.test.ts` (or a new `chat.test.ts`): scene-11's real props in the real `blurred-behind` slot wrap to ≤ 2 lines and the bubble uses ≥ 60% of the slot width; a long multi-message exchange still fits its slot; a single unbreakable long word (`"AGENTS"`, the §28a case) never spills past the rounded rect; widening the slot by 20% strictly increases characters per line (the property Task 2's handle depends on).

Expect ChatMock scenes to look different everywhere — accepted with the author.

---

## Task 4: Render from the editor

### 4a. Record the command (CLI)

- [ ] **4.1** `apps/cli/src/produce.ts` — write `command.json` into the workdir at the end of a successful run: `{ execPath, script, args, cwd, out }`. There is nothing today from which to reconstruct the invocation (`production.json` has the source path, cleanup and intent, but not `--produce`, `--out`, or the LLM flags), and guessing would silently render a different video than the one on screen.

### 4b. The endpoint (edit server)

- [ ] **4.2** `apps/cli/src/edit.ts` — `POST /api/render` spawns **only** the argv recorded in `command.json`, never anything from the request body (this server binds locally, but accepting a client-supplied command would make it a remote shell). `409` if a render is already running, `412` with a clear message if `command.json` is absent. `GET /api/render/status` → `{ running, exitCode, lines }` (a bounded ring buffer of the last ~200 output lines). Kill any in-flight child on server close, so Ctrl-C doesn't orphan an ffmpeg.
- [ ] **4.3** Tests in `apps/cli/test/edit-server.test.ts`: 412 without `command.json`; a fake `command.json` running `node -e "console.log('hi')"` reaches `exitCode: 0` with its line captured; a second POST while running gets 409; a body-supplied command is ignored.

### 4c. The button (editor)

- [ ] **4.4** `apps/editor/src/App.tsx` — a **Render** button beside Save. If the doc is dirty it saves first (a render of unsaved edits is the trap worth designing out), then POSTs, then polls `/api/render/status` ~1s, showing the tail of the log and the pipeline's own `NN%` lines in a small panel. On `exitCode: 0` re-fetch `/api/production` and swap in the new `renderProps` while KEEPING the current override doc and selection; on non-zero, surface the last lines in the existing error banner. Disabled with an explanatory title when the server reported no `command.json`.
- [ ] **4.5** e2e: with the fixture workdir (which has no `command.json`) assert the button is present and disabled with its explanation — the honest thing to pin without shelling out a real render in CI.

---

## Files touched

`packages/core/src/overrides.ts` · `packages/scenes/src/{stage,fit,SceneLayer,CaptionTrack,source-fit}.ts(x)` · `packages/scenes/src/components/ChatMock.tsx` · `packages/renderer/src/ProductionComposition.tsx` · `apps/cli/src/{produce,edit}.ts` · `apps/editor/src/{App,Overlay,Inspector,Timeline,useEdits}.tsx` · plus tests and this doc's status block.

## Verification

1. **Unit** (`pnpm vitest run`): `overrides` (graphicRect round-trips, wins over a routed rect, clear deletes the key), `stage` (`clampGraphicRect` keeps rects inside `SAFE_RECT`; the existing every-layout invariant still holds), chat metrics per 3.5, `useEdits` (rect drag is one undo step; a layout swap clears the rect), `edit-server` per 4.3.
2. **Typecheck + build:** `pnpm -r --parallel exec tsc --noEmit`, `pnpm --filter @ossclip/editor build`.
3. **e2e** (`npx playwright test` from `apps/editor`): z-order per 1.3; drag a corner handle on `scene-3`'s box → `overrides.json` `scenes["scene-3"].graphicRect` within ±20% of the intended fractions (the band `edit.spec.ts:92-104` already uses for rescaled deltas) and the box on screen follows; a click INSIDE the box still selects the element under it (the regression this feature most threatens); Render button disabled per 4.5.
4. **Fixture render:** `--scenes fixtures/scenes.json` headless, extract a ChatMock frame before/after Task 3 and confirm the bubble reads in ≤ 2 lines and no glyph crosses the rounded rect.
5. **Author's run:** re-produce `5 ClaudeCode.mp4`, open the editor on the workdir, drag `scene-11`'s box wider and watch the text rewrap live, hit Render, and confirm the new `v10` matches what the preview showed.
