# Editor usability fixes — plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Make the direct-manipulation editor behave the way a person expects: drags land where you drop them, clicking an element doesn't play/pause the video, and the timeline scrubs like a video player.

**Source:** six issues found by the author using `ossclip edit` on real footage (70s clip, 6 scenes), 2026-07-27. Every one is a real interaction failure, not a nitpick.

**Tech Stack:** React 18, Remotion `<Player>`, TypeScript strict, vitest + one Playwright e2e.

## Global Constraints

- Browser-safe imports only in `apps/editor/src/**`: `@ossclip/core/browser`, `@ossclip/renderer/composition`. Never the bare barrels — they pull in `node:fs`/`@remotion/bundler` and break the Vite build.
- No `any` in `App.tsx` (a prior round removed it deliberately via `ProductionCompProps & Record<string, unknown>`).
- zod specifier exactly `zod/v4`.
- `pnpm test` (322 passing), `pnpm typecheck`, `pnpm --filter @ossclip/editor build`, and the Playwright e2e must all stay green.
- **Do not regress what earlier rounds fixed** — read `.superpowers/sdd/2026-07-27-direct-manipulation/task-6-report.md` first. In particular: the Player's own transport controls must keep working, and `SceneLayer`'s pointer-events plumbing must not be reverted.

---

### Task 1: Drag lands where you drop it

**Symptom (verbatim):** "the further I move it, the further it drops in at the wrong position. Same direction, but much further. If I move slowly, it is closer, but still not accurate."

Overshoot proportional to distance means a constant multiplicative error, not an offset.

**Files:** `apps/editor/src/Overlay.tsx`, `packages/scenes/src/SceneLayer.tsx`, `packages/scenes/src/fit.ts`

**Diagnosis (strong hypothesis — verify before fixing):** the committed delta is scaled correctly page→composition (`scaleX = settings.width / stageRect.width`, `Overlay.tsx`), but the `editStyle` transform is then rendered **inside a container that `SceneLayer` has already scaled** by the §23 fill contract. `SceneLayer` lays a component out at `slotW / fitScale` and scales it back up by `fitScale`, so a translate of N composition px inside that wrapper moves the element `N × fitScale` px on screen. `fitScale` is commonly ~1.5–3, which matches "much further, same direction".

**Verify first, then fix:**

- [ ] **Step 1: Measure, don't guess.** Add temporary logging in `Overlay.tsx`'s mouseup: page delta, committed dx, and the element's `getBoundingClientRect()` before and after. Drag one element ~100px and record the ratio of observed movement to intended. Confirm the ratio equals that scene's `fitScale` (log it from `SceneLayer`). Write the measured numbers into the task report — this is the evidence the fix is right.
- [ ] **Step 2: Write a failing test** for the pure part: a function that converts a page-space drag delta into the composition-space value to store, given `settings.width`, the stage rect width, and the element's effective render scale. Assert that a 100px page drag on a scene with `fitScale = 2` and a 380px stage against a 1080px composition stores a value that renders back to 100px on screen.
- [ ] **Step 3: Implement.** Either divide the committed delta by the element's effective scale, or — cleaner if it is tractable — apply the user transform **outside** the fit-scaled wrapper so the two scales never compose. Prefer the structural fix; note in the report which you chose and why.
- [ ] **Step 4: Verify by hand in a real browser.** Drag an element on at least two scenes with *different* `fitScale` values (a StatCard and a FlowDiagram, say) and confirm both land under the cursor. A fix that only works on one scene means the scale is still hardcoded somewhere.
- [ ] **Step 5: Tighten the e2e.** `apps/editor/e2e/edit.spec.ts` currently allows ±20%. Once the drag is accurate, assert the element's on-screen rect actually moved by the dragged amount (±5%), not just that a patch was written. The existing test passed while this bug shipped — that is the gap to close.
- [ ] **Step 6: Commit.**

---

### Task 2: Clicking an element must not play/pause the video

