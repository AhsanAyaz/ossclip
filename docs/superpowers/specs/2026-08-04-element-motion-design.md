# Elements that arrive — entrances, and a caption transition that never fired

*Design. Companion to `packages/scenes/src/SceneLayer.tsx` and `packages/scenes/src/CaptionTrack.tsx`.*

## Why

A user reported the graphics as "very choppy" and asked for motion blur, sending two reference clips to show the difference. The clips are a synthetic demo — a hard black/green edge sweeping across a 20-frame, 0.67s, 1920×1080 test pattern — measuring 2 partial-value columns at the edge without blur and 27 with it. They demonstrate what motion blur *is*. They are not ossclip output.

Asked which elements, she was precise:

> Caption + elements, for example when a half black box appears it doesn't have motion blur, similarly when the picture in picture view is activated the mask should have motion blur as well. Text animations also should have motion blur. Every element which has movement basically.

The last sentence is the diagnosis, read the other way round. **Those elements have no movement.** Motion blur cannot fix a thing that does not move.

### What the code does today (superseded — see Correction)

| element | animation |
| --- | --- |
| 8 of 9 scene components | **none** — `grep -c 'useCurrentFrame\|spring\|interpolate\|@keyframes'` over `StatCard.tsx` returns `0` |
| `ScreenshotFrame` | the only animated component: an 8-second `1.0 → 1.08` drift, not an entrance |
| scene **exit** | `SceneLayer.tsx:66` — 18px `translateY` + fade over `EXIT_SEC = 0.3` |
| caption active word | `transform: scale(1.08)` with `transition: "transform 60ms linear"` |

So a `StatCard` pops into existence on one frame, sits perfectly still, then slides out. The "half black box appearing" she described is that pop. Motion blur applied to it would smear a teleport: `<Trail>` ghosts N copies of a jump, and `<CameraMotionBlur>` samples a sub-frame trajectory that does not exist — at N× the render cost, on a pipeline that already re-encodes a mezzanine.

### The caption transition is a real bug

`CaptionTrack.tsx:127` is the only CSS transition anywhere in the render path. Remotion renders by seeking to a frame and screenshotting it; a CSS transition needs wall-clock time to elapse, which never happens in that model. The caption's scale-up therefore **animates in the editor's `<Player>`, which plays in real time, and snaps instantly in the rendered file.**

That is an editor/output divergence — the class of defect this project has been bitten by before, and the reason `overrides.json` exists as a separate layer at all.

### A comment that is not true (retracted — see Correction below)

`SceneLayer.tsx:60` reads: *"Components own their ENTRANCES (staggered rises, per element); the exit lives here at the layer…"*. They do not. One component animates, and what it animates is a slow drift rather than an entrance. The comment describes a design that was never built.

### Correction (found during execution)

The table above was wrong in its central claim, and the error survived into
the first implementation. Every component HAS an entrance: all nine stagger
their content in through `anim.ts`'s `useEnter` springs (damping 200, 0.5s),
present since Phase 1. The survey missed it twice in the same direction —
`anim.ts` is a `.ts` file excluded by a `*.tsx` glob, and components call
`useEnter()`, which contains none of the grepped primitive names.

What never animated was the over-video **scrim**: it sits outside the
components' springs and appeared at full opacity on the cue's first frame —
almost certainly the reported "half black box appears". The layer entrance
is therefore scoped to the scrim alone; a layer-wide entrance would stack a
second animation on the springs, compounding opacity and ~44px of travel.
The caption fix and the CSS-transition tripwire are unaffected.

## Scope

**In:** an entrance for the over-video scrim — the one element that never animated (see Correction); the entrance/exit pair clamped so they cannot overlap on a short cue; the caption emphasis driven by frame instead of CSS; and the layer comment corrected to describe what exists.

**Out, deliberately:**

- **Motion blur.** Not rejected on principle — deferred because it is the wrong first move. Once elements traverse real distance, the places it could legitimately help are the pip-mask lerp and the zoom push, both of which already move continuously. Re-ask on real footage after this ships. `@remotion/motion-blur` is not currently a dependency.
- **60fps.** Doubles render time for a pipeline whose slowest stage is already encoding. An 18px move over 9 frames is a peak step of 3.78px, tapering — smooth at 30.
- **Changing the components' existing staggered entrances.** They exist (`anim.ts` `useEnter`, Phase 1 — see Correction) and are untouched; re-tuning them is an editorial round of its own.
- **Changing any component's internals.** Zero component files are touched.

## Architecture

### The entrance is the scrim's, and only the scrim's (superseded the layer wrapper)

The first implementation wrapped every cue in a layer-wide `EntranceRise`,
believing the components static. They are not (see Correction), so that
wrapper double-animated content — layer fade + 18px stacked under each
component's 0.5s spring stagger, compounding opacity and ~44px of travel.
The entrance is now a single `Scrim` component: one absolutely-positioned
div carrying the band's visual style AND its own opacity/rise, on the
exit's curve and `entranceExitSec`'s clamped seconds. One div deliberately —
an ancestor wrapper at partial opacity forms a Backdrop Root and empties
the backdrop-filter, so the frost would snap on when the ease hit 1
instead of fading in with the tint. The exit stays layer-wide and
unchanged.

