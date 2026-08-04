# Element Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every graphic an entrance mirroring the exit that already exists, make the caption's active-word emphasis actually animate in the render, and pin the bug class (CSS transitions in a seek-and-screenshot renderer) with a test.

**Architecture:** A new pure module `packages/scenes/src/motion.ts` owns the two durations, the shared ease, and `entranceExitSec` — the resolver that shrinks both ends together so they can never overlap on a short cue. `SceneLayer.tsx` gains an `EntranceRise` wrapper outside the existing `ExitFade`, both reading their duration from the resolver. `CaptionTrack.tsx` swaps its dead CSS transition for frame-driven interpolation over the same ease.

**Tech Stack:** TypeScript (ESM), React/Remotion 4, vitest, fast-check (already a root devDependency).

**Spec:** `docs/superpowers/specs/2026-08-04-element-motion-design.md`

## Global Constraints

- Node `>=22`, pnpm workspace. Never `npm install`. **No dependency may be added anywhere in this plan** — `@remotion/motion-blur` is explicitly out of scope.
- Relative imports carry **no file extension**. `packages/scenes/src` imports core via `@ossclip/core/browser` where it does today — do not change any import of that shape.
- Comments explain **why**, not what, and cite the findings section or spec that forced the choice.
- **Zero component files may be touched.** The entrance lives at the layer; that is the design's central decision. A diff touching `packages/scenes/src/components/` is a plan violation.
- **Pure logic is separated from I/O.** No test may require a TTY, a network, a real `$HOME`, or a rendered frame.
- `tsconfig.base.json` sets `strict` and `noUncheckedIndexedAccess`. `packages/scenes/tsconfig.json` includes only `src`, so **`pnpm typecheck` does not cover test files** — read test types rather than trusting a green typecheck.
- Every task ends with `pnpm test` and `pnpm typecheck` green before its commit. The suite is **825 passing** at plan start. Counts are a direction of travel, not an assertion.
- The animations are visual only: `production.json`, `render-props.json`, `overrides.json`, cue timing, and grounding must be byte-identical before and after. No task touches anything outside `packages/scenes/src/{motion.ts,SceneLayer.tsx,CaptionTrack.tsx}` and `packages/scenes/test/`.

---

### Task 1: `motion.ts` — the durations, the ease, and the resolver

**Files:**
- Create: `packages/scenes/src/motion.ts`
- Modify: `packages/scenes/src/SceneLayer.tsx` (delete its local `EXIT_SEC`, import from `./motion` — nothing else in this task)
- Test: `packages/scenes/test/motion.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ENTER_SEC = 0.3`, `EXIT_SEC = 0.3`, `CAPTION_POP_SEC = 0.133`
  - `easeOutQuad(p: number): number`
  - `entranceExitSec(durationSec: number, enterSec?: number, exitSec?: number): { enterSec: number; exitSec: number }`

- [ ] **Step 1: Write the failing test**

