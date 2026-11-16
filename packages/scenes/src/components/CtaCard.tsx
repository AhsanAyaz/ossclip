import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod/v4";
import { CtaCardProps, terminalColors, type Theme } from "@ossclip/core/browser";
import { enterProgress, entranceStyle } from "../anim";
import {
  CTA_ACTION_LH,
  CTA_BOX_BORDER_PX,
  CTA_BOX_PAD_X_PX,
  CTA_BOX_PAD_Y_PX,
  CTA_BUTTON_LH,
  CTA_CARET_GAP_PX,
  CTA_HEAD_LH,
  CTA_ITEM_GAP_PX,
  CTA_ROW_GAP_PX,
  SEND_LABEL,
  SUBSCRIBED_LABEL,
  SUBSCRIBE_LABEL,
  ctaCardMetrics,
  ctaContent,
  type CtaCardMetrics,
} from "../fit";
import { bump, caretOn, popScale, typedChars } from "../motion";
import { PATTERN_DEFAULT_SCENE_SEC, patternSceneSec, type RevealTiming } from "../reveal";
import { editStyle, type ElementEdits } from "../editable";
import { Card } from "../primitives/Card";
import { Icon } from "../primitives/Icon";
import { Words } from "./CardRow";

type Props = z.infer<typeof CtaCardProps>;
type Action = Props["action"];

/** A scene of unknown length is timed as this long (no `timing` prop: the stills, a bare mount). */
export const CTA_DEFAULT_SCENE_SEC = PATTERN_DEFAULT_SCENE_SEC;
/** The playbook's pop length (motion.ts `popScale` default). */
const POP_SEC = 0.35;
/** Typing starts once the card has popped and sat a beat. */
const TYPE_START_SEC = 0.5;
/** The playbook's typing speed, `typedChars`' default, named so both reads agree. */
const TYPE_CPS = 32;
/** The send press follows the last keystroke by a beat, as a hand would. */
const SEND_AFTER_SEC = 0.3;
/** The Subscribe press lands late, so the "Subscribe" state is read first. */
const SUBSCRIBE_AT = 0.6;

/** Seconds from the cue's start; null where the action has no such moment. */
export interface CtaTimeline {
  typeStartSec: number | null;
  typeEndSec: number | null;
  /** The button press: send for a comment, Subscribe → Subscribed for subscribe. */
  bumpSec: number | null;
}

/**
 * When the card's action happens (plan Task 5), a pure function of the
 * scene, so a still at frame N is deterministic. `comment` types its field
 * at `TYPE_CPS` from 0.5 s and presses send 0.3 s after the last character;
 * `subscribe` presses at 60% of the scene; `link` only enters. A cue too
 * short for the press simply ends before it — the card has said its line.
 */
export function ctaTimeline(
  action: Action,
  textLength: number,
  durationSec: number = CTA_DEFAULT_SCENE_SEC,
): CtaTimeline {
  switch (action) {
    case "comment": {
      const typeEndSec = TYPE_START_SEC + Math.max(0, textLength) / TYPE_CPS;
      return { typeStartSec: TYPE_START_SEC, typeEndSec, bumpSec: typeEndSec + SEND_AFTER_SEC };
    }
    case "subscribe":
      return { typeStartSec: null, typeEndSec: null, bumpSec: SUBSCRIBE_AT * durationSec };
    case "link":
      return { typeStartSec: null, typeEndSec: null, bumpSec: null };
  }
}

/** The cue's length in seconds, or `CTA_DEFAULT_SCENE_SEC` when it is not known (`patternSceneSec`, shared with BugCard). */
export const ctaSceneSec = patternSceneSec;

/** What one frame shows. */
export interface CtaFrameState {
  /** Characters of the field drawn. */
  chars: number;
  caret: boolean;
  /** The pressed button's scale. */
  buttonScale: number;
  /**
   * The press has happened. Only `subscribe` draws it (the button becomes
   * "Subscribed" with a tick); a sent comment looks as it did before.
   */
  pressed: boolean;
}

/**
 * The card at `t` seconds into the cue. The caret is solid while the field
 * is being typed into (a caret does not blink under keystrokes), then
 * blinks on the field's own clock — `caretOn` from when typing began, so
 * the blink is in phase with the field getting focus, not with the cue.
 *
 * Under `motion: "classic"` nothing here moves (plan Task 5): the field is
 * whole from the first frame, with no caret, no press, and the Subscribe
 * button in its first state — the classic look has no emphasis motion to
 * match, and a half-typed word in a classic render would be a new motion.
 */
