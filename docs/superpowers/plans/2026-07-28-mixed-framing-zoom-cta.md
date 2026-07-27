# Mixed framing, zoom policy, and the CTA keyword — plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Make ossclip correct on a real source whose framing changes mid-take, replace the constant zoom oscillation with one intentional move per clip, and stop the comment-CTA mechanic firing on a CTA it was not designed for.

**Source:** the author's own clip, `5 ClaudeCode.mp4` (64.17s, 1440×2560 HEVC, 30fps), produced 2026-07-28 with `--produce --cleanup standard`. The run succeeded (0 cuts, 5 scenes, 9 transcript repairs) but three defects showed on screen. Two were reported by the author from the rendered file; the third was found while diagnosing them.

**Tech Stack:** TypeScript strict, vitest, ffmpeg/ffprobe, Remotion.

## Evidence gathered before planning

Measured on the source, not inferred:

- **The source has mixed framing.** 24.0s of 63.5s is a letterboxed landscape strip (`1440×808 at y=876`); the rest is full-bleed portrait. Segments (top-bar luma scan at 2 Hz, `YMAX < 24` ⇒ letterboxed):

  ```
  LETTERBOXED  0.0– 2.5    full-bleed   2.5–14.5
  LETTERBOXED 14.5–22.0    full-bleed  22.0–32.5
  LETTERBOXED 32.5–38.5    full-bleed  38.5–42.5
  LETTERBOXED 42.5–46.0    full-bleed  46.0–55.0
  LETTERBOXED 55.0–59.5    full-bleed  59.5–63.5
  ```

- `content-rect.json` recorded `full: true`. **This is correct under the current contract** — `stableContentRect` unions every sample so a bar must be black in EVERY sample, and here it is not. Cropping the whole source to `1440×808` would destroy the full-bleed segments. Task 7 (2026-07-28) assumed a source is uniformly letterboxed; this one is letterboxed *per segment*. The gap is in the model, not the detector.
- Consequence in the render: `scene-0` (StatCard, `video-top`, 0.2–5.2s) overlaps the 0–2.5s letterboxed segment and shows a **13% black band across the top** of the video block for its first ~2.5s — the hook frame. `scene-11` (ChatMock, `blurred-behind`, 55.79–60.79s) sits on the 55.0–59.5s segment and renders roughly two-thirds black.
- **Zoom oscillates for the whole take.** `zoomPlan` is 25 segments alternating `1 ↔ 1.08` about every 2s, because `buildZoomPlan` reverses direction at every phrase boundary and 24 were found.
- **The CTA keyword is real but the wrong shape.** The speaker says *"which one did you not know? Type in the comments the number of it"*. The producer extracted `keyword: "number"`, so the render shows a `"NUMBER"` pill and the caption reads `comments the "NUMBER"`. The ask is "reply with a digit", not the comment-a-magic-word mechanic the feature implements.
- **`ChatMock` never renders its conversation when a keyword is set.** `chatBubbles` (`packages/scenes/src/fit.ts:292`) returns a single synthesized bubble and discards `props.messages`; the beat sheet had planned two (`agent: "Which one did you not know?"`, `user: "3"`). Meanwhile `applyCtaKeyword` (`ChatMock.tsx:53`) — which `scene-registry.ts:80-83` and its own docstring both describe as the shipped behaviour — is referenced only by its test. Documented behaviour and shipped behaviour disagree.

## Decisions taken with the author

- Mixed framing → **per-segment content rect** (not a warning, not slot-avoidance).
- Zoom → **one slow out→in per clip**, no mid-sentence reversal.

## Global Constraints

- `pnpm test`, `pnpm typecheck`, and the editor build stay green.
- Browser-safe imports only under `apps/editor/src/**` and `packages/scenes/src/**`: `@ossclip/core/browser`.
- zod specifier exactly `zod/v4`.
- Cached artefacts in a workdir (`content-rect.json`) are versioned — bump `CACHE_VERSION` on any shape change so stale caches are re-measured rather than misread.
- Do not regress Task 7's uniformly-letterboxed case: `make-fixture.mjs`'s letterboxed fixture must still crop end to end.

---

### Task A: The CTA keyword — stop firing on the wrong CTA shape

