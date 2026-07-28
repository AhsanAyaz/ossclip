# Producer framing awareness — plan (steps A and B)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Status:** not started. Steps C and D shipped in `f84c773` and produced the evidence this plan consumes.

**Goal:** Stop the producer choosing a layout the source cannot physically support at that moment, and let it choose layout at all — today it is a lookup table.

---

## Why this exists (measured, not inferred)

The author flagged two frames as over-zoomed, one with the eyes cut off. Three rounds of tuning a global constant (`MAX_FACE_FRACTION`) improved it but never fixed it, because the constant was an average standing in for a per-scene calculation.

Step D named the real mechanism. A video slot **wider** than the source canvas is cover-cropped **vertically**, so it shows only `canvasAspect / slotAspect` of the canvas height — and the face grows by the inverse of that:

- `video-top` is a 1080×806 band; the canvas is portrait (450×800 on the author's clip).
- Visible canvas height = `0.5625 / 1.34` = **42%**.
- A face at 44% of the canvas is therefore **105% of the band**. Head does not fit. Crown trimmed.

Run on the author's clip after C+D:

```
⚠ scene-6 (video-top): head is 206% of its video slot — the crop will trim it.
⚠ scene-7 (video-top): head is 215% of its video slot — the crop will trim it.
```

**This is not fixable by cropping.** The pixels a wide band wants do not exist in a portrait close-up — the source's full-bleed stretches are a zoomed crop, ~0.61 face-per-frame-width against the strips' 0.32. Matching them is geometrically impossible in a portrait output. The fix is editorial: **do not put a wide band on a close-up moment.**

## What exists to build on

- `assessCueFraming(cues, segments, faceFracOfCanvas, canvas, zoom)` in `packages/core/src/normalize.ts` — pure, tested, returns `{cueId, layout, faceFracOfSlot, headFracOfSlot}`. `headFracOfSlot > 1` means it will trim.
- `NormalizePlan.faceFracOfCanvas` — per content segment, what the framing actually achieved.
- The CLI already calls it after `sceneCues` are final and logs the warnings (`apps/cli/src/produce.ts`, "Per-scene framing" block), filtered to slots that are the subject (`PRIMARY_VIDEO_SLOT_AREA`, plus non-zero opacity — a pip bubble is meant to be a tight head-shot).
- `layoutSlots(layout).video.rect` (`@ossclip/scenes/geometry`) is the slot geometry, importable from the CLI but **not** from core (core must stay React-free and cannot depend on scenes).

## Global constraints

- `pnpm test`, `pnpm typecheck`, editor build and the 5 Playwright e2e stay green.
- zod specifier exactly `zod/v4`.
- Geometry stays deterministic and testable. The AI receives constraints; it does not do pixel arithmetic.
- Do not regress: uniform-letterbox, plain 9:16, 16:9 landscape and mixed-framing sources all produce correctly today (`node scripts/make-fixture.mjs` emits all four; `edited-reel.mp4` is skipped on an ffmpeg without `drawtext`).

---

### Task A: give the beat sheet a framing brief

The producer prompt today (`buildBeatsUserPrompt`, `packages/core/src/producer/beats.ts`) contains **only**: intent, output duration, component menu, word-indexed transcript. Zero geometry. It has never seen the face, the framing timeline or a slot dimension.

- [ ] **Step A1: Decide the brief's shape and write a failing test for the serializer.** One line per framing window, in the transcript's own coordinates so the producer can line it up with word indices — e.g. `words 0-88: face is CLOSE (fills 61% of frame width); wide layouts unavailable here`. Word indices, not seconds: the producer reasons in word spans and never sees output time.
- [ ] **Step A2: Implement the serializer** as a pure function in core, taking the framing plan + transcript and returning the brief. Unit-test the mapping from source seconds to word indices at both ends.
- [ ] **Step A3: Thread it into `buildBeatsUserPrompt`** and state in `PRODUCER_SYSTEM` what the producer must do with it: on a CLOSE window, prefer layouts that keep the face large (`pip-bubble`, `graphic-only`, `full-bleed`) and avoid the wide bands (`video-top`, `blurred-behind`).
- [ ] **Step A4: Verify on the author's clip** — re-run and confirm the two `video-top` warnings are gone or reduced. **The warnings are the acceptance test**; this step is worthless without them dropping.
- [ ] **Step A5:** Note the token cost in the run's usage line; the brief is ~10 lines and should be negligible against a 45k-token prompt.
- [ ] **Step A6: Commit.**

### Task B: let the producer choose the layout

`generateScenes` (`packages/core/src/producer/scene-props.ts:116`) assigns layout from `SCENE_REGISTRY[component].defaultLayout`, rotating through `altLayouts` on repeats (FINDINGS §20). It is a lookup table pretending to be judgement, and it is the one decision that is genuinely both editorial and geometric.

- [ ] **Step B1: Failing test — an infeasible layout is repaired, not rendered.** Given a beat sheet asking for `video-top` on a window the brief marked CLOSE, assert the validator rewrites it to a feasible layout and records an issue, exactly as `normalizeBeatSheet` repairs bad word spans today.
- [ ] **Step B2: Add `layout` to the moment schema** as optional, so an older cached beat sheet still parses and falls back to the registry default.
- [ ] **Step B3: Implement the validator** next to `normalizeBeatSheet`: for each moment, if the chosen layout's slot cannot hold the head at that window's framing, swap to the best feasible alternative from the component's `altLayouts` (then the default), and log it. Reuse `assessCueFraming` rather than a second copy of the geometry.
- [ ] **Step B4: Keep the §20 variety pass working** — it currently rotates layouts to avoid a template feel. Variety must not override feasibility; feasibility wins and variety picks among what is left.
- [ ] **Step B5: Verify on the author's clip** and on the mixed-framing fixture. Zero framing warnings is the target; any that remain must be ones where *no* layout is feasible, and those should say so.
- [ ] **Step B6: Commit.**

---

## Notes for whoever picks this up

- **A before B.** B without the brief is the model guessing at geometry it cannot see; A makes B's job checkable.
- **Do not let the model do pixel math.** The brief should be qualitative (CLOSE / MEDIUM / WIDE + what that rules out). The arithmetic stays in `assessCueFraming`, where it is tested.
- **The validator is the safety net, not the prompt.** Same lesson as FINDINGS §35: a `.describe()` is a request, `normalizeBeatSheet` is a constraint. Ship B's repair pass even if the prompt seems to behave.
- Real clip to verify against: `~/Downloads/5 ClaudeCode.mp4` (64s, 1440×2560, mixed framing, 10 segments). Its workdir caches the scene plan, so re-runs cost no LLM calls unless the transcript text changes.
- The remaining crown trimming the author accepted as house style (FINDINGS §25) is *hair*, not face. Do not confuse it with the `video-top` defect above, which cuts eyes.
