import React from "react";
import { z } from "zod/v4";
import { ChatMockProps, type Theme } from "@ossclip/core/browser";
import { pop, useEnter } from "../anim";

const Bubble: React.FC<{
  from: "user" | "agent";
  text: string;
  delay: number;
  theme: Theme;
}> = ({ from, text, delay, theme }) => {
  const p = useEnter(delay);
  const mine = from === "user";
  return (
    <div
      style={{
        ...pop(p),
        alignSelf: mine ? "flex-end" : "flex-start",
        background: mine ? theme.fg : theme.cardBg,
        color: mine ? theme.bg : theme.fg,
        border: `2px solid ${mine ? theme.fg : theme.cardBorder}`,
        borderRadius: 28,
        [mine ? "borderBottomRightRadius" : "borderBottomLeftRadius"]: 8,
        padding: "24px 34px",
        fontSize: 40,
        fontWeight: 700,
        maxWidth: "82%",
        fontFamily: theme.fontDisplay,
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

export const ChatMock: React.FC<{ props: z.infer<typeof ChatMockProps>; theme: Theme }> = ({
  props,
  theme,
}) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap: 20,
      width: "100%",
      padding: "0 40px",
    }}
  >
    {props.messages.map((m, i) => (
      <Bubble
        key={i}
        from={m.from}
        text={applyCtaKeyword(m.text, props.keyword)}
        delay={i * 8}
        theme={theme}
      />
    ))}
  </div>
);
