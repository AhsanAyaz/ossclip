# Video-aware routing — the picture is an obstacle too

*Design for R27 §120. Companion to `packages/scenes/src/source-fit.ts` and the slot table in `packages/scenes/src/stage.ts`.*

## Why

Routing negotiates with the source's own burned-in text and with nothing else. It never reads `layoutSlots(...).video`. So when no layout is clear where it stands, `placeInFreeBand` slides the graphic into the tallest band the *text* leaves free — and that band is frequently the picture. The graphic wins, because `SceneLayer` renders after `VideoStage`. On the take that motivated the finding, that put a `ScreenshotFrame` across the speaker's face.

The defect is already pinned, in `packages/scenes/test/source-fit.test.ts:149`:

```ts
it.fails.each(SEPARATED)("%s: routing keeps it clear (KNOWN BAD)", (layout) => {
  const moved = placeInFreeBand(layoutSlots(layout).graphic!, TITLE_BAND);
  expect(moved).not.toBeNull();
  expect(overlap(layout, moved!)).toBeLessThanOrEqual(0);
});
```

`it.fails` is the reminder: when routing becomes video-aware this starts erroring, and the test gets promoted to a real assertion.

Overlap is not wrong everywhere, which is why this cannot be a blanket "never touch the video" rule. `blurred-behind` blurs the picture 22px and dims it 0.55 *so that* a graphic can sit on it. `full-bleed` and `lower-third` overlay a band on purpose. Those layouts exist to put a graphic over the video.

### The second defect, found while reading this one

`apps/cli/src/produce.ts:940` calls:

```ts
const routed = routeAroundSourceText(assembled, textRegions);
```

No frame. `routeAroundSourceText` calls `layoutSlots(layout)` internally, which defaults to `PORTRAIT_FRAME`. **So on an `--aspect 16:9` run, routing decides against portrait geometry that is not what renders.** The two defects share a root cause — routing does not know the frame it is placing into — and they cannot be fixed independently without baking the portrait assumption deeper.

The geometry diverges by more than a nudge:

| | video rect | graphic rect | Y-overlap |
| --- | --- | --- | --- |
| portrait `split-left` | `y 0 → 0.5` | `y 0.58 → 0.78` | −0.08, clear |
| landscape `split-left` | `y 0 → 1` | `y 0.2 → 0.76` | +0.56, total |

In 16:9 the splits separate video and graphic **by X**. A Y-band obstacle model applied there would conclude the video covers the whole frame and skip every scene in those layouts.

Captions are already correct: `CaptionTrack.tsx:187` passes `frame` into `captionAnchorAvoiding`. Routing is the only caller that does not.

## Scope

**In:** a video-obstacle rule for routing, derived from the slot table rather than a list of layout names; a `frame` parameter on `routeAroundSourceText` threaded into every `layoutSlots` call; a fallback that retries a blocked graphic on a layout that intends overlap before giving up; the reporting line that says which happened; and the tests, including the promotion of the pinned `it.fails`.

**Out, deliberately:**

- **Per-frame or face-aware avoidance.** The video slot is a rectangle; where the speaker's face sits inside it is `measureFace`'s business, and framing is per-window rather than per-frame today (a standing ROADMAP deferral). Avoiding the slot is the correct granularity for this round.
- **X-axis routing.** `placeInFreeBand` slides vertically and keeps `x`. Making it 2-D is a larger change and buys nothing for the layouts that are actually broken — the landscape splits fall out correctly under clause 3 below without it.
- **Changing the slot table.** No layout's authored geometry moves.
- **Widening `--source-is-edited`.** The scan that triggers routing stays behind that flag, exactly as §120 left it.

## The rule

Three clauses, each read from the slot table for the frame in play. No clause names a layout.