export function ctaFrameState(
  t: number,
  timeline: CtaTimeline,
  fieldLength: number,
  explainer: boolean,
): CtaFrameState {
  if (!explainer) return { chars: fieldLength, caret: false, buttonScale: 1, pressed: false };
  const { typeStartSec, typeEndSec, bumpSec } = timeline;
  const typing = typeStartSec !== null && typeEndSec !== null;
  const chars = typing ? typedChars(t - typeStartSec, fieldLength, TYPE_CPS) : fieldLength;
  const caret = typing ? (t < typeEndSec ? true : caretOn(t - typeStartSec)) : false;
  return {
    chars,
    caret,
    buttonScale: bumpSec === null ? 1 : bump(t - bumpSec),
    pressed: bumpSec !== null && t >= bumpSec,
  };
}

/**
 * The typed text with the caret glued to its last word. `Words` alone let
 * a browser break before the caret — an inline-block is a break
 * opportunity — and the first dense 9:16 still drew it alone on a second
 * line under a word that filled the box. Inside the last word's `nowrap`
 * span it can only ever move with that word.
 */
const TypedWords: React.FC<{ text: string; whole: boolean; caret: React.ReactNode }> = ({
  text,
  whole,
  caret,
}) => {
  if (!whole) {
    return (
      <>
        {text}
        {caret}
      </>
    );
  }
  const words = text.split(" ");
  const last = words.pop() ?? "";
  return (
    <>
      <Words text={words.join(" ")} whole />
      {words.length > 0 ? " " : null}
      <span style={{ whiteSpace: "nowrap" }}>
        {last}
        {caret}
      </span>
    </>
  );
};

/** A filled platform button: fixed width (`buttonWidthPx`), so a relabel never moves the row. */
const Button: React.FC<{
  label: string;
  theme: Theme;
  m: CtaCardMetrics;
  fill: string;
  color: string;
  tick?: boolean;
  scale: number;
}> = ({ label, theme, m, fill, color, tick, scale }) => (
  <div
    style={{
      boxSizing: "border-box",
      width: m.buttonWidthPx,
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: m.tickGapPx,
      padding: `${m.buttonPadYPx}px ${m.buttonPadXPx}px`,
      borderRadius: 999,
      background: fill,
      color,
      fontFamily: theme.fontDisplay,
      fontSize: m.labelPx,
      fontWeight: 800,
      lineHeight: CTA_BUTTON_LH,
      whiteSpace: "nowrap",
      transform: scale === 1 ? undefined : `scale(${scale})`,
    }}
  >
    {tick ? <Icon name="check" sizePx={m.tickPx} color={theme.success} /> : null}
    <span>{label}</span>
  </div>
);

/**
 * The call to action, performed on screen (§161, plan Task 5): one centred
 * card. `comment` types the asked-for word into a comment box and presses
 * send; `subscribe` presses a Subscribe button beside the channel, which
 * becomes "Subscribed" with a tick; `link` shows the address in a URL bar.
 * Full frame over the speaker with no scrim (plan decision 1): it lays
 * itself out in the whole frame with the 100 px margin reserved
 * (`ctaCardMetrics`), and SceneLayer gives it the frame unscaled
 * (`SELF_FITTING`). The wrapper only fades it out, so the card owns its
 * entrance: a pop under the explainer look, `entranceStyle`'s default under
 * classic.
 *
 * Edit ids are the props themselves — `text`, `keyword`, `channel` — on
 * block elements, since an edit nudge is a transform and an inline span
 * ignores one. The caret is an empty box inside the field's element, so the
 * element's text is still exactly the typed prefix.
 */
