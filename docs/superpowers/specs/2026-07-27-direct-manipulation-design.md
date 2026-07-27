# Direct manipulation — a minimal local editing page

*Phase 2, first slice (BRAINSTORM §4.6, §8). Companion to `docs/PHASE1.md` and `docs/PHASE1-FINDINGS.md`.*

## Why

Eleven findings rounds have all had the same shape: the producer chose badly, the user wrote it up, an agent changed a heuristic, and we re-ran. That loop is slow and it only fixes *classes* of mistake. Direct manipulation turns a bad choice into a ten-second edit — and it is cheap to build precisely because scenes are schema props rather than baked pixels, so "editing the video" is editing a JSON document.

It also converts the two complaints that heuristics have not solved (§23 sparse frames, §25 the crop trade) from findings into fixes.

## Scope

**In:** editing a scene's copy, dragging/resizing individual elements inside it, swapping component and layout, nudging scene timing, and style tokens. Everything writes to a user-owned override layer.

**Out of v1, deliberately:**

- **Filler-word cutting.** The user asked for it and it belongs in Phase 2, but it is a different kind of edit: it changes the *cutlist*, which shifts output time, which re-anchors every scene and caption and re-derives the zoom plan — and it changes the audio, so it cannot be previewed by re-rendering an overlay. It is v2 of this surface, after the editing model is proven.
- Caption per-word editing, z-order, rotation, multi-select, render orchestration.

The CLI remains the only thing that renders.

## Architecture

A new `ossclip edit <workdir>` command starts a small local server and opens a page. Two pieces: `apps/editor` (Vite + React + Remotion `<Player>`) and ~80 lines of HTTP in the CLI serving the doc, the media file, and a `PUT` for overrides.

### The override layer is its own file

`production.json` is a **derived artifact** — every `produce` run overwrites it. Overrides written there would evaporate on the next run, breaking §4.6's merge rule. So the user's layer lives separately:

```jsonc
// workdir/overrides.json — user-owned, never written by the producer
{
  "theme":  { "accent": "#FFE14D" },        // global style tokens
  "scenes": {
    "scene-0": {
      "props":    { "value": "861%" },
      "elements": { "value": { "dx": 12, "dy": -4, "scale": 1.08 } }
    }
  }
}
```

`produce` loads it *after* assembling scenes and applies it by scene id. Re-planning re-rolls `props` and leaves this untouched, so the agent and the human stop overwriting each other. Ids absent from a new plan are dropped **with a log line**, never silently.

### Data flow

```
produce ──> production.json + render-props.json ──┐
                                                  ├──> editor page (Player + overlay)
workdir/overrides.json <──── PUT /overrides ──────┘
        │
        └──> next `produce` applies it → rendered mp4
```

### Two kinds of edit

- **Prop edits** (text) already work: `resolveSceneProps` does `defaults ← props ← overrides`. Only reading `overrides.json` is new.
- **Element transforms** (drag/resize) are new. Each editable leaf gains two things: `data-edit-id="value"` for hit-testing, and a lookup that applies its own `dx/dy/scale` as a style. About two lines per leaf — not a wrapper component.

### Hit-testing: DOM attributes, not a registry

§4.6 sketched an `<Editable id>` wrapper registering live hit-boxes into a context. We use `data-edit-id` attributes plus `getBoundingClientRect` instead:

- The DOM **is** the registry, so there is no second source of truth to drift.
- Adding an editable element is one attribute, not a wrapper plus a ref plus a context subscription, across eight components.
- `getBoundingClientRect` already accounts for the zoom and punch-in transforms, of which there are many.

The rejected third option — exporting analytic rects from `fit.ts` — would duplicate layout logic CSS is already doing, and predicting flexbox correctly is exactly what bit us in §12 (wrap) and §23 (fill).

The tradeoff: measurement only works in a browser. Mitigated by keeping the **edit model** (id → patch, patch → resolved props and transforms) pure and unit-tested in `core`, with only measurement in the DOM.

## The page

