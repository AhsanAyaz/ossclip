import React from "react";
import { z } from "zod/v4";
import { TitleCardProps, type Theme } from "@ossclip/core/browser";
import { rise, useEnter } from "../anim";

export const TitleCard: React.FC<{ props: z.infer<typeof TitleCardProps>; theme: Theme }> = ({
  props,
  theme,
}) => {
  const p0 = useEnter(0);
  const p1 = useEnter(5);
  const p2 = useEnter(10);
  // The producer sometimes emits the same string for both fields; the huge
  // emphasis wins and the redundant title is skipped (FINDINGS §5).
  const emphasis = props.emphasis?.trim();
  const titleIsRedundant =
    !!emphasis && emphasis.toLowerCase().includes(props.title.trim().toLowerCase());
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 28,
        textAlign: "center",
        fontFamily: theme.fontDisplay,
        color: theme.fg,
        padding: "0 40px",
      }}
    >
      {props.eyebrow ? (
        <div
          style={{
            ...rise(p0),
            fontSize: 34,
            fontWeight: 700,
            letterSpacing: "0.35em",
            color: theme.muted,
            textTransform: "uppercase",
          }}
        >
          {props.eyebrow}
        </div>
      ) : null}
      {emphasis ? (
        <div style={{ ...rise(p1, 40), fontSize: 210, fontWeight: 900, lineHeight: 0.95 }}>
          {emphasis}
        </div>
      ) : null}
      {!titleIsRedundant ? (
        <div
          style={{
            ...rise(emphasis ? p2 : p1, 34),
            fontSize: emphasis ? 64 : 96,
            fontWeight: 900,
            lineHeight: 1.05,
            textTransform: "uppercase",
            letterSpacing: "0.02em",
          }}
        >
          {props.title}
        </div>
      ) : null}
      {props.sub ? (
        <div style={{ ...rise(p2), fontSize: 40, fontWeight: 600, color: theme.muted }}>
          {props.sub}
        </div>
      ) : null}
    </div>
  );
};
