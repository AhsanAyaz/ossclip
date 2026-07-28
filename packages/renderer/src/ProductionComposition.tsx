import React from "react";
import { AbsoluteFill, staticFile } from "remotion";
import { CaptionTrack, EdlVideo, SceneLayer, VideoStage } from "@ossclip/scenes";
import {
  defaultTheme,
  type CaptionLine,
  type ContentRectSegment,
  type FaceCrop,
  type KeptSpan,
  type RenderSettings,
  type SceneCue,
  type Theme,
  type ZoomSegment,
} from "@ossclip/core/browser";

/**
 * Plain-JSON props, fully precomputed by the pipeline. The composition stays
 * dumb: no cutting logic, no source-time anywhere — output time only.
 * Stage order (PHASE1 §1): backdrop+video slot → scene graphics → captions.
 * The EDL video (and its audio) is mounted continuously across every scene.
 */
/**
 * Re-exported for the editor, whose import surface is this module plus
 * `@ossclip/core/browser`: the safe-area guide it draws while dragging must
 * come from the SAME constant the stage lays out against, or the guide
 * drifts from the geometry it claims to show.
 */
export { SAFE_AREA, clampGraphicRect, layoutSlots } from "@ossclip/scenes";

export interface ProductionCompProps {
  /** File name inside the render's public dir (or an absolute http(s) URL). */
  videoFileName: string;
  spans: KeptSpan[];
  captionLines: CaptionLine[];
  sceneCues: SceneCue[];
  theme: Theme;
  settings: RenderSettings;
  outputDurationSec: number;
  /** Measured face box (FINDINGS §13); null = fall back to assumed framing. */
  face?: FaceCrop | null;
  /** Micro zoom punches from phrase boundaries (FINDINGS §15). */
  zoomPlan?: ZoomSegment[];
  /** Comment-CTA word — quoted+capitalized in captions at the ask (FINDINGS §16). */
  ctaKeyword?: string;
  /** When the ask is on screen; without it the keyword is never styled (§22). */
  ctaWindow?: { startSec: number; endSec: number };
  /**
   * Bands where the SOURCE already has text burned in (FINDINGS §26), in
   * OUTPUT time. Consumed twice: captions route around them, and the video
   * crop refuses to slice one in half (FINDINGS §36).
   */
  sourceTextRegions?: Array<{ y: number; h: number; startSec: number; endSec: number }>;
  /**
   * The source's framing over SOURCE time (PLAN Task C). Set only when the
   * framing CHANGES mid-take; a uniformly letterboxed source is already
   * cropped into the mezzanine and must not be cropped again here.
   */
  contentTimeline?: ContentRectSegment[];
  /** The source's own pixel dimensions, which the timeline is measured in. */
  sourceSize?: { width: number; height: number };
  /** How letterboxed stretches render: cover (default) or fit (option (b)). */
  contentCropMode?: "cover" | "fit";
  /**
   * How the SOURCE meets the slot (`--source-fit`): `cover` crops it to fill,
   * `contain` shows the whole frame inset against the backdrop. The landscape
   * escape hatch — a 16:9 take cover-cropped into 9:16 keeps 32% of its width.
   * Requires `sourceSize`; without it there is nothing to fit.
   */
  sourceFit?: "cover" | "contain";
}

export const defaultProductionProps: ProductionCompProps = {
  videoFileName: "",
  spans: [],
  captionLines: [],
  sceneCues: [],
  theme: defaultTheme,
  settings: { width: 1080, height: 1920, fps: 30 },
  outputDurationSec: 1,
  face: null,
  zoomPlan: [],
};

export const ProductionComposition: React.FC<ProductionCompProps> = ({
  videoFileName,
  spans,
  captionLines,
  sceneCues,
  theme,
  face,
  zoomPlan,
  ctaKeyword,
  ctaWindow,
  sourceTextRegions,
  contentTimeline,
  sourceSize,
  contentCropMode,
  sourceFit,
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
      <VideoStage
        cues={sceneCues}
        theme={theme}
        face={face}
        zoomPlan={zoomPlan}
        sourceTextRegions={sourceTextRegions}
        contentTimeline={contentTimeline}
        spans={spans}
        sourceSize={sourceSize}
        contentCropMode={contentCropMode}
        sourceFit={sourceFit}
      >
        {/* Under `contain` the cut punch-in would scale an exactly-fitted
            picture and crop it back, and the video's own black backing would
            paint over the stage backdrop in the inset margins — so both are
            neutralised here rather than inside EdlVideo, which has no idea
            what shape its slot is. */}
        <EdlVideo
          src={src}
          spans={spans}
          {...(sourceFit === "contain" ? { punchInScale: 1, background: "transparent" } : {})}
        />
      </VideoStage>
      <SceneLayer cues={sceneCues} theme={theme} />
      <CaptionTrack
        lines={captionLines}
        cues={sceneCues}
        activeColor={theme.accent}
        ctaKeyword={ctaKeyword}
        ctaWindow={ctaWindow}
        sourceTextRegions={sourceTextRegions}
      />
    </AbsoluteFill>
  );
};