export const CtaCard: React.FC<{
  props: Props;
  theme: Theme;
  widthPx?: number;
  heightPx?: number;
  edits?: ElementEdits;
  timing?: RevealTiming;
}> = ({ props, theme, widthPx, heightPx, edits, timing }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const w = widthPx ?? width;
  const h = heightPx ?? height;
  const m = ctaCardMetrics(props, w, h);
  const c = ctaContent(props);
  const explainer = theme.motion === "explainer";
  const t = frame / fps;
  // Code points, not UTF-16 units, so a typed emoji is one keystroke.
  const fieldChars = [...(c.field ?? "")];
  const timeline = ctaTimeline(props.action, fieldChars.length, ctaSceneSec(fps, timing));
  const s = ctaFrameState(t, timeline, fieldChars.length, explainer);
  const enter: React.CSSProperties = explainer
    ? { opacity: t > 0 ? 1 : 0, transform: `scale(${popScale(t, POP_SEC)})` }
    : entranceStyle(undefined, enterProgress(frame, fps, 0));

  const actionText: React.CSSProperties = {
    fontSize: m.actionPx,
    fontWeight: 800,
    lineHeight: CTA_ACTION_LH,
    color: theme.fg,
    overflowWrap: "anywhere",
  };

  let row: React.ReactNode = null;
  if (props.action === "comment" && c.field !== null && c.fieldId !== null) {
    const typed = fieldChars.slice(0, s.chars).join("");
    row = (
      <div style={{ display: "flex", alignItems: "center", gap: CTA_ITEM_GAP_PX }}>
        <div
          style={{
            boxSizing: "border-box",
            flex: 1,
            minWidth: 0,
            // Held at the whole comment's height, so the box does not grow
            // a line mid-typing.
            minHeight: m.actionLines * m.actionPx * CTA_ACTION_LH + 2 * (CTA_BOX_PAD_Y_PX + CTA_BOX_BORDER_PX),
            display: "flex",
            alignItems: "center",
            padding: `${CTA_BOX_PAD_Y_PX}px ${CTA_BOX_PAD_X_PX}px`,
            border: `${CTA_BOX_BORDER_PX}px solid ${theme.cardBorder}`,
            borderRadius: theme.radiusPx / 2,
            background: theme.ink,
          }}
        >
          <div data-edit-id={c.fieldId} style={{ ...actionText, ...editStyle(edits, c.fieldId) }}>
            <TypedWords
              text={typed}
              whole={m.actionWordsFit}
              caret={
                <span
                  style={{
                    display: "inline-block",
                    width: m.caretWidthPx,
                    height: Math.round(m.actionPx * 0.9),
                    marginLeft: CTA_CARET_GAP_PX,
                    verticalAlign: "-0.1em",
                    background: theme.info,
                    opacity: s.caret ? 1 : 0,
                  }}
                />
              }
            />
          </div>
        </div>
        <Button
          label={SEND_LABEL}
          theme={theme}
          m={m}
          fill={theme.accent}
          color={theme.ink}
          scale={s.buttonScale}
        />
      </div>
    );
  } else if (props.action === "subscribe") {
    const button = (
      <Button
        label={s.pressed ? SUBSCRIBED_LABEL : SUBSCRIBE_LABEL}
        theme={theme}
        m={m}
        fill={s.pressed ? theme.cardBorder : theme.danger}
        color={theme.fg}
        tick={s.pressed}
        scale={s.buttonScale}
      />
    );
    const channel =
      c.channel !== null ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: CTA_ITEM_GAP_PX,
            flex: m.mode === "row" ? 1 : undefined,
            minWidth: 0,
          }}
        >
          <div
            style={{
              width: m.avatarPx,
              height: m.avatarPx,
              flexShrink: 0,
              borderRadius: "50%",
              background: theme.accent2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="user" sizePx={m.iconPx} color={theme.ink} />
          </div>
          <div data-edit-id="channel" style={{ ...actionText, minWidth: 0, ...editStyle(edits, "channel") }}>
            <Words text={c.channel} whole={m.actionWordsFit} />
          </div>
        </div>
      ) : null;
    row = (
      <div
        style={{
          display: "flex",
          flexDirection: channel !== null && m.mode === "row" ? "row" : "column",
          alignItems: "center",
          justifyContent: "center",
          gap: CTA_ITEM_GAP_PX,
        }}
      >
        {channel}
        {button}
      </div>
    );
  } else if (props.action === "link" && c.field !== null && c.fieldId !== null) {
    row = (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: CTA_ITEM_GAP_PX,
          padding: `${CTA_BOX_PAD_Y_PX}px ${CTA_BOX_PAD_X_PX}px`,
          border: `${CTA_BOX_BORDER_PX}px solid ${theme.cardBorder}`,
          borderRadius: 999,
          background: terminalColors(theme).bg,
        }}
      >
        <Icon name="search" sizePx={m.iconPx} color={theme.info} />
        <div
          data-edit-id={c.fieldId}
          style={{
            fontFamily: theme.fontMono,
            fontSize: m.actionPx,
            lineHeight: CTA_ACTION_LH,
            color: theme.info,
            minWidth: 0,
            whiteSpace: m.actionWordsFit ? "nowrap" : undefined,
            overflowWrap: "anywhere",
            ...editStyle(edits, c.fieldId),
          }}
        >
          {c.field}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        width: w,
        height: h,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Card
        theme={theme}
        border={theme.accent2}
        widthPx={m.cardWidthPx}
        style={{
          ...enter,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          justifyContent: "center",
          gap: c.headline !== null && row !== null ? CTA_ROW_GAP_PX : 0,
        }}
      >
        {c.headline !== null ? (
          <div
            data-edit-id="text"
            style={{
              fontSize: m.headPx,
              fontWeight: 900,
              lineHeight: CTA_HEAD_LH,
              color: theme.fg,
              textAlign: "center",
              overflowWrap: "anywhere",
              textWrap: "balance",
              ...editStyle(edits, "text"),
            }}
          >
            <Words text={c.headline} whole={m.headWordsFit} />
          </div>
        ) : null}
        {row}
      </Card>
    </div>
  );
};
