# Video-Aware Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop routing from sliding a graphic onto the picture in layouts that authored the two apart, and make routing frame-aware so it stops deciding 16:9 runs against portrait geometry.

**Architecture:** One pure helper, `videoObstacleFor(layout, frame)`, encodes three clauses read from the slot table and names no layout. `placeInFreeBand` takes that obstacle alongside the text regions. `routeAroundSourceText` takes a `frame` and threads it into every `layoutSlots` call. A new step in the fallback chain retries a blocked graphic inside a layout that intends overlap before the existing skip.

**Tech Stack:** TypeScript (ESM), vitest, zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-04-video-aware-routing-design.md`

## Global Constraints

- Node `>=22`, pnpm workspace. Never run `npm install`. **No dependency may be added in this plan** — every task is pure TypeScript over code that already exists.
- Relative imports carry **no file extension**. `packages/scenes/src/source-fit.ts` imports core through `@ossclip/core/browser`, not `@ossclip/core` — that subpath exists because this module is bundled into the Remotion render, which has no Node built-ins. Do not "fix" it.
- Console prefixes are load-bearing: `▸` progress/info, `✓` done, `✗` failure. Routing's per-scene lines are indented two spaces under a heading, matching `produce.ts`.
- Comments explain **why**, not what, and cite the findings section that forced the choice (`§26`, `§120`, `R25 §118`, `§32`).
- **Pure logic is separated from I/O.** Every function in this plan is pure over its arguments; no test needs a TTY, a filesystem, or a network.
- `tsconfig.base.json` sets `strict` and `noUncheckedIndexedAccess`. Indexed access yields `T | undefined` — handle it, never assert it away.
- **`packages/scenes/tsconfig.json` and `apps/cli/tsconfig.json` include only `src`**, so `pnpm typecheck` does NOT cover test files. A green typecheck is not evidence a test file's types are sound; read them.
- Every task ends with `pnpm test` and `pnpm typecheck` both green before the commit. The suite is 801 passing at the start of this plan. **Treat per-task test counts as a direction of travel, not an assertion** — a previous plan's counts drifted because tasks were reordered.
- **Backwards compatibility is required.** `routeAroundSourceText` and `placeInFreeBand` are exported from `@ossclip/scenes/geometry` and called from `apps/cli` and the editor. New parameters must be optional with defaults that preserve today's behaviour, so no call site outside this plan changes except the one the plan names.

## The obstacle table this plan is built on

Computed from the live slot table, both frames. Every task's expectations come from here:

| layout | portrait | landscape |
| --- | --- | --- |
| `full-bleed` | `null` — no graphic slot | `null` — no graphic slot |
| `video-top` | **obstacle** `y 0.00 h 0.42` | **obstacle** `y 0.00 h 0.42` |
| `pip-bubble` | **obstacle** `y 0.66 h 0.17` | **obstacle** `y 0.66 h 0.17` |
| `graphic-only` | `null` — `video.opacity === 0` | `null` — `video.opacity === 0` |
| `blurred-behind` | `null` — intends overlap (+0.36) | `null` — intends overlap (+0.36) |
| `lower-third` | `null` — intends overlap (+0.22) | `null` — intends overlap (+0.18) |
| `split-left` | **obstacle** `y 0.00 h 0.50` | `null` — intends overlap (+0.56) |
| `split-right` | **obstacle** `y 0.00 h 0.50` | `null` — intends overlap (+0.56) |

The split row is the whole reason the rule reads the frame instead of a list.

---

### Task 1: `videoObstacleFor` — the rule, as a pure function

**Files:**
- Modify: `packages/scenes/src/source-fit.ts` (add the export; touch nothing else)
- Test: `packages/scenes/test/video-obstacle.test.ts` (new)

**Interfaces:**
- Consumes: `layoutSlots`, `PORTRAIT_FRAME`, `FrameSize` from `./stage`; `Layout` from `@ossclip/core/browser`; the existing local `OccupiedRegion`.
- Produces: `videoObstacleFor(layout: Layout, frame?: FrameSize): OccupiedRegion | null`

- [ ] **Step 1: Write the failing test**

Create `packages/scenes/test/video-obstacle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Layout } from "@ossclip/core";
import { videoObstacleFor } from "../src/source-fit";
import { LANDSCAPE_FRAME, PORTRAIT_FRAME } from "../src/stage";

