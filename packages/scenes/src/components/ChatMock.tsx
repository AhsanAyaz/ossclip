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
      <Bubble key={i} from={m.from} text={m.text} delay={i * 8} theme={theme} />
    ))}
  </div>
);
