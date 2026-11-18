import { SCENE_REGISTRY, type SceneComponentId, type SceneCue } from "@ossclip/core/browser";
import { drawsSolidBackdrop } from "./stage";

/**
 * Layouts whose graphic slot sits over LIVE video (R20 §94). Everywhere else
 * the graphic lands on the stage background and the theme guarantees its
 * contrast; here the background is whatever pixels the footage happens to
 * show, and a typographic component (TitleCard, StrikethroughReveal) can land
 * white text on a bright wall. The slot gets a frosted scrim: theme-bg tint
 * over a backdrop blur. Slot-shaped rather than a broadcast bottom-gradient
 * so it FOLLOWS the box when the editor drags or resizes it.
 */
const OVER_VIDEO_LAYOUTS = new Set<SceneCue["layout"]>(["lower-third", "full-bleed"]);

/**
 * Whether a cue's graphic gets the frosted scrim (and, with it, the inset
 * that keeps type off the scrim's edge — SceneLayer).
 *
 * The layout decides whether there is live video behind the slot; the
 * COMPONENT decides whether it wants frosting at all (`scrim` in the
 * registry, spec 1.5's "per-component setting"). A transparent clip is drawn
 * to sit on the speaker, so a scrim would frost the very footage the clip was
 * made to show through (spec 1.4: "Full frame, no scrim"). Every component
 * that predates the flag leaves it unset and keeps the per-layout rule
 * exactly, which is what keeps runs without `--script` unchanged (G6).
 */
export function drawsScrim(layout: SceneCue["layout"], component: SceneComponentId): boolean {
  return OVER_VIDEO_LAYOUTS.has(layout) && SCENE_REGISTRY[component].scrim !== false;
}

/**
 * What sits behind a cue's slot: the frosted scrim, the kit's flat panel, or
 * nothing. SceneLayer insets the content for either of the first two.
 *
 * `flatPanel` is the clip kit's mode (§162, plan decision 2): a transparent
 * clip has no footage to frost and none of the blurred backdrop
 * `blurred-behind` draws, so bare type would land on whatever the author
 * puts under it in Resolve. Every component that is not full-frame and keeps
 * its scrim gets a flat panel instead, in every layout but two. A full-frame
 * component, or one that opts out of the scrim, was built to sit straight on
 * the speaker (spec 1.4) and gets nothing — in a kit clip there is no frost
 * either, since there is nothing behind it to blur. Core's `kit-plan.ts`
 * states the same rule for the report's "backdrop replaced by a flat panel"
 * note; the two are compared in scrim.test.ts.
 *
 * The two: `graphic-only` and `pip-bubble` clips carry the theme's solid
 * background themselves (§163, design 6; SceneClipComposition), so the
 * graphic already sits on a plain colour, as in the full render, where
 * neither layout draws a panel (design 2). A panel on top would be a second
 * box the full render never showed.
 *
 * Without `flatPanel` this is `drawsScrim` exactly, which is what keeps
 * produce, edit and cover renders unchanged.
 */
export type SlotBackdrop = "scrim" | "panel" | "none";

export function slotBackdrop(
  layout: SceneCue["layout"],
  component: SceneComponentId,
  flatPanel: boolean,
): SlotBackdrop {
  if (!flatPanel) return drawsScrim(layout, component) ? "scrim" : "none";
  if (drawsSolidBackdrop(layout)) return "none";
  const meta = SCENE_REGISTRY[component];
  return meta.fullFrame !== true && meta.scrim !== false ? "panel" : "none";
}
