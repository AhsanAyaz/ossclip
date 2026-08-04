# Elements that arrive — entrances, and a caption transition that never fired

*Design. Companion to `packages/scenes/src/SceneLayer.tsx` and `packages/scenes/src/CaptionTrack.tsx`.*

## Why

A user reported the graphics as "very choppy" and asked for motion blur, sending two reference clips to show the difference. The clips are a synthetic demo — a hard black/green edge sweeping across a 20-frame, 0.67s, 1920×1080 test pattern — measuring 2 partial-value columns at the edge without blur and 27 with it. They demonstrate what motion blur *is*. They are not ossclip output.

Asked which elements, she was precise:

> Caption + elements, for example when a half black box appears it doesn't have motion blur, similarly when the picture in picture view is activated the mask should have motion blur as well. Text animations also should have motion blur. Every element which has movement basically.

The last sentence is the diagnosis, read the other way round. **Those elements have no movement.** Motion blur cannot fix a thing that does not move.

### What the code does today

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

### A comment that is not true

`SceneLayer.tsx:60` reads: *"Components own their ENTRANCES (staggered rises, per element); the exit lives here at the layer…"*. They do not. One component animates, and what it animates is a slow drift rather than an entrance. The comment describes a design that was never built.

## Scope

**In:** a uniform entrance at the layer, mirroring the existing exit; both clamped so they cannot overlap on a short cue; the caption emphasis driven by frame instead of CSS; and the false comment corrected to describe what exists.

**Out, deliberately:**

- **Motion blur.** Not rejected on principle — deferred because it is the wrong first move. Once elements traverse real distance, the places it could legitimately help are the pip-mask lerp and the zoom push, both of which already move continuously. Re-ask on real footage after this ships. `@remotion/motion-blur` is not currently a dependency.
- **60fps.** Doubles render time for a pipeline whose slowest stage is already encoding. An 18px move over 9 frames is 2px/frame — smooth at 30.
- **Per-element staggered entrances.** A `BulletList` landing item by item is richer and is what the false comment promised, but it is nine components to write, nine curves to keep in sync, and a silent trap for every component added later. The uniform wrapper fixes all nine at once; stagger is an editorial round of its own, to be re-asked once real footage judges the uniform version.
- **Changing any component's internals.** Zero component files are touched.

## Architecture

### The entrance is a layer wrapper, symmetric with the exit

`SceneLayer.tsx` already argues the case for the exit: *"the exit lives here at the layer because it is the cue's END doing the animating, and every component leaving the same way is what makes the cut read as designed."* Arriving is the same argument at the other end of the cue.

```tsx
<Sequence from={from} durationInFrames={durationInFrames}>
  <EntranceRise durationInFrames={durationInFrames}>   {/* new */}
    <ExitFade durationInFrames={durationInFrames}>
      <Component … />
    </ExitFade>
  </EntranceRise>
</Sequence>
```

Nine components gain an entrance; zero component files change.

### One curve, both ends

The exit fades out while sliding **down** 18px (`translateY((1 - ease) * 18)` as `ease → 0`). The entrance is its mirror: it starts 18px low and rises to rest. Rises in, settles, sinks out — and both ends share the exit's existing ease-out quad, `p * (2 - p)`, so there is one curve in the file rather than two that can drift apart.

`ENTER_SEC = 0.3`, matching `EXIT_SEC`. At 30fps that is 9 frames for 18px — 2px per frame, which is why this reads smooth without any blur.

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

No new failure modes. Every value is a clamped interpolation over a finite duration, and `entranceExitSec` returns non-negative seconds for any input including zero and negative durations — a degenerate cue renders static rather than throwing, which is the correct outcome for something that should not exist.

The animations are visual only. They do not touch `production.json`, `render-props.json`, `overrides.json`, the cue timing, or the grounding checks. A re-produce and a re-render both reach the same document they do today.

## Testing

`entranceExitSec` is pure and carries the logic worth testing:

- a normal cue gets the full `ENTER_SEC`/`EXIT_SEC`;
- a cue exactly `ENTER_SEC + EXIT_SEC` long gets both unshrunk;
- a shorter cue gets both scaled proportionally, and **their sum never exceeds the duration** — the property, asserted directly, not inferred from two examples;
- a zero or negative duration returns zeros rather than negatives.

For the components, the risk is regression rather than the animation itself: `SceneLayer` and `CaptionTrack` have existing tests, and the wrapper must not disturb what they assert about layout, anchors or hit-testing. The editor's `Overlay.test.ts` and `hitTest.test.ts` cover drag targets that sit inside these elements — an entrance that changed layout rather than transform would break them, which is exactly the alarm we want.

One assertion is worth adding directly for the bug: **no CSS `transition` may appear in the render path.** A grep-style test over `packages/scenes/src` pins the thing that was wrong, and stops the next person reintroducing an animation that works in the editor and vanishes in the file.

## The follow-up this earns

Once elements move, re-ask her whether it still reads as choppy. If it does, the remaining candidates are the pip-mask lerp and the zoom push — both genuinely traverse distance, both are a much smaller surface than "every element", and that is the conversation where motion blur is the right answer rather than the first guess.
