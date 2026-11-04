import React from "react";
import { useVideoConfig } from "remotion";
import { z } from "zod/v4";
import { ChatMockProps, type Theme } from "@ossclip/core/browser";
import { entranceStyle, useEnter } from "../anim";
import { componentRevealFrames, type RevealTiming } from "../reveal";
import { chatBubbles, chatMetrics } from "../fit";
import { editStyle, type ElementEdits } from "../editable";

const Bubble: React.FC<{
  from: "user" | "agent";
  text: string;
  entrance: z.infer<typeof ChatMockProps>["entrance"];
  delay: number;
  fontSize: number;
  theme: Theme;
  editId: string;
  edits?: ElementEdits;
}> = ({ from, text, entrance, delay, fontSize, theme, editId, edits }) => {
  const p = useEnter(delay);
  const mine = from === "user";
  return (
    <div
      data-edit-id={editId}
      style={{
        // Unset is `pop`, the bubble's style since day one (spec §4).
        ...entranceStyle(entrance, p),
        alignSelf: mine ? "flex-end" : "flex-start",
        background: mine ? theme.fg : theme.cardBg,
        color: mine ? theme.bg : theme.fg,
        border: `2px solid ${mine ? theme.fg : theme.cardBorder}`,
        borderRadius: 28,
        [mine ? "borderBottomRightRadius" : "borderBottomLeftRadius"]: 8,
        // Padding is a HARD boundary, not a suggestion: the type is sized so
        // the longest unbreakable word fits inside bubble-minus-padding, which
        // is what stops a single word like "AGENTS" rendering edge to edge
        // and spilling past the rounded rect (FINDINGS §28a).
        padding: `${fontSize * 0.6}px ${fontSize * 0.85}px`,
        fontSize,
        fontWeight: 700,
        maxWidth: "82%",
        fontFamily: theme.fontDisplay,
        ...editStyle(edits, editId),
      }}
    >
      {text}
    </div>
  );
};

/**
 * The comment-CTA keyword gets the reference's quote-and-caps treatment —
 * `"AGENTS"` — wherever it appears in a message. The producer only marks the
 * word (props.keyword); formatting lives here, never in LLM output
 * (FINDINGS §16). Quotes the LLM already added are absorbed, not doubled.
 */
export function applyCtaKeyword(text: string, keyword: string | undefined): string {
  if (!keyword) return text;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`"?\\b${escaped}\\b"?`, "gi"), `"${keyword.toUpperCase()}"`);
}

export { chatBubbles } from "../fit";

/**
 * When each RENDERED bubble enters: one per `chatBubbles` entry — a set
 * `keyword` collapses the scene to one bubble, and the plan's item list
 * (`revealItemTexts`) collapses the same way, so index i is bubble i. The
 * historical step is 8 frames, not the others' 6.
 */
export function chatDelays(
  props: z.infer<typeof ChatMockProps>,
  fps: number,
  timing?: RevealTiming,
): number[] {
  return componentRevealFrames(chatBubbles(props).length, 8, fps, props, timing);
}

export const ChatMock: React.FC<{
  props: z.infer<typeof ChatMockProps>;
  theme: Theme;
  widthPx?: number;
  heightPx?: number;
  edits?: ElementEdits;
  /** The cue's timing, from SceneLayer; absent → today's stagger. */
  timing?: RevealTiming;
}> = ({ props, theme, widthPx, heightPx, edits, timing }) => {
  const bubbles = chatBubbles(props);
  const { fps } = useVideoConfig();
  const delays = chatDelays(props, fps, timing);
  // Self-fitting (R11 Task 3): the type solves against the REAL slot, both
  // axes — the stage no longer magnifies this component.
  const fontSize = chatMetrics(bubbles.map((b) => b.text), { widthPx, heightPx });
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: fontSize * 0.5,
        width: "100%",
        padding: "0 40px",
      }}
    >
      {bubbles.map((b, i) => (
        <Bubble
          key={i}
          from={b.from}
          text={b.text}
          entrance={props.entrance}
          delay={delays[i]!}
          fontSize={fontSize}
          theme={theme}
          editId={`message-${i}`}
          edits={edits}
        />
      ))}
    </div>
  );
};
