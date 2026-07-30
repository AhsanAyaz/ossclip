import React, { useMemo } from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, useVideoConfig } from "remotion";
import type { KeptSpan } from "@ossclip/core/browser";
import { frameWindow } from "./frames";

export interface EdlVideoProps {
  src: string;
  /** Kept spans from the TimeMap (plain JSON — precomputed in the pipeline). */
  spans: KeptSpan[];
  /** Scale applied on alternating segments to conceal jump cuts. */
  punchInScale?: number;
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
}

/**
 * Plays the kept spans of the source back-to-back — the EDL made visible.
 * Jump cuts are concealed by alternating a slight punch-in whenever the
 * removed gap is long enough to produce a visible jump.
 */
export const EdlVideo: React.FC<EdlVideoProps> = ({
  src,
  spans,
  punchInScale = 1.07,
  punchThresholdSec = 0.15,
  audioFadeSec = 0.01,
  background = "black",
}) => {
  const { fps } = useVideoConfig();

  const scales = useMemo(() => {
    const out: number[] = [];
    let punched = false;
    for (let i = 0; i < spans.length; i++) {
      const prev = spans[i - 1];
      const gap = prev ? spans[i]!.srcIn - prev.srcOut : 0;
      if (i > 0 && gap >= punchThresholdSec) punched = !punched;
      out.push(punched ? punchInScale : 1);
    }
    return out;
  }, [spans, punchInScale, punchThresholdSec]);

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
                volume={(f) =>
                  Math.max(
                    0,
                    Math.min(1, (f + 1) / fadeFrames, (durationInFrames - f) / fadeFrames),
                  )
                }
              />
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
