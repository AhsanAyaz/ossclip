# Round 15 — landscape layouts, a preview worth looking at, and caption editing that works

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes. This document is REQUIREMENTS, not a design — the diagnosis under each item is what has been verified; the approach is yours to settle, and several items name a decision the author still has to make.

**Status:** requirements captured 2026-08-01 from the author's first landscape run (`Agents in 2026_landscape.mp4` → `Agents-2026.landscape.mp4`, 1920×1080, 12:20, Gemini, $0.002). Not started. Items are independent except §55 (blocked on §57's decision) — do them in any order that suits.

**Context:** R15 shipped `--aspect 16:9` (frame-aware geometry, landscape safe area, layouts restricted to `full-bleed` + `blurred-behind`). The output is correct but conservative, and the editor turns out to be portrait-shaped in ways nobody noticed while every clip was 9:16.

---

## 54. Landscape needs layouts that use the width

**Observed:** `blurred-behind` is the only graphic layout landscape has, and it blurs the ENTIRE frame — throwing away exactly the room (desk, monitors, second screen) that choosing 16:9 was meant to keep. `full-bleed` shows everything but has nowhere to put a card except floating over the picture (R13's `FULL_BLEED_GRAPHIC_SLOT`).

**Wanted:** two new landscape-native layouts.

- [ ] **54a. `lower-third`** — video full-frame, graphic in a band across the bottom (broadcast lower-third). Picture stays whole; the card sits in the least valuable part of the frame.
- [ ] **54b. `split-left` / `split-right`** — video fills one half, graphic the other. Two layouts, not one with a flag: the side matters (the speaker's eyeline and the room's contents differ left vs right), and the producer should be able to pick.

**What the implementer needs to know:**

- `LayoutSchema` (`packages/core/src/scene-schema.ts`) is the enum; `layoutSlots()` (`packages/scenes/src/stage.ts`) is the slot table returning `{video, graphic, captionAnchor}`; `landscapeLayout()` + `LANDSCAPE_LAYOUTS` (`packages/core/src/framing.ts`) decide what survives in 16:9; `SCENE_REGISTRY`'s `defaultLayout`/`altLayouts` (`packages/core/src/scene-registry.ts`) steer the producer.
- **The slot table is frame-agnostic (fractions), but these layouts are not.** A lower-third band or a half-width split is a landscape idea; in 9:16 a half-width video slot is a sliver. Decide explicitly: are these landscape-only (and if so, what enforces it — `landscapeLayout`, the registry, the producer prompt, or a portrait-side remap that is currently missing), or do they get portrait geometry too?
- **Two existing stage tests iterate EVERY layout** and will bind the answer: "every graphic slot sits inside the platform safe area" and "every layout shows captions, inside the safe area, clear of the graphic". Both currently run against the portrait frame only. If the new layouts are landscape-only, those loops need to become frame-aware rather than have the new layouts exempted.
- **Half-width video re-opens face cropping.** A 16:9 source in a half-width 16:9-frame slot is ~8:9 — it gets cropped horizontally, so `objectPosXFor` and the measured `centerXFrac` matter again. That path is frame-aware since R15 but has never run on a real landscape take; verify against the real clip, not the fixture.
- `assessCueFraming` / the producer's framing brief only run when a normalization plan exists (letterboxed sources). A uniform landscape file still gets no assessment — so the producer will not learn that a split layout is wrong for a given moment. Out of scope here, but do not assume the brief is protecting these layouts.

---

## 55. The editor preview is tiny and most of the window is wasted

**Observed (screenshot 1):** on a 2000px-wide window the player renders at a hardcoded 380px, leaving roughly two thirds of the stage area empty black. It is worst in landscape, where 380px wide means a ~214px-tall picture — the author is asked to judge framing and read caption text at a size where neither is legible.

**Root cause, verified:** `apps/editor/src/App.tsx` passes `style={{ width: 380 }}` to `<Player>` — a fixed pixel width, chosen when the preview was a 9:16 sliver beside a sidebar.

- [ ] **55a.** The preview fills the available stage area: sized from the container, aspect-preserving, responsive to window resize and to the sidebar's width. Both 9:16 and 16:9 must look deliberate — one should not be sized to suit the other.
- [ ] **55b. View-level zoom and pan on the preview** — magnify to inspect a caption or a graphic edge, drag to move around while magnified.

**The trap in 55b, stated up front:** the stage ALREADY has a drag-to-pan and a zoom, and they mean something completely different — they EDIT `cue.video` (the framing override, R10 Task B) and they write to `overrides.json`. A view zoom must never write an override. Two gestures on one surface need an unambiguous split (a modifier, an explicit mode toggle, a separate scroll-to-zoom-vs-drag rule) and whatever is chosen has to be discoverable — the author must never be unsure whether a drag just moved the camera or edited the video. Note also that `Overlay`'s hit-testing maps page pixels to composition pixels through `playerRef.getScale()`; a view transform on top of the player changes that mapping and every drag/handle in the editor depends on it.

---

## 56. Captions cannot be positioned, and should be positionable in bulk

**Observed (screenshot 2):** the caption sits where the layout's `captionAnchor` puts it, and nothing in the editor can move it. In landscape it lands over the player's own transport row, which is both ugly and (see §57) unclickable.

**Wanted:**

- [ ] **56a. Per-scene caption position** — move the caption box for a scene, from the editor, and have it persist through a re-render.
- [ ] **56b. Multi-select on the timeline**, then move ALL selected scenes' caption boxes together. Including "select all" — the common case is "the captions are too low for this whole video", not "this one scene".

**What the implementer needs to know:**

- Captions resolve their vertical position through `captionAnchorAvoiding(layout, regions, graphicRect)` (`packages/scenes/src/source-fit.ts`), called per line by `CaptionTrack`. There is no per-scene override in the chain today.
- **Naming collision to avoid:** `OverrideDoc.captions` ALREADY exists and is the caption TEXT retype map, keyed by global caption-word index with a `was` guard (R11 Task 7a). A caption POSITION override is a different thing and must not be merged into that key — put it on the scene (`scenes[id].captionBox` or similar), where the timeline selection can address it.
- **Multi-select is the expensive half.** `Selection` is `{sceneId, elementId} | null` and is read by `App`, `Overlay`, `Inspector` and `Timeline`; every one of them assumes at most one scene. Widening it touches all four. Consider whether a bulk caption move genuinely needs general multi-select, or whether "apply to all scenes" + "apply to this scene" covers the real need at a fraction of the blast radius — the author's stated case ("select all and do so") is satisfied by the cheaper option.
- Whatever is stored must survive `produce` re-running: the override layer is the only thing that does (`applyOverrides`), and `produce.ts` must apply it when it rebuilds `captionLines`.

---

## 57. Caption editing does not work at all in landscape

**Observed:** double-clicking a caption word in a 16:9 project never opens the retype input. Works in 9:16.

**Leading hypothesis, NOT yet confirmed — verify before building:** `Overlay` reserves the bottom 64px of the stage for the Player's transport (`PLAYER_CONTROLS_STRIP_PX`, added R10 because the transport keeps pointer events while faded out and carries no stable DOM marker). In landscape the preview is short (380×214 at today's fixed width), so that 64px strip covers roughly the bottom THIRD of the picture — which is exactly where captions sit. Screenshot 2 shows the caption text overlapping the transport row.