**Symptom:** "All click events on the elements aren't stopping propagation, meaning clicking a label ends up playing or pausing the video player. Same goes for dragging."

**Files:** `apps/editor/src/Overlay.tsx`

**Diagnosis (confident):** this is the direct consequence of an earlier fix. The overlay's hit layer was made `pointer-events: none` with detection moved to a `window` mousedown listener that deliberately never calls `preventDefault`/`stopPropagation` — that was done to un-break the Player's transport controls, which the overlay had been swallowing. It fixed transport but let *every* click through, including clicks on editable elements, which the Player treats as click-to-toggle-playback.

The rule wanted is **selective**, and it is the crux of this task: a click that lands on an editable element (or on the selection box / a handle) is the editor's — swallow it. A click anywhere else is the Player's — let it through untouched.

- [ ] **Step 1: Write a failing e2e assertion** — with the video paused, click an element; assert playback is still paused and the element is selected. Then click the video background; assert playback toggles.
- [ ] **Step 2: Implement** the selective swallow. The window listener already hit-tests via the `elementBelow` layer-walk; use that result to decide whether to `preventDefault()`/`stopPropagation()`. Take care that `stopPropagation` on a window-level listener may not be enough — you may need capture phase, or a `pointer-events: auto` region that tracks the current selection. Whichever you choose, both halves must hold simultaneously.
- [ ] **Step 3: Verify by hand, both halves in one session:** clicking a label selects without toggling playback; clicking the video background still toggles; the transport bar's own play/pause and scrubber still work; dragging an element does not toggle playback on release.
- [ ] **Step 4: Commit.**

---

### Task 3: Timeline scrubbing — press and drag

**Symptom:** "The timeline cursor isn't smooth for navigating (seeking), I can only click, not click and drag to go forward or back like other players do smoothly."

**Files:** `apps/editor/src/Timeline.tsx`

**Diagnosis (confident):** `seekTrack(clientX)` is wired to `onMouseDown` on the track only. There is no `mousemove` follow, so a press-and-drag scrub is impossible.

- [ ] **Step 1: Write a failing test** for the pure mapping: `clientX` → seek time, given the track rect and duration, clamped at both ends.
- [ ] **Step 2: Implement** press-and-drag scrubbing: on track mousedown, seek and begin a scrub; on window mousemove while scrubbing, keep seeking; on mouseup, end. Clamp to `[0, duration]`. Register/remove the window listeners in one effect so nothing leaks.
- [ ] **Step 3:** Make the playhead itself grabbable — pressing directly on it should start the same scrub rather than jumping.
- [ ] **Step 4: Verify by hand** — press and drag along the track and confirm the video follows continuously, in both directions, without stutter.
- [ ] **Step 5: Commit.**

---

### Task 4: Clicking inside a scene block seeks to that point

**Symptom:** "There's no way to click anywhere within a scene. I can't go to the middle of a scene to fix it. It just takes to the start of the scene."

**Files:** `apps/editor/src/Timeline.tsx`

**Diagnosis (confident):** the block's click handler selects the cue and calls `seekTo(cue.startSec * fps)` — the scene's start — discarding where inside the block the user actually clicked.

- [ ] **Step 1: Write a failing test** for the mapping from a click x-position inside a block to a time within that cue's `[startSec, endSec]`.
- [ ] **Step 2: Implement:** clicking a block still selects the cue, but seeks to the **clicked time**, not the cue start. Scrubbing (Task 3) should keep working when the drag starts on a block and continues across it.
- [ ] **Step 3: Verify by hand** — click the middle of a long scene and confirm the playhead and preview land mid-scene.
- [ ] **Step 4: Commit.**

---

### Task 5: SPACE toggles playback globally

**Symptom:** "Pressing SPACE globally should play/pause the video."

**Files:** `apps/editor/src/Overlay.tsx` (or wherever the existing `⌘Z`/`⌘S` key handling lives)