1. **`video.opacity === 0` → the video is not an obstacle.** `graphic-only` parks the pip rect at zero opacity; an invisible video cannot be collided with.
2. **Authored graphic and video are Y-disjoint in this frame → routing must preserve that.** The separation is the reason the layout exists, so routing may not spend it. "Y-disjoint" means the vertical overlap of the two authored rects is `<= 0` — touching edges count as clear, matching the `toBeLessThanOrEqual(0)` the pinned test already asserts.
3. **Otherwise the layout intends overlap → routing stays free vertically.**

Deriving beats listing, and this is not a stylistic preference — it is load-bearing twice:

- The finding's own `SEPARATED` list is `["video-top", "split-left", "split-right"]`. The rule also catches **`pip-bubble`**: its video is `PIP_RECT` at `y 0.660 → 0.829`, fully visible, and its graphic ends at `y 0.560` — a 0.100 gap the finding never enumerated. Sliding a graphic down onto the speaker's bubble is the same bug with a different layout name.
- Clause 2 says "in this frame", so landscape splits fall to clause 3 automatically. A hardcoded list would have carried the portrait assumption into 16:9 and skipped every split scene there.

## Architecture

### `routeAroundSourceText` learns the frame

```ts
export function routeAroundSourceText(
  cues: readonly SceneCue[],
  regions: readonly OccupiedRegion[],
  frame: FrameSize = PORTRAIT_FRAME,
): SourceTextPlan
```

Every internal `layoutSlots(layout)` becomes `layoutSlots(layout, undefined, [], frame)`. The default keeps every existing caller and test compiling unchanged; `produce.ts:940` passes the `frame` already computed at `produce.ts:236`.

### The video obstacle is computed, then handed to the placer

A small pure helper, beside the rule it encodes:

```ts
/**
 * The video rect a routed graphic must stay clear of, or null when this
 * layout intends the graphic to sit on the picture.
 *
 * Derived from the slot table rather than a list of layout names: the list
 * in §120 missed pip-bubble, whose visible bubble sits 0.1 below its graphic,
 * and a list would also have carried portrait's answer into 16:9, where the
 * splits separate by X and a Y-obstacle would skip every scene.
 */
export function videoObstacleFor(
  layout: Layout,
  frame: FrameSize,
): OccupiedRegion | null
```

The obstacle carries no `startSec`/`endSec`. Burned-in text is transient, which is why `OccupiedRegion` has those fields at all — the video slot is not. An absent window already means "always" to `regionsDuring`, so the video obstacle is correctly permanent without a special case.

`placeInFreeBand` then takes the obstacle alongside the text regions:

```ts
export function placeInFreeBand(
  rect: { x: number; y: number; w: number; h: number },
  regions: readonly OccupiedRegion[],
  videoObstacle?: OccupiedRegion | null,
): { x: number; y: number; w: number; h: number } | null
```

It concatenates the obstacle onto `regions` before calling `freeBands`. That is the entire behavioural change in the placer — the caption reservation, the `MIN_ROUTED_SLOT_H` floor, and the shrink-to-band all keep working against a tighter constraint set, unchanged.

The optional third parameter is what lets the pinned test be *promoted* rather than rewritten: it keeps calling `placeInFreeBand(slot, TITLE_BAND)` and starts passing an obstacle.

### The fallback chain

Extended, not replaced. Only the third step is new:

```
candidate layouts clear where authored          unchanged
  ↓ none
slide the graphic into a free band              now also avoids the video, under clause 2
  ↓ no band clear of both
retry on the component's own altLayouts
that fall under clause 3                        NEW
  ↓ still blocked by source text
skip, and report                                unchanged
```

The retry draws from `SCENE_REGISTRY[component].altLayouts` — the layouts that component is already known to render correctly in — filtered to those where `videoObstacleFor` returns null. It is not a global list of overlay layouts. Most components defaulting to `video-top` already declare `blurred-behind`; a component declaring none (`altLayouts: []`) is genuinely out of options and skips, which is correct.

This matters because the closed component enum is load-bearing: seven systems are keyed to it and four fail *silently* on an unknown value. Routing must not invent a placement the registry has not blessed.