If that is the cause, note it is a ratio bug, not a landscape bug: the strip is an absolute pixel constant applied to a preview whose height varies. §55a (a bigger preview) will mask it without fixing it. Fix the cause.

- [ ] **57a.** Confirm the mechanism first (a caption word's `elementFromPoint` hit in a 16:9 project, with the strip's bounds logged), then fix so caption editing works in every aspect and at every preview size.
- [ ] **57b.** Whatever replaces the constant must still keep the Player's transport clickable — that is what it was protecting.

---

## 58. Timeline should page itself when a drag reaches the edge

**Observed (screenshot 3):** zoomed to 16×, dragging a block or scrubbing toward the right edge of the viewport simply stops at the edge. Every real editor scrolls the timeline when the pointer reaches the bound and lets the drag continue.

- [ ] **58a.** While a drag/scrub is live and the pointer is at (or past) the scroller's edge, page the timeline in that direction and keep the gesture going. Author's stated semantics: advance by the viewport width so the content that was at the bound becomes the new starting edge — forward and backward alike.
- [ ] **58b.** Applies to every timeline gesture that can run off-screen: track scrub, block move, edge-resize drag.

**What the implementer needs to know:** `Timeline.tsx` owns `scrollerRef` and the zoom state (R14 §53); the drag handlers are the window-level `mousemove`/`mouseup` pair. All the timing math divides by the track's own bounding width and so is already zoom-calibrated — paging changes `scrollLeft`, which the existing math reads through `getBoundingClientRect`, so the drag arithmetic should not need to change. Verify that assumption rather than trusting it; a stale `trackWidth` captured at drag start (as `DragState` does) is exactly the kind of thing that breaks under scroll.