Create `packages/scenes/test/motion.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CAPTION_POP_SEC, ENTER_SEC, EXIT_SEC, easeOutQuad, entranceExitSec } from "../src/motion";

describe("easeOutQuad", () => {
  it("is the exit's existing curve: 0→0, 1→1, fast start", () => {
    expect(easeOutQuad(0)).toBe(0);
    expect(easeOutQuad(1)).toBe(1);
    expect(easeOutQuad(0.5)).toBe(0.75);
  });
});

describe("entranceExitSec", () => {
  it("gives a normal cue the full durations", () => {
    // MIN_SCENE_SEC is 1.2 and both ends total 0.6 — the common case has slack.
    expect(entranceExitSec(1.2)).toEqual({ enterSec: ENTER_SEC, exitSec: EXIT_SEC });
  });

  it("gives a cue exactly as long as both ends the full durations, unshrunk", () => {
    expect(entranceExitSec(ENTER_SEC + EXIT_SEC)).toEqual({
      enterSec: ENTER_SEC,
      exitSec: EXIT_SEC,
    });
  });

  it("shrinks both proportionally when the cue cannot hold both", () => {
    const { enterSec, exitSec } = entranceExitSec(0.3);
    expect(enterSec).toBeCloseTo(0.15, 10);
    expect(exitSec).toBeCloseTo(0.15, 10);
  });

  // The property itself, not two examples of it: two INDEPENDENT clamps can
  // still sum past the duration, and that failure — entrance and exit
  // overlapping, opacities multiplying into a dip mid-life — is invisible in
  // a still and obvious in motion.
  it("never lets the two ends sum past the duration", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 60, noNaN: true }), (durationSec) => {
        const { enterSec, exitSec } = entranceExitSec(durationSec);
        expect(enterSec).toBeGreaterThanOrEqual(0);
        expect(exitSec).toBeGreaterThanOrEqual(0);
        expect(enterSec + exitSec).toBeLessThanOrEqual(durationSec + 1e-9);
      }),
    );
  });

  it("returns zeros for a degenerate cue rather than negatives", () => {
    // A zero or negative duration should not exist, but a graphic that
    // renders static beats one that throws mid-render.
    expect(entranceExitSec(0)).toEqual({ enterSec: 0, exitSec: 0 });
    expect(entranceExitSec(-1)).toEqual({ enterSec: 0, exitSec: 0 });
  });
});

describe("the caption pop duration", () => {
  it("is four frames at 30fps — long enough to read as a rise, not a step", () => {
    expect(CAPTION_POP_SEC * 30).toBeCloseTo(4, 0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/scenes/test/motion.test.ts`
Expected: FAIL — cannot resolve `../src/motion`.

- [ ] **Step 3: Implement**

Create `packages/scenes/src/motion.ts`:

```ts
/**
 * The layer's motion constants and the one curve every animated thing in the
 * render shares. One module rather than per-file literals so the entrance,
 * the exit, and the caption pop cannot drift onto different curves — the
 * design's "reads as designed" claim (R16 §69) depends on them agreeing.
 */

/** Seconds a graphic spends arriving. Mirrors EXIT_SEC — one number, both ends. */
export const ENTER_SEC = 0.3;

/** Seconds a graphic spends leaving. Matches LAYOUT_TRANSITION_SEC's order of
 * magnitude so the graphic departs WITH the video slot's morph — the reported
 * failure was the split view closing first and the card then blinking out. */
export const EXIT_SEC = 0.3;

/**
 * Seconds the caption's active word takes to reach its 1.08 emphasis. Four
 * frames at 30fps: the original CSS transition said 60ms, which is 1.8
 * frames — honouring it exactly would still read as a step.
 */
export const CAPTION_POP_SEC = 0.133;

/** The exit's existing ease — fast start, soft landing. */
export const easeOutQuad = (p: number): number => p * (2 - p);

/**
 * The entrance and exit seconds for a cue, shrunk proportionally when the cue
 * is too short to hold both. Resolved together rather than clamped
 * independently: two independent clamps can still sum past the duration, and
 * the failure that produces — entrance and exit overlapping, their opacities
 * multiplying into a dip halfway through a graphic's life — is invisible in
 * a still and obvious in motion.
 */
export function entranceExitSec(
  durationSec: number,
  enterSec: number = ENTER_SEC,
  exitSec: number = EXIT_SEC,
): { enterSec: number; exitSec: number } {
  if (durationSec <= 0) return { enterSec: 0, exitSec: 0 };
  const total = enterSec + exitSec;
  if (total <= durationSec) return { enterSec, exitSec };
  const k = durationSec / total;
  return { enterSec: enterSec * k, exitSec: exitSec * k };
}
```

In `packages/scenes/src/SceneLayer.tsx`, delete the local `EXIT_SEC` constant (lines 34-37, the comment moves to `motion.ts` — it already has) and add to the imports:

```ts
import { EXIT_SEC } from "./motion";
```

