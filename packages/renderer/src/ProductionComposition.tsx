import React from "react";
import { AbsoluteFill, staticFile } from "remotion";
import { CaptionTrack, EdlVideo, SceneLayer, VideoStage } from "@ossclip/scenes";
import {
  defaultTheme,
  type CaptionLine,
  type KeptSpan,
  type RenderSettings,
  type SceneCue,
  type Theme,
} from "@ossclip/core/browser";

/**
 * Plain-JSON props, fully precomputed by the pipeline. The composition stays
 * dumb: no cutting logic, no source-time anywhere — output time only.
 * Stage order (PHASE1 §1): backdrop+video slot → scene graphics → captions.
 * The EDL video (and its audio) is mounted continuously across every scene.
 */
export interface ProductionCompProps {
  /** File name inside the render's public dir (or an absolute http(s) URL). */
  videoFileName: string;
  spans: KeptSpan[];
  captionLines: CaptionLine[];
  sceneCues: SceneCue[];
  theme: Theme;
  settings: RenderSettings;
  outputDurationSec: number;
}

export const defaultProductionProps: ProductionCompProps = {
  videoFileName: "",
  spans: [],
  captionLines: [],
  sceneCues: [],
  theme: defaultTheme,
  settings: { width: 1080, height: 1920, fps: 30 },
  outputDurationSec: 1,
};

export const ProductionComposition: React.FC<ProductionCompProps> = ({
  videoFileName,
  spans,
  captionLines,
  sceneCues,
  theme,
}) => {
  if (!videoFileName) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "#111",
          color: "#888",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "monospace",
          fontSize: 40,
        }}
      >
        no production loaded
      </AbsoluteFill>
    );
  }
  const src = /^https?:\/\//.test(videoFileName) ? videoFileName : staticFile(videoFileName);
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <VideoStage cues={sceneCues} theme={theme}>
        <EdlVideo src={src} spans={spans} />
      </VideoStage>
      <SceneLayer cues={sceneCues} theme={theme} />
      <CaptionTrack lines={captionLines} cues={sceneCues} activeColor={theme.accent} />
    </AbsoluteFill>
  );
};