describe("videoObstacleFor (R27 §120)", () => {
  // Clause 2: the layout authored the graphic clear of the picture, and that
  // separation is the reason the layout exists — routing may not spend it.
  it("reports the video for a layout that authored them apart, in portrait", () => {
    expect(videoObstacleFor("video-top", PORTRAIT_FRAME)).toEqual({ y: 0, h: 0.42 });
    expect(videoObstacleFor("split-left", PORTRAIT_FRAME)).toEqual({ y: 0, h: 0.5 });
    expect(videoObstacleFor("split-right", PORTRAIT_FRAME)).toEqual({ y: 0, h: 0.5 });
  });

  // §120's own list was ["video-top", "split-left", "split-right"] and missed
  // this one: the bubble is fully visible and sits 0.1 below the graphic.
  // Deriving the rule from the slot table catches it for free.
  it("reports the video for pip-bubble, which the finding's list missed", () => {
    const obstacle = videoObstacleFor("pip-bubble", PORTRAIT_FRAME);
    expect(obstacle).not.toBeNull();
    expect(obstacle!.y).toBeCloseTo(0.66, 5);
    expect(obstacle!.h).toBeCloseTo(0.169, 3);
  });

  // Clause 3, and the reason the rule reads the frame rather than a list of
  // layout names: in 16:9 the splits separate by X with a full-height video,
  // so a Y-obstacle there would skip every scene in those layouts.
  it("reports nothing for the splits in landscape, where they separate by X", () => {
    expect(videoObstacleFor("split-left", LANDSCAPE_FRAME)).toBeNull();
    expect(videoObstacleFor("split-right", LANDSCAPE_FRAME)).toBeNull();
  });

  // Clause 3: these layouts exist to put a graphic over the picture.
  it("reports nothing for layouts that intend the overlap", () => {
    for (const frame of [PORTRAIT_FRAME, LANDSCAPE_FRAME]) {
      expect(videoObstacleFor("blurred-behind", frame)).toBeNull();
      expect(videoObstacleFor("lower-third", frame)).toBeNull();
    }
  });

  // Clause 1: an invisible video cannot be collided with.
  it("reports nothing for graphic-only, whose video is at zero opacity", () => {
    expect(videoObstacleFor("graphic-only", PORTRAIT_FRAME)).toBeNull();
    expect(videoObstacleFor("graphic-only", LANDSCAPE_FRAME)).toBeNull();
  });

  it("reports nothing for a layout with no graphic slot", () => {
    expect(videoObstacleFor("full-bleed", PORTRAIT_FRAME)).toBeNull();
  });

  it("defaults to portrait, so existing callers keep their answer", () => {
    expect(videoObstacleFor("split-left")).toEqual(videoObstacleFor("split-left", PORTRAIT_FRAME));
  });

  // Total over the enum: a new layout must get an answer, not a crash.
  it("answers for every layout in both frames", () => {
    const ALL: Layout[] = [
      "full-bleed", "video-top", "pip-bubble", "graphic-only",
      "blurred-behind", "lower-third", "split-left", "split-right",
    ];
    for (const layout of ALL) {
      for (const frame of [PORTRAIT_FRAME, LANDSCAPE_FRAME]) {
        expect(() => videoObstacleFor(layout, frame)).not.toThrow();
      }
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/scenes/test/video-obstacle.test.ts`
Expected: FAIL — `videoObstacleFor` is not exported from `../src/source-fit`.

- [ ] **Step 3: Implement**

In `packages/scenes/src/source-fit.ts`, add `PORTRAIT_FRAME` to the existing import from `./stage` if it is not already there, then add below `overlapFraction`:

```ts
/**
 * The video rect a routed graphic must stay clear of, or null when this
 * layout intends the graphic to sit on the picture (R27 §120).
 *
 * Three clauses, all read from the slot table, none naming a layout. Deriving
 * rather than listing is load-bearing twice: §120's own list of three missed
 * `pip-bubble`, whose fully visible bubble sits 0.1 below its graphic; and
 * clause 2's "in THIS frame" is what sends the landscape splits — which
 * separate by X, with a full-height video — to clause 3 instead of skipping
 * every scene in 16:9.
 *
 * No startSec/endSec: those exist on OccupiedRegion because burned-in titles
 * are transient (§32) and the video slot is not. Absent already means
 * "always" to `regionsDuring`.
 */
export function videoObstacleFor(
  layout: Layout,
  frame: FrameSize = PORTRAIT_FRAME,
): OccupiedRegion | null {
  const slots = layoutSlots(layout, undefined, [], frame);
  // A layout with no graphic slot never reaches the placer at all.
  if (!slots.graphic) return null;
  // Clause 1 — graphic-only parks the pip rect at zero opacity.
  if (slots.video.opacity === 0) return null;
  const g = slots.graphic;
  const v = slots.video.rect;
  const overlap = Math.min(g.y + g.h, v.y + v.h) - Math.max(g.y, v.y);
  // Clause 3 — they already share vertical space, so the layout means it.
  // `> 0` rather than `>= 0`: touching edges count as clear, matching the
  // `toBeLessThanOrEqual(0)` the §120 test asserts.
  if (overlap > 0) return null;
  // Clause 2 — authored apart, so routing must keep them apart.
  return { y: v.y, h: v.h };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run packages/scenes/test/video-obstacle.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: green, 8 more than before. No existing test should change — this task only adds an export.

- [ ] **Step 6: Commit**

```bash
git add packages/scenes/src/source-fit.ts packages/scenes/test/video-obstacle.test.ts
git commit -m "The rule: when the picture is an obstacle, read from the slot table

Three clauses and no layout names. An invisible video is not an obstacle;
a graphic and video authored Y-disjoint in THIS frame must stay that way;
anything else intends the overlap and routing stays free.

Deriving rather than listing earns its keep twice. §120's own list was
video-top, split-left and split-right — it missed pip-bubble, whose fully
visible bubble sits 0.1 below its graphic, where a slid graphic lands on
the speaker just as squarely. And clause 2 asks about THIS frame, so the
landscape splits — which separate by X behind a full-height video — fall to
clause 3 instead of having a Y-obstacle skip every scene in 16:9.

Nothing calls it yet."
```

---

### Task 2: `placeInFreeBand` takes the obstacle, and the pinned test is promoted

**Files:**
- Modify: `packages/scenes/src/source-fit.ts` (`placeInFreeBand` only)
- Modify: `packages/scenes/test/source-fit.test.ts` (the `it.fails` block, and `SEPARATED`)

**Interfaces:**
- Consumes: `videoObstacleFor` (Task 1).
- Produces: `placeInFreeBand(rect, regions, videoObstacle?: OccupiedRegion | null)` — third parameter optional, so every existing caller is unchanged.

- [ ] **Step 1: Promote the pinned test**

In `packages/scenes/test/source-fit.test.ts`, the final `describe` block currently ends with an `it.fails.each(...)`. Replace **the comment and that test** with:

```ts
  // Was `it.fails` until routing became video-aware (R27 §120). Promoted:
  // the placer now takes the video as an obstacle, so the separation these
  // layouts are built around survives routing.
  it.each(SEPARATED)("%s: routing keeps it clear", (layout) => {
    const moved = placeInFreeBand(
      layoutSlots(layout).graphic!,
      TITLE_BAND,
      videoObstacleFor(layout),
    );
    expect(moved).not.toBeNull();
    expect(overlap(layout, moved!)).toBeLessThanOrEqual(0);
  });
```

In the same block, extend `SEPARATED` and update the describe text:

```ts
describe("a routed graphic and the video it was authored clear of", () => {
  // pip-bubble joins §120's original three: the rule is derived from the slot
  // table, and it qualifies — a visible bubble 0.1 below the graphic.
  const SEPARATED = ["video-top", "split-left", "split-right", "pip-bubble"] as const;
```

Add `videoObstacleFor` to the imports from `../src/source-fit` at the top of the file.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/scenes/test/source-fit.test.ts`
Expected: FAIL. `placeInFreeBand` takes two arguments today, so the obstacle is ignored and the graphic still slides into the video.

Note: the sibling test `"%s: the authored slot is clear of the video to begin with"` should PASS immediately for `pip-bubble`. If it does not, stop and report BLOCKED — that would mean the rule and the slot table disagree, which is a design problem, not an implementation one.

- [ ] **Step 3: Implement**

Replace `placeInFreeBand` in `packages/scenes/src/source-fit.ts`:

```ts
export function placeInFreeBand(
  rect: { x: number; y: number; w: number; h: number },
  regions: readonly OccupiedRegion[],
  /**
   * The picture, when this layout authored the graphic clear of it (§120).
   * Optional and defaulted so every existing caller keeps its behaviour;
   * `videoObstacleFor` returns null for the layouts that intend the overlap.
   */
  videoObstacle?: OccupiedRegion | null,
): { x: number; y: number; w: number; h: number } | null {
  // freeBands merges overlapping blocked rects itself, so the obstacle can
  // simply join the text regions rather than needing to be reconciled.
  const blocked = videoObstacle ? [...regions, videoObstacle] : regions;
  const [tallest] = freeBands({ start: SAFE_AREA.top, end: 1 - SAFE_AREA.bottom }, blocked);
  if (!tallest) return null;
  const bandHeight = tallest.end - tallest.start;
  if (bandHeight < MIN_ROUTED_SLOT_H) return null;
  // Reserve room for captions inside the band before the graphic takes it.
  // Captions are mandatory and the graphic is not, so the graphic is what
  // yields — otherwise a routed graphic swallows the only free band and the
  // captions fall back on top of the source's own text.
  const reserved = CAPTION_BAND_H;
  const usable = bandHeight - reserved >= MIN_ROUTED_SLOT_H ? bandHeight - reserved : bandHeight;
  // Shrink to the band when the slot does not fit. A smaller graphic beats no
  // graphic, and since §23 every component scales its type to whatever slot it
  // is handed — so a shorter slot renders correctly rather than overflowing.
  const h = Math.min(rect.h, usable);
  return { ...rect, y: tallest.start + (usable - h) / 2, h };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run packages/scenes/test/source-fit.test.ts`
Expected: PASS, including the four `SEPARATED` cases now asserting rather than failing.

- [ ] **Step 5: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: green. The other `placeInFreeBand` callers pass two arguments and are unaffected.

- [ ] **Step 6: Commit**

```bash
git add packages/scenes/src/source-fit.ts packages/scenes/test/source-fit.test.ts
git commit -m "placeInFreeBand takes the picture as an obstacle, and §120 is pinned no longer

The it.fails that pinned the open defect becomes a real assertion, which is
exactly what its own comment asked for. pip-bubble joins the three layouts
§120 listed, because the rule is derived and it qualifies.

The obstacle simply joins the text regions: freeBands already merges
overlapping blocked rects, so nothing needed reconciling. The parameter is
optional so every existing caller keeps its behaviour, and the layouts that
intend the overlap get null from videoObstacleFor rather than a special
case here."
```

---

### Task 3: `routeAroundSourceText` learns the frame

**Files:**
- Modify: `packages/scenes/src/source-fit.ts` (`routeAroundSourceText` only)
- Test: `packages/scenes/test/routing-frame.test.ts` (new)

**Interfaces:**
- Consumes: `videoObstacleFor` (Task 1), the three-argument `placeInFreeBand` (Task 2).
- Produces: `routeAroundSourceText(cues, regions, frame?: FrameSize): SourceTextPlan`

- [ ] **Step 1: Write the failing test**

Create `packages/scenes/test/routing-frame.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SceneCue } from "@ossclip/core";
import { routeAroundSourceText } from "../src/source-fit";
import { LANDSCAPE_FRAME, PORTRAIT_FRAME, layoutSlots } from "../src/stage";

const cue = (
  id: string,
  layout: SceneCue["layout"],
  component: SceneCue["component"],
): SceneCue => ({ id, layout, component, props: {}, startSec: 0, endSec: 4 });

/** A burned-in title across the source's top band, as in §26. */
const TITLE_BAND = [{ y: 0.1, h: 0.3 }];

describe("routing reads the frame it is placing into (R27 §120)", () => {
  // The regression pin for the second defect §120's spec surfaced: produce
  // called routeAroundSourceText with no frame, and layoutSlots defaults to
  // portrait — so a 16:9 run routed against geometry that is not what
  // renders. If the argument is ever dropped at the call site again, the two
  // frames stop disagreeing and this fails.
  it("places a split-layout graphic differently in 16:9 than in 9:16", () => {
    const cues = [cue("a", "split-left", "StatCard")];
    const portrait = routeAroundSourceText(cues, TITLE_BAND, PORTRAIT_FRAME);
    const landscape = routeAroundSourceText(cues, TITLE_BAND, LANDSCAPE_FRAME);
    expect(portrait).not.toEqual(landscape);
  });

  it("defaults to portrait, so existing callers keep their behaviour", () => {
    const cues = [cue("a", "video-top", "StatCard")];
    expect(routeAroundSourceText(cues, TITLE_BAND)).toEqual(
      routeAroundSourceText(cues, TITLE_BAND, PORTRAIT_FRAME),
    );
  });

  // Clause 3 in the large: a Y-obstacle applied to a landscape split would
  // find the video covering the whole frame and skip every scene there.
  it("still places a landscape split scene rather than skipping it", () => {
    const plan = routeAroundSourceText([cue("a", "split-left", "StatCard")], TITLE_BAND, LANDSCAPE_FRAME);
    expect(plan.skipped).toEqual([]);
    expect(plan.cues).toHaveLength(1);
  });

  it("keeps a routed portrait graphic clear of the video slot", () => {
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], TITLE_BAND, PORTRAIT_FRAME);
    const placed = plan.cues[0];
    expect(placed).toBeDefined();
    const rect = placed!.graphicRect ?? layoutSlots(placed!.layout, undefined, [], PORTRAIT_FRAME).graphic!;
    const v = layoutSlots(placed!.layout, undefined, [], PORTRAIT_FRAME).video.rect;
    const overlap = Math.min(rect.y + rect.h, v.y + v.h) - Math.max(rect.y, v.y);
    expect(overlap).toBeLessThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/scenes/test/routing-frame.test.ts`
Expected: FAIL — `routeAroundSourceText` takes two arguments, so the frame is ignored and the two calls agree.

- [ ] **Step 3: Implement**

In `routeAroundSourceText`, add the parameter and thread it through. Change the signature:

```ts
export function routeAroundSourceText(
  cues: readonly SceneCue[],
  regions: readonly OccupiedRegion[],
  /**
   * The output frame. Portrait by default so every existing caller keeps its
   * behaviour — but a 16:9 run MUST pass its own, because the splits separate
   * by X there and the slot table answers differently (§120).
   */
  frame: FrameSize = PORTRAIT_FRAME,
): SourceTextPlan {
```

Inside the candidate loop, the slot lookup becomes frame-aware:

```ts
    for (const layout of candidates) {
      const slot = layoutSlots(layout, undefined, [], frame).graphic;
      if (!slot) continue;
      if (overlapFraction(slot, active) <= MAX_GRAPHIC_OVERLAP) {
        placed = layout;
        break;
      }
    }
```

And the moved-rect fallback resolves which layout supplied the base before asking for its obstacle — the base can come from `meta.defaultLayout` rather than the cue's own layout, and the obstacle must match whichever it was:

```ts
    // No layout is clear where it stands — so move the slot instead of losing
    // the scene. "Route around them, or skip" is the rule, and routing comes
    // first: the graphic keeps its size and slides into the largest free band.
    // Which layout supplies the base decides which video the obstacle is, so
    // resolve that FIRST rather than reading the slot twice.
    const baseLayout = layoutSlots(cue.layout, undefined, [], frame).graphic
      ? cue.layout
      : meta.defaultLayout;
    const base = layoutSlots(baseLayout, undefined, [], frame).graphic;
    const shifted = base
      ? placeInFreeBand(base, active, videoObstacleFor(baseLayout, frame))
      : null;
```

Everything below that line is unchanged in this task.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run packages/scenes/test/routing-frame.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: green. If a test in `source-fit.test.ts` now skips a scene that previously placed, do NOT relax it — that is the behaviour Task 4 exists to address. Report it and continue; Task 4 will resolve it.

- [ ] **Step 6: Commit**

```bash
git add packages/scenes/src/source-fit.ts packages/scenes/test/routing-frame.test.ts
git commit -m "Routing learns which frame it is placing into

produce called routeAroundSourceText with no frame, and layoutSlots defaults
to portrait — so an --aspect 16:9 run decided against geometry that is not
what renders. Captions have threaded the frame since R15; routing was the
only caller that never did.

The parameter defaults to portrait so no existing caller changes, and the
moved-rect fallback now resolves WHICH layout supplied the base slot before
asking for its obstacle: the base can come from the component's default
layout rather than the cue's own, and handing it the wrong video would
constrain the placer against a rect that is not there."
```

---

### Task 4: the overlay fallback, so the fix does not trade one defect for another

**Files:**
- Modify: `packages/scenes/src/source-fit.ts` (`SourceTextPlan` and the tail of `routeAroundSourceText`)
- Test: `packages/scenes/test/source-fit.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `videoObstacleFor` (Task 1), `placeInFreeBand` (Task 2), the frame parameter (Task 3).
- Produces: `SourceTextPlan.overlaid: Array<{ id: string; from: Layout; to: Layout }>`

**Why this task exists.** Adding an obstacle strictly shrinks the free space, so strictly more scenes reach the skip than before. R25 §118 shipped under-delivery accounting because missing graphics are a known pain, so a fix that silently drops more of them is not a fix.

**The mechanism, stated precisely because it is easy to get wrong.** The candidate loop at the top already tries the component's `altLayouts` and picks the first whose *authored* slot is clear of text — so if `blurred-behind`'s slot were clear, it would already have been chosen and this step would never run. What this step adds is different: it runs `placeInFreeBand` **inside** an overlay layout, where `videoObstacleFor` returns null. That is strictly more room than the previous step had, which is exactly why it can succeed where the previous step failed.

- [ ] **Step 1: Write the failing test**

Append to `packages/scenes/test/source-fit.test.ts`:

```ts
describe("falling back to a layout that intends the overlap (R27 §120)", () => {
  // Text across the band a video-top graphic would route into. Its own slot
  // is blocked, and the band left over collides with the video — so before
  // §120 this scene placed on the picture, and after the obstacle landed it
  // would have been skipped. blurred-behind blurs 22px and dims 0.55 for
  // exactly this case, and StatCard already declares it as an alternate.
  const BLOCKING = [
    { y: 0.06, h: 0.16 },
    { y: 0.46, h: 0.34 },
  ];

  it("moves the scene to an overlay layout rather than dropping it", () => {
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], BLOCKING);
    expect(plan.skipped).toEqual([]);
    expect(plan.cues).toHaveLength(1);
    expect(plan.overlaid[0]).toMatchObject({ id: "a", from: "video-top" });
    const to = plan.overlaid[0]!.to;
    expect(videoObstacleFor(to)).toBeNull();
  });

  it("reports the move separately from a source-text relayout", () => {
    // The reason differs: this graphic moved because of the PICTURE, and
    // saying "source text in the way" would be a false explanation.
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], BLOCKING);
    expect(plan.relayouts).toEqual([]);
    expect(plan.overlaid).toHaveLength(1);
  });

  it("still skips when even the overlay layouts are covered in text", () => {
    // The floor must hold: the fallback may not resurrect a scene that has
    // genuinely nowhere legal to go.
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], [{ y: 0, h: 1 }]);
    expect(plan.cues).toEqual([]);
    expect(plan.overlaid).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ id: "a" });
  });

  it("skips a component that declares no overlay alternate", () => {
    // TitleCard defaults to pip-bubble — itself a separated layout under
    // clause 2 — and its altLayouts is []. Nowhere blessed to fall back to,
    // and routing must not invent a placement the registry has not approved.
    const plan = routeAroundSourceText([cue("a", "pip-bubble", "TitleCard")], [{ y: 0, h: 1 }]);
    expect(plan.overlaid).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });

  it("leaves overlaid empty on a clean source", () => {
    const plan = routeAroundSourceText([cue("a", "video-top", "StatCard")], []);
    expect(plan.overlaid).toEqual([]);
  });
});
```

Add `videoObstacleFor` and `routeAroundSourceText` to this file's imports if they are not already there.

**Before writing the implementation, verify the fixture.** Run the first test and read what actually happens. `BLOCKING` is chosen to leave `video-top`'s own slot covered and the remaining free band colliding with the video — if it does not, adjust the two rects until it does and say so in your report. A fixture that passes for the wrong reason is worse than a failing one.

The registry values these fixtures depend on are already verified: `StatCard` is `video-top` with `altLayouts: ["blurred-behind"]`, and `TitleCard` is `pip-bubble` with `altLayouts: []`. Worth knowing that `ScreenshotFrame` — the component that landed across a speaker's face in the motivating take — is also `video-top` with `["blurred-behind"]`, so this fallback is exactly the path that case now takes.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/scenes/test/source-fit.test.ts`
Expected: FAIL — `plan.overlaid` is undefined.

- [ ] **Step 3: Add the field**

In `SourceTextPlan`:

```ts
export interface SourceTextPlan {
  cues: SceneCue[];
  /** Scenes moved to a layout whose slot is clear. */
  relayouts: Array<{ id: string; from: Layout; to: Layout }>;
  /** Scenes whose graphic was repositioned into a free band. */
  moved: Array<{ id: string; y: number; h: number }>;
  /**
   * Scenes moved to a layout that INTENDS a graphic over the picture, because
   * no band was clear of both the source's text and the video (§120). Kept
   * separate from `relayouts` because the reason differs, and a run that
   * quietly changes a scene's visual character should say which happened.
   */
  overlaid: Array<{ id: string; from: Layout; to: Layout }>;
  /** Scenes dropped because no layout had a free slot. */
  skipped: Array<{ id: string; reason: string }>;
}
```

Add `const overlaid: SourceTextPlan["overlaid"] = [];` beside the other accumulators, include `overlaid` in the early return for `regions.length === 0`, and in the final `return`.

- [ ] **Step 4: Add the fallback step**

In `routeAroundSourceText`, between the `if (shifted) { … }` block and the `skipped.push(...)` line:

```ts
    // Adding the video as an obstacle strictly shrinks the free space, so
    // strictly more scenes would reach the skip below than before §120 — and
    // R25 §118 shipped under-delivery accounting because missing graphics are
    // a known pain. Before losing the scene, try the layouts this component
    // ALREADY declares that intend a graphic over the picture.
    //
    // Note this is not the candidate loop again: there, an alternate had to be
    // clear where it was authored. Here the graphic is free to slide within
    // the alternate, because clause 3 means its video is not an obstacle —
    // strictly more room, which is why it can succeed where the step above
    // failed.
    //
    // Drawn from the registry's altLayouts rather than a global list of
    // overlay layouts: seven systems are keyed to the closed component enum
    // and four fail SILENTLY on an unknown value, so routing must not invent
    // a placement the registry has not blessed.
    let overlay: { layout: Layout; rect: { x: number; y: number; w: number; h: number } } | null =
      null;
    for (const alt of meta.altLayouts ?? []) {
      if (videoObstacleFor(alt, frame) !== null) continue;
      const slot = layoutSlots(alt, undefined, [], frame).graphic;
      if (!slot) continue;
      const moved2 = placeInFreeBand(slot, active, null);
      if (moved2) {
        overlay = { layout: alt, rect: moved2 };
        break;
      }
    }
    if (overlay) {
      overlaid.push({ id: cue.id, from: cue.layout, to: overlay.layout });
      out.push({ ...cue, layout: overlay.layout, graphicRect: overlay.rect });
      continue;
    }
```

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm vitest run packages/scenes/test/source-fit.test.ts`
Expected: PASS, including any test Task 3 turned into a skip.

- [ ] **Step 6: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/scenes/src/source-fit.ts packages/scenes/test/source-fit.test.ts
git commit -m "Before losing a graphic to the picture, try a layout built to hold one

Adding the video as an obstacle strictly shrinks the free space, so strictly
more scenes would have reached the skip — and R25 §118 shipped
under-delivery accounting precisely because missing graphics are a known
pain. A fix that trades a ScreenshotFrame across a face for a graphic that
silently vanishes is not much of a fix.

This is not the candidate loop again. There, an alternate had to be clear
where it was AUTHORED. Here the graphic may slide within the alternate,
because clause 3 says that layout's video is not an obstacle — strictly more
room, which is why it succeeds where the step above failed.

Drawn from the component's own declared altLayouts rather than a global list
of overlay layouts: seven systems are keyed to the closed component enum and
four fail silently on an unknown value.

Reported as `overlaid`, not folded into `relayouts` — that reason string
says 'source text in the way', which would be false here, and a run that
quietly changes a scene's look from video-top to blurred-and-dimmed should
say which happened."
```

---

### Task 5: the call site, and the reporting line

**Files:**
- Modify: `apps/cli/src/produce.ts` (the `routeAroundSourceText` call and the lines that print its plan)

**Interfaces:**
- Consumes: everything above.
- Produces: no new exports.

- [ ] **Step 1: Read the call site**

Run: `grep -n "routeAroundSourceText" -A 14 apps/cli/src/produce.ts`

The call is around `produce.ts:940` and the `frame` it needs is already computed around `produce.ts:236` as `const frame = landscape ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };`. **Verify both line numbers by reading rather than trusting them** — this file has been edited since the plan was written.

- [ ] **Step 2: Pass the frame and report the new hop**

```ts
  // The frame matters here: the splits separate by X in 16:9, so routing that
  // assumed portrait decided against geometry that is not what renders (§120).
  const routed = routeAroundSourceText(assembled, textRegions, frame);
  for (const r of routed.relayouts) {
    console.log(`  ▸ scene ${r.id}: ${r.from} → ${r.to} (source text in the way)`);
  }
  for (const o of routed.overlaid) {
    console.log(
      `  ▸ scene ${o.id}: ${o.from} → ${o.to} (no room clear of the video — ` +
        `the graphic now sits on a blurred backdrop)`,
    );
  }
```

Leave the existing `moved` and `skipped` loops exactly as they are.

- [ ] **Step 3: Full suite**

Run: `pnpm test && pnpm typecheck`
Expected: green.

- [ ] **Step 4: Prove it on a real render, both aspects**

A green unit suite does not show a graphic landing on a face. Run the pipeline twice and paste the real output:

```bash
pnpm fixture
pnpm ossclip produce fixtures/<generated>.mp4 --source-is-edited --no-render
pnpm ossclip produce fixtures/<generated>.mp4 --source-is-edited --no-render --aspect 16:9
```

Both must complete. Report any `▸ scene …` routing lines each printed, and confirm the two runs' `render-props.json` differ in at least one scene's layout or `graphicRect` — that is the frame parameter doing visible work rather than being accepted and ignored.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/produce.ts
git commit -m "produce tells routing which frame it is rendering into

One argument, and it was already sitting three hundred lines up: `frame` is
computed for the render and every other consumer takes it. Routing was the
one that did not, so a 16:9 run placed graphics against portrait geometry.

The overlay hop gets its own line. `relayouts` prints 'source text in the
way', which is a false explanation for a graphic that moved because of the
picture — and a run that changes a scene from video-top to blurred-and-dimmed
should say so rather than let the change turn up in the render."
```

---

## Self-Review

**Spec coverage.** Clause 1/2/3 → Task 1. The `frame` parameter and its threading → Task 3. `placeInFreeBand` taking the obstacle → Task 2. The promoted `it.fails` and `pip-bubble` joining `SEPARATED` → Task 2. The overlay fallback and `overlaid` → Task 4. The reporting line → Task 5. The landscape-splits test, the `graphic-only` clause-1 test, and the frame regression pin → Tasks 1 and 3. Every test the spec's Testing section names has a home.

**One thing the spec left implicit, now explicit in Task 4.** The spec described the fallback as "retry on a layout that intends overlap", which reads like a plain relayout — and a plain relayout would be dead code, because the candidate loop already tries `altLayouts` against text. Task 4 states the actual mechanism: it is a `placeInFreeBand` retry *inside* the alternate, with no video obstacle, which is strictly more room. An implementer who missed that would write a step that never fires and a test that passes for the wrong reason.

**Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries its code. Task 4's fixture is the one value not computed in advance, and the plan says so out loud and tells the implementer to verify it rather than trust it.

**Type consistency.** `videoObstacleFor` is defined in Task 1 and consumed by name in Tasks 2, 3 and 4. `OccupiedRegion`, `FrameSize`, `Layout` and `SourceTextPlan` all pre-exist. `placeInFreeBand`'s third parameter is added in Task 2 and passed in Tasks 3 and 4. `SourceTextPlan.overlaid` is added in Task 4 and read in Task 5.

**Ordering.** Task 2 depends on Task 1; Task 3 on both; Task 4 on all three; Task 5 on Task 4. Strictly sequential, no reordering available — which also means the per-task test counts cannot drift the way a previous plan's did.
