import type { SceneComponentId } from "@ossclip/core/browser";

/**
 * The fill contract (FINDINGS §23).
 *
 * Components were authored at one fixed type scale and centred in their slot,
 * so what they actually filled was accidental: a three-chip FlowDiagram
 * occupied 8% of `graphic-only`, a one-line TitleCard 12%, while a full
 * TerminalMock overflowed to 169% and bled outside the platform safe area with
 * nothing clipping it. The reference frames fill their space, and that is much
 * of why they read as designed rather than sparse.
 *
 * So the stage now scales each graphic to its slot. `estimateHeightPx` models
 * a component's natural height at a given content width, in the same
 * em-relative style `flowLayout` already uses — analytic and pure, not
 * measured, because these values must be unit-testable in Node and because
 * one component's height depends on an image that may not have decoded yet.
 *
 * The models only have to be good to a few percent: `FILL_TARGET` leaves
 * headroom, and being wrong in the safe direction (over-estimating height,
 * hence under-scaling) costs a little air rather than an overflow.
 */

/** Fraction of the slot height a fitted graphic aims to occupy. */
export const FILL_TARGET = 0.94;
/** Components that solve their own type against the slot, needing no scale. */
const SELF_FITTING = new Set<SceneComponentId>([
  "FlowDiagram",
  "StrikethroughReveal",
  "ChatMock",
  "BulletList",
  // A clip fills its slot as-is (explainer plan Task 7): the video
  // letterboxes itself with `objectFit: contain`, so a stage scale has
  // nothing to solve and could only shrink the box it plays in.
  "ClipScene",
  // Full-frame pattern scenes (§161): each solves its own type and its
  // margin against the box it is drawn in — the whole frame, or its graphic
  // box (§163) — (`cardRowMetrics`), so a stage scale would only move the
  // margin it was solved for.
  "CardRow",
  "CtaCard",
  "BugCard",
  "PhoneDemo",
]);

/**
 * Components whose type is solved against the slot directly, so the stage's
 * uniform scale would only cancel out. FlowDiagram and StrikethroughReveal
 * are WIDTH-bound — a row of chips or a line of big words can only grow
 * until it hits the slot's edge. ChatMock joined them in R11 Task 3 for the
 * inverse reason: its bubble is capped at 82% of its own box, so magnifying
 * it NARROWS the text it can hold — `fitScale`'s ×2.4 turned a 26-character
 * message into a five-line one-word column. Its type solves against the
 * real slot in `chatMetrics` instead.
 */
export function isSelfFitting(component: SceneComponentId): boolean {
  return SELF_FITTING.has(component);
}
/**
 * Never blow a small card up past this. A one-line terminal window stretched
 * to fill the tallest slot would need ~7×, giving it a 200px title bar — the
 * ceiling is a taste limit, and content that hits it simply keeps some air.
 */
export const MAX_SCALE = 2.4;
/** Never shrink past legibility on a phone; overflow is clipped instead. */
const MIN_SCALE = 0.45;

/**
 * Rough advance width per character, as a fraction of font size. Slightly
 * conservative: over-estimating width predicts extra wrapped lines, hence a
 * taller estimate and a smaller scale — air rather than overflow. (Less
 * conservative than `flowMetrics`' 0.78, where a bad guess breaks the layout
 * outright rather than costing a few pixels of fill.)
 */
const CHAR_W_BOLD = 0.58;
const CHAR_W_UPPER = 0.72;
/** Monospace advances are uniform and wider than proportional text. */
const CHAR_W_MONO = 0.62;

