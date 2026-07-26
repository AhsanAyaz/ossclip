import React from "react";
import { z } from "zod/v4";
import { Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ScreenshotFrameProps, type Theme } from "@ossclip/core/browser";
import { pop, useEnter } from "../anim";

export const ScreenshotFrame: React.FC<{
  props: z.infer<typeof ScreenshotFrameProps>;
  theme: Theme;
}> = ({ props, theme }) => {
  const p = useEnter(0);
  const labelP = useEnter(8);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const drift = props.kenBurns
    ? interpolate(frame, [0, fps * 8], [1.0, 1.08], { extrapolateRight: "clamp" })
    : 1;
  const src = props.src
    ? /^https?:\/\//.test(props.src)
      ? props.src
      : staticFile(props.src)
    : null;
  return (
    <div style={{ ...pop(p), position: "relative", width: "94%" }}>
      <div
        style={{
          overflow: "hidden",
          borderRadius: theme.radiusPx / 2,
          border: `2px solid ${theme.cardBorder}`,
          background: theme.cardBg,
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
        }}
      >
        {src ? (
          <Img
            src={src}
            style={{ width: "100%", display: "block", transform: `scale(${drift})` }}
          />
        ) : (
          <div
            style={{
              height: 420,
              display: "flex",
              flexDirection: "column",
              gap: 14,
              padding: 30,
              transform: `scale(${drift})`,
            }}
          >
            {[0.9, 0.75, 0.85, 0.6, 0.8, 0.5].map((w, i) => (
              <div
                key={i}
                style={{
                  height: 22,
                  width: `${w * 100}%`,
                  borderRadius: 6,
                  background: i % 3 === 0 ? theme.cardBorder : "#22222B",
                }}
              />
            ))}
          </div>
        )}
      </div>
      {props.label ? (
        <div
          style={{
            ...pop(labelP),
            position: "absolute",
            right: -8,
            bottom: -20,
            background: theme.fg,
            color: theme.bg,
            fontFamily: theme.fontMono,
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: "0.08em",
            padding: "12px 22px",
            borderRadius: 10,
            textTransform: "uppercase",
          }}
        >
          {props.label}
        </div>
      ) : null}
    </div>
  );
};
