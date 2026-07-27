import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionLine, SceneCue } from "@ossclip/core/browser";
import { SAFE_AREA, captionAnchorAt } from "./stage";

export interface CaptionTrackProps {
  lines: CaptionLine[];
  /** Scene cues, for layout-aware anchoring/visibility. Empty = always visible. */
  cues?: SceneCue[];
  /** Vertical center of the caption block, as a fraction of frame height. */
  verticalAnchor?: number;
  fontSizePx?: number;
  activeColor?: string;
  /**
   * The comment-CTA word: when the speaker says it, the caption word renders
   * quoted and capitalized — reinforcing the ask for muted viewers
   * (FINDINGS §16).
   */
  ctaKeyword?: string;
}

/** `agents.` → `"AGENTS".` — quote-and-caps the word, punctuation kept outside. */
function ctaDisplay(text: string, keyword: string | undefined): string {
  if (!keyword) return text;
  const core = text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (core.toLowerCase() !== keyword.toLowerCase()) return text;
  return text.replace(core, `"${core.toUpperCase()}"`);
}

const LineView: React.FC<{
  line: CaptionLine;
  verticalAnchor: number;
  fontSizePx: number;
  activeColor: string;
  ctaKeyword?: string;
}> = ({ line, verticalAnchor, fontSizePx, activeColor, ctaKeyword }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // The parent <Sequence> starts at line.start, so local frame 0 === line.start.
  const t = line.start + frame / fps;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          top: `${verticalAnchor * 100}%`,
          left: 0,
          right: 0,
          transform: "translateY(-50%)",
          display: "flex",
          justifyContent: "center",
          gap: "0.28em",
          flexWrap: "wrap",
          // Keep caption text clear of the platform's right-hand action rail.
          paddingLeft: `${SAFE_AREA.left * 100}%`,
          paddingRight: `${SAFE_AREA.right * 100}%`,
          fontFamily:
            "'Inter', 'Helvetica Neue', 'Arial Black', Arial, sans-serif",
          fontWeight: 900,
          fontSize: fontSizePx,
          lineHeight: 1.15,
          textAlign: "center",
          color: "white",
          WebkitTextStroke: "10px rgba(0,0,0,0.85)",
          paintOrder: "stroke fill",
          textShadow: "0 4px 24px rgba(0,0,0,0.55)",
        }}
      >
        {line.words.map((w, i) => {
          const active = t >= w.start && t <= Math.max(w.end, w.start + 0.12);
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                transform: active ? "scale(1.08)" : "scale(1)",
                color: active ? activeColor : "white",
                transition: "transform 60ms linear",
              }}
            >
              {ctaDisplay(w.text, ctaKeyword)}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/**
 * Word-timed kinetic captions. All timings are OUTPUT time. When scene cues
 * are provided, each line is anchored per the active layout's caption slot
 * and hidden entirely while a graphic owns the frame (PHASE1 §1).
 */
export const CaptionTrack: React.FC<CaptionTrackProps> = ({
  lines,
  cues = [],
  verticalAnchor = 0.76,
  fontSizePx = 64,
  activeColor = "#FFE14D",
  ctaKeyword,
}) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      {lines.map((line, i) => {
        const anchor = cues.length > 0 ? captionAnchorAt(cues, line.start) : verticalAnchor;
        const from = Math.round(line.start * fps);
        const durationInFrames = Math.max(1, Math.round((line.end - line.start) * fps));
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames}>
            <LineView
              line={line}
              verticalAnchor={anchor}
              fontSizePx={fontSizePx}
              activeColor={activeColor}
              ctaKeyword={ctaKeyword}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
