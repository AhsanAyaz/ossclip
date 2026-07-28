# Editor: playback control, seeking, affordances, and caption editing — plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Status:** not started. Logged 2026-07-29 from the author's first real editing session on `5 ClaudeCode.v8` (workdir `~/Downloads/.ossclip/5 ClaudeCode-07fbd090`).

**Goal:** Make the editor's playback behave like an editor's playback — explicit transport, J/K/L, a seekable ruler — and close three concrete defects the session surfaced, then take the one large feature (caption editing) seriously rather than bolting it on.

**Tech stack:** React 18, Remotion `<Player>`, TypeScript strict, vitest + Playwright e2e.

## Global constraints

- `pnpm test`, `pnpm typecheck`, `pnpm --filter @ossclip/editor build` and the 5 Playwright e2e stay green.
- Browser-safe imports only under `apps/editor/src/**`: `@ossclip/core/browser`, `@ossclip/renderer/composition`. Never the bare barrels.
- zod specifier exactly `zod/v4`.
- **Run the e2e with plain `npx playwright test` on macOS.** `OSSCLIP_E2E_CHROMIUM` points at a Linux container path; setting it on a Mac fails every spec for the wrong reason.
- Do not regress the six interaction fixes from `2026-07-28-editor-usability-fixes.md` — read its status block first.

---

### Task 1: kill click-to-play entirely

**Symptom (verbatim):** "Clicking inside the player still plays and pauses it. Just disable it completely. It should be explicit clicking and playing using the play button."

**Diagnosis (confirmed):** `App.tsx` passes `controls` to `<Player>` but never `clickToPlay`. Remotion defaults `clickToPlay` to `controls`, so the whole player surface is a play/pause target. The earlier §Task-2 work made the swallow *selective* — clicks on editable elements are the editor's, everything else falls through to the Player — which was the right fix for that bug and is the wrong policy now: in an editor, the frame is a canvas, not a play button.

- [ ] **Step 1.1:** Pass `clickToPlay={false}`. One prop.
- [ ] **Step 1.2: Re-examine the Overlay's capture-phase `pointerdown` swallow.** With `clickToPlay` off it is no longer load-bearing for playback, but it may still matter for other Player affordances. Decide with the behaviour in front of you: keep it (harmless, defends against a future `clickToPlay`) or delete it and simplify. Do NOT delete blind — the e2e "clicking an element selects it without toggling playback" asserts the first half and must keep passing.
- [ ] **Step 1.3: Update that e2e's second half.** It currently asserts clicking the video background *does* toggle. That assertion inverts: background clicks must now do nothing. The test is the specification — change it deliberately, in the same commit.
- [ ] **Step 1.4:** Verify by hand: clicking anywhere on the frame never toggles; the transport bar's own play/pause still works; SPACE still works.
- [ ] **Step 1.5: Commit.**

### Task 2: speed control and J/K/L transport

**Symptom:** "Add speed control on the player as well, to play fast or slow. Add the keyboard shortcuts as well."

Requested semantics, verbatim:

| key | behaviour |
| --- | --- |
| `L` | play forward; pressing again plays faster, and so on |
| `J` | play backward; pressing again plays back faster |
| `K` | stop/play toggle; when it plays, it plays at 1× |
| `SPACE` | toggle play/pause |

