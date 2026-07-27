import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionLine, SceneCue } from "@ossclip/core/browser";
import { SAFE_AREA, activeCueAt, captionAnchorAt } from "./stage";
import { captionAnchorAvoiding, regionsDuring, type OccupiedRegion } from "./source-fit";

export interface CaptionTrackProps {
  lines: CaptionLine[];
  /** Scene cues, for layout-aware anchoring/visibility. Empty = always visible. */
  cues?: SceneCue[];
  /** Vertical center of the caption block, as a fraction of frame height. */
  verticalAnchor?: number;
  fontSizePx?: number;
  activeColor?: string;
  /**
   * The comment-CTA word: at the moment it is ASKED FOR, the caption word
   * renders quoted and capitalized — reinforcing the ask for muted viewers
   * (FINDINGS §16).
   */
  ctaKeyword?: string;
  /**
   * When the ask is on screen, in output seconds — the CTA cue's own window.
   * Required for the treatment to apply at all: quoting marks *the word you
   * type in the comments*, so styling every ordinary use of it (nine times in
   * one take) inverts the meaning and devalues the real ask (FINDINGS §22).
   */
  ctaWindow?: { startSec: number; endSec: number };
  /**
   * Bands where the SOURCE already has burned-in text. Captions relocate to
   * clear them but are NEVER hidden — they are the accessibility layer, so a
   * crowded caption still beats a missing one (FINDINGS §26).
   */
  sourceTextRegions?: OccupiedRegion[];
}

/**
 * A caption word may sit slightly outside the cue that carries the ask — the
 * cue starts at its anchor's first word, and speech runs on either side. The
 * window is narrow enough that a near miss is glaring and the next occurrence
 * of the word is seconds away, so a small pad is free insurance.
 */
const CTA_WINDOW_PAD_SEC = 0.4;

/** `agents.` → `"AGENTS".` — quote-and-caps the word, punctuation kept outside. */
export function ctaDisplay(text: string, keyword: string | undefined): string {
  if (!keyword) return text;
  const core = text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (core.toLowerCase() !== keyword.toLowerCase()) return text;
  return text.replace(core, `"${core.toUpperCase()}"`);
}

/** Is this caption word inside the CTA moment? No window ⇒ no treatment. */
export function inCtaWindow(
  startSec: number,
  window: { startSec: number; endSec: number } | undefined,
): boolean {
  if (!window) return false;
  return (
    startSec >= window.startSec - CTA_WINDOW_PAD_SEC &&
    startSec <= window.endSec + CTA_WINDOW_PAD_SEC
  );
}

const LineView: React.FC<{
  line: CaptionLine;
  verticalAnchor: number;
  fontSizePx: number;
  activeColor: string;
  ctaKeyword?: string;
  ctaWindow?: { startSec: number; endSec: number };
}> = ({ line, verticalAnchor, fontSizePx, activeColor, ctaKeyword, ctaWindow }) => {
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
              {/* Per WORD, not per line: a line straddling the cue boundary
                  styles only the word actually inside the ask. */}
              {ctaDisplay(w.text, inCtaWindow(w.start, ctaWindow) ? ctaKeyword : undefined)}
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
  ctaWindow,
  sourceTextRegions = [],
}) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      {lines.map((line, i) => {
        const active = cues.length > 0 ? activeCueAt(cues, line.start) : null;
        const anchor =
          sourceTextRegions.length > 0
            ? captionAnchorAvoiding(
                active?.layout ?? "full-bleed",
                regionsDuring(sourceTextRegions, line.start, line.end),
                active?.graphicRect,
              )
            : cues.length > 0
              ? captionAnchorAt(cues, line.start)
              : verticalAnchor;
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
              ctaWindow={ctaWindow}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