Nothing else in `SceneLayer.tsx` changes in this task; `ExitFade` keeps reading `EXIT_SEC` exactly as before.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run packages/scenes/test/motion.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: green, ~832 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/scenes/src/motion.ts packages/scenes/src/SceneLayer.tsx packages/scenes/test/motion.test.ts
git commit -m "motion.ts: one curve, two durations, and a resolver that keeps them apart

The entrance about to be built and the exit that already exists must agree
on their curve and their scale, or the cut stops reading as designed
(R16 §69). One module owns ENTER_SEC, EXIT_SEC, the caption pop duration,
and the ease, so per-file literals cannot drift.

entranceExitSec shrinks both ends together when a cue is too short to hold
them. Together, not independently: two independent clamps can still sum
past the duration, and that failure — entrance and exit overlapping, their
opacities multiplying into a dip halfway through a graphic's life — is
invisible in a still and obvious in motion. The property is asserted with
fast-check rather than two examples.

SceneLayer's EXIT_SEC moves here unchanged. Nothing animates differently
yet."
```

---

### Task 2: `EntranceRise` — the arrival that mirrors the departure

**Files:**
- Modify: `packages/scenes/src/SceneLayer.tsx` only
- Test: existing suite (see Step 3 for why no new test file)

**Interfaces:**
- Consumes: `ENTER_SEC`, `EXIT_SEC`, `easeOutQuad`, `entranceExitSec` (Task 1).
- Produces: nothing exported — `EntranceRise` is module-private, like `ExitFade`.

- [ ] **Step 1: Rewrite the false comment and both wrappers**

In `packages/scenes/src/SceneLayer.tsx`, replace the `ExitFade` block (the comment at line 59-65 and the component at 66-90) with:

```tsx
/**
 * Uniform entrance and exit for every graphic, both at the layer (R16 §69).
 * Every component arriving and leaving the same way is what makes the cut
 * read as designed — and the layer is the only place that can guarantee it:
 * a per-component convention is a silent trap for every component added
 * later. (An earlier comment here claimed components owned staggered
 * per-element entrances. None did — eight of nine rendered static, which a
 * user reported as "choppy" and asked to fix with motion blur. Blur cannot
 * fix a thing that does not move; arriving can.)
 *
 * Both read their seconds from `entranceExitSec`, which shrinks the pair
 * proportionally on a cue too short to hold both — overlapping ends multiply
 * their opacities into a mid-life dip. Inside the cue's Sequence, so local
 * frame 0 is the cue's own start.
 */
const wrapperStyle = (ease: number): React.CSSProperties => ({
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  opacity: ease,
  // 18px over ENTER_SEC/EXIT_SEC (9 frames at 30fps) is 2px a frame — the
  // move reads smooth without any blur, which was the actual ask.
  transform: ease < 1 ? `translateY(${(1 - ease) * 18}px)` : undefined,
});

