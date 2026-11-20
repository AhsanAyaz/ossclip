import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod/v4";
import { TerminalMockProps, terminalColors, type Theme } from "@ossclip/core/browser";
import { enterFrames, entranceStyle, rise, useEnter } from "../anim";
import {
  componentRevealFrames,
  isLegacyReveal,
  latestEntryFrame,
  type RevealTiming,
} from "../reveal";
import { editStyle, type ElementEdits } from "../editable";
import { TERMINAL_BADGE_OUT_PX, TERMINAL_BADGE_PX, TERMINAL_BADGE_RISE_PX } from "../fit";
import { caretOn, popScale, typedChars } from "../motion";
import { Editable } from "../primitives/Editable";
import { Pill } from "../primitives/Pill";

type Props = z.infer<typeof TerminalMockProps>;

/** The playbook's typing speed, `typedChars`' default, named so every read agrees. */
export const TERMINAL_TYPE_CPS = 32;
/** The output lines after a typed command land this far apart (§161). */
export const TERMINAL_LINE_GAP_SEC = 0.12;
/**
 * The caret stays this long after the last keystroke: one `caretOn` on-phase,
 * so it reads as the blink's first beat, then goes with the command's output.
 */
export const TERMINAL_CARET_HOLD_SEC = 0.5;
/**
 * The ceiling on the sped-up typing of a cue too short for 32 cps. A 38
 * character command at this speed takes 19 ms, under one frame: past it,
 * faster changes nothing anyone sees.
 */
const MAX_TYPE_CPS = 2000;

/**
 * A line with a shell (`$ `) or REPL (`> `) prompt. The two-character
 * mark is the prompt, printed whole and drawn in `theme.info`; the rest is
 * the command. The line the explainer look types is `typedLineIndex`'s,
 * which prefers one of these but does not need one.
 */
export function isTypedLine(line: string): boolean {
  return line.startsWith("$ ") || line.startsWith("> ");
}

/**
 * The line a window types under the explainer look: the first prompt line,
 * else line 0. Every window types once (§161): the acceptance run's
 * planner wrote windows like `["/egm:egm-brainstorm", "Initial Critique &
 * Risks"]` with no `$ `, and a prompt-only rule left every one of them
 * static. Null only for a window with no lines, which the schema rejects.
 */
export function typedLineIndex(lines: readonly string[]): number | null {
  if (lines.length === 0) return null;
  const k = lines.findIndex(isTypedLine);
  return k === -1 ? 0 : k;
}

/** The prompt mark `typedLineText` prints rather than types: two code points, or none. */
const markLength = (line: string): number => (isTypedLine(line) ? 2 : 0);

/**
 * A typed line `tSec` after its typing began: a two-character prompt mark
 * is whole from the start (a prompt is printed, not typed), the command
 * follows `typedChars`; a line without a mark types from its first
 * character. Code points, not UTF-16 units, so a typed emoji is one
 * keystroke (CtaCard's rule).
 */
export function typedLineText(line: string, tSec: number, cps = TERMINAL_TYPE_CPS): string {
  const chars = [...line];
  const n = markLength(line);
  const mark = chars.slice(0, n).join("");
  const rest = chars.slice(n);
  return mark + rest.slice(0, typedChars(tSec, rest.length, cps)).join("");
}

/**
 * When each window (the reveal item — spec "TerminalMock reveals per
 * window") and the fan-out tail enter. The tail is not an item: it follows
 * the LAST window by the same 10 frames it always has (`n * 6 + 4` is
 * `(n - 1) * 6 + 10`), so legacy is exact, and on a timed path it is held
 * to the entry limit — a tail pushed past the cut would never be read.
 */
