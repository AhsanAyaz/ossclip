import React from "react";
import { z } from "zod/v4";
import { StrikethroughRevealProps, type Theme } from "@ossclip/core/browser";
import { rise, useEnter } from "../anim";

const Line: React.FC<{
  text: string;
  struck: boolean;
  delay: number;
  theme: Theme;
}> = ({ text, struck, delay, theme }) => {
  const p = useEnter(delay);
  const strike = useEnter(delay + 8);
  return (
    <div style={{ ...rise(p, 30), position: "relative", display: "inline-block" }}>
      <span
        style={{
          fontSize: 92,
          fontWeight: 900,
          textTransform: "uppercase",
          lineHeight: 1.08,
          color: struck ? theme.muted : theme.fg,
        }}
      >
        {text}
      </span>
      {struck ? (
        <div
          style={{
            position: "absolute",
            left: "-2%",
            top: "50%",
            height: 10,
            width: `${strike * 104}%`,
            background: theme.danger,
            borderRadius: 5,
            transform: "translateY(-50%) rotate(-2deg)",
          }}
        />
      ) : null}
    </div>
  );
};

export const StrikethroughReveal: React.FC<{
  props: z.infer<typeof StrikethroughRevealProps>;
  theme: Theme;
}> = ({ props, theme }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 18,
      textAlign: "center",
      fontFamily: theme.fontDisplay,
    }}
  >
    {props.lines.map((line, i) => (
      <Line key={i} text={line.text} struck={line.struck} delay={i * 6} theme={theme} />
    ))}
  </div>
);