```
┌─────────────────────────────────────────────┬──────────────────┐
│                                             │  INSPECTOR       │
│         Remotion <Player>                   │                  │
│         + selection overlay                 │  StatCard        │
│         (handles, drag, dbl-click text)     │  ─────────────   │
│                                             │  value  [861%  ] │
│                                             │  label  [CODE…]  │
│                                             │  x +12  y −4     │
│                                             │  scale 1.08      │
│                                             │  [reset element] │
├─────────────────────────────────────────────┴──────────────────┤
│ ▓▓▓▓▓░░░░▓▓▓▓▓░░░░░░░░▓▓▓▓▓░░░░░▓▓▓▓  ← scene blocks + playhead │
└────────────────────────────────────────────────────────────────┘
```

**Selection.** Click anything with `data-edit-id` → box with handles. Drag to move (`dx/dy`), corner handle to scale, double-click text to edit inline. Escape deselects, `⌘Z` undoes.

**Inspector** shows only the selection: text as a field, transform as *typeable numbers* (dragging is imprecise; typing `x: 0` is how a nudge gets undone cleanly), and a per-element reset. Selecting the scene instead shows component swap, layout, and timing.

**Style tokens are global, not per-element.** With nothing selected, the inspector shows the production's `theme` — font, accent colour, background, card radius. Editing one re-renders every scene at once, which is the point: the look is a system, and per-element font overrides are how a deck stops looking designed. These write to a `theme` key in `overrides.json`, beside the scene entries, and follow the same merge rule. Per-element style is explicitly *not* in v1.

**Timeline strip**: scene blocks against the full duration with a playhead. Click to select and seek, drag edges to nudge timing.

**Timing pins.** Scene times are *derived* from word anchors — that is what makes them survive a re-cut (PHASE1 §5). Dragging an edge overrides that with an absolute time, so the scene stops tracking its words. A nudged scene therefore shows a **pin icon**, and the inspector offers one-click "re-anchor to words". Silent divergence here would surface as a mystery bug several rounds later.

**Live preview**: overrides apply in the Player immediately — what you see is what renders.

**Save is explicit** (`⌘S` plus a dirty indicator), not autosave. This file sits beside files the producer writes; a half-dragged card should not persist itself.

Visual design follows the `frontend-design` skill at implementation time; this spec fixes behaviour, not aesthetics.

## Testing

**Pure, in `core` (vitest, no browser)** — where the real logic lives:

- Merge order `defaults ← props ← overrides.props`, and that re-planning replaces `props` while `overrides` survive (the §4.6 rule, asserted directly).
- Element transforms resolve to the right leaf; **reset removes the entry** rather than writing zeros, so "reset" and "nudged to 0,0" stay distinguishable.
- Orphan overrides (`scene-7` when the plan has five scenes) are dropped *and reported*.
- Theme overrides merge over `defaultTheme` and apply to every scene at once.
- Timing pins: a pinned scene holds absolute time across a `--cleanup` change; an unpinned one re-anchors. This extends the existing §5 regression test and is the most likely thing to break.
- Undo: snapshot stack, including that undoing past the last save re-marks the doc dirty.

**Browser: one Playwright smoke test, not a suite.** Load a fixture workdir, click an element, drag it, save, assert `overrides.json` on disk. That covers hit-test → patch → HTTP → file, which unit tests cannot reach. More than one and we are maintaining a UI suite for a local tool.

## Failure modes

| Situation | Behaviour |
|---|---|
| `overrides.json` malformed | Refuse to start, print the parse error. It is hand-editable user data; silently resetting it destroys work. |
| Producer rewrites the workdir while the editor is open | Watch mtime, show "the plan changed — reload". Never merge blind. |
| Save races the producer | Atomic write (temp file + rename). No half-written file. |
| Media or `render-props.json` missing | Error naming the workdir — the usual cause is the wrong directory. |
| Element id disappears (component swapped) | Its transform is dropped on load and logged in the page. Not fatal. |

## Milestones

| # | Deliverable | Done when |
|---|---|---|
| M2.1 | Override model in `core` | Merge, reset, orphan, theme and pin semantics unit-tested; `produce` reads `overrides.json` |
| M2.2 | `data-edit-id` on the scene library | Every editable leaf is tagged and applies its own transform |
| M2.3 | Editor shell | `ossclip edit <workdir>` serves the page; Player renders the production |
| M2.4 | Selection + inspector | Click, drag, resize, inline text, typed transforms, reset |
| M2.5 | Timeline + save | Scene blocks, playhead, timing nudge with pins, `⌘S` to disk |
| M2.6 | Round trip | Edit → save → `produce` → the render shows the edit; Playwright smoke test green |
