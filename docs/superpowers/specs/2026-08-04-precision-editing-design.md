# Precision editing — snapping, frames, guides, and a list that admits it scrolls

*Design. Companion to `apps/editor/src/{Timeline.tsx,timing.ts,Overlay.tsx,hitTest.ts,ProjectPicker.tsx}`.*

## Why

Second-round feedback from the project's first outside user, now past install friction and doing real editing. Four items, three of which are one complaint:

> "There was a gap between two clips. And I tried to move the scene to the left so it starts where the previous ends. The absence of snapping made it a bit difficult as I didn't know where the previous clip was ending exactly." … "even if the snapping feature cannot be embedded, to solve the problem of not knowing where the previous clip is ending … adding frames as well." … "the element cannot be aligned in the centre … there should be an alignment guide if not snap to align."

Snapping, a frames readout, and alignment guides are the same sentence three ways: *I cannot tell where things are, so I cannot land them precisely.* The fourth item is the project picker rendering a cut list.

### The picker, diagnosed live rather than guessed

Reproduced with Playwright against a real `$HOME` (27 entries): the browse list **is** constrained (`maxHeight: 34vh` → 320px at a 941px window) and **is** technically scrollable (`scrollHeight 376 > clientHeight 320`, `overflowY: auto`). The constraint is not broken. What is broken is that scrolling is invisible and unadvertised:

1. macOS overlay scrollbars render nothing until a scroll begins — a clipped list with no affordance reads as broken, which is what was reported.
2. Two nested scroll regions — the card (`82vh`/auto) and the list (`34vh`/auto) — fight the wheel; which moves depends on cursor position.
3. The magic vh pair means the list starves while the card shows dead space, or vice versa, depending on window height — "weird heights," as reported.

## Scope

**In:** timeline snapping to neighbour edges and the playhead; a `min:sec:frame` readout; centre + safe-area alignment guides on overlay drags; the picker rebuilt around one scroll region. Every behaviour has a pure core; UI files only wire and render.

**Out, deliberately:**

- **Element-to-element edge snapping** (Figma/Premiere style). The candidate set grows with every element and the guide rendering gets busy; waits for evidence someone needs it.
- **Magnetic timeline / ripple editing.** Different editing model entirely.
- **Timecode input.** The Inspector's numeric fields stay seconds — they are inputs, not readouts, and `min:sec:frame` parsing is its own design question.
- **New gestures.** Snapping and guides attach to the drags that exist today.

**Invariant, non-negotiable:** with snapping inactive (Alt held, or beyond threshold), every drag produces byte-identical results to 0.1.7. The existing `timing.ts` tests stay untouched and green; snap is a pre-pass, never a rewrite of the clamps.

## Architecture

### Timeline snapping — pure core in `timing.ts`

```ts
/** Timeline positions a drag wants to land on: neighbour cue edges, the
 * playhead, and the clip bounds. Derived per drag, not cached. */
export function snapTargets(
  cues: readonly SceneCue[],
  sceneId: string,
  playheadSec: number,
  durationSec: number,
): number[]

/** Snap `sec` to the nearest target within `thresholdSec`, or pass it
 * through. Returns which target hit so the UI can draw the tick. */
export function applySnap(
  sec: number,
  targets: readonly number[],
  thresholdSec: number,
): { sec: number; snapped: number | null }
```

Wiring order is the load-bearing rule: **snap first, clamp second.** `moveTiming` and `clampTiming` already guarantee no overlap and no sub-floor scene; running `applySnap` on the proposed edge *before* those clamps means a snap can never produce a state the clamps forbid — the clamp remains the single authority on legality, exactly as today.

The threshold is **8 screen pixels converted through the track's px-per-second** at the current zoom. Zoomed out, 8px is a coarse net; zoomed in, a fine one — which is how every NLE behaves and why the threshold parameter is seconds, converted at the call site where zoom lives.

Both drag kinds get it: body drags snap whichever edge is nearer its target (leading edge to a target, or trailing edge — the block shifts whole either way, duration preserved through `moveTiming` as today); edge drags snap the dragged edge only.

**Alt/Option held disables snapping entirely** — the standard escape hatch, checked at the call site from the pointer event, so the pure core never reads modifier state.

While a snap is active, the timeline renders a 1-px vertical tick at the snapped position in the accent yellow, carried through the existing `dragPreview` state — no new state channel.

### The frames readout — `formatTimecode` in `timing.ts`

```ts
/** "m:ss:ff" — the OpusClip-style readout the feedback referenced. Frames,
 * not centiseconds; ff is zero-padded to the fps' digit width. */
export function formatTimecode(sec: number, fps: number): string
```

