import React from "react";
import { AbsoluteFill } from "remotion";
import { Asset, fadeIn, useSafeArea, useSceneTime, useTheme } from "@ossclip/scenes/draw";

// A scene as the LLM is asked to write one: kit imports only, a transparent
// background, everything inside the safe area. Passes checkDrawnScene
// (drawn-render.test.ts asserts it), so this is the honest case the CSP must
// not break: the bundle's scripts, the staged fonts and the staged asset.
export default function Scene({ durationSec }: { durationSec: number }) {
  const t = useSceneTime();
  const theme = useTheme();
  const area = useSafeArea();
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height / 2;
  return (
    <AbsoluteFill>
      <svg width="100%" height="100%">
        <circle cx={cx} cy={cy} r={area.width / 4} fill={theme.accent} />
        <text x={cx} y={area.y + 120} textAnchor="middle" fontSize={72} fontFamily={theme.fontDisplay} fill={theme.fg} opacity={fadeIn(t, 0)}>
          {durationSec} seconds
        </text>
      </svg>
      <div style={{ position: "absolute", left: area.x, bottom: area.y }}>
        <Asset name="dot" width={64} height={64} />
      </div>
    </AbsoluteFill>
  );
}