const EntranceRise: React.FC<{ durationInFrames: number; children: React.ReactNode }> = ({
  durationInFrames,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { enterSec } = entranceExitSec(durationInFrames / fps);
  const p = enterSec <= 0 ? 1 : Math.min(1, Math.max(0, frame / fps / enterSec));
  return <div style={wrapperStyle(easeOutQuad(p))}>{children}</div>;
};

const ExitFade: React.FC<{ durationInFrames: number; children: React.ReactNode }> = ({
  durationInFrames,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { exitSec } = entranceExitSec(durationInFrames / fps);
  const remaining = (durationInFrames - frame) / fps;
  const p = exitSec <= 0 ? 1 : Math.min(1, Math.max(0, remaining / exitSec));
  return <div style={wrapperStyle(easeOutQuad(p))}>{children}</div>;
};
```

Update the import from `./motion` to `{ easeOutQuad, entranceExitSec }` (`ENTER_SEC`/`EXIT_SEC` are no longer referenced directly in this file — drop them from the import if Task 1 added them).

**Note the entrance rises from below like the exit sinks below** — both use the same `wrapperStyle`, so at `ease < 1` both sit `(1-ease)*18px` low. Arrives up into place, departs down out of it: one style function, mirror-symmetric by construction.

- [ ] **Step 2: Wrap the render**

In the JSX, wrap the existing `ExitFade` (which wraps the scrim + component):

```tsx
<EntranceRise durationInFrames={durationInFrames}>
  <ExitFade durationInFrames={durationInFrames}>
    …existing children unchanged…
  </ExitFade>
</EntranceRise>
```

The scrim stays INSIDE both wrappers — it must rise and fade with the card it backs, or the frosted band arrives before its content.

- [ ] **Step 3: Why no new test file, and what guards this instead**

`EntranceRise`/`ExitFade` are thin frame→style maps over `entranceExitSec` and `easeOutQuad`, both exhaustively tested in Task 1; a DOM test would re-test React. What CAN regress is structure: the editor's hit-testing walks `data-edit-scene`/`data-edit-id` through these wrappers. `apps/editor/test/Overlay.test.ts`, `hitTest.test.ts`, and `packages/scenes/test/editable.test.ts` already pin that. Run them by name and confirm:

Run: `pnpm vitest run apps/editor/test/Overlay.test.ts apps/editor/test/hitTest.test.ts packages/scenes/test/editable.test.ts`
Expected: PASS, unchanged counts.

- [ ] **Step 4: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: green, same count as after Task 1.

- [ ] **Step 5: Commit**

```bash
git add packages/scenes/src/SceneLayer.tsx
git commit -m "Every graphic arrives the way it leaves

EntranceRise mirrors ExitFade: same 18px, same ease-out quad, one shared
style function so the symmetry is by construction rather than by review.
Nine components gain an entrance; zero component files change — the layer
is the only place that can guarantee every future component arrives too.

The comment claiming components owned staggered per-element entrances is
gone. None did: eight of nine rendered static, which a user reported as
choppy and asked to fix with motion blur. Blur cannot fix a thing that
does not move.

Both wrappers now read their seconds from entranceExitSec, so a cue too
short to hold both ends shrinks them together instead of letting their
opacities multiply into a mid-life dip. The scrim stays inside both — the
frosted band must not arrive before the card it backs."
```

---

### Task 3: The caption pop becomes real, and the bug class gets a tripwire

**Files:**
- Modify: `packages/scenes/src/CaptionTrack.tsx` (the word-span style only)
- Test: `packages/scenes/test/motion.test.ts` (append the render-path scan)

**Interfaces:**
- Consumes: `CAPTION_POP_SEC`, `easeOutQuad` (Task 1).
- Produces: nothing exported.

- [ ] **Step 1: Write the failing tripwire test**

Append to `packages/scenes/test/motion.test.ts`:

```ts
describe("no CSS transitions in the render path", () => {
  // Remotion renders by seeking to a frame and screenshotting it — no
  // wall-clock time passes, so a CSS transition animates in the editor's
  // real-time <Player> and SNAPS in the rendered file. CaptionTrack shipped
  // exactly that: a 60ms transition the render never played. This scan pins
  // the bug CLASS, not the one instance.
  it("finds no `transition:` style property under packages/scenes/src", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          const src = readFileSync(path, "utf8");
          // The CSS property shape (`transition: "…"`), not the word — prose
          // like "layout transitions" in comments must not trip this.
          if (/\btransition\s*:\s*["'`]/.test(src)) offenders.push(entry.name);
        }
      }
    };
    walk(fileURLToPath(new URL("../src", import.meta.url)));
    expect(offenders).toEqual([]);
  });
});
```

Add to the test file's imports (`import.meta.url`, not `__dirname` — this repo's tests resolve paths that way, see `docs-install.test.ts:11`):

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/scenes/test/motion.test.ts`
Expected: FAIL — `offenders` contains `CaptionTrack.tsx`. If it names any OTHER file, stop and report: that is a second instance of the bug the spec did not know about.

- [ ] **Step 3: Implement**

In `packages/scenes/src/CaptionTrack.tsx`, add to the imports:

```ts
import { CAPTION_POP_SEC, easeOutQuad } from "./motion";
```

