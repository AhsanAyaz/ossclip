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
];