export function terminalDelays(
  props: Props,
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

/** One window's explainer schedule. Seconds are from the cue's first frame. */
export interface TerminalWindowPlan {
  /** Entrance delay in frames, as `terminalDelays` gives it, pushed later if needed. */
  enterFrame: number;
  /** Index of the line typed out (`typedLineIndex`); null only for a window with no lines. */
  typed: number | null;
  /** Typing runs [typeStartSec, typeEndSec); both are the entrance time without a typed line. */
  typeStartSec: number;
  typeEndSec: number;
  /** When each line is shown. The typed line shows its prompt (if any) from the entrance. */
  lineAtSec: number[];
}

export interface TerminalTimeline {
  windows: TerminalWindowPlan[];
  /** The fan-out tail's (and badge's) entrance delay, in frames. */
  tail: number;
  /** The typing speed every window uses: 32, raised only for a short cue. */
  cps: number;
}

/** The schedule at a given typing speed, unclamped. */
function scheduleAt(
  props: Props,
  base: { windows: number[]; tail: number },
  fps: number,
  cps: number,
): TerminalTimeline {
  const enter = enterFrames(fps);
  const windows: TerminalWindowPlan[] = [];
  // A window pushed later pushes every later one by as much, so the
  // stagger between them is kept and no window overtakes another.
  let push = 0;
  let gateSec = -Infinity;
  for (const [i, w] of props.windows.entries()) {
    const baseFrame = base.windows[i]!;
    // Not before the previous window's typing has ended: two windows
    // typing at once read as noise, and the second command answers the first.
    const enterFrame = Math.max(baseFrame + push, Math.ceil(gateSec * fps - 1e-9));
    push = enterFrame - baseFrame;
    const enterSec = enterFrame / fps;
    const k = typedLineIndex(w.lines);
    if (k === null) {
      windows.push({
        enterFrame,
        typed: null,
        typeStartSec: enterSec,
        typeEndSec: enterSec,
        lineAtSec: w.lines.map(() => enterSec),
      });
      continue;
    }
    // Typing waits for the window to finish arriving: keystrokes into a
    // window still scaling up are not readable.
    const typeStartSec = (enterFrame + enter) / fps;
    const line = w.lines[k]!;
    const typeEndSec = typeStartSec + Math.max(0, [...line].length - markLength(line)) / cps;
    windows.push({
      enterFrame,
      typed: k,
      typeStartSec,
      typeEndSec,
      lineAtSec: w.lines.map((_, j) =>
        j <= k ? enterSec : typeEndSec + (j - k - 1) * TERMINAL_LINE_GAP_SEC,
      ),
    });
    gateSec = typeEndSec;
  }
  const last = windows.at(-1);
  const lastLineSec = last ? Math.max(last.typeEndSec, ...last.lineAtSec) : 0;
  // The tail closes the window's output: after its own 10 frames, as
  // today, and not before the last window's last line.
  const tail = Math.max(base.tail + push, Math.ceil(lastLineSec * fps - 1e-9));
  return { windows, tail, cps };
}

/** The last moment anything in the schedule appears or finishes typing, in seconds. */
function scheduleEndSec(s: TerminalTimeline, fps: number): number {
  let end = s.tail / fps;
  for (const w of s.windows) end = Math.max(end, w.enterFrame / fps, w.typeEndSec, ...w.lineAtSec);
  return end;
}

/**
 * The explainer look's TerminalMock schedule (§161, plan Task 8): each
 * window enters at its `terminalDelays` frame, but never before the
 * previous window's typing has ended; its first prompt line (line 0 when it
 * has none, `typedLineIndex`) types out once the window has arrived, and
 * the lines after it land `TERMINAL_LINE_GAP_SEC` apart from the last
 * keystroke. Pure, so a still at frame N is the same frame on every run.
 *
 * With the cue's length known, everything appears by `latestEntryFrame` —
 * the limit every other entrance keeps. A cue too short for 32 cps is typed
 * FASTER, never cut off mid-command: the speed is raised (one speed for
 * every window, so they still read as one terminal) to the slowest that
 * fits. Only past `MAX_TYPE_CPS`, where the waits for entrances alone
 * overrun the cue, are times simply held to the limit.
 */
export function terminalTimeline(
  props: Props,
  fps: number,
  timing?: RevealTiming,
): TerminalTimeline {
  const base = terminalDelays(props, fps, timing);
  const known = timing !== undefined && timing.durationInFrames > 0;
  if (!known) return scheduleAt(props, base, fps, TERMINAL_TYPE_CPS);
  const latest = latestEntryFrame(fps, timing.durationInFrames);
  const latestSec = latest / fps;
  const fits = (cps: number): boolean =>
    scheduleEndSec(scheduleAt(props, base, fps, cps), fps) <= latestSec + 1e-9;

  let cps = TERMINAL_TYPE_CPS;
  if (!fits(cps)) {
    if (!fits(MAX_TYPE_CPS)) {
      cps = MAX_TYPE_CPS;
    } else {
      // The end time only falls as the speed rises, so bisect for the
      // slowest speed that fits — the least change from the playbook's 32.
      let lo = TERMINAL_TYPE_CPS;
      let hi = MAX_TYPE_CPS;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
      cps = hi;
    }
  }
  const s = scheduleAt(props, base, fps, cps);
  const sec = (v: number): number => Math.min(latestSec, v);
  return {
    cps,
    tail: Math.min(latest, s.tail),
    windows: s.windows.map((w) => ({
      ...w,
      enterFrame: Math.min(latest, w.enterFrame),
      typeStartSec: sec(w.typeStartSec),
      typeEndSec: sec(w.typeEndSec),
      lineAtSec: w.lineAtSec.map(sec),
    })),
  };
}

/** One line of an explainer window at `t` seconds into the cue. */
export interface TerminalLineState {
  /** What is drawn: the whole line, or the typed line's prefix. */
  text: string;
  shown: boolean;
  /** The block caret after `text` — only ever on the typed line. */
  caret: boolean;
}

/**
 * Line `j` of a window at `t`. The caret is solid under keystrokes (a caret
 * does not blink while being typed into, CtaCard's rule) and holds for
 * `TERMINAL_CARET_HOLD_SEC` after — `caretOn`'s first on-phase, timed from
 * the last keystroke.
 */
export function terminalLineState(
  plan: TerminalWindowPlan,
  line: string,
  j: number,
  t: number,
  cps: number,
): TerminalLineState {
  const shown = t >= plan.lineAtSec[j]!;
  if (j !== plan.typed) return { text: line, shown, caret: false };
  // A clamped window may have no time left to type in at all: the
  // command is then whole the moment typing would have begun.
  const instant = plan.typeEndSec <= plan.typeStartSec;
  const text =
    instant && t >= plan.typeStartSec ? line : typedLineText(line, t - plan.typeStartSec, cps);
  const typing = t >= plan.typeStartSec && t < plan.typeEndSec;
  const holding =
    t >= plan.typeEndSec &&
    t - plan.typeEndSec < TERMINAL_CARET_HOLD_SEC &&
    caretOn(t - plan.typeEndSec);
  return { text, shown, caret: typing || holding };
}

/** The explainer body of a window: one row per line, every row laid out from the start. */
const ExplainerLines: React.FC<{
  lines: string[];
  plan: TerminalWindowPlan;
  cps: number;
  t: number;
  theme: Theme;
}> = ({ lines, plan, cps, t, theme }) => (
  <>
    {lines.map((line, j) => {
      const s = terminalLineState(plan, line, j, t, cps);
      return (
        <div
          key={j}
          style={{
            fontSize: 27,
            color: theme.fg,
            whiteSpace: "pre",
            // Hidden, not absent: every row keeps its height from the
            // window's entrance, so a line landing never grows the window
            // and slides the stack under the stage's centring.
            opacity: s.shown ? 1 : 0,
          }}
        >
          {isTypedLine(line) ? (
            <>
              <span style={{ color: theme.info }}>{s.text.slice(0, 1)}</span>
              {s.text.slice(1)}
            </>
          ) : (
            s.text
          )}
          {j === plan.typed ? (
            // Always mounted on the typed line and only made transparent,
            // so the line box is the same on every frame. One mono cell
            // wide; inside the line's normal height at -0.15em.
            <span
              style={{
                display: "inline-block",
                width: "0.6em",
                height: "1em",
                verticalAlign: "-0.15em",
                background: theme.info,
                opacity: s.caret ? 1 : 0,
              }}
            />
          ) : null}
        </div>
      );
    })}
  </>
);

const Window: React.FC<{
  title: string;
  lines: string[];
  entrance: Props["entrance"];
  delay: number;
  theme: Theme;
  editId: string;
  edits?: ElementEdits;
  /** The explainer schedule for this window; absent → today's static lines. */
  explainer?: { plan: TerminalWindowPlan; cps: number; t: number };
}> = ({ title, lines, entrance, delay, theme, editId, edits, explainer }) => {
  const p = useEnter(delay);
  const term = terminalColors(theme);
  return (
    <div
      data-edit-id={editId}
      style={{
        // Unset is `pop`, the window's style since day one (spec §4).
        ...entranceStyle(entrance, p),
        // Terminal roles, not `cardBg` (§161): the explainer look's windows
        // are darker than its cards. Unset, both follow `cardBg`, so a theme
        // without them (a user's config `cardBg` included) draws the window
        // it always did.
        background: term.bg,
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
          // Painted only when it is a colour of its own. A bar the window's
          // colour is the window's background already, and a second layer
          // of it double-composites the anti-aliased edge pixels under the
          // rounded border: the default theme's terminal came out up to 5
          // levels off along its corners (plan Task 8's `cmp` of default-
          // theme stills, before and after) — not the same frames.
          background: term.bar === term.bg ? undefined : term.bar,
        }}
      >
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
          <div key={c} style={{ width: 16, height: 16, borderRadius: 8, background: c }} />
        ))}
        <div style={{ marginLeft: 10, fontSize: 24, color: theme.muted }}>{title}</div>
      </div>
      <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 8 }}>
        {explainer ? (
          <ExplainerLines lines={lines} theme={theme} {...explainer} />
        ) : (
          lines.map((line, i) => (
            <div key={i} style={{ fontSize: 27, color: theme.fg, whiteSpace: "pre" }}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export const TerminalMock: React.FC<{
  props: Props;
  theme: Theme;
  edits?: ElementEdits;
  /** The cue's timing, from SceneLayer; absent → today's stagger. */
  timing?: RevealTiming;
}> = ({ props, theme, edits, timing }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // The typing is the explainer look's motion only (plan decision 4); the
  // classic look keeps `terminalDelays` and static lines, frame for frame.
  const explainer = theme.motion === "explainer";
  const timeline = explainer ? terminalTimeline(props, fps, timing) : null;
  const delays = timeline
    ? { windows: timeline.windows.map((w) => w.enterFrame), tail: timeline.tail }
    : terminalDelays(props, fps, timing);
  const tail = useEnter(delays.tail);
  const t = frame / fps;
  const badge = props.badge ? props.badge : null;
  const last = props.windows.length - 1;
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
      {props.windows.map((w, i) => {
        const win = (
          <Window
            key={i}
            title={w.title}
            lines={w.lines}
            entrance={props.entrance}
            delay={delays.windows[i]!}
            theme={theme}
            editId={`window-${i}`}
            edits={edits}
            explainer={timeline ? { plan: timeline.windows[i]!, cps: timeline.cps, t } : undefined}
          />
        );
        if (i !== last || badge === null) return win;
        // Only a badged last window is wrapped, so every other terminal's
        // tree is exactly what it was. The margin is the badge's rise
        // (fit.ts models it), so the badge never sits on the window above.
        return (
          <div
            key={i}
            style={{ position: "relative", width: "100%", marginTop: TERMINAL_BADGE_RISE_PX }}
          >
            {win}
            <div
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                // Centred on the top edge, poking past the corner into the
                // root's side padding (fit.ts TERMINAL_BADGE_OUT_PX).
                transform: `translate(${TERMINAL_BADGE_OUT_PX}px, -50%)`,
              }}
            >
              <Editable editId="badge" edits={edits}>
                <Pill
                  text={badge}
                  border={theme.accent}
                  theme={theme}
                  sizePx={TERMINAL_BADGE_PX}
                  // With the tail: a pop under the explainer look, the
                  // tail's own rise under classic. Flat, like the windows
                  // it sits on: the primitive's 32 px shadow reaches past
                  // the root's 30 px side padding, and the first stills
                  // showed it sheared off square at the slot's edge.
                  style={{
                    boxShadow: "none",
                    ...(explainer
                      ? {
                          opacity: t > delays.tail / fps ? 1 : 0,
                          transform: `scale(${popScale(t - delays.tail / fps)})`,
                        }
                      : rise(tail)),
                  }}
                />
              </Editable>
            </div>
          </div>
        );
      })}
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
