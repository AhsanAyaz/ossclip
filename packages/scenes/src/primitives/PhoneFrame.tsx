import React from "react";
import type { Theme } from "@ossclip/core/browser";
import { PHONE_BORDER_PX, PHONE_SILHOUETTE } from "../fit";
import { SHADOW } from "./shadow";

/**
 * A stand-in vertical video (§161): a 9:16 panel, `heightPx` tall, with a
 * gradient and a plain head-and-shoulders silhouette, so a "this is how the
 * captions sit on a phone" shot needs no footage and no file prop (the
 * staging and safety checks a path needs are `ScreenshotFrame`'s, and
 * decision 2 keeps them out of these scenes). Children are laid over the
 * whole panel, positioned by the caller.
 */
export const PhoneFrame: React.FC<{
  theme: Theme;
  heightPx: number;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ theme, heightPx, children, style }) => {
  const widthPx = Math.round((heightPx * 9) / 16);
  return (
    <div
      style={{
        position: "relative",
        boxSizing: "border-box",
        width: widthPx,
        height: heightPx,
        flexShrink: 0,
        overflow: "hidden",
        borderRadius: Math.round(heightPx * 0.06),
        // The rim and the silhouette's numbers are fit.ts's, so PhoneDemo's
        // caption is laid out against the panel and face drawn here.
        border: `${PHONE_BORDER_PX}px solid ${theme.cardBorder}`,
        background: `linear-gradient(180deg, ${theme.muted} 0%, ${theme.cardBg} 100%)`,
        boxShadow: SHADOW,
        ...style,
      }}
    >
      {/* The silhouette: one head, one shoulder arc, in the near-black ink at
          partial opacity so it reads as a person without competing with the
          caption drawn over it. viewBox is the panel's own 9:16. */}
      <svg
        viewBox={`0 0 ${PHONE_SILHOUETTE.viewW} ${PHONE_SILHOUETTE.viewH}`}
        preserveAspectRatio="xMidYMax meet"
        aria-hidden
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.55 }}
      >
        <circle
          cx={PHONE_SILHOUETTE.headCx}
          cy={PHONE_SILHOUETTE.headCy}
          r={PHONE_SILHOUETTE.headR}
          fill={theme.ink}
        />
        <path d="M8 160c0-30 16-52 37-52s37 22 37 52z" fill={theme.ink} />
      </svg>
      <div style={{ position: "absolute", inset: 0 }}>{children}</div>
    </div>
  );
};
