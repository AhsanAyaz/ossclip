import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionLine, SceneCue } from "@ossclip/core/browser";
import { safeAreaFor, activeCueAt } from "./stage";
import { frameWindow } from "./frames";
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
  /** This line's first word's index in the WHOLE caption stream — the id the
   * editor's retype override keys on (`OverrideDoc.captions`). */
  wordOffset: number;
  verticalAnchor: number;
  fontSizePx: number;
  activeColor: string;
  ctaKeyword?: string;
  ctaWindow?: { startSec: number; endSec: number };
}> = ({ line, wordOffset, verticalAnchor, fontSizePx, activeColor, ctaKeyword, ctaWindow }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const safeArea = safeAreaFor({ width, height });
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
          paddingLeft: `${safeArea.left * 100}%`,
          paddingRight: `${safeArea.right * 100}%`,
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
              // The editor double-click retypes a word in place; the RAW text
              // rides along because the rendered text may be CTA-decorated,
              // and the retype's stale-guard must compare against the truth.
              data-caption-word={wordOffset + i}
              data-caption-text={w.text}
              style={{
                display: "inline-block",
                // Words are individually hit-testable for the editor (the
                // parent layer stays pointer-events: none); harmless in the
                // render, where nothing dispatches events.
                pointerEvents: "auto",
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
  const { fps, width, height } = useVideoConfig();
  const frame = { width, height };
  // Each line's first-word index in the whole stream, so a word's id is
  // stable regardless of which line the layout put it on.
  const offsets: number[] = [];
  let running = 0;
  for (const line of lines) {
    offsets.push(running);
    running += line.words.length;
  }
  return (
    <AbsoluteFill>
      {lines.map((line, i) => {
        const active = cues.length > 0 ? activeCueAt(cues, line.start) : null;
        // ONE rect-aware path for every line (R11 Task 2b). The old split —
        // `captionAnchorAvoiding` only when the source had burned-in text,
        // the pure layout anchor otherwise — meant a hand-moved graphic box
        // silently sat on top of the captions on a clean source, the common
        // case. With no regions and no moved rect this resolves to exactly
        // the layout anchor the old branch returned.
        // A hand-set per-scene anchor (R15 §56) wins over the automatic
        // chain outright — like every other hand edit, the user's placement
        // is a decision, not an input to the avoidance search.
        const anchor =
          active?.captionY !== undefined
            ? active.captionY
            : cues.length > 0 || sourceTextRegions.length > 0
              ? captionAnchorAvoiding(
                  active?.layout ?? "full-bleed",
                  regionsDuring(sourceTextRegions, line.start, line.end),
                  active?.graphicRect,
                  frame,
                )
              : verticalAnchor;
        // End frame from the end TIME, never from a rounded duration — see
        // frameWindow. Two lines either side of a cue boundary resolve to
        // different anchors, so a one-frame overlap there renders as two
        // captions stacked at two heights (§115).
        const { from, durationInFrames } = frameWindow(line.start, line.end, fps);
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames}>
            <LineView
              line={line}
              wordOffset={offsets[i]!}
              verticalAnchor={anchor}
              // Per-scene size multiplier (R16 §64) — resolved per line like
              // the anchor, from the cue the line starts under.
              fontSizePx={fontSizePx * (active?.captionScale ?? 1)}
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