Replace the word-span block (currently `const active = t >= w.start && …` through the `style={{…}}`):

```tsx
        {line.words.map((w, i) => {
          const held = Math.max(w.end, w.start + 0.12);
          const inWindow = t >= w.start && t <= held;
          // Ramp from the word's OWN start, then hold — frame-driven, because
          // the CSS transition this replaces only ever animated in the
          // editor's real-time <Player>; the render seeks and screenshots,
          // so no wall-clock time passes and the scale snapped (spec
          // 2026-08-04). Same ease as the layer's entrance and exit.
          const p = inWindow ? Math.min(1, (t - w.start) / CAPTION_POP_SEC) : 0;
          const pop = easeOutQuad(p);
          return (
            <span
              key={i}
              // The editor double-click retypes a word in place; the RAW text
              // rides along because the rendered text may be CTA-decorated,
              // and the retype's stale-guard must compare against the truth.
              data-caption-word={wordOffset + i}
              data-caption-text={w.text}
              style={{
                display: "inline-block",
                // Words are individually hit-testable for the editor (the
                // parent layer stays pointer-events: none); harmless in the
                // render, where nothing dispatches events.
                pointerEvents: "auto",
                transform: pop > 0 ? `scale(${1 + 0.08 * pop})` : "scale(1)",
                // Colour stays keyed to the window, not the ramp: colour has
                // no in-between worth animating, and lerping it would fight
                // the stroke.
                color: inWindow ? activeColor : "white",
              }}
            >
```

The `transition: "transform 60ms linear"` line is deleted. Everything after the `style` object (the `ctaDisplay` child, the closing tags) is unchanged.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run packages/scenes/test/motion.test.ts`
Expected: PASS — the scan finds no offenders, and every Task 1 test still holds.

- [ ] **Step 5: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: green, ~833 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/scenes/src/CaptionTrack.tsx packages/scenes/test/motion.test.ts
git commit -m "The caption pop animates in the file, not just in the editor

CaptionTrack carried the only CSS transition in the render path. Remotion
renders by seeking to a frame and screenshotting it — no wall-clock time
passes, so the 60ms scale-up played in the editor's real-time Player and
snapped in the rendered video. Editor and output disagreed, the exact
divergence class this project keeps paying for.

Now frame-driven: ramp from the word's own start over CAPTION_POP_SEC
(4 frames — the original 60ms is 1.8 frames and would still read as a
step), on the same ease as the layer's entrance and exit. Colour stays
keyed to the window; it has no in-between worth animating.

A scan test pins the bug CLASS: no `transition:` style property may appear
anywhere under packages/scenes/src. The next editor-only animation fails
in the suite instead of in somebody's export."
```

---

## Self-Review

**Spec coverage.** Uniform entrance at the layer → Task 2. One curve both ends → Task 1's `easeOutQuad` consumed by both wrappers and the caption. Overlap-proofing → Task 1's resolver + property test, wired in Task 2. Caption frame-driven over 4 frames → Task 3. False comment corrected → Task 2's rewrite. No-CSS-transition tripwire → Task 3. Zero component files touched → enforced as a Global Constraint. Motion blur, 60fps, stagger → all out of scope per spec, no task touches them.

**Placeholder scan.** Every step carries its real code. The one judgment left to the implementer is flagged explicitly (Task 3 Step 2: a second offender is a finding, not noise).

**Type consistency.** `entranceExitSec`, `easeOutQuad`, `ENTER_SEC`, `EXIT_SEC`, `CAPTION_POP_SEC` defined in Task 1; Tasks 2 and 3 import by those exact names. `wrapperStyle` is local to Task 2's file. No cross-task signature drift possible — three tasks, one producer.

**Honest limits.** No headless way to see the animation here: rendering needs ffmpeg + a browser, and the editor's Player needs eyes. The verification story is: the math is property-tested, the structure is pinned by existing hit-test suites, and the divergence class is tripwired. The visual judgment call — does 0.3s/18px read well — ships to the user who reported it, which is the point of the release.