- [ ] **Step 1: Write a failing test** or e2e assertion: press SPACE with nothing focused; playback toggles.
- [ ] **Step 2: Implement**, alongside the existing shortcuts. **Guard it:** SPACE must NOT toggle playback while an inline text edit is open or while focus is in an inspector `<input>`/`<select>` — typing a space in a caption or a hex colour must insert a space. Check `document.activeElement` / the editing state before handling.
- [ ] **Step 3: Verify by hand:** SPACE toggles when nothing is focused; SPACE types a space inside an inline edit and inside inspector fields.
- [ ] **Step 4: Commit.**

---

### Task 6: Drag a scene block to move it in time

**Symptom:** "I can extend the scene from its edges, but can't DRAG it?"

**Files:** `apps/editor/src/Timeline.tsx`, `apps/editor/src/timing.ts`

**Diagnosis (confident):** blocks expose edge handles (`beginEdgeDrag(cue, "start" | "end")`) but the block body has only a select/seek handler — no move gesture.

- [ ] **Step 1: Write a failing test** in `timing.ts`: moving a cue by a delta preserves its DURATION while clamping against neighbours and the clip bounds — distinct from the existing edge-resize clamp, which changes duration.
- [ ] **Step 2: Implement** body-drag: dragging a block's body shifts both `startSec` and `endSec` by the same delta, clamped so it cannot overlap a neighbour or leave the clip. Like an edge drag, it writes `timing` and therefore **pins** the scene — the pin badge and the un-pin affordance must appear exactly as they do for an edge drag.
- [ ] **Step 3: Disambiguate the gestures.** A block body now serves click-to-seek (Task 4) *and* drag-to-move. Use a small movement threshold (~3–4px) before a drag begins, so a click that wobbles still seeks rather than silently retiming — and a plain click must never write a `timing` override. There is an existing click-vs-drag guard for edge drags; follow its pattern.
- [ ] **Step 4: Verify by hand** — drag a block sideways and confirm it moves as a unit, keeps its duration, gains a pin, and that a plain click still just seeks.
- [ ] **Step 5: Commit.**

---

## Notes for whoever picks this up

- **Task 1 and Task 2 are the two that matter.** They are the difference between "a demo" and "a tool you would actually use". Tasks 3–6 are ordinary interaction gaps.
- Tasks 3, 4 and 6 all touch `Timeline.tsx` and interact (scrub vs seek vs move). Doing them in one pass may be cleaner than three separate ones — use judgement, but keep the tests per behaviour.
- A real produced workdir to test against, with 6 scenes across 70s:
  `/private/tmp/claude-503/-Users-amu1o5-personal-open-clip/61f3bab9-5211-4fcd-be4f-a0ca20255652/edit-demo/26-07-27 22-42-30 9912-9d855068`
  Start it with `pnpm ossclip edit "<that path>" --no-open` (build the page first: `pnpm --filter @ossclip/editor build`), then open `http://127.0.0.1:5174`.
- **Every one of these six shipped past a green test suite and multiple code reviews.** They were only found by a person using the thing. Hand-verification in a real browser is not optional for any of these tasks, and "the test passes" is not evidence a gesture feels right.

---

# Part 2 — production bugs found on the same clip

These are not editor bugs. They are worth doing **before** more editor polish, because they cost far more screen area than any interaction gap.

### Task 7: The source is letterboxed and nothing notices

**Evidence:** author-supplied screenshots of the rendered output for `26-07-27 22-42-30 9912.mp4`. The file probes as 1440×2560 (portrait), but the actual picture inside it is a **landscape shot with black bars baked in above and below**. The pipeline treats the whole 1440×2560 canvas as content, so:

- `video-top` renders a thin strip of real picture surrounded by black, with more black above it — the frame reads as mostly empty.
- `blurred-behind` blurs the letterbox too, so the top third is flat black rather than a blurred backdrop.
- The composition looks sparse in a way no amount of scene-graphic tuning can fix, because the wasted area is *inside the video slot*.

