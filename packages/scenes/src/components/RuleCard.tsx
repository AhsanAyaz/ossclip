import React from "react";
import { z } from "zod/v4";
import { RuleCardProps, type Theme } from "@ossclip/core/browser";
import { pop, rise, useEnter } from "../anim";
import { editStyle, type ElementEdits } from "../editable";

export const RuleCard: React.FC<{
  props: z.infer<typeof RuleCardProps>;
  theme: Theme;
  edits?: ElementEdits;
}> = ({ props, theme, edits }) => {
  const p0 = useEnter(0);
  const p1 = useEnter(8);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 26,
        fontFamily: theme.fontDisplay,
        width: "100%",
        padding: "0 30px",
      }}
    >
      <div
        style={{
          ...pop(p0),
          width: "100%",
          background: theme.fg,
          color: theme.bg,
          borderRadius: theme.radiusPx,
          padding: "40px 48px",
          textAlign: "left",
        }}
      >
        <div
          data-edit-id="kicker"
          style={{
            fontSize: 30,
            fontWeight: 800,
            letterSpacing: "0.28em",
            textTransform: "uppercase",
            color: "#55555E",
            marginBottom: 14,
            fontFamily: theme.fontMono,
            ...editStyle(edits, "kicker"),
          }}
        >
          {props.kicker}
        </div>
        <div
          data-edit-id="text"
          style={{
            fontSize: 72,
            fontWeight: 900,
            lineHeight: 1.02,
            textTransform: "uppercase",
            ...editStyle(edits, "text"),
          }}
        >
          {props.text}
        </div>
      </div>
      {props.struck ? (
        <div
          data-edit-id="struck"
          style={{
            ...rise(p1),
            fontSize: 44,
            fontWeight: 800,
            color: theme.muted,
            textDecoration: "line-through",
            textDecorationThickness: 6,
            textDecorationColor: theme.danger,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            ...editStyle(edits, "struck"),
          }}
        >
          {props.struck}
        </div>
      ) : null}
    </div>
  );
};