**Symptom (verbatim):** "this was a video that did not have a keyword to comment. As I'm not sending them anything. However, as you can see, it made 'Number' as the keyword. Which is incorrect."

Two independent defects; fix both, smallest first.

**Files:** `packages/scenes/src/fit.ts`, `packages/scenes/src/components/ChatMock.tsx`, `packages/core/src/scene-registry.ts`, the producer prompt that emits `keyword`.

- [ ] **Step A1: Failing test — a keyword must not delete the conversation.** Assert `chatBubbles({messages: [{from:"agent",text:"Which one did you not know?"},{from:"user",text:"3"}], keyword:"number"})` returns BOTH bubbles, with the keyword styled in place where it appears. Today it returns one synthesized `"NUMBER"` bubble.
- [ ] **Step A2: Implement.** Make `chatBubbles` map `props.messages` through `applyCtaKeyword` instead of short-circuiting. `applyCtaKeyword` stops being dead code and becomes the single formatter, matching its docstring and `scene-registry.ts:80-83`. Keep the synthesized-bubble path ONLY for the case it was really for — `keyword` set with no messages at all.
- [ ] **Step A3: Failing test — a "reply with a number" CTA is not a keyword CTA.** The keyword mechanic asks the viewer to type a specific magic word. A prompt like "comment the number of it" asks for a digit the producer cannot know. Assert that a generic filler word (`number`, `answer`, `it`, `one`, `below`, `comments`) is rejected as a keyword, so `ctaKeyword` stays unset and neither the pill nor the caption styling fires.
- [ ] **Step A4: Implement the guard** where `keyword` is validated (schema refinement and/or the producer's post-parse validation, next to the existing grounding checks). Reject on a denylist of CTA filler AND on the word not being a distinctive term in the take. Log the rejection the way grounding warnings are logged — silent suppression is worse than a wrong keyword.
- [ ] **Step A5: Verify on the real clip.** Re-run `produce` on `5 ClaudeCode.mp4`; `render-props.json` must have no `ctaKeyword`, and the ChatMock scene must render the two planned bubbles.
- [ ] **Step A6: Commit.**

---

### Task B: One intentional zoom per clip

**Symptom (verbatim):** "One big flaw I think we have overall is the weird constant zooming in and zooming out."

**Files:** `packages/core/src/zoom.ts`, its callers in the CLI, `packages/core/test/zoom.test.ts`.

The current contract is stated in the module header — *"a slow, subtle zoom that reverses direction at speech-phrase boundaries"*. That contract is the bug: 24 boundaries produce 24 reversals. Replace it, don't patch it.

**New contract:** within one cut-free clip the zoom moves in ONE direction only. Each clip ramps `1 → maxScale` on a cosine ease over `min(clipDuration, RAMP_SEC)` and then **holds** at `maxScale` for the remainder. A cut resets it to 1, where the existing cut punch-in already justifies a step. On a take with no cuts this is a single slow push that settles — never a reversal, never a sawtooth.

Holding after the ramp is what keeps the move perceptible on a long clip: stretching `1 → 1.08` across a 64s take is ~0.12%/s and reads as no motion at all, while a bounded ramp then a hold is exactly the author's "zoomed-out to zoomed-in, then keep that perspective consistent".

- [ ] **Step B1: Failing test — no reversal within a clip.** For a plan built over a single 64s cut-free clip, assert `zoomScaleAt` is **monotonically non-decreasing** across the whole clip. Today it oscillates 24 times. Also assert it reaches `maxScale` by `RAMP_SEC` and stays there.
- [ ] **Step B2: Failing test — a cut resets.** With two clips split by a cut, assert each clip independently starts at 1 and ramps, and that the reset lands exactly on the cut boundary.
- [ ] **Step B3: Implement.** `buildZoomPlan` takes cut boundaries (kept spans in OUTPUT time) instead of phrase boundaries. Delete the phrase-boundary machinery (`merge`, acoustic/caption/metronome sources) if nothing else needs it — or keep `ZoomSource` reporting only if the CLI log still earns it. Update the CLI's `▸ zoom:` line to say what it now does; a log claiming "24 phrase boundaries" after this change would be a lie.
- [ ] **Step B4: Check the interaction with the fill/crop budget.** `ZOOM_MAX_SCALE` is exported "so the stage can budget crop margins against it" — holding at `maxScale` for most of a clip means the budget is now the common case, not the peak. Verify nothing was relying on the zoom spending most of its time near 1.
- [ ] **Step B5: Verify on the real clip** and eyeball the first 15s: one settled push, no breathing.
- [ ] **Step B6: Commit.**

---

### Task C: Per-segment content rect

**Symptom:** 38% of the author's source is a letterboxed landscape strip; scenes that land on those stretches render mostly black bar.

**Files:** `packages/core/src/content-rect.ts`, `packages/core/src/ingest.ts`, `packages/core/src/face.ts`, `packages/core/src/source-text.ts`, `packages/core/src/cover.ts`, the mezzanine build, `packages/scenes/src/stage.ts`, `scripts/make-fixture.mjs`.

This is the largest task and it changes a value that most of the geometry depends on, from a constant into a function of time. Sequence it so the constant case never breaks.

- [ ] **Step C1: Failing test — detect a framing CHANGE.** Build the measurement on `stableContentRect`'s existing per-sample rects, but instead of one union, group consecutive samples into runs of like framing and emit a timeline: `Array<{startSec, endSec, rect}>`. Assert on a synthetic sample sequence (letterboxed, letterboxed, full, full, letterboxed) that three segments come back with the right boundaries. Assert the uniform cases still collapse to exactly one segment — a uniformly letterboxed source and a uniformly full source must both keep today's behaviour.
- [ ] **Step C2: Failing test — the union rule still protects a dark shot.** The reason `stableContentRect` unions is that a genuinely dim frame can "detect" a false crop. Per-segment detection reintroduces that risk at segment granularity. Assert a single anomalous dark sample inside a long full-bleed run does NOT become its own crop segment: require a minimum run length (in samples AND seconds) before a framing change is believed, and keep `MIN_CONTENT_FRAC`.
- [ ] **Step C3: Implement detection.** Extend `detectContentRect` to return the timeline; keep a `full`-style summary rect for callers that genuinely need one constant. Bump `CACHE_VERSION` — the JSON shape changes and stale `content-rect.json` files must be re-measured.
- [ ] **Step C4: Decide and document how a mixed source is BAKED.** A per-segment crop cannot be a single ffmpeg `crop` on the mezzanine. Options, to be chosen with measurements in the report: (a) bake per segment via a filter chain that crops-and-scales each range back to a common frame, (b) leave the mezzanine uncropped and let the render-time stage consume the timeline. (b) is likely right — the stage already animates the video slot per frame, and it avoids re-encoding decisions — but it must be stated, not assumed. **Whichever is chosen, `sourceAspect` and the face/cover/source-text consumers must agree with it.**
- [ ] **Step C5: Face and cover must measure inside the ACTIVE rect.** `measureFace` samples frames across the take; with mixed framing it currently averages a face measured in a letterboxed frame with one measured full-bleed, which is why the reported `centerYFrac`/`sizeFrac` describe neither. Sample per segment and either report per segment or weight by segment duration — and say in the log which it did.
- [ ] **Step C6: Stage consumes the timeline.** The video slot's crop for a given frame comes from the rect active at that output time (mapped through the TimeMap, since the timeline is in SOURCE time and the stage runs in OUTPUT time). A `video-top` slot during a letterboxed stretch must show picture, not bar.
- [ ] **Step C7: Producer awareness.** A scene placed on a letterboxed stretch has far less usable picture. Either the beat sheet avoids those windows for `video-top`/`blurred-behind`, or the layouts adapt. Decide with the render in front of you.
- [ ] **Step C8: Fixture.** `make-fixture.mjs` gains a MIXED-framing fixture (alternating letterboxed and full-bleed) so this case is covered by an automated end-to-end run, not only by the author's private clip.
- [ ] **Step C9: Verify on the real clip.** The 0–2.5s hook must render solid picture with no black band, and the 55–59.5s ChatMock stretch must show a blurred face rather than a black frame. Attach before/after frames to the report.
- [ ] **Step C10: Commit.**

---

## Verification owed to the author

- The hook frame (0–2.5s) with no black band.
- The 55–59.5s CTA stretch showing picture.
- The first 15s showing one settled zoom push, no breathing.
- `render-props.json` with no `ctaKeyword`, and a ChatMock rendering both planned bubbles.
