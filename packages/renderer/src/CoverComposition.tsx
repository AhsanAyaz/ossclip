import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { defaultTheme, type Theme } from "@ossclip/core/browser";
import { COVER_TEXT_RECT } from "@ossclip/scenes";

/**
 * The cover image (FINDINGS §31): a frame from the take with a short,
 * high-contrast banner over it — the same treatment as the reference grid,
 * where every tile is a video frame plus a white box with dark text.
 *
 * Rendered as its own still rather than burned into the video, because both
 * platforms accept a custom cover and the first two seconds of a reel are far
 * too valuable to spend on a static card.
 */
export interface CoverCompProps {
  /** Frame image in the render's public dir. */
  frameFileName: string;
  text: string;
  theme: Theme;
  /** Handle/byline under the banner; omitted when not known. */
  byline?: string;
}

export const defaultCoverProps: CoverCompProps = {
  frameFileName: "",
  text: "COVER",
  theme: defaultTheme,
};

export const COVER_ID = "cover";

export const CoverComposition: React.FC<CoverCompProps> = ({
  frameFileName,
  text,
  theme,
  byline,
}) => {
  // The profile grid crops to a centre square, so the banner must sit inside
  // COVER_GRID_SAFE or it is simply cut off in the grid — a different
  // constraint from the player's SAFE_AREA, and both have to hold.
  const words = text.trim().split(/\s+/).filter(Boolean);
  // Long headlines get smaller type rather than more lines: three lines of
  // banner in a grid tile is unreadable at thumbnail size.
  const fontSize = words.length <= 4 ? 96 : words.length <= 6 ? 78 : 64;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      {frameFileName ? (
        <Img
          src={/^https?:\/\//.test(frameFileName) ? frameFileName : staticFile(frameFileName)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}
      {/* A scrim keeps the banner legible over any frame. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.55) 100%)`,
        }}
      />
      <AbsoluteFill
        style={{
          paddingTop: `${COVER_TEXT_RECT.y * 100}%`,
          paddingBottom: `${(1 - COVER_TEXT_RECT.y - COVER_TEXT_RECT.h) * 100}%`,
          paddingLeft: `${COVER_TEXT_RECT.x * 100}%`,
          paddingRight: `${(1 - COVER_TEXT_RECT.x - COVER_TEXT_RECT.w) * 100}%`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          // Centred in the grid-safe band rather than pinned to its bottom:
          // flush against the crop edge is exactly where a tile clips it.
          justifyContent: "center",
          gap: 24,
        }}
      >
        <div
          style={{
            background: theme.fg,
            color: theme.bg,
            padding: `${fontSize * 0.32}px ${fontSize * 0.42}px`,
            borderRadius: theme.radiusPx,
            fontFamily: theme.fontDisplay,
            fontSize,
            fontWeight: 900,
            lineHeight: 1.04,
            letterSpacing: "-0.01em",
            textTransform: "uppercase",
            textAlign: "center",
            textWrap: "balance",
          }}
        >
          {text}
        </div>
        {byline ? (
          <div
            style={{
              color: theme.fg,
              fontFamily: theme.fontDisplay,
              fontSize: 34,
              fontWeight: 800,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              textShadow: "0 2px 18px rgba(0,0,0,0.7)",
            }}
          >
            {byline}
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
