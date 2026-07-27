import React from "react";
import { z } from "zod/v4";
import { TerminalMockProps, type Theme } from "@ossclip/core/browser";
import { pop, rise, useEnter } from "../anim";
import { editStyle, type ElementEdits } from "../editable";

const Window: React.FC<{
  title: string;
  lines: string[];
  delay: number;
  theme: Theme;
  editId: string;
  edits?: ElementEdits;
}> = ({ title, lines, delay, theme, editId, edits }) => {
  const p = useEnter(delay);
  return (
    <div
      data-edit-id={editId}
      style={{
        ...pop(p),
        background: theme.cardBg,
        border: `2px solid ${theme.cardBorder}`,
        borderRadius: theme.radiusPx / 2,
        overflow: "hidden",
        width: "100%",
        fontFamily: theme.fontMono,
        ...editStyle(edits, editId),
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "14px 20px",
          borderBottom: `2px solid ${theme.cardBorder}`,
        }}
      >
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
          <div key={c} style={{ width: 16, height: 16, borderRadius: 8, background: c }} />
        ))}
        <div style={{ marginLeft: 10, fontSize: 24, color: theme.muted }}>{title}</div>
      </div>
      <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 8 }}>
        {lines.map((line, i) => (
          <div key={i} style={{ fontSize: 27, color: theme.fg, whiteSpace: "pre" }}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
};

export const TerminalMock: React.FC<{
  props: z.infer<typeof TerminalMockProps>;
  theme: Theme;
  edits?: ElementEdits;
}> = ({ props, theme, edits }) => {
  const tail = useEnter(props.windows.length * 6 + 4);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 22,
        width: "100%",
        padding: "0 30px",
      }}
    >
      {props.windows.map((w, i) => (
        <Window
          key={i}
          title={w.title}
          lines={w.lines}
          delay={i * 6}
          theme={theme}
          editId={`window-${i}`}
          edits={edits}
        />
      ))}
      {props.fanOut ? (
        <div
          style={{
            ...rise(tail),
            fontFamily: theme.fontDisplay,
            fontSize: 40,
            fontWeight: 900,
            letterSpacing: "0.2em",
            color: theme.fg,
            textTransform: "uppercase",
          }}
        >
          ⌄ {props.fanOut}
        </div>
      ) : null}
    </div>
  );
};