Used by the transport's current/total readout and by the drag preview, so the number a drag shows is in the same units as the number the transport shows. `live.settings.fps` is already plumbed to both sites.

Rounding rule, stated because it is the trap: the frame component is `Math.floor((sec % 1) * fps)` computed on the *rounded-down* whole-second remainder — never `Math.round`, which at `29.97…` produces `ff == fps` and displays `0:01:30` for a 30fps clip, a timecode that does not exist.

### Overlay guides — pure core beside `hitTest.ts`

```ts
export interface Guide { axis: "x" | "y"; at: number /* frame fraction */ }

/** Snap a dragged rect to the centre lines and safe-area edges. Move drags
 * snap the rect's centre to centres and its edges to safe edges; resize
 * drags snap only the dragged edge. Returns the guides that hit so the
 * overlay can draw them. */
export function guideSnap(
  rect: GraphicRect,
  handle: BoxHandle | "move",
  frame: FrameSize,
  thresholdFrac: number,
): { rect: GraphicRect; guides: Guide[] }
```

Candidates: horizontal centre, vertical centre, and the four safe-area edges from the existing `safeAreaFor(frame)` — the same source the caption placement already uses, so the guide a user snaps to is the same boundary the renderer respects. Nothing else; the candidate list is closed by design this round.

`Overlay.tsx` applies it inside the existing drag handler after `applyBoxHandle` and before the edit is committed, and renders each active guide as a 1-px line in the accent yellow, visible only while snapped. Alt/Option disables, same convention as the timeline.

### The picker — one scroll region

`ProjectPicker.tsx` restructures from nested `maxHeight`s to a flex column:

- The card keeps `maxHeight: 82vh` but becomes `display: flex; flexDirection: column` with **no outer scroll**. Under the cap it stays content-sized (a shallow home directory does not get a tall empty card); at the cap, the flex column makes the browse list the part that gives.
- Header, recent list, and section titles are natural-height rows. The recent list keeps a modest `maxHeight` with its own scroll *only* if it has more than ~6 entries — recents are capped at 12 by `recordRecentProject`, so this stays small.
- The browse list gets `flex: 1; minHeight: 0; overflowY: auto` — it fills whatever the card has left, at every window size. The vh magic numbers go.
- The list's scrollbar is **styled visible** (thin, `#3a3a44` thumb via `::-webkit-scrollbar` — the editor ships in Chromium-family browsers; Firefox falls back to `scrollbar-width: thin`), and the list gets a bottom **fade mask when scrollable-but-not-at-end**, so a cut list looks continuable instead of broken.

Since inline styles cannot express `::-webkit-scrollbar` or dynamic fades, the scrollbar styling lands in the editor's existing global CSS entry, and the fade is a `maskImage` computed from scroll state — a small `onScroll` handler, the only non-pure addition in this round.

## Error handling

All pure cores are total: `applySnap` with no targets or a zero threshold returns the input; `guideSnap` outside every threshold returns the rect unchanged and no guides; `formatTimecode` clamps negative seconds to `0:00:00` and guards `fps <= 0` by returning seconds-only. The picker's fade handler degrades to no-fade if the ref is unmounted. Nothing throws mid-drag; a snap failure mode is always "behaves like 0.1.7."

## Testing

- `timing.test.ts` (existing file, appended): `snapTargets` includes neighbour edges/playhead/bounds and excludes the dragged scene's own edges; `applySnap` at, inside, and outside threshold; equidistant targets pick the earlier one deterministically; **snap-then-clamp**: a snap proposing an overlap is corrected by the existing clamps (composition test through `moveTiming`).
- `formatTimecode`: zero, sub-second, the `29.97` rounding trap, minute rollover, `fps <= 0` guard.
- `guideSnap`: each candidate axis, move vs resize semantics, threshold boundary, the no-hit passthrough (`toEqual` the input rect).
- **`ProjectPicker` gets its first rendering test** — same hole `SceneLayer` had: nothing renders this file today. jsdom test with a mocked `/api/fs` response of 40 entries asserting the browse list element carries `flex: 1` semantics and its container marks `overflowY: auto` — plus the existing e2e picker flow in `apps/editor/e2e` must stay green.
- The 0.1.7-parity invariant: existing `timing.ts` and `Overlay`/`hitTest` tests are untouched; any change to them is a red flag, not an update.

## Follow-ups this round deliberately creates

Element-to-element guides if centre/safe-area proves insufficient on real footage; timecode input in the Inspector; and — if nested-scroll complaints recur elsewhere — a shared scroll-region component instead of per-file styling.
