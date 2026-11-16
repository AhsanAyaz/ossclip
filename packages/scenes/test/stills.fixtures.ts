import type { Layout, SceneComponentId } from "@ossclip/core/browser";

/**
 * What `pnpm stills` renders (plan Task 3; scripts/render-scene-stills.ts).
 * Each fixture is drawn in 16:9 and 9:16 at every `atSec`, in the explainer
 * theme over the look's slate background, and written to `__stills__/` as
 * `<component>-<name>-<16x9|9x16>-<atSec>s.png`. The stills are committed
 * for the author to look at, not compared (plan decision 6).
 *
 * Props are parsed by the component's registry schema before rendering, so a
 * fixture must be props a planner could produce. Pattern components add one
 * sparse and one dense fixture each (the Task 4 checklist, item 9): the
 * dense one at every field's maximum length and count.
 *
 * Not a test file (no `.test.`), so vitest does not collect it; the shape is
 * restated in renderer's `StillFixture`, which this must stay assignable to.
 */
export interface StillFixture {
  component: SceneComponentId;
  name: string;
  props: unknown;
  /** Seconds into the scene to photograph; the scene runs to max + 2 s. */
  atSec: number[];
  /** Defaults to the component's registry `defaultLayout`. */
  layout?: Layout;
}

export const STILL_FIXTURES: StillFixture[] = [
  // The harness's own check: an existing component, settled (its entrance
  // springs take 0.5 s and the caption starts 6 frames later). The text
  // carries 1s on purpose — Inter's 1 has a flag and no foot, Arial's has a
  // foot — so the still shows at a glance whether the bundled font loaded.
  {
    component: "StatCard",
    name: "settled",
    props: { label: "Stars in 11 days", value: "+1,214", caption: "From 1 launch post" },
    atSec: [1.5],
  },
  // CardRow (plan Task 4). No word timings in a still, so the cards build at
  // `beatStarts`: 0.25, 0.95, 1.65, 2.35 s, each popping for 0.35 s. Sparse
  // at 0.4 s catches the first card mid-pop; dense at 1.8 s has two cards
  // settled, the third mid-overshoot and the fourth not yet in. Settled is
  // after the last pop AND the highlight's bump (last start + 0.35 + 0.3).
  {
    component: "CardRow",
    name: "sparse",
    props: { cards: [{ text: "Draft" }, { text: "Review" }] },
    atSec: [0.4, 1.5],
  },
  {
    component: "CardRow",
    name: "dense",
    // Every cap: 18-character titles, 24-character sub-lines, four cards,
    // an icon on each, and the highlight on the third.
    props: {
      cards: [
        { text: "WRITE THE TESTS OK", sub: "pnpm vitest run --watch!", icon: "check" },
        { text: "MEASURE EVERY RUN!", sub: "tokens, seconds and cost", icon: "bolt" },
        { text: "Review the diff ok", sub: "git diff main...HEAD -w!", icon: "code" },
        { text: "Ship it on Monday!", sub: "npm publish --tag latest", icon: "terminal" },
      ],
      highlight: 2,
    },
    atSec: [1.8, 3.5],
  },
];
