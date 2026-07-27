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
const SELF_FITTING = new Set<SceneComponentId>(["FlowDiagram"]);
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
      const lines = arr(props.lines);
      const each = lines.map((l) =>
        textHeight(
          str((l as Record<string, unknown>)?.text).length,
          92,
          widthPx,
          1.08,
          CHAR_W_UPPER,
        ),
      );
      return each.reduce((a, b) => a + b, 0) + 18 * Math.max(0, lines.length - 1);
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
      return h;
    }
    case "ChatMock": {
      const messages = arr(props.messages);
      const bubbleWidth = (widthPx - 80) * 0.82;
      let h = 0;
      for (const m of messages) {
        const text = str((m as Record<string, unknown>)?.text);
        h += textHeight(text.length, 40, bubbleWidth - 68, 1.2, CHAR_W_BOLD) + 48 + 4;
      }
      return h + 20 * Math.max(0, messages.length - 1);
    }
    case "ScreenshotFrame": {
      // The placeholder is a fixed 420px block; a real image is unbounded and
      // assumed 16:9 (the fit only has to be close — it is clamped either way).
      const frame = widthPx * 0.94;
      const body = str(props.src) ? (frame * 9) / 16 : 420 + 60;
      return body + 4;
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
export function estimateMinWidthPx(
  component: SceneComponentId,
  props: Record<string, unknown>,
): number {
  switch (component) {
    case "TerminalMock": {
      let longest = 0;
      for (const w of arr(props.windows)) {
        for (const l of arr((w as Record<string, unknown>)?.lines)) {
          longest = Math.max(longest, str(l).length);
        }
      }
      // root padding 60 + window border 4 + body padding 44
      return longest > 0 ? 108 + longest * 27 * CHAR_W_MONO : 0;
    }
    case "StatCard": {
      // The card is a row: label | gap | value. The value is `nowrap`, and the
      // label can only shrink to its longest word — so the row has a hard
      // floor, and scaling past it pushes the value out through the card's
      // right edge (which is exactly what it did once graphics started
      // filling their slot).
      const value = str(props.value).length * 110 * CHAR_W_UPPER;
      if (value === 0) return 0;
      const longestWord = str(props.label)
        .split(/\s+/)
        .reduce((max, w) => Math.max(max, w.length), 0);
      const label = longestWord * 42 * CHAR_W_UPPER;
      return 60 + 104 + label + 40 + value; // root pad + card pad + row
    }
    default:
      return 0;
  }
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
