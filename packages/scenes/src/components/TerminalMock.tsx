import React from "react";
import { useVideoConfig } from "remotion";
import { z } from "zod/v4";
import { TerminalMockProps, type Theme } from "@ossclip/core/browser";
import { entranceStyle, rise, useEnter } from "../anim";
import {
  componentRevealFrames,
  isLegacyReveal,
  latestEntryFrame,
  type RevealTiming,
} from "../reveal";
import { editStyle, type ElementEdits } from "../editable";

const Window: React.FC<{
  title: string;
  lines: string[];
  entrance: z.infer<typeof TerminalMockProps>["entrance"];
  delay: number;
  theme: Theme;
  editId: string;
  edits?: ElementEdits;
}> = ({ title, lines, entrance, delay, theme, editId, edits }) => {
  const p = useEnter(delay);
  return (
    <div
      data-edit-id={editId}
      style={{
        // Unset is `pop`, the window's style since day one (spec §4).
        ...entranceStyle(entrance, p),
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

/**
 * When each window (the reveal item — spec "TerminalMock reveals per
 * window") and the fan-out tail enter. The tail is not an item: it follows
 * the LAST window by the same 10 frames it always has (`n * 6 + 4` is
 * `(n - 1) * 6 + 10`), so legacy is exact, and on a timed path it is held
 * to the entry limit — a tail pushed past the cut would never be read.
 */
export function terminalDelays(
  props: z.infer<typeof TerminalMockProps>,
  fps: number,
  timing?: RevealTiming,
): { windows: number[]; tail: number } {
  const windows = componentRevealFrames(props.windows.length, 6, fps, props, timing);
  const legacy = timing === undefined || isLegacyReveal(timing.itemAtSec, props);
  if (legacy) return { windows, tail: props.windows.length * 6 + 4 };
  const last = windows.at(-1);
  const tail = last === undefined ? 4 : last + 10;
  return { windows, tail: Math.min(tail, latestEntryFrame(fps, timing.durationInFrames)) };
}

export const TerminalMock: React.FC<{
  props: z.infer<typeof TerminalMockProps>;
  theme: Theme;
  edits?: ElementEdits;
  /** The cue's timing, from SceneLayer; absent → today's stagger. */
  timing?: RevealTiming;
}> = ({ props, theme, edits, timing }) => {
  const { fps } = useVideoConfig();
  const delays = terminalDelays(props, fps, timing);
  const tail = useEnter(delays.tail);
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
          entrance={props.entrance}
          delay={delays.windows[i]!}
          theme={theme}
          editId={`window-${i}`}
          edits={edits}
        />
      ))}
      {props.fanOut ? (
        <div
          // The last un-transformable element on any component (R17 §85
          // audit): with an id it joins the generic drag/resize/retype
          // machinery like everything else.
          data-edit-id="fanOut"
          style={{
            ...rise(tail),
            fontFamily: theme.fontDisplay,
            fontSize: 40,
            fontWeight: 900,
            letterSpacing: "0.2em",
            color: theme.fg,
            textTransform: "uppercase",
            ...editStyle(edits, "fanOut"),
          }}
        >
          ⌄ {props.fanOut}
        </div>
      ) : null}
    </div>
  );
};
