/**
 * The kit as the LLM sees it (§167). `DRAW_KIT_EXPORTS` is what the static
 * check lets a drawn scene import; `DRAW_KIT_REFERENCE` is the declarations
 * text the draw call sends. Both sit here, beside each other, because the
 * kit is a contract (storyboard design §4): an export is only ever added,
 * and the list, the text and index.ts are changed together. draw-kit.test.ts
 * pins that the three agree, and that every name below passes the check.
 *
 * Runtime names only. `Theme`, `IconName` and `ParsedCount` appear in the
 * text as local types, not exports: types erase, a scene gets them by
 * inference from the hooks, and an `import { Theme }` would be a name the
 * static check has to allow for no gain.
 *
 * Also its own entry, `@ossclip/scenes/draw/reference`: a Node caller that
 * only builds a prompt or runs the check needs these two values, and the
 * `./draw` door would load React, Remotion and every part to hand them over.
 * So this file imports nothing; keep it that way.
 */

/**
 * Recorded with every drawn version, so a scene can be matched to the kit it
 * was written for. Here rather than in index.ts (which re-exports it) for the
 * reason above: `ossclip draw` writes it into each version's record in Node
 * and must not load React to read a number (§167).
 */
export const DRAW_KIT_VERSION = 1;

export const DRAW_KIT_EXPORTS = [
  "useSceneTime",
  "useTheme",
  "useFrameSize",
  "useSafeArea",
  "popScale",
  "easeInOut",
  "typedChars",
  "caretOn",
  "bobPx",
  "bump",
  "beatStarts",
  "parseCount",
  "countAt",
  "fadeIn",
  "riseIn",
  "Card",
  "Pill",
  "Sticker",
  "NumberBadge",
  "PhoneFrame",
  "Icon",
  "Asset",
] as const;

/**
 * Hand-written, not generated from the source: the source's comments are
 * for the maintainers and its types carry props (`editId`) a drawn scene
 * should not set. Every field and prop here is real; Theme's `terminalBg`,
 * `terminalBar`, `fonts` and `motion` are left out because a scene has no
 * use for them (the terminal pair is read through `terminalColors`, and the
 * last two are render switches).
 */
export const DRAW_KIT_REFERENCE = `// The module "@ossclip/scenes/draw": every name a drawn scene may import from it.
// Times are seconds since the scene started (t = useSceneTime()); sizes and positions are pixels.
import type { CSSProperties, FC, ReactNode } from "react";

// The project's look, returned by useTheme(). Not importable. All text uses its fonts; interface parts use its colours.
interface Theme {
  bg: string;
  fg: string;
  accent: string;
  accent2: string;
  highlight: string;
  info: string;
  muted: string;
  success: string;
  danger: string;
  ink: string;
  cardBg: string;
  cardBorder: string;
  fontDisplay: string;
  fontMono: string;
  radiusPx: number;
}
// Colours: bg background, fg main text, accent and accent2 the two accents, highlight a yellow mark,
// info a cool informational colour, muted secondary text, success a green, danger a red,
// ink a near-black for text on light fills, cardBg and cardBorder a panel's fill and border.
// Fonts: fontDisplay for all text, fontMono for code (CSS font-family values). radiusPx: corner radius, pixels.

// Icon names for <Icon name>; "none" draws nothing.
type IconName = "none" | "chat" | "doc" | "search" | "terminal" | "code" | "check" | "bolt" | "user" | "robot";

// A stat string split for counting up. Not importable: get one from parseCount.
interface ParsedCount { prefix: string; number: number; decimals: number; suffix: string; grouped: boolean }

// Seconds since the scene started.
export declare function useSceneTime(): number;
// The project's theme.
export declare function useTheme(): Theme;
// The frame's size, pixels.
export declare function useFrameSize(): { width: number; height: number };
// The rect, pixels, that all text and interface parts stay inside (clear of the players' controls).
export declare function useSafeArea(): { x: number; y: number; width: number; height: number };

// Pop-in scale: 0 at t <= 0, overshoots, exactly 1 from durSec seconds on (default 0.35). t is seconds since its own start.
export declare function popScale(t: number, durSec?: number): number;
// Ease in-out progress: 0 at t <= 0, 1 from durSec seconds on.
export declare function easeInOut(t: number, durSec: number): number;
// How many of total characters are typed at t, at cps characters per second (default 32).
export declare function typedChars(t: number, total: number, cps?: number): number;
// A blinking caret: true during the first half of every second.
export declare function caretOn(t: number): boolean;
// An idle vertical drift, pixels: a sine of amplitude pixels (default 7) over periodSec seconds (default 2.4).
export declare function bobPx(t: number, amplitude?: number, periodSec?: number): number;
// A one-shot emphasis scale: 1 to 1.15 and back to 1 over durSec seconds (default 0.3).
export declare function bump(t: number, durSec?: number): number;
// Start times, seconds, of count items one beat apart: firstSec (default 0.25), then every gapSec (default 0.7).
export declare function beatStarts(count: number, gapSec?: number, firstSec?: number): number[];
// Parses a stat such as "4,494", "+242%" or "1.05s" for countAt; null when it cannot count up (draw it as written).
export declare function parseCount(value: string): ParsedCount | null;
// The stat's text at t, counting up from 0 over durSec seconds (default 1); exactly the source string from durSec on.
export declare function countAt(parsed: ParsedCount, t: number, durSec?: number): string;
// Opacity: 0 before startSec, rising to 1 over durSec seconds (default 0.3). t and startSec are scene seconds.
export declare function fadeIn(t: number, startSec: number, durSec?: number): number;
// A y offset, pixels: px (default 26) before startSec, falling to 0 over durSec seconds (default 0.35). Use in translateY.
export declare function riseIn(t: number, startSec: number, durSec?: number, px?: number): number;

// A themed panel with a 5 px border in the colour border (e.g. theme.accent); widthPx pixels, else it fits its content.
export declare const Card: FC<{ border: string; children?: ReactNode; widthPx?: number; style?: CSSProperties }>;
// A rounded label with a 3 px border in the colour border; sizePx is its font size, pixels (default 34); mark adds a tick or a cross.
export declare const Pill: FC<{ text: string; border: string; sizePx?: number; mark?: "tick" | "cross"; style?: CSSProperties }>;
// A tilted uppercase tag filled with the colour color; tiltDeg degrees (default -4); sizePx font size, pixels (default 34).
export declare const Sticker: FC<{ text: string; color: string; tiltDeg?: number; sizePx?: number; style?: CSSProperties }>;
// A numbered disc in theme.danger showing n, sizePx pixels across.
export declare const NumberBadge: FC<{ n: number; sizePx: number; style?: CSSProperties }>;
// A stand-in 9:16 phone video heightPx pixels tall, with a silhouette; children are laid over the whole panel.
export declare const PhoneFrame: FC<{ heightPx: number; children?: ReactNode; style?: CSSProperties }>;
// A line icon sizePx pixels square, stroked in the colour color (pass a theme colour).
export declare const Icon: FC<{ name: IconName; sizePx: number; color: string }>;
// One of the author's image files by its name in the asset list, as an image; width and height pixels; draws nothing for an unknown name.
export declare const Asset: FC<{ name: string; width?: number; height?: number; style?: CSSProperties }>;
`;
