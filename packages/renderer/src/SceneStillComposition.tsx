import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { defaultTheme } from "@ossclip/core/browser";
import { BundledFonts, SceneLayer, VideoStage } from "@ossclip/scenes";
import { standInSvg, stillCue, type SceneStillProps } from "./scene-still";

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
export const SceneStillComposition: React.FC<SceneStillProps> = (p) => {
  const cue = stillCue(p);
  return (
    <AbsoluteFill style={{ backgroundColor: p.background }}>
      <BundledFonts theme={p.theme} />
      {/* `solid` and `bubble` (§163): the real VideoStage — backdrop fade,
          picture rect, circle mask, crop and head zoom — with the stand-in
          footage as its child where a render mounts EdlVideo. No stage at
          all otherwise, so every other still draws the tree it always did. */}
      {p.backdrop && p.face ? (
        <VideoStage cues={[cue]} theme={p.theme} face={p.face}>
          <SpeakerStandIn face={p.face} />
        </VideoStage>
      ) : null}
      <SceneLayer cues={[cue]} theme={p.theme} />
    </AbsoluteFill>
  );
};

/**
 * The stand-in footage: an image of the source's shape, styled the way
 * EdlVideo styles its <video> — filling the slot, `object-fit: cover`,
 * windowed by the stage's object-position variables — so the stage crops it
 * exactly as it would crop the take. Remotion's `Img` holds the frame until
 * the image has decoded, so a still never photographs an empty picture.
 */
const SpeakerStandIn: React.FC<{ face: NonNullable<SceneStillProps["face"]> }> = ({ face }) => (
  <Img
    src={`data:image/svg+xml;utf8,${encodeURIComponent(standInSvg(face))}`}
    style={{
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover",
      objectPosition: "var(--ossclip-obj-x, 50%) var(--ossclip-obj-y, 50%)",
    }}
  />
);