Without this step the fix would trade one visible defect for another. Adding an obstacle strictly shrinks the free space, so strictly more scenes would hit "nowhere legal" and be dropped — and R25 §118 shipped under-delivery accounting precisely because missing graphics are a known pain. A graphic that survives on a blurred, dimmed backdrop is a better outcome than a graphic that vanishes, and a much better one than a `ScreenshotFrame` across a face.

### Reporting

`SourceTextPlan.relayouts` already carries `{ id, from, to }` and `produce.ts:941-943` already prints it as `source text in the way`. That reason is now wrong for the new hop, which fires because the graphic would have landed on the *picture*. Rather than widen the tuple for one string, the plan gains a parallel list:

```ts
/** Scenes moved to an overlay layout because no band was clear of the video. */
overlaid: Array<{ id: string; from: Layout; to: Layout }>;
```

printed with its own line. A run that quietly changes a scene's visual character should say so — `blurred-behind` is a different look from `video-top`, and the beat sheet did not pick it.

## Error handling

There is no new failure mode. Every path already terminates in one of: placed as authored, relayout, moved rect, or skip-with-reason. The change adds one more relayout opportunity before the existing skip, and the skip's reason string stays accurate — a scene reaching it now had no clear band *and* no overlay alternate.

`videoObstacleFor` reads only the slot table, which is total over the `Layout` enum, so it cannot throw. A layout with `graphic: null` (`full-bleed`) is skipped as a *candidate* — but that only rules it out as a destination, not as the cue's own layout, and the placer runs afterwards regardless. A `full-bleed` cue with a graphic borrows the default layout's slot geometry and reaches the placer like any other. `videoObstacleFor("full-bleed")` returns null on clause 0 (no graphic slot), which is the correct answer for it: the layout renders the picture full-frame and intends whatever sits on it. The obstacle must therefore be asked of the cue's own layout, never of the layout that donated the slot — the moved-rect path changes the rect, not the layout.

## Testing

In `packages/scenes/test/source-fit.test.ts`:

- **Promote the pinned test.** `it.fails.each(SEPARATED)` becomes `it.each(SEPARATED)`, passing the obstacle. Its comment about being deferred goes with it.
- **Add `pip-bubble` to `SEPARATED`.** It qualifies under clause 2 and the finding missed it; the existing "authored slot is clear to begin with" sibling should pass for it immediately, which is the check that the rule and the slot table agree.
- **Clause 1** — `graphic-only` returns no obstacle, so routing there is unconstrained by its zero-opacity pip.
- **Clause 3 in landscape** — `split-left`/`split-right` at `LANDSCAPE_FRAME` return no obstacle, and a routed graphic still places. This is the test that would have caught a hardcoded list: without it, the naive fix skips every split scene in 16:9 and nothing says so.
- **Clause 2 in portrait** — the same two layouts DO return an obstacle at `PORTRAIT_FRAME`. One rule, two answers, decided by the frame.
- **The fallback** — a `video-top` `StatCard` with text across the band it would route into lands on `blurred-behind` and appears in `overlaid`, rather than in `skipped`.
- **The floor still holds** — a source with text everywhere still skips, and still reports the existing reason. The fallback must not resurrect a scene that has genuinely nowhere to go.

In `apps/cli/test/` or alongside: one test that `routeAroundSourceText` given `LANDSCAPE_FRAME` produces different placements than given the portrait default, on the same cues. That is the regression pin for the frame bug itself — without it, dropping the argument at the call site again would be silent.

## Out of scope this round, worth writing down

Routing's `x` never moves, so a graphic narrower than the frame is never slid sideways out of a landscape split's video half. Under clause 3 that is by design for now: the layouts that separate by X already author their graphic in the free column, and routing only ever changes `y`. If a future finding shows a landscape graphic colliding horizontally, that is the round that makes `placeInFreeBand` two-dimensional.