---

## 59. NEW FEATURE — a transcript editing view

**Wanted:** a view of the whole transcript where words are easy to find and easy to fix. Edits update the captions in the editor preview AND in the re-rendered video.

**What already exists (this is smaller than it looks):**

- Caption text edits already have a home: `OverrideDoc.captions`, keyed by global caption-word index, guarded by the `was` text so a stale edit is dropped loudly rather than landing on the wrong word (`applyCaptionEdits`, `packages/core/src/overrides.ts`). `produce.ts` already applies it when rebuilding captions, so the re-render half is DONE — a transcript view that writes through this layer gets it for free.
- `App` already holds `baseCaptionLines` (the pristine pre-edit lines) and the live merged copy.

**So the work is mostly the view:** a scrollable word list with search/jump, showing the current (possibly edited) text, writing 1:1 retypes through the existing override, and keeping the preview and the timeline in sync with wherever the user is reading.

- [ ] **59a.** Find + edit + jump-to-time, updating the preview live.
- [ ] **59b.** Decide the scope boundary and say it in the UI. R11 Task 7 settled on **1:1 retype only** for a hard reason: cues anchor to word INDICES, so inserting or deleting words shifts every downstream anchor, and word timings drive the kinetic highlight. A transcript view invites split/merge/delete — if those are wanted, they are a re-timing project (`applyRepairs` already solves the proportional-split shape and should be reused, not reinvented), not a text box. Ship 1:1 first unless the author decides otherwise.
- [ ] **59c.** Deleting a sentence from the transcript and having the VIDEO lose it is a third thing again (it drives the cut, not the captions). Explicitly out of scope unless asked for.

---

## Verification

- `pnpm vitest run`, `pnpm -r --parallel exec tsc --noEmit`, `pnpm --filter @ossclip/editor build`, and the Playwright suite (21 today) stay green.
- e2e for anything with a gesture: §56's bulk move, §57's landscape caption retype, §58's edge paging. The existing specs are the model — raw `page.mouse`, the `settle()` helper, assertions against `overrides.json` on disk.
- §54 needs a real landscape render, not just the fixture: extract frames from a `lower-third` and a `split-*` scene and confirm the picture is not cropped through the speaker.
- §55/§57 want a screenshot at two window sizes and both aspects — these are ratio bugs, and a single-size check is how they got here.

## Notes for whoever picks this up

- The author's standing guard, unchanged: **the product is solid; do not overengineer.** Where an item names a cheaper option than the obvious one (§56b), take the cheap one unless it demonstrably fails the real case.
- Landscape has had exactly ONE real run. Prefer verifying against `~/Downloads/Agents-2026.landscape.mp4`'s workdir over reasoning from the 9:16 fixture.
- Still open from R15, unrelated to these items: the cut engine removed 0.1% of a 741s take, so long-form input still yields same-length output — there is no highlight selection anywhere in the pipeline.
