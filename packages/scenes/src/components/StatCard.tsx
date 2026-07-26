import React from "react";
import { z } from "zod/v4";
import { StatCardProps, type Theme } from "@ossclip/core/browser";
import { pop, rise, useEnter } from "../anim";

export const StatCard: React.FC<{ props: z.infer<typeof StatCardProps>; theme: Theme }> = ({
  props,
  theme,
}) => {
  const p0 = useEnter(0);
  const p1 = useEnter(6);
  const inverted = props.inverted;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 30,
        fontFamily: theme.fontDisplay,
        width: "100%",
        padding: "0 30px",
      }}
    >
      <div
        style={{
          ...pop(p0),
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 40,
          width: "100%",
          background: inverted ? theme.fg : theme.cardBg,
          color: inverted ? theme.bg : theme.fg,
          border: `2px solid ${inverted ? theme.fg : theme.cardBorder}`,
          borderRadius: theme.radiusPx,
          padding: "44px 52px",
        }}
      >
        <div
          style={{
            fontSize: 42,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            lineHeight: 1.15,
            maxWidth: "55%",
          }}
        >
          {props.label}
        </div>
        <div style={{ fontSize: 110, fontWeight: 900, whiteSpace: "nowrap" }}>{props.value}</div>
      </div>
      {props.caption ? (
        <div
          style={{
            ...rise(p1),
            fontSize: 38,
            fontWeight: 800,
            color: theme.fg,
            background: theme.cardBg,
            border: `2px solid ${theme.cardBorder}`,
            borderRadius: theme.radiusPx / 2,
            padding: "16px 30px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          {props.caption}
        </div>
      ) : null}
    </div>
  );
};
