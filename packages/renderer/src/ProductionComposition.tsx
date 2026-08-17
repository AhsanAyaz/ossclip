import React from "react";
import { AbsoluteFill, staticFile } from "remotion";
import { CaptionTrack, EdlVideo, SceneLayer, VideoStage, Watermark, punchPropsFor, showCaptions, showWatermark, type PunchPlan } from "@ossclip/scenes";
import {
  defaultTheme,
  type CaptionLine,
  type ContentRectSegment,
  type FaceCrop,
  type FramingSegment,
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
export { SAFE_AREA, clampGraphicRect, graphicSlotFor, layoutSlots, safeAreaFor } from "@ossclip/scenes";

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
  /**
   * The render-time framing plan over SOURCE time (2026-08-16 incident) —
   * the props-based successor to the destructive normalization bake, which
   * crop+scale+re-encoded the mezzanine irreversibly. Windows are SOURCE
   * pixels, all sharing one aspect; preferred over `contentTimeline` when
   * both are present. Optional and absent-means-none, so every pre-existing
   * render-props.json parses and renders unchanged.
   */
  framingTimeline?: FramingSegment[];
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
  /**
   * OPT-IN "made with ossclip" credit (`--watermark` / config `watermark`).
   * Optional and absent-means-off so every pre-watermark render-props.json
   * parses and renders unchanged; strict `=== true` at the render gate
   * (`showWatermark`) so a hand-edited non-boolean can't coerce a credit on.
   */
  watermark?: boolean;
  /**
   * Global captions OFF switch (`--no-captions` / the editor's doc-global
   * `captionsHidden` override). Optional and absent-means-VISIBLE — captions
   * are the default, so every pre-feature render-props.json parses and
   * renders unchanged; strict `=== true` at the render gate (`showCaptions`)
   * so a hand-edited non-boolean falls back to visible, never to a silently
   * missing track.
   */
  captionsHidden?: boolean;
  /**
   * `--no-zoom` (2026-08-13): kills the SECOND motion driver — EdlVideo's
   * cut punch-in — which an emptied `zoomPlan` can't reach. Optional and
   * absent-means-off (motion is the default), so every pre-flag
   * render-props.json parses and renders unchanged; strict `=== true` at
   * the spread below, same posture as `watermark`.
   */
  staticCamera?: boolean;
  /**
   * The face-only jump-cut punch plan (2026-08-16 incident, Task 6): one
   * scale plus a per-span mask of the spans allowed to render it. Optional
   * and ABSENT-MEANS-LEGACY — the 1.07 punch on every alternating span —
   * so every pre-feature render-props.json renders unchanged; the shape is
   * gated through `punchPropsFor` below (parse, never coerce), so a
   * hand-mangled plan also falls back to legacy rather than NaN scales.
   */
  punch?: PunchPlan;
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
  settings,
  face,
  zoomPlan,
  ctaKeyword,
  ctaWindow,
  sourceTextRegions,
  contentTimeline,
  framingTimeline,
  sourceSize,
  contentCropMode,
  sourceFit,
  watermark,
  captionsHidden,
  staticCamera,
  punch,
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
  // The punch plan is dropped — not just rescaled — under contain/static:
  // both already force punchInScale 1 in the spreads below, and a plan
  // passed alongside would override that base scale inside EdlVideo. The
  // suppression has to live here for the same reason the spreads do:
  // EdlVideo has no idea what shape its slot is or that the camera is off.
  const punchPlan =
    sourceFit === "contain" || staticCamera === true ? null : punchPropsFor(punch);
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <VideoStage
        cues={sceneCues}
        theme={theme}
        face={face}
        zoomPlan={zoomPlan}
        sourceTextRegions={sourceTextRegions}
        contentTimeline={contentTimeline}
        framingTimeline={framingTimeline}
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
          {...(punchPlan ? { punch: punchPlan } : {})}
          {...(sourceFit === "contain" ? { punchInScale: 1, background: "transparent" } : {})}
          {...(staticCamera === true ? { punchInScale: 1 } : {})}
        />
      </VideoStage>
      <SceneLayer cues={sceneCues} theme={theme} />
      {/* Hidden pulls the WHOLE layer, CTA keyword styling included: the
          §16/§22 quote-and-capitalize treatment is a styling OF caption
          words — there is no keyword to emphasize once the track is gone.
          ACCEPTED trade, and it answers the field question outright: yes,
          --no-captions (or the editor's Captions toggle) also removes the
          CTA emphasis, rather than promoting the keyword to some new
          caption-less overlay this feature never designed. */}
      {showCaptions(captionsHidden) ? (
        <CaptionTrack
          lines={captionLines}
          cues={sceneCues}
          activeColor={theme.accent}
          // fontDisplay/fg for the caption type (F6) — the accent above was
          // always themed; this completes the set so a config theme reaches
          // every caption color except the contrast stroke (see
          // captionTypography for why the stroke stays fixed).
          theme={theme}
          ctaKeyword={ctaKeyword}
          ctaWindow={ctaWindow}
          sourceTextRegions={sourceTextRegions}
        />
      ) : null}
      {/* Its own TOP layer, above scenes and captions: the credit must never
          be occluded by a graphic, and living outside SceneLayer keeps it out
          of the editor's cue-driven world entirely (see Watermark.tsx for the
          hit-testing reasoning). Sized from `settings` so both shapes place
          it inside their own safe area. */}
      {showWatermark(watermark) ? (
        <Watermark theme={theme} frame={{ width: settings.width, height: settings.height }} />
      ) : null}
    </AbsoluteFill>
  );
};