/** Height of `chars` of text wrapped into `widthPx`, in pixels. */
function textHeight(
  chars: number,
  fontSizePx: number,
  widthPx: number,
  lineHeight: number,
  charW: number,
): number {
  const perLine = Math.max(1, Math.floor(widthPx / Math.max(1, charW * fontSizePx)));
  const lines = Math.max(1, Math.ceil(chars / perLine));
  return lines * fontSizePx * lineHeight;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * A component's natural height at its authored type scale, given the content
 * width it will lay out in. Mirrors each component's own box model — see the
 * pixel values in `components/*.tsx`.
 */
export function estimateHeightPx(
  component: SceneComponentId,
  props: Record<string, unknown>,
  widthPx: number,
  heightPx = Infinity,
): number {
  switch (component) {
    case "TitleCard": {
      const inner = widthPx - 80; // padding "0 40px"
      const emphasis = str(props.emphasis);
      const gap = 28;
      let h = 0;
      let blocks = 0;
      if (str(props.eyebrow)) {
        h += 34 * 1.2;
        blocks++;
      }
      if (emphasis) {
        h += 210 * 0.95;
        blocks++;
      }
      const titleFont = emphasis ? 64 : 96;
      h += textHeight(str(props.title).length, titleFont, inner, 1.05, CHAR_W_UPPER);
      blocks++;
      if (str(props.sub)) {
        h += textHeight(str(props.sub).length, 40, inner, 1.2, CHAR_W_BOLD);
        blocks++;
      }
      return h + gap * Math.max(0, blocks - 1);
    }
    case "StatCard": {
      // Card: padding 44 top/bottom + the taller of label / 110px value.
      const label = textHeight(str(props.label).length, 42, widthPx * 0.55, 1.15, CHAR_W_UPPER);
      let h = 88 + Math.max(label, 110 * 1.15) + 4;
      if (str(props.caption)) h += 30 + (38 * 1.2 + 32 + 4);
      return h;
    }
    case "RuleCard": {
      const inner = widthPx - 60 - 96; // root padding + card padding
      let h = 80; // card padding 40 top/bottom
      h += 30 * 1.2 + 14; // kicker + marginBottom
      h += textHeight(str(props.text).length, 72, inner, 1.02, CHAR_W_UPPER);
      if (str(props.struck)) h += 26 + textHeight(str(props.struck).length, 44, inner, 1.2, CHAR_W_UPPER);
      return h;
    }
    case "StrikethroughReveal": {
      const lines = arr(props.lines).map((l) => str((l as Record<string, unknown>)?.text));
      const font = revealMetrics(lines, widthPx, heightPx);
      const rows = lines.reduce((n, l) => n + revealRows(l, font, widthPx).length, 0);
      return rows * font * 1.08 + font * 0.2 * Math.max(0, rows - 1);
    }
    case "FlowDiagram": {
      // Self-fitting: flowMetrics already solves against both budgets.
      const nodes = arr(props.nodes).map((n) => str(n));
      const n = Math.max(1, nodes.length);
      const { mode, fontSize } = flowMetrics(nodes, widthPx, heightPx);
      return mode === "row" ? fontSize * CHIP_H + 4 : fontSize * (CHIP_H * n + ARROW_ROW_H * (n - 1));
    }
    case "TerminalMock": {
      const windows = arr(props.windows);
      let h = 0;
      for (const w of windows) {
        const lines = arr((w as Record<string, unknown>)?.lines);
        h += 56.8 + 2; // titlebar + its border
        h += Math.max(1, lines.length) * 27 * 1.2 + 8 * Math.max(0, lines.length - 1) + 36;
        h += 4; // window border
      }
      h += 22 * Math.max(0, windows.length - 1);
      if (str(props.fanOut)) h += 22 + 40 * 1.2;
      // The badge's upper half rides above the last window, in a margin the
      // component reserves for it (§161) — only when one is drawn, so every
      // badge-less terminal keeps the model it always had.
      if (str(props.badge)) h += TERMINAL_BADGE_RISE_PX;
      return h;
    }
    case "ChatMock": {
      // One model, two callers (R11 Task 3.3): the metric solved the font
      // against this same stack-height function, so the two cannot disagree.
      const texts = chatBubbles(props).map((b) => b.text);
      const font = chatMetrics(texts, { widthPx, heightPx });
      return chatStackHeightPx(texts, font, widthPx);
    }
    case "ScreenshotFrame": {
      // The placeholder is a fixed 420px block; a real image is unbounded and
      // assumed 16:9 (the fit only has to be close — it is clamped either way).
      const frame = widthPx * 0.94;
      const body = str(props.src) ? (frame * 9) / 16 : 420 + 60;
      return body + 4;
    }
    case "BulletList": {
      // Self-fitting like the reveal: rows of nowrap uppercase text. Same
      // model bulletMetrics solves against — the two cannot disagree.
      const items = arr(props.items).map((i) => str(i));
      const font = bulletMetrics(items, widthPx, heightPx, Boolean(str(props.title)), str(props.title));
      return bulletStackHeightPx(items.length, font, Boolean(str(props.title)));
    }
    case "ClipScene":
      // No text to lay out, and self-fitting above, so this estimate never
      // sizes it; 0 keeps the switch exhaustive without inventing a height.
      return 0;
    case "CardRow": {
      // Self-fitting, so this never sizes it either; the row's own model is
      // answered rather than `heightPx` (which defaults to Infinity here).
      const cards = arr(props.cards).map((c) => {
        const card = (c ?? {}) as Record<string, unknown>;
        return { text: str(card.text), sub: str(card.sub), icon: str(card.icon) };
      });
      return cardRowMetrics(cards, widthPx, heightPx).blockHeightPx;
    }
    case "CtaCard": {
      // Self-fitting too; answered from the card's own model, as CardRow is.
      // Props here passed CtaCardProps, so `action` is one of the three; an
      // estimate for anything else is the registry default's ("subscribe").
      const action = str(props.action);
      const input: CtaCardInput = {
        action: action === "comment" || action === "link" ? action : "subscribe",
        text: str(props.text),
        keyword: str(props.keyword),
        channel: str(props.channel),
      };
      return ctaCardMetrics(input, widthPx, heightPx).blockHeightPx;
    }
    case "BugCard": {
      // Self-fitting as well, answered from the card's own model. Props here
      // passed BugCardProps; anything else estimates as its schema default.
      const mock = str(props.mock);
      const input: BugCardInput = {
        number: typeof props.number === "number" ? props.number : 1,
        headline: str(props.headline),
        sub: str(props.sub),
        mock: mock === "caption" || mock === "lines" ? mock : "none",
        mockLines: arr(props.mockLines).map(str),
        mockWrong: typeof props.mockWrong === "number" ? props.mockWrong : undefined,
        mockFault: str(props.mockFault) === "clipped" ? "clipped" : "struck",
        sticker: str(props.sticker),
      };
      return bugCardMetrics(input, widthPx, heightPx).blockHeightPx;
    }
    case "PhoneDemo": {
      // Self-fitting as well, answered from the scene's own model.
      const input: PhoneDemoInput = {
        caption: arr(props.caption).map((c) => {
          const w = (c ?? {}) as Record<string, unknown>;
          return { text: str(w.text), emphasis: str(w.emphasis) };
        }),
        pills: arr(props.pills).map((c) => {
          const pill = (c ?? {}) as Record<string, unknown>;
          return { text: str(pill.text), state: str(pill.state) };
        }),
      };
      return phoneDemoMetrics(input, widthPx, heightPx).blockHeightPx;
    }
  }
}

/**
 * Width the component cannot shrink below at its authored type scale, or 0
 * when everything in it wraps.
 *
 * Scaling up narrows the layout box by the same factor it magnifies, which is
 * harmless for text that reflows — but `white-space: pre` and `nowrap` content
 * keeps its width and simply runs off the edge. That is exactly what clipped
 * "$ ossclip produce raw.mp4" in the terminal once graphics started filling
 * their slot, so the fill scale is bounded by this too.
 */
/** Longest unbreakable word in a string, in characters. */
const longestWord = (v: unknown): number =>
  str(v)
    .split(/\s+/)
    .reduce((max, w) => Math.max(max, w.length), 0);

export function estimateMinWidthPx(
  component: SceneComponentId,
  props: Record<string, unknown>,
): number {
  switch (component) {
    case "RuleCard": {
      // §46: `AI HARNESS` wrapped to two lines and HARNESS — one unbreakable
      // word — was wider than the card, spilling past the rounded rect until
      // the slot's overflow:hidden severed it. The height model knows how
      // text WRAPS but a word cannot, so the longest word is a hard floor on
      // width, exactly like ChatMock's §28a rule. Fonts, paddings and
      // letter-spacings mirror RuleCard.tsx.
      const kicker = longestWord(props.kicker) * 30 * (CHAR_W_UPPER + 0.28);
      const text = longestWord(props.text) * 72 * CHAR_W_UPPER;
      const struck = longestWord(props.struck) * 44 * (CHAR_W_UPPER + 0.04);
      const widest = Math.max(kicker, text, struck);
      return widest > 0 ? 60 + 96 + widest : 0; // root "0 30px" + card "40px 48px"
    }
    case "TitleCard": {
      // Same rule; fonts and spacings mirror TitleCard.tsx. The emphasis
      // block is one huge token (a "861%"-style stat) and renders at 210px.
      const titleFont = str(props.emphasis) ? 64 : 96;
      const eyebrow = longestWord(props.eyebrow) * 34 * (CHAR_W_UPPER + 0.35);
      const emphasis = longestWord(props.emphasis) * 210 * CHAR_W_UPPER;
      const title = longestWord(props.title) * titleFont * (CHAR_W_UPPER + 0.02);
      const sub = longestWord(props.sub) * 40 * CHAR_W_BOLD;
      const widest = Math.max(eyebrow, emphasis, title, sub);
      return widest > 0 ? 80 + widest : 0; // root padding "0 40px"
    }
    case "TerminalMock": {
      let longest = 0;
      for (const w of arr(props.windows)) {
        for (const l of arr((w as Record<string, unknown>)?.lines)) {
          longest = Math.max(longest, str(l).length);
        }
      }
      // root padding 60 + window border 4 + body padding 44
      const lines = longest > 0 ? 108 + longest * 27 * CHAR_W_MONO : 0;
      // A badge sits on the last window's title bar, right of its title, so
      // that bar must hold both (§161) — absent, the floor is the lines'.
      const badge = str(props.badge);
      if (!badge) return lines;
      const last = arr(props.windows).at(-1) as Record<string, unknown> | undefined;
      return Math.max(lines, terminalBadgeRowMinWidthPx(str(last?.title).length, badge));
    }
    case "StatCard": {
      // The card is a row: label | gap | value. The value is `nowrap`, and the
      // label can only shrink to its longest word — so the row has a hard
      // floor, and scaling past it pushes the value out through the card's
      // right edge (which is exactly what it did once graphics started
      // filling their slot).
      const value = str(props.value).length * 110 * CHAR_W_UPPER;
      if (value === 0) return 0;
      const label = longestWord(props.label) * 42 * CHAR_W_UPPER;
      return 60 + 104 + label + 40 + value; // root pad + card pad + row
    }
    default:
      return 0;
  }
}

/** Bullet list typography (R16 §67), reveal-style bounds. */
const BULLET_MIN_FONT = 36;
const BULLET_MAX_FONT = 120;
/** Row: 1.15 line-height + 0.45em gap; the kicker title ≈ one smaller row. */
const BULLET_ROW_H = 1.6;
/**
 * The kicker title's real height (R27 §121). It renders at `fontSize * 0.36`
 * (`BulletList.tsx:75`) plus the column's `0.45em` gap — 0.36x1.2 + 0.45 ≈
 * 0.88em, not the 1.1em this used to charge. Over-charging the title shrinks
 * `heightFit`, so a titled list was solved against a budget ~0.2em smaller
 * than the one it actually occupies.
 */
const BULLET_TITLE_H = 0.88;
/**
 * Per-character advance of the kicker, in ems of the BASE font: its own
 * 0.36em type times (glyph + the 0.28em tracking it is set with). Letter
 * spacing was not modelled at all, so a long title could overrun the slot
 * width unbudgeted.
 */
const BULLET_TITLE_CHAR_W = (CHAR_W_UPPER + 0.28) * 0.36;
/** Glyph column: the ▸ plus its gap, in ems. */
const BULLET_GLYPH_W = 1.1;

/** Height of the whole list at a font — ONE model, two callers. */
export function bulletStackHeightPx(rows: number, font: number, hasTitle: boolean): number {
  return (Math.max(1, rows) * BULLET_ROW_H + (hasTitle ? BULLET_TITLE_H : 0)) * font;
}

/**
 * Type size for a BulletList, solved against the real slot like the reveal:
 * the longest item must fit one row (they are nowrap — a wrapped bullet stops
 * reading as a list), and the stack must fit the height budget.
 */
export function bulletMetrics(
  items: readonly string[],
  widthPx = 831,
  heightPx = Infinity,
  hasTitle = false,
  title = "",
): number {
  const longest = items.reduce((max, t) => Math.max(max, t.length), 0);
  if (longest === 0) return BULLET_MIN_FONT;
  // Whichever of the longest bullet and the tracked-out kicker needs more room.
  const widthFit = Math.min(
    widthPx / (longest * CHAR_W_UPPER + BULLET_GLYPH_W),
    title ? widthPx / (title.length * BULLET_TITLE_CHAR_W) : Infinity,
  );
  const heightFit =
    (heightPx * FILL_TARGET) /
    (Math.max(1, items.length) * BULLET_ROW_H + (hasTitle ? BULLET_TITLE_H : 0));
  return Math.max(
    BULLET_MIN_FONT,
    Math.min(BULLET_MAX_FONT, Math.floor(Math.min(widthFit, heightFit))),
  );
}

/** Base type size a reveal line is authored at, its floor, and its ceiling. */
const REVEAL_FONT = 92;
const REVEAL_MIN_FONT = 44;
const REVEAL_MAX_FONT = 150;
/** Arrow-ish glyphs a reveal line may be broken at, longest first. */
const REVEAL_BREAKS = [" → ", " -> ", " → ", " > "];

/**
 * Break a reveal line into the rows it will actually render as.
 *
 * A wrapped line strands its arrow at the end of a row and — worse — leaves
 * the strike rule drawn *between* the rows instead of through either, because
 * the rule is positioned against the whole block (FINDINGS §27). So the line
 * is treated as an unbreakable unit like FlowDiagram's row: it scales to fit,
 * and only when it cannot fit at the legibility floor is it broken — at the
 * arrow, with the arrow LEADING the next row, never trailing the previous
 * one. Each returned row is struck independently.
 */
export function revealRows(text: string, fontSizePx: number, widthPx: number): string[] {
  const fits = (s: string) => s.length * fontSizePx * CHAR_W_UPPER <= widthPx;
  if (fits(text)) return [text];
  for (const sep of REVEAL_BREAKS) {
    if (!text.includes(sep)) continue;
    const parts = text.split(sep);
    const rows = parts.map((part, i) => (i === 0 ? part : `${sep.trim()} ${part}`.trim()));
    if (rows.every(fits)) return rows;
  }
  return [text];
}

/**
 * Type size for a StrikethroughReveal, sized so its longest line fits one row
 * AND the block fills its slot. Falls to the floor and lets `revealRows` break
 * at an arrow beyond that.
 *
 * Width-bound like FlowDiagram's row, so the stage's uniform scale cancels out
 * against it — this solves both budgets directly instead (FINDINGS §23/§27).
 */
export function revealMetrics(
  lines: readonly string[],
  widthPx = 831,
  heightPx = Infinity,
): number {
  const longest = lines.reduce((max, l) => Math.max(max, l.length), 0);
  if (longest === 0) return REVEAL_FONT;
  const widthFit = widthPx / (longest * CHAR_W_UPPER);
  const heightFit = heightPx / (Math.max(1, lines.length) * 1.28);
  return Math.max(
    REVEAL_MIN_FONT,
    Math.min(REVEAL_MAX_FONT, Math.floor(Math.min(widthFit, heightFit))),
  );
}

/**
 * Chat typography (R11 Task 3), all in COMPOSITION px now that ChatMock is
 * self-fitting (the old `CHAT_FONT = 40` was a layout-space number that only
 * made sense before ×2.4 magnification stopped applying):
 * - `CHAT_TARGET_LINE_CHARS` is the measure — overlay-caption typography
 *   wraps around ~22 characters, not body-text 45+.
 * - `CHAT_WRAP_FONT` caps a WRAPPING exchange at caption-sized type. The cap
 *   is what makes widening the box REWRAP the text (strictly more characters
 *   per line) instead of just magnifying it — the property the Task 2 handle
 *   depends on; without it the font scales with the slot and the wrap comes
 *   out the same at every width.
 * - `CHAT_MAX_FONT` is what a single short line — the CTA word — may grow
 *   to: today's 40 × 2.4 ceiling, expressed directly.
 */
const CHAT_MIN_FONT = 22;
const CHAT_WRAP_FONT = 44;
const CHAT_MAX_FONT = 96;
const CHAT_TARGET_LINE_CHARS = 22;
/** Bubble geometry as multiples of the font size — see ChatMock's Bubble. */
const BUBBLE_PAD_X = 0.85;
const BUBBLE_MAX_WIDTH = 0.82;

/** Height of the bubble stack at a given font. ONE model, two callers
 * (`chatMetrics`' height fit and `estimateHeightPx`) — no disagreement. */
function chatStackHeightPx(texts: readonly string[], font: number, widthPx: number): number {
  const inner = widthPx - 80; // root padding "0 40px"
  const textW = inner * BUBBLE_MAX_WIDTH - 2 * font * BUBBLE_PAD_X;
  let h = 0;
  for (const t of texts) {
    h += textHeight(t.length, font, textW, 1.2, CHAR_W_BOLD) + font * 1.2 + 4;
  }
  return h + font * 0.5 * Math.max(0, texts.length - 1);
}

/**
 * The bubbles a ChatMock actually renders.
 *
 * A CTA scene shows ONE bubble carrying the keyword and nothing else
 * (FINDINGS §28b). The model likes to add a reply — "link sent 🔗" — which is
 * reassurance for something that has not happened, competes with the word the
 * viewer is supposed to type, and appears nowhere in the reference. The ask is
 * the whole message, so it gets the whole frame. Conversational scenes with no
 * keyword keep the full exchange.
 *
 * Lives here rather than in the component because it decides how many boxes
 * are laid out, which the height model must agree with exactly.
 */
export function chatBubbles(
  props: Record<string, unknown>,
): Array<{ from: "user" | "agent"; text: string }> {
  const keyword = str(props.keyword);
  if (keyword) return [{ from: "user", text: `"${keyword.toUpperCase()}"` }];
  return arr(props.messages).map((m) => {
    const msg = (m ?? {}) as Record<string, unknown>;
    return { from: msg.from === "agent" ? "agent" : "user", text: str(msg.text) };
  });
}

/**
 * Type size for chat bubbles, solved against the REAL slot (R11 Task 3).
 *
 * Sized by LINE LENGTH: the line the type must fit is the whole message when
 * it is short (a CTA word grows toward `CHAT_MAX_FONT` and fills its
 * bubble), and the ~22-character target measure when it wraps (capped at
 * caption-sized `CHAT_WRAP_FONT`, so a wider slot means MORE words per line,
 * never just bigger ones). The old sizer used the longest WORD as the sizer
 * itself, which — through the fill magnifier narrowing the layout box —
 * rendered a 26-character message as five one-word lines.
 *
 * §28a's invariant is kept EXACTLY, as the hard upper bound it always was:
 * the longest unbreakable word must still fit inside bubble-minus-padding,
 * because wrapping cannot save a single word. And the stack must fit the
 * slot's height budget — the font shrinks (down to `CHAT_MIN_FONT`) until
 * the same height model `estimateHeightPx` uses says it fits.
 */
export function chatMetrics(
  texts: readonly string[],
  slot: { widthPx?: number; heightPx?: number } = {},
): number {
  const widthPx = slot.widthPx ?? 831;
  const heightPx = slot.heightPx ?? Infinity;
  const inner = widthPx - 80; // root padding "0 40px"
  const longestText = texts.reduce((max, t) => Math.max(max, t.length), 0);
  if (longestText === 0) return CHAT_WRAP_FONT;
  const longestWord = texts
    .flatMap((t) => t.split(/\s+/))
    .reduce((max, w) => Math.max(max, w.length), 0);
  // bubbleWidth = font·(chars·CHAR_W + 2·PAD_X) ≤ inner·MAX_WIDTH
  const fitChars = (chars: number): number =>
    (inner * BUBBLE_MAX_WIDTH) / (chars * CHAR_W_BOLD + 2 * BUBBLE_PAD_X);
  const line = Math.min(longestText, CHAT_TARGET_LINE_CHARS);
  const ceiling = longestText > CHAT_TARGET_LINE_CHARS ? CHAT_WRAP_FONT : CHAT_MAX_FONT;
  let font = Math.floor(Math.min(fitChars(line), fitChars(longestWord), ceiling));
  while (
    font > CHAT_MIN_FONT &&
    chatStackHeightPx(texts, font, widthPx) > heightPx * FILL_TARGET
  ) {
    font -= 1;
  }
  return Math.max(CHAT_MIN_FONT, font);
}

/** Below this the chips stop reading on a phone — switch shape, don't shrink. */
export const MIN_ROW_FONT = 26;
export const MIN_STACK_FONT = 22;
/** A stack of huge chips stops reading as a diagram and starts reading as a list. */
const MAX_STACK_FONT = 76;

/** Chip is ~2.1em tall; a stacked arrow row adds ~2.05em with its gaps. */
const CHIP_H = 2.1;
const ARROW_ROW_H = 2.05;

/**
 * FlowDiagram's row/stack decision, given the real slot it must fill.
 *
 * A row is bounded by WIDTH, so scaling cannot make it taller — three chips in
 * the 1037px-tall `graphic-only` slot fill 8% of it no matter what, which is
 * precisely the strip §23 reported. The slot's own shape therefore picks the
 * shape of the diagram: whichever orientation fills more of the height wins,
 * subject to legibility floors. Wide, short slots keep the reference's
 * horizontal flow; tall slots get a vertical one.
 */
export function flowMetrics(
  nodes: readonly string[],
  widthPx: number,
  heightPx = Infinity,
): { mode: "row" | "stack"; fontSize: number } {
  const chars = nodes.reduce((acc, n) => acc + n.length, 0);
  const n = Math.max(1, nodes.length);
  // Conservative width model, all ∝ fontSize. Uppercase 900-weight runs
  // ~0.74em/char + 0.04em letter-spacing; chip padding 2×0.8em; arrow =
  // pad 0.55 + glyph ~0.7 + gap 0.55. The old 0.62em/char model was what
  // let real copy wrap at a font the math said fit (FINDINGS §12) —
  // overestimating costs a couple of font px, underestimating breaks layout.
  const CHAR_W = 0.78;
  const CHIP_PAD = 1.6;
  const ARROW_W = 1.8;
  const budget = widthPx - 20; // root padding "0 10px"

  const rowFont = Math.floor(
    Math.min(budget / (CHAR_W * chars + CHIP_PAD * n + ARROW_W * (n - 1)), heightPx / CHIP_H),
  );
  const longest = Math.max(...nodes.map((node) => node.length), 1);
  const stackUnits = CHIP_H * n + ARROW_ROW_H * (n - 1);
  const stackFont = Math.floor(
    Math.min(budget / (CHAR_W * longest + CHIP_PAD), heightPx / stackUnits, MAX_STACK_FONT),
  );

  const rowFits = rowFont >= MIN_ROW_FONT;
  const stackFits = stackFont >= MIN_STACK_FONT;
  if (!stackFits) return { mode: "row", fontSize: Math.max(MIN_ROW_FONT, rowFont) };
  if (!rowFits) return { mode: "stack", fontSize: stackFont };
  // Both are legible — take the one that uses the slot.
  return rowFont * CHIP_H >= stackFont * stackUnits
    ? { mode: "row", fontSize: rowFont }
    : { mode: "stack", fontSize: stackFont };
}

/**
 * Uniform scale that makes a component fill its slot.
 *
 * The component lays out at `slotW / scale` and is then scaled by `scale`, so
 * its rendered width is exactly the slot width while its type grows — three
 * chips end up visibly bigger than six, which is the point of §23. Solved by
 * bisection because the height model depends on the content width, which
 * depends on the scale.
 *
 * Sizes off `props` alone — blind to which elements the edit layer hid
 * (PLAN Task 2's accepted v1 wrinkle; see the call site's own comment in
 * `SceneLayer.tsx` for the full reasoning).
 */
export function fitScale(
  component: SceneComponentId,
  props: Record<string, unknown>,
  slot: { widthPx: number; heightPx: number },
): number {
  // A width-bound component cannot be made taller by scaling — narrowing it
  // shrinks its type by exactly the factor the scale restores. FlowDiagram
  // solves both budgets itself instead.
  if (SELF_FITTING.has(component)) return 1;
  const target = slot.heightPx * FILL_TARGET;
  const fits = (k: number): boolean => estimateHeightPx(component, props, slot.widthPx / k) * k <= target;
  if (!fits(MIN_SCALE)) return MIN_SCALE; // content overflows even shrunk — clip rather than vanish
  // Content that cannot reflow caps the scale outright.
  const minWidth = estimateMinWidthPx(component, props);
  const widthCap = minWidth > 0 ? slot.widthPx / minWidth : MAX_SCALE;
  let lo = MIN_SCALE;
  let hi = Math.max(MIN_SCALE, Math.min(MAX_SCALE, widthCap));
  if (hi <= lo) return lo;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ---- CardRow (§161, plan Task 4) -------------------------------------------

/**
 * Clear space on every side of a full-frame pattern scene, at the 1080 px
 * short edge every composition has (resolution.ts keeps it 1080 and scales
 * the render instead). Scaled by the short edge, so the margin is the same
 * share of the frame in 16:9 and 9:16 — 100 px in both (plan Global
 * Constraints: "keep 100 px clear on all sides").
 */
export const PATTERN_MARGIN_PX = 100;

/** The output frame a full-frame component's box sits in, in pixels. */
export interface PatternFrame {
  width: number;
  height: number;
}

/**
 * The margin of a full-frame pattern scene drawn in a box `widthPx` ×
 * `heightPx` of `frame` (§163): the same share of the box that 100 px is
 * of the frame, by the box's tighter side. On the whole frame it is
 * today's rule exactly — 100 px at the 1080 px short edge, in 16:9 and
 * 9:16 alike — and portrait boxes take the same share rule as landscape:
 * the rule is one ratio, so it has no aspect to special-case. A frame of
 * another short edge keeps the short-edge scaling it always had.
 *
 * Scaled by the frame's share, not the box's short edge: in the bubble box
 * (0.72 × 0.88 of 16:9) the short edge gave 88 px, more air than the full
 * frame gives the tighter side's share of it.
 */
export function patternMarginPx(widthPx: number, heightPx: number, frame: PatternFrame): number {
  const frameMargin = (PATTERN_MARGIN_PX * Math.min(frame.width, frame.height)) / 1080;
  return Math.round(frameMargin * Math.min(widthPx / frame.width, heightPx / frame.height));
}

/**
 * The frame the metrics solve the margin against. Absent, the box IS the
 * frame — what every caller meant before §163 — so `estimateHeightPx` and
 * the tests that pass only a size keep today's margin. `heightPx` is the
 * finite height the metric already settled on.
 */
const marginFrame = (widthPx: number, heightPx: number, frame?: PatternFrame): PatternFrame =>
  frame ?? { width: widthPx, height: heightPx };
/** Between cards, both aspects (plan Task 4, "40 px gap"). */
const CARD_GAP_PX = 40;
/** The `Card` primitive's box, mirrored: 5 px border, padding 36 / 40. */
const CARD_BORDER_PX = 5;
const CARD_PAD_Y_PX = 36;
const CARD_PAD_X_PX = 40;
/**
 * The largest a card is ever drawn: the highlight's `bump` peaks at 1.15
 * (motion.ts), above `popScale`'s ~1.10 overshoot. The layout reserves it,
 * so the margin holds on EVERY frame, not only once the row has settled —
 * an edge card mid-bump would otherwise reach 70 px from the frame.
 */
export const CARD_PEAK_SCALE = 1.15;
/**
 * Widest a card gets in a row or a column. A two-card row at the full width
 * would be two 840 px slabs around a word each; capped, a sparse row sits
 * centred with the slate around it, as the playbook's shots do.
 */
const CARD_MAX_W_ROW = 520;
const CARD_MAX_W_COLUMN = 760;
/** Title and sub-line type: the floor is the playbook's 34 px minimum. */
const CARD_TEXT_MIN_PX = 34;
const CARD_TITLE_MAX_PX = 64;
const CARD_SUB_MAX_PX = 40;
/** Exported so the component sets the line heights this model charges. */
export const CARD_TITLE_LH = 1.1;
export const CARD_SUB_LH = 1.3;
const CARD_ICON_GAP_PX = 18;
const CARD_SUB_GAP_PX = 12;
/** A card's title and sub-line each wrap to at most this many lines. */
const CARD_MAX_LINES = 2;

/**
 * Advance width of a run of Inter at weight 900, in ems, per character
 * class. Conservative like the rest of this file (air rather than overflow):
 * capitals and figures at 0.74, lower case at 0.62, the rest narrower.
 */
function displayWidthEm(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (ch === " ") w += 0.28;
    else if (/[A-Z0-9]/.test(ch)) w += 0.74;
    else if (/[a-z]/.test(ch)) w += 0.62;
    else w += 0.45;
  }
  return w;
}
/** DejaVu Sans Mono's advance is 1233/2048 em; rounded up. */
const monoWidthEm = (text: string): number => [...text].length * 0.61;

/**
 * Lines `text` wraps to in `widthPx` at `fontPx`, greedy on spaces, and
 * whether every word fit on a line of its own. A word wider than the line
 * is broken by the card's `overflowWrap: anywhere` (counted as the lines it
 * takes), but a solve that needs that is rejected while a smaller font
 * would avoid it.
 */
function wrapLines(
  text: string,
  fontPx: number,
  widthPx: number,
  widthEm: (s: string) => number,
): { lines: number; wordsFit: boolean } {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return { lines: 0, wordsFit: true };
  const space = widthEm(" ") * fontPx;
  let lines = 1;
  let used = 0;
  let wordsFit = true;
  for (const word of words) {
    const w = widthEm(word) * fontPx;
    if (w > widthPx) {
      wordsFit = false;
      // The broken word starts its own line(s) and leaves the last one partly full.
      lines += (used > 0 ? 1 : 0) + Math.ceil(w / widthPx) - 1;
      used = w % widthPx;
      continue;
    }
    if (used === 0) used = w;
    else if (used + space + w <= widthPx) used += space + w;
    else {
      lines++;
      used = w;
    }
  }
  return { lines, wordsFit };
}

export interface CardRowMetrics {
  /** One row in a landscape frame, one column in a portrait one. */
  mode: "row" | "column";
  marginPx: number;
  gapPx: number;
  cardWidthPx: number;
  /** Every card's min height — the tallest card's, so the set reads as one. */
  cardHeightPx: number;
  titlePx: number;
  subPx: number;
  /** 0 when no card has an icon. */
  iconPx: number;
  iconGapPx: number;
  subGapPx: number;
  /**
   * Every word of every title (sub-line) fits a line at the solved size. The
   * component then keeps each word whole — a browser otherwise breaks after
   * a hyphen ("--" / "tag"), which this model does not count and a reader
   * does not expect. False only below the floor, where breaking is the
   * lesser evil (`overflowWrap: anywhere`).
   */
  titleWordsFit: boolean;
  subWordsFit: boolean;
  /** The settled row or column, gaps included, before any scale. */
  blockWidthPx: number;
  blockHeightPx: number;
}

/**
 * CardRow's layout, solved against the box it is drawn in: the whole frame,
 * or since §163 its graphic box (it is `fullFrame`, so `widthPx`×`heightPx`
 * is that box, unscaled), with the margin `patternMarginPx` gives the box in
 * `frame`. ONE model for the component and `estimateHeightPx`, the
 * `chatMetrics` rule.
 *
 * Every card gets the same width and the same type, so the set reads as
 * parallel things. The sub-line size is the largest from 40 down to the
 * 34 px floor at which every sub-line fits two lines with no word broken;
 * the title size is the largest from 64 down to 34 at which every title
 * does the same and the tallest card fits the height left after the margin
 * and the peak-scale reserve. Below the floor nothing shrinks further: a
 * sub-line takes a third line, and a word too long for the card breaks
 * rather than leaving it.
 */
export function cardRowMetrics(
  cards: readonly { text: string; sub?: string; icon?: string }[],
  widthPx: number,
  heightPx: number,
  /** The output frame the box sits in (§163); absent, the box is the frame. */
  frame?: PatternFrame,
): CardRowMetrics {
  const n = Math.max(1, cards.length);
  // `estimateHeightPx` may be called with no height budget (Infinity): solve
  // it as a portrait box twice as tall as it is wide, a column with room to
  // spare, so every number below stays finite.
  const finiteH = Number.isFinite(heightPx) ? heightPx : widthPx * 2;
  const mode: CardRowMetrics["mode"] = widthPx >= finiteH ? "row" : "column";
  const marginPx = patternMarginPx(widthPx, finiteH, marginFrame(widthPx, finiteH, frame));
  const gapPx = CARD_GAP_PX;
  const reserve = CARD_PEAK_SCALE - 1;
  const availW = widthPx - 2 * marginPx;
  const availH = finiteH - 2 * marginPx;
  // An edge card at peak scale reaches (reserve / 2) × its size past its box
  // on the outer side, so the run of cards is solved with one `reserve` of a
  // card's size added to it.
  const cardWidthPx = Math.floor(
    mode === "row"
      ? Math.min(CARD_MAX_W_ROW, (availW - gapPx * (n - 1)) / (n + reserve))
      : Math.min(CARD_MAX_W_COLUMN, availW / (1 + reserve)),
  );
  const maxCardH =
    mode === "row" ? availH / (1 + reserve) : (availH - gapPx * (n - 1)) / (n + reserve);
  const innerW = cardWidthPx - 2 * CARD_BORDER_PX - 2 * CARD_PAD_X_PX;
  const hasIcon = cards.some((c) => c.icon !== undefined && c.icon !== "" && c.icon !== "none");

  // The sub-line is solved on its own, then held under the title: a
  // 24-character mono line can need three lines at the floor in a four-card
  // row, and coupling the two would drag every title to the floor with it
  // when only the sub-line could not do better.
  const subFits = (subPx: number): boolean =>
    cards.every((c) => {
      if (!c.sub) return true;
      const sub = wrapLines(c.sub, subPx, innerW, monoWidthEm);
      return sub.wordsFit && sub.lines <= CARD_MAX_LINES;
    });
  let subBest = CARD_SUB_MAX_PX;
  while (subBest > CARD_TEXT_MIN_PX && !subFits(subBest)) subBest -= 1;

  const solve = (titlePx: number) => {
    const subPx = Math.max(CARD_TEXT_MIN_PX, Math.min(subBest, Math.round(titlePx * 0.62)));
    // The icons are 24-unit line drawings with a 2-unit stroke, so they read
    // light; drawn at ~1.25× the title they balance it (stills, plan Task 4).
    const iconPx = hasIcon ? Math.max(56, Math.min(80, Math.round(titlePx * 1.25))) : 0;
    let fits = true;
    let tallest = 0;
    for (const card of cards) {
      const title = wrapLines(card.text, titlePx, innerW, displayWidthEm);
      const sub = card.sub ? wrapLines(card.sub, subPx, innerW, monoWidthEm) : null;
      if (!title.wordsFit || title.lines > CARD_MAX_LINES) fits = false;
      const iconH = card.icon && card.icon !== "none" ? iconPx + CARD_ICON_GAP_PX : 0;
      const h =
        2 * (CARD_BORDER_PX + CARD_PAD_Y_PX) +
        iconH +
        Math.max(1, title.lines) * titlePx * CARD_TITLE_LH +
        (sub && sub.lines > 0 ? CARD_SUB_GAP_PX + sub.lines * subPx * CARD_SUB_LH : 0);
      tallest = Math.max(tallest, h);
    }
    return { subPx, iconPx, tallest: Math.ceil(tallest), fits: fits && tallest <= maxCardH };
  };

  let titlePx = CARD_TITLE_MAX_PX;
  let solved = solve(titlePx);
  while (!solved.fits && titlePx > CARD_TEXT_MIN_PX) {
    titlePx -= 1;
    solved = solve(titlePx);
  }
  const cardHeightPx = solved.tallest;
  const wordsFit = (field: "text" | "sub", px: number, widthEm: (s: string) => number) =>
    cards.every((c) => wrapLines(c[field] ?? "", px, innerW, widthEm).wordsFit);
  return {
    mode,
    marginPx,
    gapPx,
    cardWidthPx,
    cardHeightPx,
    titlePx,
    subPx: solved.subPx,
    iconPx: solved.iconPx,
    iconGapPx: CARD_ICON_GAP_PX,
    subGapPx: CARD_SUB_GAP_PX,
    titleWordsFit: wordsFit("text", titlePx, displayWidthEm),
    subWordsFit: wordsFit("sub", solved.subPx, monoWidthEm),
    blockWidthPx: mode === "row" ? n * cardWidthPx + gapPx * (n - 1) : cardWidthPx,
    blockHeightPx: mode === "row" ? cardHeightPx : n * cardHeightPx + gapPx * (n - 1),
  };
}

// ---- CtaCard (§161, plan Task 5) -------------------------------------------

/**
 * `displayWidthEm` with M and W charged at their real width. CardRow's 0.74
 * for every capital is an average, and the first comment-dense still showed
 * where an average fails: "COMMENTPROMPTNOW" (three Ms, a W) set ~4% wider
 * than modelled, filled its 9:16 box exactly, and pushed the caret onto a
 * line of its own. A one-word field has no spaces to absorb the error, so
 * the CtaCard model charges Inter ExtraBold's wide letters what they take.
 */
function ctaDisplayWidthEm(text: string): number {
  let extra = 0;
  for (const ch of text) if (/[MWmw]/.test(ch)) extra += 0.3;
  return displayWidthEm(text) + extra;
}

/** CtaCardProps' shape, as the metric reads it (no zod in this module). */
export interface CtaCardInput {
  action: "comment" | "subscribe" | "link";
  text: string;
  keyword?: string;
  channel?: string;
}

/**
 * What the card shows, decided once for the component and the metric. The
 * button words are fixed UI, not planner copy: they are the platform's
 * labels the viewer is asked to press, so they never pass through an LLM.
 */
export const SEND_LABEL = "Send";
export const SUBSCRIBE_LABEL = "Subscribe";
export const SUBSCRIBED_LABEL = "Subscribed";

export interface CtaContent {
  /** Above the action row; null when the row itself carries `text`. */
  headline: string | null;
  /** The comment typed, or the URL in the bar; null when there is none. */
  field: string | null;
  /** The prop `field` came from, so the editor retypes the right one. */
  fieldId: "text" | "keyword" | null;
  /** Beside the Subscribe button; null shows the button alone. */
  channel: string | null;
}

/**
 * The plan's "keyword (or text when there is no keyword) is typed": a
 * comment with no keyword types the headline itself, so the headline is
 * not drawn twice. An empty string is no value (`keyword` and `channel`
 * have no `min`), and a field the action does not use is ignored rather
 * than drawn — a `channel` on a comment card has nowhere honest to sit.
 */
export function ctaContent(p: CtaCardInput): CtaContent {
  const keyword = p.keyword ? p.keyword : null;
  switch (p.action) {
    case "comment":
      return keyword
        ? { headline: p.text, field: keyword, fieldId: "keyword", channel: null }
        : { headline: null, field: p.text, fieldId: "text", channel: null };
    case "subscribe":
      return { headline: p.text, field: null, fieldId: null, channel: p.channel ? p.channel : null };
    case "link":
      return { headline: p.text, field: keyword, fieldId: keyword ? "keyword" : null, channel: null };
  }
}

/**
 * The most the WHOLE card is ever drawn at: `popScale`'s overshoot, which
 * easeOutBack puts a hair over 1.10 (1.100004; motion.ts, asserted in
 * fit.test.ts), rounded up so the bound holds rather than nearly holds.
 * The button `bump`s (1.15) happen inside the card's 40 px padding once the
 * card has settled, so they grow no box the margin has to hold.
 */
export const CTA_PEAK_SCALE = 1.11;
/** The `bump` peak, for the in-card check that a pressed button stays inside the padding. */
export const CTA_BUTTON_PEAK_SCALE = 1.15;
/**
 * The card's width bounds. Sized to its content between them, so a short
 * headline over one button is a card, not a 1240 px slab with a word in it
 * (CardRow's cap, for its reason); the floor keeps a comment box looking
 * like a field even around a five-letter word.
 */
const CTA_MAX_W = 1240;
const CTA_MIN_W = 760;
/** Type: 34 px is the playbook floor for display text, 26 px for mono. */
const CTA_TEXT_MIN_PX = 34;
const CTA_MONO_MIN_PX = 26;
const CTA_HEAD_MAX_PX = 72;
const CTA_ACTION_MAX_PX = 56;
const CTA_HEAD_MAX_LINES = 2;
/** Exported so the component sets the line heights this model charges. */
export const CTA_HEAD_LH = 1.1;
export const CTA_ACTION_LH = 1.2;
export const CTA_BUTTON_LH = 1.1;
/** The action row's largest size, as a share of the headline's. */
const CTA_ROW_TO_HEAD = 0.8;
/** Headline to action row, and between a row's parts. */
export const CTA_ROW_GAP_PX = 36;
export const CTA_ITEM_GAP_PX = 24;
/**
 * The comment box and the URL bar share one chrome: padding inside a 3 px
 * `cardBorder` rim. The bar had no rim in the first link still, and
 * `terminalBg` on `cardBg` (#0F1320 on #14161C) all but vanished.
 */
export const CTA_BOX_PAD_X_PX = 28;
export const CTA_BOX_PAD_Y_PX = 18;
export const CTA_BOX_BORDER_PX = 3;
/** The block caret beside the typed text: its width and its gap, in ems. */
export const CTA_CARET_EM = 0.55;
export const CTA_CARET_GAP_PX = 4;

export interface CtaCardMetrics {
  /**
   * `subscribe` only: the channel beside the button in a landscape frame,
   * above it in a portrait one, where a 24-character name beside the
   * button would wrap to three lines.
   */
  mode: "row" | "column";
  marginPx: number;
  cardWidthPx: number;
  cardHeightPx: number;
  headPx: number;
  /** Lines the headline wraps to; 0 when there is no headline. */
  headLines: number;
  headWordsFit: boolean;
  /** The typed comment, the channel, or (mono) the URL. */
  actionPx: number;
  /** Lines the field or channel wraps to — the comment box's held height. */
  actionLines: number;
  actionWordsFit: boolean;
  labelPx: number;
  buttonPadXPx: number;
  buttonPadYPx: number;
  /**
   * Fixed for the scene: the Subscribe button is as wide as "Subscribed"
   * plus its tick, so the press changes the label, not the row.
   */
  buttonWidthPx: number;
  buttonHeightPx: number;
  /** The tick in front of "Subscribed", and its gap to the label. */
  tickPx: number;
  tickGapPx: number;
  /** The channel's round avatar, and the icon inside it. */
  avatarPx: number;
  /** The avatar's icon, or the URL bar's. */
  iconPx: number;
  caretWidthPx: number;
  blockWidthPx: number;
  blockHeightPx: number;
}

/**
 * CtaCard's layout, solved against the box it is drawn in (the whole frame,
 * or its graphic box, §163; `cardRowMetrics`' rule). ONE model for the
 * component and `estimateHeightPx`, and the same reserves: the margin
 * (100 px on the whole frame, `patternMarginPx`), plus the pop's overshoot
 * around a centred card.
 *
 * The card is as wide as its content set on one line at the largest sizes,
 * between `CTA_MIN_W` and the frame's room. When that is the frame's room,
 * the action row's size comes down from 56 until it fits (the comment on
 * one line when it is a keyword, two when it is the headline; the channel
 * on two; the URL on one, in mono down to 26), then the headline's from 72
 * until it takes two lines with no word broken and the card fits the
 * height. Below the floors nothing shrinks further: a 40-character comment
 * in a 9:16 box takes a third line at 34 px (the box is held at the height
 * the metric reports), and a word too long for its box breaks
 * (`overflowWrap: anywhere`) rather than leaving it.
 */
export function ctaCardMetrics(
  p: CtaCardInput,
  widthPx: number,
  heightPx: number,
  /** The output frame the box sits in (§163); absent, the box is the frame. */
  frame?: PatternFrame,
): CtaCardMetrics {
  const content = ctaContent(p);
  // `estimateHeightPx` may be called with no height budget (Infinity):
  // solve it as a portrait box twice as tall as it is wide, as cardRowMetrics does.
  const finiteH = Number.isFinite(heightPx) ? heightPx : widthPx * 2;
  const mode: CtaCardMetrics["mode"] = widthPx >= finiteH ? "row" : "column";
  const marginPx = patternMarginPx(widthPx, finiteH, marginFrame(widthPx, finiteH, frame));
  const reserve = CTA_PEAK_SCALE - 1;
  const availW = widthPx - 2 * marginPx;
  const availH = finiteH - 2 * marginPx;
  const maxW = Math.floor(Math.min(CTA_MAX_W, availW / (1 + reserve)));
  const maxCardH = availH / (1 + reserve);
  const chromeX = 2 * (CARD_BORDER_PX + CARD_PAD_X_PX);
  const chromeY = 2 * (CARD_BORDER_PX + CARD_PAD_Y_PX);
  const isLink = p.action === "link";
  const minActionPx = isLink ? CTA_MONO_MIN_PX : CTA_TEXT_MIN_PX;

  // Everything below that depends on the action size, in one place.
  const parts = (actionPx: number) => {
    const labelPx = Math.max(CTA_TEXT_MIN_PX, Math.round(actionPx * 0.75));
    const buttonPadXPx = Math.round(labelPx * 0.75);
    const buttonPadYPx = Math.round(labelPx * 0.4);
    const tickPx = labelPx;
    const tickGapPx = Math.round(labelPx * 0.4);
    const buttonWidthPx = Math.ceil(
      2 * buttonPadXPx +
        (p.action === "comment"
          ? labelPx * ctaDisplayWidthEm(SEND_LABEL)
          : Math.max(
              labelPx * ctaDisplayWidthEm(SUBSCRIBE_LABEL),
              tickPx + tickGapPx + labelPx * ctaDisplayWidthEm(SUBSCRIBED_LABEL),
            )),
    );
    const buttonHeightPx = Math.ceil(labelPx * CTA_BUTTON_LH + 2 * buttonPadYPx);
    const avatarPx = Math.round(actionPx * 1.6);
    const iconPx = isLink ? actionPx : Math.round(avatarPx * 0.6);
    const caretWidthPx = Math.round(actionPx * CTA_CARET_EM);
    // Chrome around the text in the row, so `fieldW(innerW)` is the text's own line.
    const around =
      p.action === "comment"
        ? 2 * (CTA_BOX_PAD_X_PX + CTA_BOX_BORDER_PX) +
          caretWidthPx +
          CTA_CARET_GAP_PX +
          CTA_ITEM_GAP_PX +
          buttonWidthPx
        : p.action === "subscribe"
          ? avatarPx + CTA_ITEM_GAP_PX + (mode === "row" ? CTA_ITEM_GAP_PX + buttonWidthPx : 0)
          : 2 * (CTA_BOX_PAD_X_PX + CTA_BOX_BORDER_PX) + iconPx + CTA_ITEM_GAP_PX;
    return {
      labelPx,
      buttonPadXPx,
      buttonPadYPx,
      tickPx,
      tickGapPx,
      buttonWidthPx,
      buttonHeightPx,
      avatarPx,
      iconPx,
      caretWidthPx,
      around,
    };
  };

  const rowText = p.action === "subscribe" ? content.channel : content.field;
  const widthEm = isLink ? monoWidthEm : ctaDisplayWidthEm;
  // The comment box holds the headline-length text on two lines; a keyword,
  // a URL, is one line; a channel name may take two beside its avatar.
  const rowMaxLines = p.action === "comment" ? (content.fieldId === "keyword" ? 1 : 2) : isLink ? 1 : 2;

  // Natural width: the content on one line at the largest sizes.
  const big = parts(CTA_ACTION_MAX_PX);
  const rowNatural =
    p.action === "subscribe" && rowText === null
      ? big.buttonWidthPx
      : p.action === "subscribe" && mode === "column"
        ? Math.max(big.buttonWidthPx, big.around + widthEm(rowText ?? "") * CTA_ACTION_MAX_PX)
        : rowText === null
          ? 0
          : big.around + widthEm(rowText) * CTA_ACTION_MAX_PX;
  const headNatural = content.headline ? ctaDisplayWidthEm(content.headline) * CTA_HEAD_MAX_PX : 0;
  const cardWidthPx = Math.min(
    maxW,
    Math.max(Math.min(CTA_MIN_W, maxW), Math.ceil(Math.max(rowNatural, headNatural)) + chromeX),
  );
  const innerW = cardWidthPx - chromeX;

  const rowAt = (actionPx: number) => {
    const q = parts(actionPx);
    const wrap =
      rowText === null
        ? { lines: 0, wordsFit: true }
        : wrapLines(rowText, actionPx, innerW - q.around, widthEm);
    const textH = wrap.lines * actionPx * CTA_ACTION_LH;
    let rowH: number;
    if (p.action === "comment") {
      rowH = Math.max(textH + 2 * (CTA_BOX_PAD_Y_PX + CTA_BOX_BORDER_PX), q.buttonHeightPx);
    } else if (p.action === "subscribe") {
      const channelH = rowText === null ? 0 : Math.max(q.avatarPx, textH);
      rowH =
        rowText === null
          ? q.buttonHeightPx
          : mode === "row"
            ? Math.max(channelH, q.buttonHeightPx)
            : channelH + CTA_ITEM_GAP_PX + q.buttonHeightPx;
    } else {
      rowH = rowText === null ? 0 : Math.max(textH, q.iconPx) + 2 * (CTA_BOX_PAD_Y_PX + CTA_BOX_BORDER_PX);
    }
    const fits = wrap.wordsFit && wrap.lines <= rowMaxLines;
    return { q, wrap, rowH, fits };
  };
  let actionPx = CTA_ACTION_MAX_PX;
  let row = rowAt(actionPx);
  while (!row.fits && actionPx > minActionPx) {
    actionPx -= 1;
    row = rowAt(actionPx);
  }

  const headAt = (headPx: number) => {
    const wrap = content.headline
      ? wrapLines(content.headline, headPx, innerW, ctaDisplayWidthEm)
      : { lines: 0, wordsFit: true };
    const headH = wrap.lines * headPx * CTA_HEAD_LH;
    const gap = wrap.lines > 0 && row.rowH > 0 ? CTA_ROW_GAP_PX : 0;
    const cardH = Math.ceil(chromeY + headH + gap + row.rowH);
    const fits = wrap.wordsFit && wrap.lines <= CTA_HEAD_MAX_LINES && cardH <= maxCardH;
    return { wrap, cardH, fits };
  };
  let headPx = CTA_HEAD_MAX_PX;
  let head = headAt(headPx);
  while (!head.fits && headPx > CTA_TEXT_MIN_PX) {
    headPx -= 1;
    head = headAt(headPx);
  }
  // The row never outgrows its headline (CardRow's sub-line rule): solved
  // alone, a 9:16 channel name came out at 56 px under a 46 px headline
  // and read as the card's subject. Brought down after the fact, so the
  // headline keeps the size it solved for; a smaller row only frees height.
  const rowCap = Math.max(minActionPx, Math.round(headPx * CTA_ROW_TO_HEAD));
  if (content.headline !== null && actionPx > rowCap) {
    actionPx = rowCap;
    row = rowAt(actionPx);
    head = headAt(headPx);
  }

  const q = row.q;
  return {
    mode,
    marginPx,
    cardWidthPx,
    cardHeightPx: head.cardH,
    headPx,
    headLines: head.wrap.lines,
    headWordsFit: head.wrap.wordsFit,
    actionPx,
    actionLines: row.wrap.lines,
    actionWordsFit: row.wrap.wordsFit,
    labelPx: q.labelPx,
    buttonPadXPx: q.buttonPadXPx,
    buttonPadYPx: q.buttonPadYPx,
    buttonWidthPx: q.buttonWidthPx,
    buttonHeightPx: q.buttonHeightPx,
    tickPx: q.tickPx,
    tickGapPx: q.tickGapPx,
    avatarPx: q.avatarPx,
    iconPx: q.iconPx,
    caretWidthPx: q.caretWidthPx,
    blockWidthPx: cardWidthPx,
    blockHeightPx: head.cardH,
  };
}

// ---- BugCard (§161, plan Task 6) -------------------------------------------

/** The box's shape, as BugCard reads it: the mock is drawn only in a landscape box (the whole frame, or its graphic box, §163). */
export type BugAspect = "16:9" | "9:16";

/** BugCardProps' shape after parsing, as the metric reads it (no zod in this module). */
export interface BugCardInput {
  number: number;
  headline: string;
  sub?: string;
  mock: "none" | "caption" | "lines";
  mockLines: readonly string[];
  mockWrong?: number;
  mockFault: "struck" | "clipped";
  sticker?: string;
}

/** Landscape or portrait, by the box it is drawn in — `ctaCardMetrics`' row/column test. */
export function bugAspect(widthPx: number, heightPx: number): BugAspect {
  const finiteH = Number.isFinite(heightPx) ? heightPx : widthPx * 2;
  return widthPx >= finiteH ? "16:9" : "9:16";
}

/**
 * Whether the mock panel is drawn (plan Task 6): not for `mock: "none"`, not
 * for a mock with nothing to show, and never in 9:16, where a second panel
 * beside the text would leave each too narrow to read and one under it would
 * push the text panel off its centre. "Nothing to show" is every entry blank,
 * not only an empty list: a panel of blank caption words is an empty box.
 */
export function bugMockVisible(
  p: Pick<BugCardInput, "mock" | "mockLines">,
  aspect: BugAspect,
): boolean {
  if (aspect === "9:16" || p.mock === "none") return false;
  return p.mockLines.some((l) => l.trim().length > 0);
}

/**
 * The entry `mockWrong` marks, or null when it marks nothing: absent, past
 * the end of `mockLines` (the schema caps both at four, not at each other),
 * or a blank entry, which has no word to strike and no code to turn red.
 */
export function bugWrongIndex(p: Pick<BugCardInput, "mockLines" | "mockWrong">): number | null {
  const i = p.mockWrong;
  if (i === undefined || !Number.isInteger(i) || i < 0 || i >= p.mockLines.length) return null;
  return (p.mockLines[i] ?? "").trim().length > 0 ? i : null;
}

/** Case and surrounding whitespace and punctuation off, so "Wipes captions." and "WIPES CAPTIONS!" compare equal. */
const stickerKey = (s: string): string => s.toLowerCase().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");

/**
 * The sticker as drawn, or null for none: an empty one, or one that repeats
 * `sub`, ignoring case and surrounding punctuation. The acceptance run's
 * planner (§161) wrote the consequence into both, and a sticker that says
 * the line under the headline again is not a beat. One function for the
 * metric and the component, so a dropped sticker reserves no room either.
 */
export function bugStickerText(p: Pick<BugCardInput, "sub" | "sticker">): string | null {
  if (!p.sticker) return null;
  if (p.sub && stickerKey(p.sticker) === stickerKey(p.sub)) return null;
  return p.sticker;
}

/**
 * The most a panel (and the badge inside it) is drawn at: `popScale`'s
 * overshoot, a hair over 1.10, rounded up as `CTA_PEAK_SCALE` is. The two
 * panels pop 1.1 s apart (`bugTimeline`), so the gap between them only ever
 * holds one panel's growth at a time.
 */
export const BUG_PEAK_SCALE = 1.11;
/** The sticker lands with a `bump`, which peaks at 1.15 (motion.ts). */
export const BUG_STICKER_PEAK_SCALE = 1.15;
/** Between the text panel and the mock in 16:9. */
export const BUG_PANEL_GAP_PX = 64;
/**
 * A lone text panel (no mock, or 9:16) is as wide as its headline at the
 * largest size, between these: CtaCard's rule, for its reason.
 */
const BUG_SINGLE_MAX_W = 1240;
const BUG_SINGLE_MIN_W = 640;
/** Type: 34 px is the playbook floor for display text, 26 px for mono. */
const BUG_TEXT_MIN_PX = 34;
const BUG_MONO_MIN_PX = 26;
const BUG_HEAD_MAX_PX = 72;
const BUG_SUB_MAX_PX = 48;
/** The consequence never outgrows the headline it qualifies (CtaCard's row rule). */
const BUG_SUB_TO_HEAD = 0.75;
/** "Two-line headline" (the playbook); the sub-line is held to two as well. */
const BUG_MAX_LINES = 2;
/** Exported so the component sets the line heights this model charges. */
export const BUG_HEAD_LH = 1.08;
export const BUG_SUB_LH = 1.15;
export const BUG_SUB_GAP_PX = 16;
/** Badge to headline. */
export const BUG_BADGE_GAP_PX = 28;
/**
 * The badge is a little taller than a headline line, so it reads as the
 * marker of the line it sits beside; never under 64 px, where its numeral
 * (0.58 of the disc, `NumberBadge`) would drop under the 34 px floor.
 */
const BUG_BADGE_MIN_PX = 64;
const BUG_BADGE_TO_HEAD = 1.3;
/**
 * Caption mock: big display words in one row, two when they need it. One
 * row is worth some size — a caption is one line on screen, and the first
 * struck still wrapped "Ask Cloud to / refactor" at 64 px with the row a
 * word short — so one row is tried down to 40 px before two rows are
 * allowed from 64 again. A clipped caption must also fit its row whole
 * before the fault (`runFits`): the second clipped still, at 56 px, had
 * "migration" cut by a letter before it ever slid, so the fault had no
 * intact caption to break.
 */
const BUG_CAP_MAX_PX = 64;
const BUG_CAP_ONE_ROW_MIN_PX = 40;
const BUG_CAP_MAX_ROWS = 2;
export const BUG_CAP_LH = 1.15;
export const BUG_CAP_ROW_GAP_PX = 12;
export const BUG_CAP_WORD_GAP_EM = 0.3;
/**
 * The caption outline, as a share of the type: 0.14 em is ~9 px at 64 px,
 * the playbook's "10 to 12 px outline" scaled down to a mock's caption.
 */
export const BUG_CAP_STROKE_EM = 0.14;
/** The strike line's thickness. */
export const BUG_STRIKE_EM = 0.12;
/** How much of a clipped word is still in view once it has slid: half, so it reads as a word cut off. */
export const BUG_CLIP_VISIBLE = 0.5;
/** Lines mock: mono, one line per entry. */
const BUG_LINE_MAX_PX = 40;
export const BUG_LINE_LH = 1.35;
export const BUG_LINE_GAP_PX = 10;
/** The cross before the wrong line, in ems of the line, and its gap to the text. */
export const BUG_MARK_EM = 0.9;
export const BUG_MARK_GAP_PX = 16;
/**
 * The sticker: one size in both aspects, so its box — which the panels'
 * height budget reserves below them — is known before any type is solved.
 * 40 px clears the 34 px floor with the tilt's soft edges to spare.
 */
export const BUG_STICKER_PX = 40;
export const BUG_STICKER_TILT_DEG = -4;
/**
 * The sticker straddles the anchor panel's bottom edge near its right
 * corner: its top this far above the edge, its right end this far past the
 * panel's side. 16 px keeps the tilted sticker, at its bump peak, inside
 * the panel's 41 px of padding and border — off the mock's content, so it
 * never covers the fault it is commenting on (asserted in fit.test.ts).
 */
const BUG_STICKER_TUCK_PX = 16;
const BUG_STICKER_OVERHANG_PX = 24;
/** The `Sticker` primitive's box, mirrored: padding 0.25 / 0.55 em, a 5 px rim, line height 1.1. */
const STICKER_BORDER_PX = 5;

export interface BugRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BugCardMetrics {
  aspect: BugAspect;
  /** Text panel left and mock right (16:9 with a mock), or the text panel alone, centred. */
  mode: "split" | "single";
  marginPx: number;
  /** Rest boxes in frame pixels; each panel pops about its own centre. */
  textPanel: BugRect;
  badgePx: number;
  /** Pushes the badge down when a headline line is taller than it… */
  badgeOffsetPx: number;
  /** …or the headline down when the badge is taller, so the two share a centre line. */
  headOffsetPx: number;
  headPx: number;
  headLines: number;
  headWordsFit: boolean;
  /** 0 when there is no sub. */
  subPx: number;
  subLines: number;
  subWordsFit: boolean;
  /** Null when the mock is not drawn (`bugMockVisible`). */
  mockPanel: BugRect | null;
  /** `mockWrong` as drawn (`bugWrongIndex`); null when nothing is marked. */
  wrongIndex: number | null;
  /** Caption mock; 0 / empty otherwise. */
  capPx: number;
  capStrokePx: number;
  capWordGapPx: number;
  /** Entry indices per row, blanks left out; rows are drawn as laid out here, never re-wrapped. */
  capRows: number[][];
  /** Per entry: it fits a row, so it is drawn unbroken. */
  capUnitFits: boolean[];
  /**
   * The clipped fault's row: the wrong word and those after it, sliding
   * right until half the wrong word is past the panel's edge. Drawn as a
   * row this wide whose free space a spacer before the wrong word grows
   * into (`flexGrow` = the slide's progress), so the word's END position is
   * set from the panel's edge, which is exact, and not from the words before
   * it, which this model can only over-measure: the first clipped still,
   * which slid by a modelled offset, left "migratio" of "migration" in view.
   * 0 when there is no clipped fault.
   */
  clipRowWidthPx: number;
  /** The row `clipRowWidthPx` applies to; -1 when there is none. */
  clipRow: number;
  /** Lines mock; 0 / empty otherwise. */
  linePx: number;
  /** Per line: it fits the panel unwrapped. */
  lineFits: boolean[];
  markPx: number;
  /** Space before every line for the cross, so the lines stay aligned; 0 when nothing is marked. */
  gutterPx: number;
  /** Content height inside each panel (centred in it), for the sticker's clearance check. */
  textContentPx: number;
  mockContentPx: number;
  /** The sticker's centre and unrotated box; null without a sticker. */
  sticker: { cx: number; cy: number; w: number; h: number; sizePx: number } | null;
  blockWidthPx: number;
  blockHeightPx: number;
}

/** Caption entries laid out in rows of whole words (the `wrapLines` rule, one entry per unit). */
function bugCaptionLayout(
  units: readonly string[],
  capPx: number,
  innerW: number,
  clipEdgePx: number,
  wrong: number | null,
  clipped: boolean,
): {
  rows: number[][];
  visualRows: number;
  unitFits: boolean[];
  allFit: boolean;
  /** The clipped row, wrong word and all, fits inside the panel before it slides. */
  runFits: boolean;
  clipRowWidthPx: number;
  clipRow: number;
} {
  // Rounded as the component rounds it (`capWordGapPx`), so a row's sum is the drawn one.
  const gap = Math.round(BUG_CAP_WORD_GAP_EM * capPx);
  const width = (u: string) => ctaDisplayWidthEm(u) * capPx;
  const unitFits = units.map((u) => width(u) <= innerW);
  const rows: number[][] = [];
  let cur: number[] = [];
  let used = 0;
  let allFit = true;
  let clipRow = -1;
  let runPx = 0;
  const runOff = clipped && wrong !== null;
  for (let i = 0; i < units.length; i++) {
    const u = units[i] ?? "";
    if (u.trim().length === 0) continue;
    const w = width(u);
    if (runOff && i >= wrong) {
      // The clipped fault: from the wrong word on, the caption stays on one
      // row and runs past the panel's edge, the way a caption that is too
      // long for the frame does. The wrong word starts a new row only when
      // the one it would join has no room left to show half of it.
      if (i === wrong && cur.length > 0 && clipEdgePx - (used + gap) < BUG_CLIP_VISIBLE * w) {
        rows.push(cur);
        cur = [];
        used = 0;
      }
      if (i === wrong) {
        clipRow = rows.length;
        // Settled, the wrong word's left edge is `BUG_CLIP_VISIBLE` of it
        // short of the edge, and the words after it follow at their gaps.
        runPx = clipEdgePx + (1 - BUG_CLIP_VISIBLE) * w;
      } else {
        runPx += gap + w;
      }
      used = cur.length > 0 ? used + gap + w : w;
      cur.push(i);
      continue;
    }
    if (!unitFits[i]) {
      // Wider than a row even alone: it takes rows of its own and breaks
      // inside them (`wrapLines` counts them), rather than leaving the panel.
      allFit = false;
      if (cur.length > 0) rows.push(cur);
      rows.push([i]);
      cur = [];
      used = 0;
      continue;
    }
    if (cur.length === 0) {
      cur = [i];
      used = w;
    } else if (used + gap + w <= innerW) {
      cur.push(i);
      used += gap + w;
    } else {
      rows.push(cur);
      cur = [i];
      used = w;
    }
  }
  if (cur.length > 0) rows.push(cur);
  const clipRowUnits = clipRow >= 0 ? (rows[clipRow] ?? []) : [];
  const runFits =
    clipRowUnits.reduce((a, i, j) => a + (j > 0 ? gap : 0) + width(units[i] ?? ""), 0) <= innerW;
  let visualRows = 0;
  for (const row of rows) {
    const only = row.length === 1 ? row[0]! : -1;
    visualRows +=
      only >= 0 && !unitFits[only] && !(runOff && only >= wrong!)
        ? wrapLines(units[only] ?? "", capPx, innerW, ctaDisplayWidthEm).lines
        : 1;
  }
  return { rows, visualRows, unitFits, allFit, runFits, clipRowWidthPx: Math.ceil(runPx), clipRow };
}

/**
 * BugCard's layout, solved against the box it is drawn in (the whole frame,
 * or its graphic box, §163), ONE model for the component and
 * `estimateHeightPx` (the `cardRowMetrics` rule), with the same reserves:
 * the margin (100 px on the whole frame, `patternMarginPx`), the pop's
 * overshoot around each panel, and the sticker's bump. The mock is drawn
 * when the BOX is at least as wide as it is tall (`bugAspect`): a wide band
 * below the face is landscape room, whatever the frame.
 *
 * 16:9 with a mock: two panels of one width side by side, as tall as the
 * taller one, so they read as a pair. Otherwise the text panel alone,
 * centred, as wide as its headline at 72 px between 640 px and the room.
 * The headline's size comes down from 72 until it takes two lines with no
 * word broken and the panel fits the height left after the sticker; the
 * sub-line's from 48 (never above 0.75 of the headline) until it takes two.
 * The caption's from 64 until its words fill at most two rows; the code
 * lines' from 40 until each fits unwrapped. Below the floors nothing
 * shrinks further: a line wraps, a word too long for its row breaks.
 *
 * The sticker straddles the bottom edge of the mock (or of the text panel
 * when there is no mock) near its right corner, pulled in where its peak
 * would reach the margin. Widths use `ctaDisplayWidthEm`, which charges M
 * and W their real width: a caption word is one unbroken unit, the case
 * where CardRow's flat 0.74 under-measured (CtaCard's comment-dense still).
 */
export function bugCardMetrics(
  p: BugCardInput,
  widthPx: number,
  heightPx: number,
  /** The output frame the box sits in (§163); absent, the box is the frame. */
  frame?: PatternFrame,
): BugCardMetrics {
  const finiteH = Number.isFinite(heightPx) ? heightPx : widthPx * 2;
  const aspect = bugAspect(widthPx, finiteH);
  const showMock = bugMockVisible(p, aspect);
  const mode: BugCardMetrics["mode"] = showMock ? "split" : "single";
  const wrongIndex = showMock ? bugWrongIndex(p) : null;
  const marginPx = patternMarginPx(widthPx, finiteH, marginFrame(widthPx, finiteH, frame));
  const reserve = BUG_PEAK_SCALE - 1;
  const availW = widthPx - 2 * marginPx;
  const availH = finiteH - 2 * marginPx;
  const chromeX = 2 * (CARD_BORDER_PX + CARD_PAD_X_PX);
  const chromeY = 2 * (CARD_BORDER_PX + CARD_PAD_Y_PX);
  const sub = p.sub ? p.sub : null;

  // The sticker's box first: the panels' height budget reserves what of it
  // hangs below them.
  const drawn = bugStickerText(p);
  const stickerText = drawn !== null ? drawn.toUpperCase() : null;
  const sPx = BUG_STICKER_PX;
  const sW = stickerText
    ? Math.ceil(ctaDisplayWidthEm(stickerText) * sPx + 2 * Math.round(sPx * 0.55) + 2 * STICKER_BORDER_PX)
    : 0;
  const sH = stickerText ? Math.ceil(sPx * 1.1 + 2 * Math.round(sPx * 0.25) + 2 * STICKER_BORDER_PX) : 0;
  const tilt = (Math.abs(BUG_STICKER_TILT_DEG) * Math.PI) / 180;
  // The tilted box's bounds at the bump's peak, about its centre.
  const sPeakW = (sW * Math.cos(tilt) + sH * Math.sin(tilt)) * BUG_STICKER_PEAK_SCALE;
  const sPeakH = (sW * Math.sin(tilt) + sH * Math.cos(tilt)) * BUG_STICKER_PEAK_SCALE;
  const stickerHang = stickerText ? -BUG_STICKER_TUCK_PX + sH / 2 + sPeakH / 2 : 0;
  const maxPanelH = (availH - Math.max(0, stickerHang)) / (1 + reserve);

  // Panel width.
  let panelW: number;
  if (mode === "split") {
    // Outer edges carry half the pop's growth each; the gap holds one panel's.
    panelW = Math.floor((availW - BUG_PANEL_GAP_PX) / (2 + reserve));
  } else {
    const maxW = Math.floor(Math.min(BUG_SINGLE_MAX_W, availW / (1 + reserve)));
    const badgeBig = Math.max(BUG_BADGE_MIN_PX, Math.round(BUG_HEAD_MAX_PX * BUG_BADGE_TO_HEAD));
    const headNatural = ctaDisplayWidthEm(p.headline) * BUG_HEAD_MAX_PX;
    const subNatural = sub ? ctaDisplayWidthEm(sub) * BUG_SUB_MAX_PX : 0;
    const natural = Math.ceil(Math.max(headNatural, subNatural)) + badgeBig + BUG_BADGE_GAP_PX + chromeX;
    panelW = Math.min(maxW, Math.max(Math.min(BUG_SINGLE_MIN_W, maxW), natural));
  }
  const innerW = panelW - chromeX;

  // The text panel.
  const textAt = (headPx: number) => {
    const badgePx = Math.max(BUG_BADGE_MIN_PX, Math.round(headPx * BUG_BADGE_TO_HEAD));
    const colW = innerW - badgePx - BUG_BADGE_GAP_PX;
    const head = wrapLines(p.headline, headPx, colW, ctaDisplayWidthEm);
    let subPx = 0;
    let subWrap = { lines: 0, wordsFit: true };
    if (sub) {
      subPx = Math.max(BUG_TEXT_MIN_PX, Math.min(BUG_SUB_MAX_PX, Math.round(headPx * BUG_SUB_TO_HEAD)));
      subWrap = wrapLines(sub, subPx, colW, ctaDisplayWidthEm);
      while (subPx > BUG_TEXT_MIN_PX && !(subWrap.wordsFit && subWrap.lines <= BUG_MAX_LINES)) {
        subPx -= 1;
        subWrap = wrapLines(sub, subPx, colW, ctaDisplayWidthEm);
      }
    }
    const lineH = headPx * BUG_HEAD_LH;
    const badgeOffsetPx = Math.max(0, Math.round((lineH - badgePx) / 2));
    const headOffsetPx = Math.max(0, Math.round((badgePx - lineH) / 2));
    const colH =
      headOffsetPx +
      Math.max(1, head.lines) * lineH +
      (subWrap.lines > 0 ? BUG_SUB_GAP_PX + subWrap.lines * subPx * BUG_SUB_LH : 0);
    const contentPx = Math.ceil(Math.max(badgeOffsetPx + badgePx, colH));
    const h = chromeY + contentPx;
    const fits = head.wordsFit && head.lines <= BUG_MAX_LINES && h <= maxPanelH;
    return { badgePx, badgeOffsetPx, headOffsetPx, head, subPx, subWrap, contentPx, h, fits };
  };
  let headPx = BUG_HEAD_MAX_PX;
  let text = textAt(headPx);
  while (!text.fits && headPx > BUG_TEXT_MIN_PX) {
    headPx -= 1;
    text = textAt(headPx);
  }

  // The mock panel.
  let capPx = 0;
  let cap: ReturnType<typeof bugCaptionLayout> = {
    rows: [],
    visualRows: 0,
    unitFits: [],
    allFit: true,
    runFits: true,
    clipRowWidthPx: 0,
    clipRow: -1,
  };
  let linePx = 0;
  let lineFits: boolean[] = [];
  let markPx = 0;
  let gutterPx = 0;
  let mockContentPx = 0;
  if (showMock && p.mock === "caption") {
    const clipEdgePx = innerW + CARD_PAD_X_PX;
    const capAt = (px: number, maxRows: number) => {
      const lay = bugCaptionLayout(p.mockLines, px, innerW, clipEdgePx, wrongIndex, p.mockFault === "clipped");
      const contentPx = Math.ceil(
        lay.visualRows * px * BUG_CAP_LH + Math.max(0, lay.visualRows - 1) * BUG_CAP_ROW_GAP_PX,
      );
      const fits = lay.allFit && lay.runFits && lay.visualRows <= maxRows && chromeY + contentPx <= maxPanelH;
      return { lay, contentPx, fits };
    };
    capPx = BUG_CAP_MAX_PX;
    let solved = capAt(capPx, 1);
    while (!solved.fits && capPx > BUG_CAP_ONE_ROW_MIN_PX) {
      capPx -= 1;
      solved = capAt(capPx, 1);
    }
    if (!solved.fits) {
      capPx = BUG_CAP_MAX_PX;
      solved = capAt(capPx, BUG_CAP_MAX_ROWS);
      while (!solved.fits && capPx > BUG_TEXT_MIN_PX) {
        capPx -= 1;
        solved = capAt(capPx, BUG_CAP_MAX_ROWS);
      }
    }
    cap = solved.lay;
    mockContentPx = solved.contentPx;
  } else if (showMock && p.mock === "lines") {
    const linesAt = (px: number) => {
      const mark = Math.round(px * BUG_MARK_EM);
      const gutter = wrongIndex !== null ? mark + BUG_MARK_GAP_PX : 0;
      const textW = innerW - gutter;
      const rows = p.mockLines.map((l) => Math.max(1, Math.ceil((monoWidthEm(l) * px) / textW)));
      const n = rows.length;
      const contentPx = Math.ceil(
        rows.reduce((a, r) => a + r, 0) * px * BUG_LINE_LH + Math.max(0, n - 1) * BUG_LINE_GAP_PX,
      );
      const fits = rows.every((r) => r === 1) && chromeY + contentPx <= maxPanelH;
      return { mark, gutter, rows, contentPx, fits };
    };
    linePx = BUG_LINE_MAX_PX;
    let solved = linesAt(linePx);
    while (!solved.fits && linePx > BUG_MONO_MIN_PX) {
      linePx -= 1;
      solved = linesAt(linePx);
    }
    lineFits = solved.rows.map((r) => r === 1);
    markPx = solved.mark;
    gutterPx = solved.gutter;
    mockContentPx = solved.contentPx;
  }

  const panelH = Math.ceil(Math.max(text.h, showMock ? chromeY + mockContentPx : 0));
  const blockWidthPx = mode === "split" ? 2 * panelW + BUG_PANEL_GAP_PX : panelW;
  const x0 = Math.round((widthPx - blockWidthPx) / 2);
  // Centre the union of the panels at their pop peak and the sticker at its bump peak.
  const growY = (reserve / 2) * panelH;
  const below = Math.max(growY, stickerHang);
  const y = Math.round((finiteH - (growY + panelH + below)) / 2 + growY);
  const textPanel: BugRect = { x: x0, y, w: panelW, h: panelH };
  const mockPanel: BugRect | null = showMock
    ? { x: x0 + panelW + BUG_PANEL_GAP_PX, y, w: panelW, h: panelH }
    : null;

  let sticker: BugCardMetrics["sticker"] = null;
  if (stickerText) {
    const anchor = mockPanel ?? textPanel;
    const desired = anchor.x + anchor.w + BUG_STICKER_OVERHANG_PX - sW / 2;
    const cx = Math.max(
      marginPx + sPeakW / 2,
      Math.min(widthPx - marginPx - sPeakW / 2, desired),
    );
    const cy = anchor.y + anchor.h - BUG_STICKER_TUCK_PX + sH / 2;
    sticker = { cx: Math.floor(cx), cy: Math.round(cy), w: sW, h: sH, sizePx: sPx };
  }

  return {
    aspect,
    mode,
    marginPx,
    textPanel,
    badgePx: text.badgePx,
    badgeOffsetPx: text.badgeOffsetPx,
    headOffsetPx: text.headOffsetPx,
    headPx,
    headLines: text.head.lines,
    headWordsFit: text.head.wordsFit,
    subPx: text.subPx,
    subLines: text.subWrap.lines,
    subWordsFit: text.subWrap.wordsFit,
    mockPanel,
    wrongIndex,
    capPx,
    capStrokePx: capPx > 0 ? Math.round(capPx * BUG_CAP_STROKE_EM) : 0,
    capWordGapPx: capPx > 0 ? Math.round(capPx * BUG_CAP_WORD_GAP_EM) : 0,
    capRows: cap.rows,
    capUnitFits: cap.unitFits,
    clipRowWidthPx: cap.clipRowWidthPx,
    clipRow: cap.clipRow,
    linePx,
    lineFits,
    markPx,
    gutterPx,
    textContentPx: text.contentPx,
    mockContentPx,
    sticker,
    blockWidthPx,
    blockHeightPx: panelH,
  };
}

// ---- PhoneDemo (§161, plan Task 7) -----------------------------------------

/** PhoneDemoProps' shape after parsing, as the metric reads it (no zod in this module). */
export interface PhoneDemoInput {
  caption: readonly { text: string; emphasis?: "none" | "yellow" | "orange" | string }[];
  pills: readonly { text: string; state?: "ok" | "bad" | "plain" | string }[];
}

/**
 * The `PhoneFrame` primitive's box and silhouette, exported so the
 * primitive draws what this model measures: a 6 px rim, and a head of
 * radius 19 at y 70 in a 90×160 viewBox scaled to meet the inner panel and
 * set on its bottom edge.
 */
export const PHONE_BORDER_PX = 6;
export const PHONE_SILHOUETTE = { viewW: 90, viewH: 160, headCx: 45, headCy: 70, headR: 19 } as const;

/** The phone and every pill are drawn at most at `popScale`'s overshoot (CTA_PEAK_SCALE's reason). */
export const PHONE_PEAK_SCALE = 1.11;
/** The idle bob once the phone has settled: motion.ts `bobPx`'s default amplitude. */
export const PHONE_BOB_PX = 7;
/**
 * The phone's share of the frame height (plan Task 7): 80% in 16:9 — but
 * no more than the margin holds at the pop's peak, which at 1080 px is
 * 880 / 1.11 ≈ 792 px, 73% (plan author, 2026-11-16: the margin wins) —
 * and 50% in 9:16.
 */
const PHONE_SHARE_LANDSCAPE = 0.8;
const PHONE_SHARE_PORTRAIT = 0.5;
/** Between the phone and the pill column in 16:9, and above the column in 9:16. */
export const PHONE_GROUP_GAP_PX = 80;
export const PHONE_STACK_GAP_PX = 40;
/** Between pills. */
export const PHONE_PILL_GAP_PX = 24;
/** Pill type: from 48 down to the playbook's 34 px floor. */
const PHONE_PILL_MAX_PX = 48;
const PHONE_TEXT_MIN_PX = 34;
/** The `Pill` primitive's box, mirrored: a 3 px border, padding 0.36 / 0.75 em, a mark of 1 em and a 0.4 em gap. */
const PILL_BORDER_PX = 3;
const PILL_LH = 1.1;

/**
 * The caption inside the phone. Its type is solved against the panel, from
 * 15% of the panel's inner width down to 34 px; its side padding is 7% of
 * that width, and 2% where that is what lets the words fit three lines.
 * It sits on the panel's lower edge, 7% of the inner height up.
 */
const PHONE_CAP_MAX_SHARE = 0.15;
const PHONE_CAP_PAD_SHARE = 0.07;
const PHONE_CAP_PAD_REDUCED_SHARE = 0.02;
const PHONE_CAP_BOTTOM_SHARE = 0.07;
/** How low an overflowing caption may sit to clear the face: 2% of the inner height. */
const PHONE_CAP_BOTTOM_MIN_SHARE = 0.02;
/** "Aim for at most three lines" (plan author, 2026-11-16). */
const PHONE_CAP_MAX_LINES = 3;
export const PHONE_CAP_LH = 1.15;
export const PHONE_CAP_WORD_GAP_EM = 0.3;
/** The outline, BugCard's caption look (`BUG_CAP_STROKE_EM`). */
export const PHONE_CAP_STROKE_EM = 0.14;
/** The emphasis box: padding around the word, its corner, and its tilt. */
export const PHONE_EMPH_PAD_X_EM = 0.2;
export const PHONE_EMPH_PAD_Y_EM = 0.06;
export const PHONE_EMPH_RADIUS_EM = 0.16;
export const PHONE_EMPH_TILT_DEG = -3;

export interface PhoneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PhoneDemoMetrics {
  aspect: BugAspect;
  marginPx: number;
  /** The phone's rest box in frame pixels; `w` is `PhoneFrame`'s own `round(h × 9 / 16)`. */
  phone: PhoneRect;
  /** The panel inside the rim, which the caption and the silhouette are laid out in. */
  innerW: number;
  innerH: number;
  /** Where the silhouette's head ends, from the top of the inner panel. */
  faceBottomPx: number;
  capPx: number;
  capStrokePx: number;
  capWordGapPx: number;
  /** Above each caption row (0 for the first): what keeps a tilted box off its neighbour. */
  capRowGapsPx: number[];
  capPadXPx: number;
  capBottomPx: number;
  emphPadXPx: number;
  emphPadYPx: number;
  /** Caption entry indices per row, drawn as laid out here and never re-wrapped. */
  capRows: number[][];
  /**
   * "lower-third": at most three rows inside the panel's lower third.
   * "overflow": the words cannot do that at 34 px with the padding reduced,
   * so they take the rows they need, still whole, still on the lower edge.
   */
  capMode: "lower-third" | "overflow";
  /** Every caption word fits a row unbroken (always true within the schema's caps). */
  capWordsFit: boolean;
  /** The caption block's height and its top edge, from the top of the inner panel. */
  capBlockPx: number;
  capTopPx: number;
  pillPx: number;
  /** One per pill, the `Pill` primitive's box at `pillPx`. */
  pillWidths: number[];
  pillHeightPx: number;
  pillGapPx: number;
  /** The pill column's rest box; null without pills. */
  pillColumn: PhoneRect | null;
  /** Pills sit on the column's left edge and pop from it (16:9), or are centred and pop about their centre (9:16). */
  pillAlign: "left" | "center";
  blockWidthPx: number;
  blockHeightPx: number;
}

/** The `Pill` primitive's box for `text` at `sizePx`. */
export function pillBoxPx(text: string, marked: boolean, sizePx: number): { w: number; h: number } {
  const markW = marked ? sizePx + Math.round(sizePx * 0.4) : 0;
  return {
    w: Math.ceil(2 * PILL_BORDER_PX + 2 * Math.round(sizePx * 0.75) + markW + ctaDisplayWidthEm(text) * sizePx),
    h: Math.ceil(2 * PILL_BORDER_PX + 2 * Math.round(sizePx * 0.36) + sizePx * PILL_LH),
  };
}

/** A `plain` pill carries no mark; `ok` and `bad` do (an unknown state reads as the default, `ok`). */
const pillMarked = (state: string | undefined): boolean => state !== "plain";

/** Where the silhouette's head ends inside a panel `innerW`×`innerH` (`PhoneFrame`'s meet-and-bottom fit). */
export function phoneFaceBottomPx(innerW: number, innerH: number): number {
  const s = PHONE_SILHOUETTE;
  const k = Math.min(innerW / s.viewW, innerH / s.viewH);
  return innerH - s.viewH * k + (s.headCy + s.headR) * k;
}

/** Caption entries in rows of whole words at `px`, the `bugCaptionLayout` rule. */
function phoneCaptionLayout(
  units: readonly { text: string; emphasis?: string }[],
  px: number,
  lineW: number,
): { rows: number[][]; allFit: boolean; rowGaps: number[]; blockPx: number } {
  const gap = Math.round(PHONE_CAP_WORD_GAP_EM * px);
  const stroke = Math.round(PHONE_CAP_STROKE_EM * px);
  const padX = Math.round(PHONE_EMPH_PAD_X_EM * px);
  const padY = Math.round(PHONE_EMPH_PAD_Y_EM * px);
  const rowH = px * PHONE_CAP_LH + 2 * padY;
  const tilt = (Math.abs(PHONE_EMPH_TILT_DEG) * Math.PI) / 180;
  const emph = (u: { emphasis?: string }) => u.emphasis === "yellow" || u.emphasis === "orange";
  // A boxed word has its padding and the tilt's sideways reach; a plain one
  // its outline, half of which lies outside the glyphs.
  const width = (u: { text: string; emphasis?: string }) =>
    ctaDisplayWidthEm(u.text) * px + (emph(u) ? 2 * padX + rowH * Math.sin(tilt) : stroke);
  const rows: number[][] = [];
  let cur: number[] = [];
  let used = 0;
  let allFit = true;
  units.forEach((u, i) => {
    const w = width(u);
    if (w > lineW) allFit = false;
    if (cur.length === 0) {
      cur = [i];
      used = w;
    } else if (used + gap + w <= lineW) {
      cur.push(i);
      used += gap + w;
    } else {
      rows.push(cur);
      cur = [i];
      used = w;
    }
  });
  if (cur.length > 0) rows.push(cur);
  // A box tilted 3° rises at one end and drops at the other by half its
  // width × sin 3°, so the gap above a row holds the reach of the widest
  // box on each side of it. Per pair, not one gap for the block: a single
  // gap sized by the widest box spread 85 px of air through the six-row
  // dense caption and pushed its top over the silhouette's face.
  const reach = rows.map((row) =>
    row.reduce((a, i) => (emph(units[i]!) ? Math.max(a, (width(units[i]!) / 2) * Math.sin(tilt)) : a), 0),
  );
  const rowGaps = rows.map((_, r) => (r === 0 ? 0 : Math.ceil(reach[r - 1]! + reach[r]!)));
  const blockPx = Math.ceil(rows.length * rowH + rowGaps.reduce((a, g) => a + g, 0));
  return { rows, allFit, rowGaps, blockPx };
}

/**
 * PhoneDemo's layout, solved against the box it is drawn in (the whole
 * frame, or its graphic box, §163): ONE model for the component and
 * `estimateHeightPx`, with the pattern scenes' reserves — the margin
 * (`patternMarginPx`), the pop's overshoot about every box, and the phone's
 * bob once it has settled. Aspect and the phone's share follow the box.
 *
 * 16:9: the phone, then the pill column, one group centred in the frame
 * with an 80 px gap; pills left-aligned and centred on the phone's height,
 * popping from their left edge so none grows back towards the phone. With
 * no pills the phone is centred alone. 9:16: the phone at the top inside
 * the margin, and the column centred in the band between it and the
 * bottom margin; with no pills, the phone is centred.
 *
 * Caption (plan author's rule, 2026-11-16): the largest size, from 15% of
 * the panel width down to 34 px, at which the words take at most three
 * rows inside the panel's lower third; failing that, the same with the
 * side padding reduced; failing that, the rows the words need — the
 * largest size whose block still clears the silhouette's face, else 34 px,
 * set as low as 2% from the edge where that clears it — never a broken
 * word, always on the panel's lower edge. Widths use
 * `ctaDisplayWidthEm`: a caption word is one unbroken unit, the case
 * CardRow's flat average under-measured.
 */
export function phoneDemoMetrics(
  p: PhoneDemoInput,
  widthPx: number,
  heightPx: number,
  /** The output frame the box sits in (§163); absent, the box is the frame. */
  frame?: PatternFrame,
): PhoneDemoMetrics {
  const finiteH = Number.isFinite(heightPx) ? heightPx : widthPx * 2;
  const aspect = bugAspect(widthPx, finiteH);
  const marginPx = patternMarginPx(widthPx, finiteH, marginFrame(widthPx, finiteH, frame));
  const reserve = PHONE_PEAK_SCALE - 1;
  const availW = widthPx - 2 * marginPx;
  const availH = finiteH - 2 * marginPx;
  const hasPills = p.pills.length > 0;

  // The phone's height: its share, held to what the margin allows with the
  // pop's peak (and, once settled, the bob) about its centre.
  const share = aspect === "16:9" ? PHONE_SHARE_LANDSCAPE : PHONE_SHARE_PORTRAIT;
  const phoneH = Math.floor(
    Math.min(
      share * finiteH,
      availH / (1 + reserve),
      availH - 2 * PHONE_BOB_PX,
      // Its width at the peak, too (a frame narrower than 9:16 of it).
      (availW / (1 + reserve)) * (16 / 9),
    ),
  );
  const phoneW = Math.round((phoneH * 9) / 16);
  const growPhoneX = (reserve / 2) * phoneW;
  const growPhoneY = Math.max((reserve / 2) * phoneH, PHONE_BOB_PX);

  // Pills: one size for the set, the largest that fits.
  const pillsAt = (px: number) => {
    const boxes = p.pills.map((pill) => pillBoxPx(pill.text, pillMarked(pill.state), px));
    const colW = boxes.reduce((a, b) => Math.max(a, b.w), 0);
    const pillH = boxes[0]?.h ?? 0;
    const n = boxes.length;
    const colH = n * pillH + Math.max(0, n - 1) * PHONE_PILL_GAP_PX;
    return { widths: boxes.map((b) => b.w), colW, pillH, colH };
  };
  const bandTop = marginPx + growPhoneY + phoneH + growPhoneY + PHONE_STACK_GAP_PX;
  const pillFits = (q: ReturnType<typeof pillsAt>): boolean => {
    if (!hasPills) return true;
    const growPillY = (reserve / 2) * q.pillH;
    if (aspect === "16:9") {
      // Centred group; the phone grows left by half its overshoot, a pill
      // (popping from its left edge) right by all of its own.
      const groupW = phoneW + PHONE_GROUP_GAP_PX + q.colW;
      const side = (availW - groupW) / 2;
      return side >= growPhoneX && side >= reserve * q.colW && q.colH + 2 * growPillY <= phoneH;
    }
    return q.colW * (1 + reserve) <= availW && q.colH + 2 * growPillY <= finiteH - marginPx - bandTop;
  };
  let pillPx = PHONE_PILL_MAX_PX;
  let pills = pillsAt(pillPx);
  while (!pillFits(pills) && pillPx > PHONE_TEXT_MIN_PX) {
    pillPx -= 1;
    pills = pillsAt(pillPx);
  }

  // Placement.
  let phone: PhoneRect;
  let pillColumn: PhoneRect | null = null;
  if (aspect === "16:9") {
    const groupW = hasPills ? phoneW + PHONE_GROUP_GAP_PX + pills.colW : phoneW;
    const x0 = Math.round((widthPx - groupW) / 2);
    const y = Math.round((finiteH - phoneH) / 2);
    phone = { x: x0, y, w: phoneW, h: phoneH };
    if (hasPills) {
      pillColumn = {
        x: x0 + phoneW + PHONE_GROUP_GAP_PX,
        y: Math.round(y + (phoneH - pills.colH) / 2),
        w: pills.colW,
        h: pills.colH,
      };
    }
  } else {
    const x = Math.round((widthPx - phoneW) / 2);
    if (hasPills) {
      phone = { x, y: Math.ceil(marginPx + growPhoneY), w: phoneW, h: phoneH };
      const bandBottom = finiteH - marginPx;
      pillColumn = {
        x: Math.round((widthPx - pills.colW) / 2),
        y: Math.round(bandTop + (bandBottom - bandTop - pills.colH) / 2),
        w: pills.colW,
        h: pills.colH,
      };
    } else {
      phone = { x, y: Math.round((finiteH - phoneH) / 2), w: phoneW, h: phoneH };
    }
  }

  // The caption, inside the rim.
  const innerW = phoneW - 2 * PHONE_BORDER_PX;
  const innerH = phoneH - 2 * PHONE_BORDER_PX;
  const faceBottomPx = phoneFaceBottomPx(innerW, innerH);
  const capBottomBasePx = Math.round(innerH * PHONE_CAP_BOTTOM_SHARE);
  const capFloorPx = Math.round(innerH * PHONE_CAP_BOTTOM_MIN_SHARE);
  const capMax = Math.max(PHONE_TEXT_MIN_PX, Math.round(innerW * PHONE_CAP_MAX_SHARE));
  const lowerThird = innerH / 3 - capBottomBasePx;
  type Solved = { px: number; pad: number; lay: ReturnType<typeof phoneCaptionLayout> };
  let solved: Solved | null = null;
  let capMode: PhoneDemoMetrics["capMode"] = "lower-third";
  const reducedPad = Math.round(innerW * PHONE_CAP_PAD_REDUCED_SHARE);
  for (const pad of [Math.round(innerW * PHONE_CAP_PAD_SHARE), reducedPad]) {
    for (let px = capMax; px >= PHONE_TEXT_MIN_PX && solved === null; px--) {
      const lay = phoneCaptionLayout(p.caption, px, innerW - 2 * pad);
      if (lay.allFit && lay.rows.length <= PHONE_CAP_MAX_LINES && lay.blockPx <= lowerThird) {
        solved = { px, pad, lay };
      }
    }
    if (solved !== null) break;
  }
  if (solved === null) {
    capMode = "overflow";
    const lineW = innerW - 2 * reducedPad;
    // Measured with the lowest inset the block may sit at (below).
    const belowFace = innerH - capFloorPx - faceBottomPx;
    for (let px = capMax; px >= PHONE_TEXT_MIN_PX && solved === null; px--) {
      const lay = phoneCaptionLayout(p.caption, px, lineW);
      if (lay.allFit && lay.blockPx <= belowFace) solved = { px, pad: reducedPad, lay };
    }
    if (solved === null) {
      solved = { px: PHONE_TEXT_MIN_PX, pad: reducedPad, lay: phoneCaptionLayout(p.caption, PHONE_TEXT_MIN_PX, lineW) };
    }
  }
  const capPx = solved.px;
  // An overflowing block sits lower, down to `capFloorPx` from the edge,
  // where that is what keeps it off the face: the six-row dense caption at
  // 34 px reached ~8 px over the chin in 16:9 at the usual 7% inset.
  const capBottomPx =
    capMode === "overflow"
      ? Math.max(capFloorPx, Math.min(capBottomBasePx, Math.floor(innerH - faceBottomPx - solved.lay.blockPx)))
      : capBottomBasePx;

  const left = Math.min(phone.x, pillColumn?.x ?? Infinity);
  const right = Math.max(phone.x + phone.w, pillColumn ? pillColumn.x + pillColumn.w : -Infinity);
  const top = Math.min(phone.y, pillColumn?.y ?? Infinity);
  const bottom = Math.max(phone.y + phone.h, pillColumn ? pillColumn.y + pillColumn.h : -Infinity);
  return {
    aspect,
    marginPx,
    phone,
    innerW,
    innerH,
    faceBottomPx,
    capPx,
    capStrokePx: Math.round(capPx * PHONE_CAP_STROKE_EM),
    capWordGapPx: Math.round(capPx * PHONE_CAP_WORD_GAP_EM),
    capRowGapsPx: solved.lay.rowGaps,
    capPadXPx: solved.pad,
    capBottomPx,
    emphPadXPx: Math.round(capPx * PHONE_EMPH_PAD_X_EM),
    emphPadYPx: Math.round(capPx * PHONE_EMPH_PAD_Y_EM),
    capRows: solved.lay.rows,
    capMode,
    capWordsFit: solved.lay.allFit,
    capBlockPx: solved.lay.blockPx,
    capTopPx: innerH - capBottomPx - solved.lay.blockPx,
    pillPx,
    pillWidths: pills.widths,
    pillHeightPx: pills.pillH,
    pillGapPx: PHONE_PILL_GAP_PX,
    pillColumn,
    pillAlign: aspect === "16:9" ? "left" : "center",
    blockWidthPx: right - left,
    blockHeightPx: bottom - top,
  };
}

// ---- TerminalMock badge (§161, plan Task 8) --------------------------------

/** The badge is a `Pill` at the playbook's 34 px pill floor (Global Constraints). */
export const TERMINAL_BADGE_PX = 34;
/**
 * How far the badge rises above the last window: half its height, since it
 * is centred on the window's top edge to overlap the corner. The component
 * reserves exactly this as the window's top margin, so the badge never sits
 * on the window above (or above the graphic's own box) and the model's
 * height is the drawn one.
 */
export const TERMINAL_BADGE_RISE_PX = Math.ceil(pillBoxPx("", false, TERMINAL_BADGE_PX).h / 2);
/**
 * How far the badge pokes out past the window's right edge — into the
 * root's 30 px side padding, never past it, so it stays inside the box the
 * stage scales and the slot clips.
 */
export const TERMINAL_BADGE_OUT_PX = 24;

/**
 * The narrowest TerminalMock whose last title bar holds its title and the
 * badge with `TERMINAL_BADGE_OUT_PX` of air between them. Mirrors the
 * Window title bar: border 2 + padding 20 + three 16 px dots and two 10 px
 * gaps + the 10 px gap and 10 px margin before a 24 px mono title; then the
 * badge (`pillBoxPx`, unmarked). Root padding 60 is counted once: the
 * badge's overhang past the window's right edge equals the air before it,
 * so the two cancel.
 */
function terminalBadgeRowMinWidthPx(titleChars: number, badge: string): number {
  const titleBar = 2 + 20 + 3 * 16 + 2 * 10 + 10 + 10 + titleChars * 24 * CHAR_W_MONO;
  return 60 + titleBar + pillBoxPx(badge, false, TERMINAL_BADGE_PX).w;
}
