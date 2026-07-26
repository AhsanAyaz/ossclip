import React from "react";
import { z } from "zod/v4";
import { FlowDiagramProps, type Theme } from "@ossclip/core/browser";
import { pop, useEnter } from "../anim";

const Chip: React.FC<{ text: string; emphasized: boolean; delay: number; theme: Theme }> = ({
  text,
  emphasized,
  delay,
  theme,
}) => {
  const p = useEnter(delay);
  return (
    <div
      style={{
        ...pop(p),
        background: emphasized ? theme.fg : theme.cardBg,
        color: emphasized ? theme.bg : theme.fg,
        border: `2px solid ${emphasized ? theme.fg : theme.cardBorder}`,
        borderRadius: theme.radiusPx / 2,
        padding: "26px 38px",
        fontSize: 44,
        fontWeight: 900,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        fontFamily: theme.fontDisplay,
      }}
    >
      {text}
    </div>
  );
};

const Arrow: React.FC<{ delay: number; theme: Theme }> = ({ delay, theme }) => {
  const p = useEnter(delay);
  return (
    <div style={{ opacity: p, color: theme.muted, fontSize: 52, fontWeight: 700 }}>→</div>
  );
};

export const FlowDiagram: React.FC<{ props: z.infer<typeof FlowDiagramProps>; theme: Theme }> = ({
  props,
  theme,
}) => (
  <div
    style={{
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "center",
      gap: 24,
      padding: "0 24px",
    }}
  >
    {props.nodes.map((node, i) => (
      <React.Fragment key={i}>
        {i > 0 ? <Arrow delay={i * 6 - 2} theme={theme} /> : null}
        <Chip
          text={node}
          emphasized={props.emphasizeLast && i === props.nodes.length - 1}
          delay={i * 6}
          theme={theme}
        />
      </React.Fragment>
    ))}
  </div>
);
