import React from "react";
import { AbsoluteFill } from "remotion";
import { defaultTheme } from "@ossclip/core/browser";
import { BundledFonts, SceneLayer } from "@ossclip/scenes";
import { stillCue, type SceneStillProps } from "./scene-still";

export type { SceneStillProps } from "./scene-still";

export const SCENE_STILL_ID = "scene-still";

export const defaultSceneStillProps: SceneStillProps = {
  component: "StatCard",
  props: { label: "METRIC", value: "+0%", inverted: false },
  layout: "video-top",
  theme: defaultTheme,
  frame: { width: 1080, height: 1920 },
  background: defaultTheme.bg,
  durationSec: 3,
};

/**
 * One scene over a solid background, for `pnpm stills` (plan Task 3). The
 * scene goes through the real `SceneLayer` with one cue rather than being
 * mounted bare, so a still shows what a render shows: the layout's slot, the
 * fit scale, the scrim where the component draws one. The background stands
 * in for the speaker's video — the pattern scenes draw over it with no scrim
 * (decision 1), so a flat field is the honest worst case for contrast.
 *
 * `<BundledFonts>` is mounted as ProductionComposition mounts it, so an
 * explainer still waits on Inter and DejaVu Sans Mono instead of
 * photographing the fallback stack.
 */
export const SceneStillComposition: React.FC<SceneStillProps> = (p) => (
  <AbsoluteFill style={{ backgroundColor: p.background }}>
    <BundledFonts theme={p.theme} />
    <SceneLayer cues={[stillCue(p)]} theme={p.theme} />
  </AbsoluteFill>
);
