import React, { useMemo } from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, useVideoConfig } from "remotion";
import type { KeptSpan } from "@ossclip/core/browser";
import { frameWindow, playableSpans } from "./frames";
import { punchScalesFor, type PunchPlan } from "./punch-plan";

export interface EdlVideoProps {
  src: string;
  /** Kept spans from the TimeMap (plain JSON — precomputed in the pipeline). */
  spans: KeptSpan[];
  /** Scale applied on alternating segments to conceal jump cuts. */
  punchInScale?: number;
  /**
   * The face-only punch plan from render-props (punch-plan.ts). When present
   * its scale replaces `punchInScale` and its mask gates which spans render
   * it; absent/null is the LEGACY contract — `punchInScale` everywhere — so
   * every pre-feature render-props renders unchanged. Callers gate the raw
   * JSON through `punchPropsFor` first (parse, never coerce).
   */
  punch?: PunchPlan | null;
  /** Removed gaps shorter than this don't toggle the punch-in (cut is invisible anyway). */
  punchThresholdSec?: number;
  /** Audio micro-fade at each cut boundary, in seconds. */
  audioFadeSec?: number;
  /**
   * What shows where the video doesn't reach. Black by default — with a
   * cover-cropped source it never shows at all. Under `--source-fit contain`
   * the picture is INSET in its slot, so this backing would paint black bars
   * over the stage's own backdrop; the composition passes `transparent` there
   * and lets the backdrop through.
   */
  background?: string;
  /**
   * Per-window user gain (cue `video.volume`), output clock. Empty/absent =
   * unity everywhere — the pre-feature tree, byte for byte.
   */
  gain?: readonly GainSegment[];
}

/**
 * Plays the kept spans of the source back-to-back — the EDL made visible.
 * Jump cuts are concealed by alternating a slight punch-in whenever the
 * removed gap is long enough to produce a visible jump.
 */
/** One window of user audio gain on the OUTPUT clock (cue windows). */
export interface GainSegment {
  startSec: number;
  endSec: number;
  gain: number;
}

/**
 * The user gain at one output second — 1 outside every segment. Last match
 * wins, mirroring how later cues paint over earlier ones; windows come from
 * cues, which tile rather than overlap, so the rule is a tiebreak, not a
 * feature.
 */
export function gainAtSec(segments: readonly GainSegment[], sec: number): number {
  let g = 1;
  for (const s of segments) if (sec >= s.startSec && sec < s.endSec) g = s.gain;
  return g;
}

export const EdlVideo: React.FC<EdlVideoProps> = ({
  src,
  spans: rawSpans,
  punchInScale = 1.07,
  punch = null,
  punchThresholdSec = 0.15,
  audioFadeSec = 0.01,
  background = "black",
  gain = [],
}) => {
  const { fps } = useVideoConfig();

  // A span whose source window rounds to zero frames would mount
  // <OffthreadVideo trimBefore={n} trimAfter={n}> — a Remotion validation
  // THROW that blanks the whole Player (the 2026-08-31 ADK crash). Filtered
  // here, not just at the writers, so docs saved by older versions render.
  const spans = useMemo(() => playableSpans(rawSpans, fps), [rawSpans, fps]);

  // Extracted to punch-plan.ts so the mask/parity interaction is testable
  // without mounting a composition; the loop there is the reference
  // implementation the Premiere export mirrors.
  const scales = useMemo(
    () => punchScalesFor(spans, punch, punchInScale, punchThresholdSec),
    [spans, punch, punchInScale, punchThresholdSec],
  );

  const fadeFrames = Math.max(1, Math.round(audioFadeSec * fps));

  return (
    <AbsoluteFill style={{ backgroundColor: background }}>
      {spans.map((sp, i) => {
        // §115: from the end TIME. Beyond stacking two spans for a frame, a
        // duration that is one frame long also skews the fade ramp below,
        // which measures against `durationInFrames`.
        const { from, durationInFrames } = frameWindow(sp.outIn, sp.outOut, fps);
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames} premountFor={fps}>
            <AbsoluteFill style={{ transform: `scale(${scales[i]})` }}>
              <OffthreadVideo
                src={src}
                trimBefore={Math.round(sp.srcIn * fps)}
                trimAfter={Math.round(sp.srcOut * fps)}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  // Crop bias set by VideoStage per layout (§11) — vertical
                  // for a portrait source, horizontal for a landscape one.
                  objectPosition: "var(--ossclip-obj-x, 50%) var(--ossclip-obj-y, 50%)",
                }}
                volume={(f) => {
                  const fade = Math.max(
                    0,
                    Math.min(1, (f + 1) / fadeFrames, (durationInFrames - f) / fadeFrames),
                  );
                  // User gain composes ON the fade. The preview's <video>
                  // element caps at 1.0, so a boost only fully lands in the
                  // render (allowAmplificationDuringRender below) — the same
                  // documented fidelity limit as the SFX preview gain.
                  return fade * gainAtSec(gain, (from + f) / fps);
                }}
                allowAmplificationDuringRender
              />
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
