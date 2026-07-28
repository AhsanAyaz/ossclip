import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { defaultTheme, type Theme } from "@ossclip/core/browser";
import { coverTextRect } from "@ossclip/scenes";

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
  /**
   * Banner headline. EMPTY means ship the frame with no banner at all — the
   * §34 case, where the source already carries its own burned-in title and a
   * second one would just say the same thing twice.
   */
  text: string;
  theme: Theme;
  /** Handle/byline under the banner; omitted when not known. */
  byline?: string;
  /**
   * Where the face is in this frame, in its own fractions. The banner routes
   * around it (FINDINGS §33) — reference covers keep the box off the speaker.
   */
  face?: { centerYFrac: number; sizeFrac: number };
  /**
   * The OUTPUT frame this cover belongs to (R16 §76). A landscape render used
   * to ship a 1080×1920 cover, because this composition was registered at a
   * fixed portrait size and — unlike the production composition — had no
   * `calculateMetadata` to follow the settings. The extracted still was
   * already 16:9, so `objectFit: cover` cropped it back to a portrait crop of
   * itself: a portrait thumbnail for a landscape video.
   */
  frame?: { width: number; height: number };
}

export const defaultCoverProps: CoverCompProps = {
  frameFileName: "",
  text: "COVER",
  theme: defaultTheme,
  frame: { width: 1080, height: 1920 },
};

export const COVER_ID = "cover";

export const CoverComposition: React.FC<CoverCompProps> = ({
  frameFileName,
  text,
  theme,
  byline,
  face,
  frame: outFrame = { width: 1080, height: 1920 },
}) => {
  const landscape = outFrame.width >= outFrame.height;
  // The profile grid crops to a centre square, so the banner must sit inside
  // COVER_GRID_SAFE or it is simply cut off in the grid — a different
  // constraint from the player's SAFE_AREA, and both have to hold. Within
  // that, it takes whichever band the head leaves free.
  const words = text.trim().split(/\s+/).filter(Boolean);
  // Long headlines get smaller type rather than more lines: three lines of
  // banner in a grid tile is unreadable at thumbnail size. A landscape cover
  // is 1920 wide but only 1080 tall, so the same point size eats twice the
  // frame height — type is set against the SHORT edge, which is the one that
  // decides how much of the thumbnail a banner swallows.
  const base = words.length <= 4 ? 96 : words.length <= 6 ? 78 : 64;
  const fontSize = Math.round(base * (Math.min(outFrame.width, outFrame.height) / 1080));
  const rect = coverTextRect(
    face && face.sizeFrac > 0 ? face : null,
    outFrame as { width: number; height: number },
  );

  const frame = frameFileName ? (
    <Img
      src={/^https?:\/\//.test(frameFileName) ? frameFileName : staticFile(frameFileName)}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
  ) : null;

  // §34: no banner means the frame IS the cover. The scrim goes too — it only
  // ever existed to keep type legible, and darkening a bare photo for nothing
  // makes it look like a mistake.
  if (words.length === 0) {
    return <AbsoluteFill style={{ backgroundColor: theme.bg }}>{frame}</AbsoluteFill>;
  }

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      {frame}
      {/* A scrim keeps the banner legible over any frame. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.55) 100%)`,
        }}
      />
      <AbsoluteFill
        style={{
          paddingTop: `${rect.y * 100}%`,
          paddingBottom: `${(1 - rect.y - rect.h) * 100}%`,
          paddingLeft: `${rect.x * 100}%`,
          paddingRight: `${(1 - rect.x - rect.w) * 100}%`,
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
            // A 1920-wide banner spanning the whole frame reads as a bar, not
            // a title card — landscape keeps the box inside the middle of the
            // frame, the way a thumbnail's title block sits.
            maxWidth: landscape ? "72%" : "100%",
          }}
        >
          {text}
        </div>
        {byline ? (
          <div
            style={{
              color: theme.fg,
              fontFamily: theme.fontDisplay,
              fontSize: Math.round(34 * (Math.min(outFrame.width, outFrame.height) / 1080)),
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