**Files:** `packages/core/src/ingest.ts` (or a new module beside `face.ts`), `packages/scenes/src/stage.ts`, `apps/cli/src/produce.ts`

- [ ] **Step 1: Detect the content rect.** Sample frames (reuse the sampling `measureFace`/`scanSourceText` already do — do not add a third ffmpeg pass if one can be shared) and find the largest rect that is not uniformly black across all samples. ffmpeg's `cropdetect` filter does exactly this and is already a dependency — prefer it over hand-rolled pixel scanning, and read its output the way `detectSilences` reads `silencedetect`.
- [ ] **Step 2: Cache it** in the workdir next to `face.json` (`content-rect.json`) — it is a property of the source, like the face box.
- [ ] **Step 3: Write a failing test** for the pure part: given per-frame black-bar measurements, derive a stable content rect; assert a letterboxed source yields the inner rect and a full-frame source yields the whole frame (no false crop on legitimately dark footage — a night shot must not be mistaken for a bar).
- [ ] **Step 4: Consume it.** Everything that reasons about the source's geometry must use the content rect, not the raw frame: the crop bias (`objectPosYFor`/`objectPosXFor`), `sourceAspect`, face measurement (Task 8), and the cover frame. The video slot should show the *picture*, not the picture plus bars.
- [ ] **Step 5: Log it** — `▸ source is letterboxed: content 1440×810 at y 875 (bars trimmed)`. A silent geometry change is exactly the class of bug this project keeps re-learning.
- [ ] **Step 6: Verify** on this clip: the rendered `video-top` block should be filled with picture, not bars.
- [ ] **Step 7: Commit.**

### Task 8: Face detection misses a profile view

**Evidence:** `face.json` is `{"face": null}` for this clip — zero detections across all sampled frames, where earlier clips got 9/9 and 7/9. The author confirms the face is present throughout, **turned sideways (profile) for most of the take**. The screenshots bear this out.

**Diagnosis (confident):** the vendored pico cascade is a **frontal** face detector. A profile view is outside what it was trained to find, so this is a coverage gap, not a threshold to tune. It is compounded by Task 7: inside the letterboxed frame the face occupies a much smaller fraction of the canvas than the detector's scale sweep assumes.

**Files:** `packages/core/src/face.ts`, `packages/core/assets/`

- [ ] **Step 1: Re-test after Task 7.** Detecting against the *content rect* rather than the full letterboxed canvas may recover some detections on its own, because the face is then a larger fraction of the searched area. Measure before building anything: run the existing detector on the cropped region and report the hit rate. If that alone fixes it, stop here and say so.
- [ ] **Step 2: If it does not,** add profile coverage. Options in order of preference: (a) run the existing cascade over rotated copies of the frame — pico supports an orientation parameter and this needs no new asset; (b) vendor a profile cascade alongside the frontal one and take the better hit; (c) fall back to a different detector. Prefer (a) — it is the smallest change and adds no dependency.
- [ ] **Step 3: Keep the fallback honest.** Today a total miss silently becomes the assumed-selfie framing, which is how this went unnoticed until a person looked at the output. Log the miss loudly (`▸ no face detected in N sampled frames — using the assumed framing; crop may be wrong`), so the next clip that fails announces itself.
- [ ] **Step 4: Add a regression fixture** — a few frames from this clip (or an equivalent profile shot) checked in small, with a test asserting a face IS found. Keep the asset tiny; there is already a note in the ledger about a 700KB fixture committed to git.
- [ ] **Step 5: Verify** on this clip: `face.json` non-null, and the resulting crop keeps the head in frame.
- [ ] **Step 6: Commit.**

**Ordering note:** do Task 7 before Task 8 — the letterbox is upstream of the face measurement, and fixing it may resolve part of Task 8 for free. Both are upstream of the editor work in Tasks 1–6 in terms of visible impact, though the editor issues are what make the tool usable at all.
