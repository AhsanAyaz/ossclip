import React from "react";
import { AbsoluteFill, staticFile } from "remotion";
import { CaptionTrack, CoverInVideo, EdlVideo, SceneLayer, SfxTrack, VideoStage, Watermark, colorGradePropsFor, coverInVideoPropsFor, punchPropsFor, sfxCuesFor, showCaptions, showWatermark, type ColorGradeProps, type CoverInVideoProps, type PunchPlan, type SfxCueProps } from "@ossclip/scenes";
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
  /**
   * OPT-IN cover overlay on the opening frames (`--cover-in-video` / config
   * `coverInVideo`), for the platforms that ignore an uploaded cover and use
   * frame 1. `fileName` is an image in the render's public dir (or an http(s)
   * URL, or the editor's `/media/…`); `durationSec` is OUTPUT seconds from
   * frame 0, derived by produce from the first word's start.
   *
   * Optional and absent-means-off so every pre-feature render-props.json
   * parses and renders BYTE-IDENTICALLY — this is an overlay, so a present
   * value changes pixels only, never the clock (core's cover-in-video.ts has
   * the §93 argument). Gated through `coverInVideoPropsFor` below (parse,
   * never coerce), so a hand-mangled entry falls back to no overlay rather
   * than a NaN-frame Sequence over the hook.
   */
  coverInVideo?: CoverInVideoProps;
  /**
   * `--sfx`: sound effects at output-time instants, already resolved from word
   * anchors and gain-multiplied by produce (`resolveSfxCues`). Files live under
   * the render's public dir as `sfx/<id>.<ext>`.
   *
   * Optional and absent-means-SILENCE, so every pre-feature render-props.json
   * parses and renders byte-identically — an absent key is not an empty track,
   * it is no track at all (the mount below is gated on a non-empty list, so a
   * silent run bundles no `<Audio>` and its audio graph is unchanged). Gated
   * through `sfxCuesFor` (parse, never coerce), so a hand-mangled entry falls
   * back to silence rather than an `undefined` src or a NaN-frame Sequence.
   */
  sfxCues?: SfxCueProps[];
  /**
   * `--grade`: the color grade as an SVG filter spec, fully precomputed by
   * produce (core's `gradeToSvgFilterSpec` — per-channel transfer tables plus
   * one 5x4 feColorMatrix). The composition stays dumb: it serializes the
   * numbers into a `<filter>`, no grade math in here or in scenes.
   *
   * Optional and absent-means-UNGRADED, so every pre-feature
   * render-props.json parses and renders byte-identically — an absent key
   * mounts zero new DOM, not an identity filter. Gated through
   * `colorGradePropsFor` below (parse, never coerce), so a hand-mangled spec
   * falls back to no grade rather than an feColorMatrix that blanks the
   * picture.
   */
  colorGrade?: ColorGradeProps;
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
  coverInVideo,
  sfxCues,
  colorGrade,
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
  // Gated here rather than at the mount below so the parse runs once per
  // render and the JSX stays a plain presence check (punchPlan's shape).
  const coverInVideoProps = coverInVideoPropsFor(coverInVideo);
  // Gated here for the same reason, so the per-entry parse runs once per
  // render rather than once per frame.
  const sfx = sfxCuesFor(sfxCues);
  // Gated here for the same once-per-render reason; VideoStage receives an
  // already-parsed spec (or null) and never sees the raw props value.
  const grade = colorGradePropsFor(colorGrade);
  // Per-window user gain (`video.volume` on a cue, 2026-08-31): cue windows
  // become EdlVideo gain segments. Only non-unity entries — an empty list is
  // the pre-feature audio graph, byte for byte.
  const gainSegments = sceneCues.flatMap((c) =>
    c.video?.volume !== undefined && c.video.volume !== 1
      ? [{ startSec: c.startSec, endSec: c.endSec, gain: c.video.volume }]
      : [],
  );
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
        colorGrade={grade}
      >
        {/* Under `contain` the cut punch-in would scale an exactly-fitted
            picture and crop it back, and the video's own black backing would
            paint over the stage backdrop in the inset margins — so both are
            neutralised here rather than inside EdlVideo, which has no idea
            what shape its slot is. */}
        <EdlVideo
          src={src}
          spans={spans}
          {...(gainSegments.length > 0 ? { gain: gainSegments } : {})}
          {...(punchPlan ? { punch: punchPlan } : {})}
          {...(sourceFit === "contain" ? { punchInScale: 1, background: "transparent" } : {})}
          {...(staticCamera === true ? { punchInScale: 1 } : {})}
        />
      </VideoStage>
      <SceneLayer cues={sceneCues} theme={theme} />
      {/* After the scene layer, before the captions: the track draws nothing,
          so its position is about the audio graph, not the stacking order —
          and mounted only when there ARE cues, so a run without --sfx builds
          the same tree it always did (SfxTrack.tsx has the loudnorm argument
          for why the mixing happens in here at all). */}
      {sfx.length > 0 ? <SfxTrack cues={sfx} /> : null}
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
      {/* LAST, so it is above even the credit: for the frames it covers, the
          cover IS the video — a wordmark or a caption showing through would
          be exactly the composite the overlay exists to avoid. It occupies
          only its own opening window (CoverInVideo mounts a Sequence), so
          everything above renders normally the moment it ends. */}
      {coverInVideoProps ? <CoverInVideo cover={coverInVideoProps} /> : null}
    </AbsoluteFill>
  );
};
