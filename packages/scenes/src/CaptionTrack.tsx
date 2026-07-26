import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionLine } from "@ossclip/core";

export interface CaptionTrackProps {
  lines: CaptionLine[];
  /** Vertical center of the caption block, as a fraction of frame height. */
  verticalAnchor?: number;
  fontSizePx?: number;
  activeColor?: string;
}

const LineView: React.FC<{
  line: CaptionLine;
  verticalAnchor: number;
  fontSizePx: number;
  activeColor: string;
}> = ({ line, verticalAnchor, fontSizePx, activeColor }) => {
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
          paddingLeft: 60,
          paddingRight: 60,
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
              {w.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** Word-timed kinetic captions. All timings are OUTPUT time. */
export const CaptionTrack: React.FC<CaptionTrackProps> = ({
  lines,
  verticalAnchor = 0.76,
  fontSizePx = 64,
  activeColor = "#FFE14D",
}) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      {lines.map((line, i) => {
        const from = Math.round(line.start * fps);
        const durationInFrames = Math.max(1, Math.round((line.end - line.start) * fps));
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames}>
            <LineView
              line={line}
              verticalAnchor={verticalAnchor}
              fontSizePx={fontSizePx}
              activeColor={activeColor}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