### One curve, both ends

The exit fades out while sliding **down** 18px (`translateY((1 - ease) * 18)` as `ease → 0`). The scrim's entrance is its mirror: it starts 18px low and rises to rest. Rises in, settles, sinks out — and both ends share the exit's existing ease-out quad, `p * (2 - p)`, so there is one curve in the file rather than two that can drift apart.

`ENTER_SEC = 0.3`, matching `EXIT_SEC`. At 30fps that is 9 frames for 18px — a peak step of 3.78px, tapering, which is why this reads smooth without any blur.

### Neither end may eat the other

`MIN_SCENE_SEC` is 1.2s and the two animations total 0.6s, so there is normally slack. But nothing in the type system says a cue is at least 1.2s, and if one were shorter the entrance and exit would overlap — their opacities would multiply and the graphic would visibly dip in the middle of its own life.

So both durations are resolved together from the cue's length:

```ts
/**
 * The entrance and exit seconds for a cue, shrunk proportionally when the cue
 * is too short to hold both. Resolved together rather than clamped
 * independently: two independent clamps can still sum past the duration, and
 * the failure that produces — opacities multiplying into a dip halfway
 * through a graphic's life — is invisible in a still and obvious in motion.
 */
export function entranceExitSec(
  durationSec: number,
  enterSec?: number,
  exitSec?: number,
): { enterSec: number; exitSec: number }
```

Pure, in its own module, so the arithmetic is tested without rendering a frame.

**Scope of this guarantee (correction):** it covers the scrim's entrance and
the layer exit — the two ends `entranceExitSec` governs. The components'
content springs (`anim.ts`, 0.5s + stagger) predate it and do not read it,
so content can still overlap the exit on ordinary cues: the boundary is
`duration < 0.8s + maxStaggerDelay`, and a five-item `BulletList` at the
editor's 1.2s floor starts its last bullet's spring one frame after the
exit begins — that bullet peaks at 41% opacity and never arrives. Known,
pre-existing, and deliberately not fixed in this round; deriving the
springs' delays from the cue duration is a design round of its own.

### The caption emphasis is driven by frame

`CaptionTrack.tsx` already computes `t = line.start + frame / fps` and the word's own `w.start`, so the progress is available without new plumbing:

```ts
const held = Math.max(w.end, w.start + 0.12);
const inWindow = t >= w.start && t <= held;
// Ramp from the word's OWN start, then hold. Same ease-out quad as the
// layer animations — one curve for every motion in the render.
const p = inWindow ? Math.min(1, (t - w.start) / CAPTION_POP_SEC) : 0;
const pop = p * (2 - p);
```

`transform: scale(${1 + 0.08 * pop})`, and the `transition` line is deleted.

`CAPTION_POP_SEC` is `0.133` — 4 frames at 30fps. The original 60ms is 1.8 frames, so honouring it exactly would animate over two frames and still read as a step. Four frames stays word-synced and reads as a rise. The colour change stays keyed to `inWindow`, unchanged: colour has no in-between state worth animating and lerping it would fight the stroke.

## Error handling

No new failure modes. Every value is a clamped interpolation over a finite duration, and `entranceExitSec` returns non-negative seconds for any input including zero and negative durations — a degenerate cue renders nothing rather than throwing (every animated value is at its frame-0 state, which for a one-frame cue is fully transparent), which is the correct outcome for something that should not exist.

The animations are visual only. They do not touch `production.json`, `render-props.json`, `overrides.json`, the cue timing, or the grounding checks. A re-produce and a re-render both reach the same document they do today.

## Testing

`entranceExitSec` is pure and carries the logic worth testing:

- a normal cue gets the full `ENTER_SEC`/`EXIT_SEC`;
- a cue exactly `ENTER_SEC + EXIT_SEC` long gets both unshrunk;
- a shorter cue gets both scaled proportionally, and **their sum never exceeds the duration** — the property, asserted directly, not inferred from two examples;
- a zero or negative duration returns zeros rather than negatives.

For the components, the risk is regression rather than the animation itself: `SceneLayer` and `CaptionTrack` have existing tests, and the layer's exit and scrim components must not disturb what they assert about layout, anchors or hit-testing. The editor's `Overlay.test.ts` and `hitTest.test.ts` cover drag targets that sit inside these elements — an entrance that changed layout rather than transform would break them, which is exactly the alarm we want.

One assertion is worth adding directly for the bug: **no CSS `transition` may appear in the render path.** A grep-style test over `packages/scenes/src` pins the thing that was wrong, and stops the next person reintroducing an animation that works in the editor and vanishes in the file.

## The follow-up this earns

Once elements move, re-ask her whether it still reads as choppy. If it does, the remaining candidates are the pip-mask lerp and the zoom push — both genuinely traverse distance, both are a much smaller surface than "every element", and that is the conversation where motion blur is the right answer rather than the first guess.
