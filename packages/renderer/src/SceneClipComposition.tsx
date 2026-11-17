import React from "react";
import { AbsoluteFill } from "remotion";
import { defaultTheme } from "@ossclip/core/browser";
import { BundledFonts, SceneLayer } from "@ossclip/scenes";
import type { SceneClipProps } from "./scene-clip";

export type { SceneClipProps } from "./scene-clip";

export const SCENE_CLIP_ID = "scene-clip";

export const defaultSceneClipProps: SceneClipProps = {
  cue: {
    id: "scene-0",
    kind: "graphic",
    layout: "video-top",
    component: "StatCard",
    props: { label: "METRIC", value: "+0%", inverted: false },
    startSec: 0,
    endSec: 3,
  },
  theme: defaultTheme,
  settings: { width: 1920, height: 1080, fps: 30 },
};

/**
 * One scene alone on a transparent frame — a kit clip (§162, design 3.2).
 *
 * NOTHING behind the layer: not a `transparent` background, no element at
 * all, so every pixel the scene does not paint keeps the page's zero alpha
 * through the PNG frames into the ProRes 4444 file (`clipRenderOptions`).
 * The scene goes through the real `SceneLayer`, as a still does, so its
 * slot, fit scale and entrance and exit are the full render's; `flatPanel`
 * swaps the footage-dependent scrim for a flat panel, the one thing a clip
 * with no footage cannot reproduce.
 *
 * `<BundledFonts>` holds the render until Inter and DejaVu Sans Mono load,
 * as in ProductionComposition, so a clip never bakes in the fallback stack.
 */
export const SceneClipComposition: React.FC<SceneClipProps> = (p) => (
  <AbsoluteFill>
    <BundledFonts theme={p.theme} />
    <SceneLayer cues={[p.cue]} theme={p.theme} flatPanel />
  </AbsoluteFill>
);