This is the YouTube/Premiere J-K-L convention. `SPACE` already works (§Task 5 of the usability plan) and must keep its guards (inline edits, inspector fields, the Player's own focused play button).

- [ ] **Step 2.1: Verify Remotion's reverse-playback support before designing around it.** `<Player>` takes `playbackRate`; confirm on THIS version whether a negative rate actually plays backwards, or whether J must be implemented as a seek loop (`seekTo(frame - step)` on an interval). The answer changes the whole task — measure it, do not assume. Record the finding in the report.
- [ ] **Step 2.2: Model the transport as a pure reducer** — `(state, key) => {rate, playing}` — and unit-test it. The ladder (1→2→4… on repeated L, mirrored on J), K resetting to 1×, and SPACE toggling without touching the rate are all logic, not UI, and belong in a testable function. Pick the ladder stops explicitly (suggest 1, 1.5, 2, 4) and write them where they can be read.
- [ ] **Step 2.3: Wire it** to `playerRef` + `playbackRate`, alongside the existing shortcut handler in `Overlay.tsx`, with the same typing guards.
- [ ] **Step 2.4: Surface the rate in the UI** — a small readout/control near the transport, so the state is visible and mouse-reachable. A rate that is only reachable by keyboard is a rate users lose track of.
- [ ] **Step 2.5:** e2e: press L twice, assert the rate rises; K, assert 1× and playing; SPACE, assert paused. Use the `data-playing` mirror on the stage (the container's headless Chromium has no H.264 decoder, so `<video>.paused` is not a usable oracle — see the usability plan's status block) and add a `data-rate` mirror the same way.
- [ ] **Step 2.6: Commit.**

### Task 3: the ruler seeks

**Symptom:** "the track above the timeline should also work for navigation/seeking, as it makes it super easy to not even touch the scene." (screenshot: the full-width `0:00 … 1:04.2` strip above the scene blocks)

**Diagnosis (confirmed):** `Timeline.tsx`'s `ruler` is two `<span>` labels in a flex row with no handler. All seeking lives on the scene track below it, so seeking near a scene boundary means aiming at a block — which also selects that scene, a side effect the user does not want when they are only navigating.

- [ ] **Step 3.1:** Give the ruler the same press-and-drag scrub the track has, reusing `timeAtX` — one mapping for every seek gesture, which is already the rule (§Tasks 3+4).
- [ ] **Step 3.2: Seeking on the ruler must NOT change the selection.** That is the whole point of the request.
- [ ] **Step 3.3:** Make it look seekable: give the ruler height/hit-area, show the playhead against it, cursor affordance.
- [ ] **Step 3.4:** e2e: drag on the ruler, assert the playhead follows and `overlay-box` selection is unchanged.
- [ ] **Step 3.5: Commit.**

### Task 4: show the safe area while dragging

**Symptom:** "when an item is being dragged, show the safe outlines (slightly) so user understands that the item can't be moved beyond that, as it hides behind them."

The platform chrome insets (`SAFE_AREA` in `packages/scenes/src/stage.ts` — top 12%, bottom 22%, right 16%, left 4%) are invisible, so an element dragged under them looks like it simply vanished.

- [ ] **Step 4.1:** Render a faint safe-area rectangle in `Overlay.tsx` **only while a drag is in progress**, from the exported `SAFE_AREA` — never a hardcoded copy, or it will drift from the geometry it claims to show.
- [ ] **Step 4.2:** Consider also outlining the cover grid-safe rect (`COVER_GRID_RECT`) — decide with it on screen; two overlapping guides may be worse than one.
- [ ] **Step 4.3:** Keep it non-interactive (`pointer-events: none`) so it cannot swallow the drag it is annotating.
- [ ] **Step 4.4:** Verify by hand at both ends of a drag.
- [ ] **Step 4.5: Commit.**

### Task 5: the scale field rejects decimals

**Symptom:** "The 'scale' property is an integer. Doesn't allow anything between 1 and 0 therefore, it is useless."

**Diagnosis (confirmed):** `Inspector.tsx`'s `NumberField` renders `<input type="number">` with no `step`. HTML's default step is `1`, so the browser marks `0.62` invalid and the value never commits. Every numeric inspector field has this — the video-framing `scale` is just where it bites hardest, since its entire useful range is 0–1.

- [ ] **Step 5.1:** Add a `step` prop to `NumberField`; `any` (or `0.01`) for scale, `1` for pixel offsets. While there, check `min`/`max` so the schema's `positive().max(4)` and the UI agree instead of failing at the store.
- [ ] **Step 5.2: Audit every other `NumberField` call site** for the same defect — theme `radiusPx`, element `dx`/`dy`/`scale`. The element `scale` has exactly the same problem and was shipped weeks ago.
- [ ] **Step 5.3:** Unit-test or e2e that typing `0.62` commits `0.62`.
- [ ] **Step 5.4: Commit.**

### Task 6: the Timing section says nothing

**Symptom:** "'tracking transcript' always shows nothing." (screenshot: the TIMING section reads only `Tracking transcript`)

**Diagnosis:** the section renders the pinned time range only when `cue.pinned`; an unpinned cue gets the bare string. But an unpinned cue still HAS a resolved `startSec`/`endSec` — the user is looking at a scene on screen and being told nothing about when it is.

- [ ] **Step 6.1:** Always show the resolved `startSec – endSec` and the duration. The pinned/tracking distinction becomes a label on that, not a replacement for it.
- [ ] **Step 6.2:** Show what it is tracking — the anchor word range, and ideally the anchor text, so "tracking transcript" is a fact the user can check rather than a claim.
- [ ] **Step 6.3: Commit.**

### Task 7: caption editing

**Symptom:** "We need to be able to edit the captions as well." (reference screenshot: a Descript-style transcript pane beside the preview, with the words as editable text)

**This is a feature, not a fix, and it is the largest thing in this plan.** Do not start it in the same pass as Tasks 1–6.

What makes it hard, stated up front so it is designed rather than discovered:

- **Captions are derived, not stored.** `captionLines` in `render-props.json` come from the repaired transcript through `buildCaptionLines` + the `TimeMap`. There is no caption layer in `overrides.json` today, so "edit a caption" has no home yet.
- **Words carry timings.** Editing text is easy; editing text without destroying word-level timing is the actual problem, and the timing is what drives the kinetic highlight. Splitting one word into two, or merging two into one, has to redistribute stamps — `applyRepairs` already solves exactly this shape (proportional split inside the original span) and should be reused, not reinvented.
- **Scene copy and captions must keep agreeing (FINDINGS §21).** `reconcileCopy` exists because a graphic and the caption under it spelling one word two ways is a shipped defect. A manual caption edit can reintroduce it; decide whether an edit propagates, warns, or is scoped.
- **The transcript is the anchor for scene timing.** Cues resolve from word indices. An edit that changes word COUNT shifts every downstream anchor unless it is constrained to 1:1 substitutions (which is precisely the constraint `reconcileCopy` accepts, and why).

- [ ] **Step 7.1: Decide the scope first, with the author.** Three honest levels: (a) retype a word in place, 1:1, no timing change — small, safe, closes most of the need (e.g. the `double scape` → `double escape` case the strict repair gate refuses); (b) full transcript editing with split/merge and re-timed words; (c) Descript-style pane that also drives cutting (delete a sentence, the video loses it). These are days apart in cost. **Do not assume (c) from one screenshot.**
- [ ] **Step 7.2:** Design the override shape for whichever level is chosen, and write down how it survives a re-`produce` — that is the property that makes `overrides.json` worth having.
- [ ] **Step 7.3:** Plan the UI separately once the data model is settled.

---

## Notes for whoever picks this up

- **Tasks 1, 5 and 6 are ~one sitting together** and are pure defect work. 2, 3, 4 are interaction features. 7 is its own project.
- **The e2e are the specification.** Task 1 inverts an existing assertion — change it in the same commit as the behaviour, never after.
- The author's editing session ran against `~/Downloads/.ossclip/5 ClaudeCode-07fbd090`; start the editor with `pnpm build && pnpm ossclip edit "<that path>"`.
- Every one of these came from ten minutes of a person actually using the tool. That is the only reason they were found — keep the hand-verification step in each task.
