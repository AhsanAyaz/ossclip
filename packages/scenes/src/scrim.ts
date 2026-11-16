import { SCENE_REGISTRY, type SceneComponentId, type SceneCue } from "@ossclip/core/browser";

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
