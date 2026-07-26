import React from "react";
import { AbsoluteFill, staticFile } from "remotion";
import { CaptionTrack, EdlVideo } from "@ossclip/scenes";
import type { CaptionLine, KeptSpan, RenderSettings } from "@ossclip/core";

/**
 * Plain-JSON props, fully precomputed by the pipeline. The composition stays
 * dumb: no cutting logic, no source-time anywhere — output time only.
 */
export interface ProductionCompProps {
  /** File name inside the render's public dir (or an absolute http(s) URL). */
  videoFileName: string;
  spans: KeptSpan[];
  captionLines: CaptionLine[];
  settings: RenderSettings;
  outputDurationSec: number;
}

export const defaultProductionProps: ProductionCompProps = {
  videoFileName: "",
  spans: [],
  captionLines: [],
  settings: { width: 1080, height: 1920, fps: 30 },
  outputDurationSec: 1,
};

export const ProductionComposition: React.FC<ProductionCompProps> = ({
  videoFileName,
  spans,
  captionLines,
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
      <EdlVideo src={src} spans={spans} />
      <CaptionTrack lines={captionLines} />
    </AbsoluteFill>
  );
};
