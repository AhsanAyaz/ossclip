import { describe, expect, it } from "vitest";
import { SCENE_REGISTRY, SceneComponentIdSchema, type SceneComponentId } from "@ossclip/core";
import {
  BUG_PANEL_GAP_PX,
  BUG_PEAK_SCALE,
  BUG_STICKER_PEAK_SCALE,
  BUG_STICKER_TILT_DEG,
  CARD_PEAK_SCALE,
  CTA_BUTTON_PEAK_SCALE,
  CTA_PEAK_SCALE,
  FILL_TARGET,
  MAX_SCALE,
  PATTERN_MARGIN_PX,
  bulletMetrics,
  bugCardMetrics,
  bugMockVisible,
  cardRowMetrics,
  ctaCardMetrics,
  ctaContent,
  bulletStackHeightPx,
  chatBubbles,
  chatMetrics,
  estimateHeightPx,
  estimateMinWidthPx,
  fitScale,
  isSelfFitting,
  revealMetrics,
  revealRows,
} from "../src/fit";
import { FULL_BLEED_GRAPHIC_SLOT, layoutSlots } from "../src/stage";
import { bump, popScale } from "../src/motion";

const FRAME_W = 1080;
const FRAME_H = 1920;

function slotOf(component: SceneComponentId) {
  // A `fullFrame` component is drawn in the whole frame whatever its layout
  // (`graphicSlotFor`), so that is the box its model must fit.
  if (SCENE_REGISTRY[component].fullFrame) return { widthPx: FRAME_W, heightPx: FRAME_H };
  const layout = SCENE_REGISTRY[component].defaultLayout;
  // full-bleed (ClipScene's default) has no slot of its own; graphics there
  // use the R13 fallback band, exactly as `graphicSlotFor` places them.
  const g = layoutSlots(layout).graphic ?? FULL_BLEED_GRAPHIC_SLOT;
  return { widthPx: g.w * FRAME_W, heightPx: g.h * FRAME_H };
}

/** Did non-reflowing content, rather than the fill target, decide the scale? */
function isWidthCapped(
  component: SceneComponentId,
  props: Record<string, unknown>,
  scale: number,
): boolean {
  const minWidth = estimateMinWidthPx(component, props);
  if (minWidth <= 0) return false;
  return Math.abs(minWidth * scale - slotOf(component).widthPx) < 1;
}

/** Rendered height after the stage's fill scale. */
function fittedHeight(component: SceneComponentId, props: Record<string, unknown>) {
  const slot = slotOf(component);
  const k = fitScale(component, props, slot);
  return {
    height: estimateHeightPx(component, props, slot.widthPx / k, slot.heightPx / k) * k,
    slotH: slot.heightPx,
    scale: k,
  };
}

/**
 * CardRow at every cap (18-character text, 24-character sub, an icon) and
 * the most cards (4). Capitals and wide letters on purpose: the width model
 * charges them most, so this is the copy most likely to need a third line.
 */
const CARD_ROW_DENSE = [
  { text: "WRITE THE TESTS OK", sub: "pnpm vitest run --watch!", icon: "check" },
  { text: "MEASURE EVERY RUN!", sub: "tokens, seconds and cost", icon: "bolt" },
  { text: "Review the diff ok", sub: "git diff main...HEAD -w!", icon: "code" },
  { text: "Ship it on Monday!", sub: "npm publish --tag latest", icon: "terminal" },
];

/**
 * CtaCard at every cap: a 40-character headline, a 16-character keyword and
 * a 24-character channel, in capitals (the widest the model charges). The
 * comment action is the DENSE entry because its row is the busiest — a box,
 * a caret and a button on one line — and the suite below runs all three.
 */
const CTA_DENSE = {
  action: "comment",
  text: "WATCH THE WHOLE SERIES ON AGENTS TODAY!!",
  keyword: "COMMENTPROMPTNOW",
  channel: "THE PRAGMATIC ENGINEER!!",
} as const;

/**
 * BugCard at every cap: headline and sub at 40, four mock entries at 32 (the
 * most `mockLines` holds), the last one wrong, and a 14-character sticker —
 * in capitals, the widest the model charges. `lines` is the DENSE entry; the
 * suite below runs both caption faults at the same caps.
 */
const BUG_DENSE = {
  number: 9,
  headline: "WHISPER DROPS THE LAST WORD OF EVERY CUT",
  sub: "AND THE ONE IT DROPS IS THE ONE YOU NEED",
  mock: "lines",
  mockLines: [
    "CONST PLAN = AWAIT AGENT.PLAN();",
    "FOR (CONST STEP OF PLAN.STEPS) {",
    "  AWAIT RUN(STEP, { RETRY: 0 });",
    "} // NO RETRY, NO LOG, NO TRACE!",
  ],
  mockWrong: 3,
  mockFault: "struck",
  sticker: "WATCH THE EDGE",
} as const;

/** Sparse content — the §23 complaint: a thin strip in a sea of black. */
const SPARSE: Record<SceneComponentId, Record<string, unknown>> = {
  TitleCard: { title: "SHIP IT" },
  StatCard: { label: "CHURN", value: "861%" },
  RuleCard: { kicker: "RULE", text: "SHOW, THEN TELL" },
  StrikethroughReveal: { lines: [{ text: "MORE WORDS", struck: true }] },
  FlowDiagram: { nodes: ["LOOP", "BUILD", "VERIFY"] },
  TerminalMock: { windows: [{ title: "ossclip", lines: ["$ run"] }] },
  ChatMock: { messages: [{ from: "user", text: "can it cut my ums?" }] },
  ScreenshotFrame: { label: "REVIEW" },
  BulletList: { items: ["AI HARNESS", "CONTEXT ENGINEERING"] },
  CardRow: { cards: [{ text: "Draft" }, { text: "Review" }] },
  CtaCard: { action: "subscribe", text: "Subscribe" },
  BugCard: { number: 1, headline: "Captions drift", mock: "none", mockLines: [], mockFault: "struck" },
  // No copy to be sparse or dense with: a clip's props are a file and a length.
  ClipScene: { src: "clips/a.webm", durationSec: 4.6 },
};

/** Schema maxima — the cases that silently overflowed the safe area. */
const DENSE: Record<SceneComponentId, Record<string, unknown>> = {
  TitleCard: {
    eyebrow: "TWENTY EIGHT CHARACTERS OKAY",
    title: "A FORTY EIGHT CHARACTER TITLE THAT RUNS LONG!!",
    emphasis: "861%",
    sub: "A SIXTY FOUR CHARACTER SUBTITLE THAT ALSO RUNS ON AND ON HERE",
  },
  StatCard: {
    label: "TWENTY EIGHT CHARS LABEL OKA",
    value: "+1000000%",
    caption: "A FORTY CHARACTER CAPTION RIGHT HERE OK!",
  },
  RuleCard: {
    kicker: "TWENTY FOUR CHARS RULE!!",
    text: "A FORTY CHARACTER RULE LINE RIGHT HERE OK",
    struck: "A FORTY CHARACTER STRUCK LINE RIGHT HERE!",
  },
  StrikethroughReveal: {
    lines: Array.from({ length: 4 }, () => ({ text: "THIRTY TWO CHARACTERS OF COPY!!!", struck: true })),
  },
  FlowDiagram: { nodes: Array.from({ length: 5 }, () => "SIXTEEN CHARS AB") },
  TerminalMock: {
    windows: Array.from({ length: 5 }, (_, i) => ({
      title: `window-${i}`,
      lines: Array.from({ length: 6 }, () => "a forty character terminal line here okay"),
    })),
    fanOut: "OUTPUT ×5",
  },
  ChatMock: {
    messages: Array.from({ length: 4 }, () => ({
      from: "user" as const,
      text: "a sixty character chat message that wraps across some lines!",
    })),
  },
  ScreenshotFrame: { src: "shot.png", label: "A THIRTY TWO CHARACTER LABEL OK!" },
  BulletList: {
    title: "TWENTY EIGHT CHARACTERS OKAY",
    items: Array.from({ length: 5 }, () => "THIRTY SIX CHARACTERS OF BULLET COPY"),
  },
  CardRow: { cards: CARD_ROW_DENSE, highlight: 2 },
  CtaCard: CTA_DENSE,
  BugCard: BUG_DENSE,
  ClipScene: { src: "clips/a.webm", durationSec: 15 },
};

describe("fill contract (FINDINGS §23)", () => {
  it("no component overflows its slot, at sparse or schema-max content", () => {
    // Before this contract TerminalMock rendered at 169% of its slot, ChatMock
    // at 122% and ScreenshotFrame at 105% — bleeding outside the platform safe
    // area with nothing clipping them.
    for (const id of SceneComponentIdSchema.options) {
      for (const [label, set] of [["sparse", SPARSE], ["dense", DENSE]] as const) {
        const { height, slotH } = fittedHeight(id, set[id]);
        expect(height, `${id} (${label}) overflows its slot`).toBeLessThanOrEqual(slotH + 1);
      }
    }
  });

  it("sparse content fills the slot, unless a ceiling legitimately stops it", () => {
    // The §23 render measured 8-15% fill on exactly these shapes. Two things
    // may legitimately stop a graphic short: the taste ceiling, and content
    // that cannot reflow (a nowrap stat value, a pre-formatted terminal line).
    for (const id of SceneComponentIdSchema.options) {
      if (isSelfFitting(id)) continue; // width-bound; covered by their own tests
      const { height, slotH, scale } = fittedHeight(id, SPARSE[id]);
      const filled = height / slotH;
      const clamped = Math.abs(scale - MAX_SCALE) < 1e-6 || isWidthCapped(id, SPARSE[id], scale);
      expect(
        filled > 0.6 || clamped,
        `${id} fills only ${(filled * 100).toFixed(0)}% at scale ${scale.toFixed(2)}`,
      ).toBe(true);
    }
  });

  it("the thin-strip cases gain real size", () => {
    // The components §23 called out: each rendered at 8-15% of its slot.
    // Self-fitting components (FlowDiagram, StrikethroughReveal, and since
    // R11 ChatMock) have no "unscaled" baseline — their own suites cover
    // their fill directly.
    for (const id of ["TitleCard", "TerminalMock"] as const) {
      const slot = slotOf(id);
      const natural = estimateHeightPx(id, SPARSE[id], slot.widthPx, slot.heightPx);
      const { height } = fittedHeight(id, SPARSE[id]);
      expect(height / natural, `${id} barely changed`).toBeGreaterThan(1.5);
    }
  });

  it("gets close to the target whenever nothing clamps the scale", () => {
    // Sparse content usually hits the taste ceiling and dense content the
    // width cap; wherever neither binds, the fill target is what decides —
    // approached, not hit, because wrapped text quantizes: the chosen scale is
    // the largest that does not push a line over into another row.
    let unclamped = 0;
    for (const id of SceneComponentIdSchema.options) {
      if (isSelfFitting(id)) continue; // bounded by their own solver, not this target
      for (const set of [SPARSE, DENSE]) {
        const slot = slotOf(id);
        const scale = fitScale(id, set[id], slot);
        if (scale >= MAX_SCALE - 1e-6 || isWidthCapped(id, set[id], scale) || scale <= 0.45 + 1e-6) {
          continue;
        }
        unclamped++;
        const { height, slotH } = fittedHeight(id, set[id]);
        const filled = height / slotH;
        expect(filled, `${id} under-fills at ${(filled * 100).toFixed(0)}%`).toBeGreaterThan(0.7);
        expect(filled, `${id} overshoots the target`).toBeLessThanOrEqual(FILL_TARGET + 1e-6);
      }
    }
    expect(unclamped, "no unclamped case to verify").toBeGreaterThan(0);
  });

  it("scales type with content — less copy reads bigger than more", () => {
    // Self-fitting since R11 Task 3: the stage no longer scales ChatMock
    // (magnifying it narrowed its own text box); its METRIC carries the
    // less-copy-reads-bigger property instead.
    const slot = slotOf("ChatMock");
    expect(fitScale("ChatMock", DENSE.ChatMock, slot)).toBe(1);
    const one = chatMetrics(["why?"], slot);
    const four = chatMetrics(
      (DENSE.ChatMock.messages as Array<{ text: string }>).map((m) => m.text),
      slot,
    );
    expect(one).toBeGreaterThan(four);
  });

  it("estimated height grows monotonically with content", () => {
    const w = 864;
    expect(estimateHeightPx("ChatMock", { messages: [{ from: "user", text: "hi" }] }, w)).toBeLessThan(
      estimateHeightPx(
        "ChatMock",
        { messages: [{ from: "user", text: "hi" }, { from: "agent", text: "there" }] },
        w,
      ),
    );
    expect(
      estimateHeightPx("StrikethroughReveal", { lines: [{ text: "ONE" }] }, w),
    ).toBeLessThan(
      estimateHeightPx("StrikethroughReveal", { lines: [{ text: "ONE" }, { text: "TWO" }] }, w),
    );
  });

  it("wraps long text into more height at a narrower width", () => {
    const long = { messages: [{ from: "user", text: "a".repeat(60) }] };
    expect(estimateHeightPx("ChatMock", long, 400)).toBeGreaterThan(
      estimateHeightPx("ChatMock", long, 900),
    );
  });

  it("never scales non-reflowing content past the slot width", () => {
    // The terminal's lines are white-space: pre — they cannot wrap, so a scale
    // chosen on height alone runs "$ ossclip produce raw.mp4" off the edge.
    // RuleCard and TitleCard joined in R12 §46: a single unbreakable WORD
    // cannot wrap either, and without a min-width they magnified past it.
    for (const set of [SPARSE, DENSE]) {
      for (const id of ["TerminalMock", "StatCard", "RuleCard", "TitleCard"] as const) {
        const slot = slotOf(id);
        const k = fitScale(id, set[id], slot);
        const minWidth = estimateMinWidthPx(id, set[id]);
        if (minWidth > 0) {
          expect(minWidth * k, `${id} overflows its slot horizontally`).toBeLessThanOrEqual(
            slot.widthPx + 1,
          );
        }
      }
    }
  });

  it("returns a finite, positive scale for every component and both content sets", () => {
    for (const id of SceneComponentIdSchema.options) {
      for (const set of [SPARSE, DENSE]) {
        const k = fitScale(id, set[id], slotOf(id));
        expect(Number.isFinite(k), id).toBe(true);
        expect(k, id).toBeGreaterThan(0);
      }
    }
  });
});

describe("BulletList metrics (R16 §67)", () => {
  const SLOT = { w: 831, h: 690 };

  it("the longest item fits one row at the solved font — bullets never wrap", () => {
    const items = ["AI HARNESS", "CONTEXT ENGINEERING", "PROMPT ENGINEERING"];
    const font = bulletMetrics(items, SLOT.w, SLOT.h);
    const longest = Math.max(...items.map((i) => i.length));
    // Same width model the metric solves against: glyph column + uppercase run.
    expect((longest * 0.72 + 1.1) * font).toBeLessThanOrEqual(SLOT.w + 1);
    expect(font).toBeGreaterThanOrEqual(36);
  });

  it("the stack fits the height budget, title included", () => {
    const items = ["ONE", "TWO", "THREE", "FOUR", "FIVE"];
    const font = bulletMetrics(items, SLOT.w, 400, true);
    expect(bulletStackHeightPx(items.length, font, true)).toBeLessThanOrEqual(400 * 0.94 + font);
  });

  it("fewer items render bigger — the §23 fill property", () => {
    expect(bulletMetrics(["AA", "BB"], SLOT.w, SLOT.h)).toBeGreaterThan(
      bulletMetrics(["AA", "BB", "CC", "DD", "EE"], SLOT.w, SLOT.h),
    );
  });

  it("estimateHeightPx and bulletMetrics share one model", () => {
    const props = { items: ["AI HARNESS", "CONTEXT ENGINEERING"], title: "WHAT YOU NEED" };
    const font = bulletMetrics(props.items, SLOT.w, SLOT.h, true);
    expect(estimateHeightPx("BulletList", props, SLOT.w, SLOT.h)).toBeCloseTo(
      bulletStackHeightPx(2, font, true),
      5,
    );
  });
});

describe("StrikethroughReveal rows (FINDINGS §27)", () => {
  const SLOT_W = 0.77 * 1080;
  const SLOT_H = 0.36 * 1920;

  it("keeps a line on one row by scaling, rather than wrapping it", () => {
    // t≈12s: "PROMPT → OUTCOME" wrapped, stranding the arrow at the end of
    // row one and drawing the strike rule between the two rows.
    const lines = ["PROMPT → OUTCOME"];
    const font = revealMetrics(lines, SLOT_W, SLOT_H);
    expect(revealRows(lines[0]!, font, SLOT_W)).toEqual(lines);
  });

  it("breaks at the arrow with the arrow LEADING the next row, never trailing", () => {
    // The whole line does not fit, but each half does — so it breaks, and the
    // arrow travels with the phrase it points into (the §12 rule, applied to
    // a different component).
    const text = "A VERY LONG FIRST HALF → AN EQUALLY LONG SECOND HALF";
    const rows = revealRows(text, 30, 700);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]!.endsWith("→")).toBe(false);
    expect(rows[1]!.startsWith("→")).toBe(true);
  });

  it("never breaks a line that has no arrow to break at", () => {
    expect(revealRows("ONE UNBREAKABLE STATEMENT", 92, 200)).toHaveLength(1);
  });

  it("every row fits the width it was measured against", () => {
    for (const text of ["SHORT", "PROMPT → OUTCOME", "MORE WORDS → MORE SIGNAL → LESS NOISE"]) {
      const font = revealMetrics([text], SLOT_W, SLOT_H);
      for (const row of revealRows(text, font, SLOT_W)) {
        expect(row.length * font * 0.72, `"${row}" overflows`).toBeLessThanOrEqual(SLOT_W + 1);
      }
    }
  });

  it("grows to the slot until its own width stops it, and never past it", () => {
    // Like a FlowDiagram row, a reveal line is WIDTH-bound: it can only grow
    // until the longest line reaches the slot edge. That is the honest ceiling
    // — filling more would mean overflowing.
    const lines = ["MORE WORDS", "MORE SIGNAL", "LESS NOISE"];
    const font = revealMetrics(lines, SLOT_W, SLOT_H);
    const longest = Math.max(...lines.map((l) => l.length));
    expect(font).toBe(Math.floor(SLOT_W / (longest * 0.72))); // width is the binding constraint
    const height = lines.length * font * 1.08 + font * 0.2 * (lines.length - 1);
    expect(height).toBeLessThanOrEqual(SLOT_H + 1);
    expect(height / SLOT_H).toBeGreaterThan(0.5); // vs ~14% before the fill work
  });

  it("a tall block is bounded by height, not width", () => {
    const lines = Array.from({ length: 4 }, () => "THIRTY TWO CHARACTERS OF COPY!!!");
    const font = revealMetrics(lines, SLOT_W, SLOT_H);
    const height = lines.length * font * 1.08 + font * 0.2 * (lines.length - 1);
    expect(height).toBeLessThanOrEqual(SLOT_H + 1);
  });
});

describe("ChatMock bubbles (FINDINGS §28)", () => {
  const SLOT_W = 0.77 * 1080;

  it("a CTA scene renders exactly one bubble, carrying only the keyword", () => {
    // The "link sent 🔗" reply is invented reassurance, competes with the
    // word the viewer must type, and is not in the reference.
    const bubbles = chatBubbles({
      keyword: "agents",
      messages: [
        { from: "user", text: "comment agents" },
        { from: "agent", text: "link sent 🔗" },
      ],
    });
    expect(bubbles).toEqual([{ from: "user", text: '"AGENTS"' }]);
  });

  it("a conversational scene keeps its full exchange", () => {
    const messages = [
      { from: "user", text: "can it cut my ums?" },
      { from: "agent", text: "already did." },
    ];
    expect(chatBubbles({ messages })).toEqual(messages);
  });

  it("shrinks the type so the longest WORD fits inside bubble-minus-padding", () => {
    // A single unbreakable word has no wrap opportunity, so only the type size
    // can keep it inside the rounded rect (§28a).
    const long = ['"ABSOLUTELYENORMOUSKEYWORD"'];
    const font = chatMetrics(long, { widthPx: SLOT_W });
    const inner = SLOT_W - 80;
    const bubbleWidth = font * (long[0]!.length * 0.58 + 2 * 0.85);
    expect(bubbleWidth).toBeLessThanOrEqual(inner * 0.82 + 1);
  });

  it("a short line — the CTA word — grows toward the composition ceiling (R11 Task 3)", () => {
    // The old layout-space 40 only made sense under the stage's ×2.4
    // magnifier; self-fitting, the single-word ask sizes against the real
    // slot, bounded by 96 (the same 40 × 2.4, expressed directly) and by
    // §28a's word fit.
    const font = chatMetrics(['"AGENTS"'], { widthPx: SLOT_W });
    expect(font).toBeGreaterThan(40);
    expect(font).toBeLessThanOrEqual(96);
    const bubbleWidth = font * ('"AGENTS"'.length * 0.58 + 2 * 0.85);
    expect(bubbleWidth).toBeLessThanOrEqual((SLOT_W - 80) * 0.82 + 1);
  });

  describe("sized to read, not to fill (R11 Task 3.5)", () => {
    // Scene-11's real case: one 26-character message in the real
    // blurred-behind slot rendered as five one-word lines.
    const SLOT = { widthPx: 0.77 * 1080, heightPx: 0.36 * 1920 };
    const MSG = "Which one didn't you know?";
    const perLine = (font: number, widthPx: number): number => {
      const textW = (widthPx - 80) * 0.82 - 2 * font * 0.85;
      return Math.floor(textW / (0.58 * font));
    };

    it("scene-11's message wraps to at most 2 lines and the bubble reads wide", () => {
      const font = chatMetrics([MSG], SLOT);
      const chars = perLine(font, SLOT.widthPx);
      expect(Math.ceil(MSG.length / chars)).toBeLessThanOrEqual(2);
      // The bubble spans a real share of the slot, not a thin column.
      const lineChars = Math.min(MSG.length, chars);
      const bubbleWidth = font * (lineChars * 0.58 + 2 * 0.85);
      expect(bubbleWidth).toBeGreaterThan(SLOT.widthPx * 0.6);
    });

    it("a long multi-message exchange still fits its slot height", () => {
      const messages = Array.from({ length: 5 }, (_, i) => ({
        from: i % 2 ? "agent" : "user",
        text: "a fairly long conversational message that wraps a few times over",
      }));
      const height = estimateHeightPx("ChatMock", { messages }, SLOT.widthPx, SLOT.heightPx);
      expect(height).toBeLessThanOrEqual(SLOT.heightPx + 1);
    });

    it("widening the slot strictly increases characters per line — what the box handle depends on", () => {
      const narrow = chatMetrics([MSG], SLOT);
      const wide = chatMetrics([MSG], { widthPx: SLOT.widthPx * 1.2, heightPx: SLOT.heightPx });
      expect(perLine(wide, SLOT.widthPx * 1.2)).toBeGreaterThan(perLine(narrow, SLOT.widthPx));
    });
  });
});

describe("a single unbreakable word never scales past its card (R12 §46)", () => {
  it("the real scene-4: RuleCard 'AI HARNESS' keeps HARNESS inside the slot", () => {
    // Rendered as AI / HARNESS, and HARNESS was wider than the card — the
    // glyphs ran past the rounded rect and the slot's overflow:hidden served
    // the viewer a severed S. The height model knows wrapping; a word can't.
    const props = { kicker: "NEEDED", text: "AI HARNESS" };
    const slot = slotOf("RuleCard");
    const minWidth = estimateMinWidthPx("RuleCard", props);
    expect(minWidth).toBeGreaterThan(0); // used to hit `default: return 0`
    const k = fitScale("RuleCard", props, slot);
    expect(minWidth * k).toBeLessThanOrEqual(slot.widthPx + 1);
    expect(k).toBeLessThan(2.4 - 1e-6); // the cap actually bound
  });

  it("TitleCard's longest word caps the scale the same way", () => {
    const props = { title: "AN UNBREAKABLETITLEWORD HERE" };
    const slot = slotOf("TitleCard");
    const minWidth = estimateMinWidthPx("TitleCard", props);
    expect(minWidth).toBeGreaterThan(0);
    const k = fitScale("TitleCard", props, slot);
    expect(minWidth * k).toBeLessThanOrEqual(slot.widthPx + 1);
  });
});

/**
 * R27 §121. Nothing asserted BulletList fills its slot: the fill assertions
 * skip self-fitting components, and the one bullet test uses 2-character items
 * so the WIDTH term never binds. On real copy it binds almost always, because
 * items are nowrap uppercase.
 */
describe("BulletList fill (§121)", () => {
  const SLOT = { w: 842.4, h: 806.4 }; // pip-bubble's graphic slot, portrait
  const REAL = ["MCP TOOLS", "CONTEXT", "TASK DEFINITION", "DEFINITION OF DONE"];
  const fill = (items: readonly string[], title = ""): number => {
    const font = bulletMetrics(items, SLOT.w, SLOT.h, Boolean(title), title);
    return bulletStackHeightPx(items.length, font, Boolean(title)) / SLOT.h;
  };

  it("fewer items render bigger — the §23 fill property, on real-length copy", () => {
    expect(fill(REAL.slice(0, 2))).toBeLessThan(1);
    expect(bulletMetrics(REAL.slice(0, 2), SLOT.w, SLOT.h)).toBeGreaterThanOrEqual(
      bulletMetrics(REAL, SLOT.w, SLOT.h),
    );
  });

  it("never overflows the slot it was given", () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(fill(REAL.slice(0, n) as string[], "LOOP INPUTS"), `${n} items`).toBeLessThanOrEqual(1);
    }
  });

  it("a long nowrap item is what caps the type, not the height budget", () => {
    // Documents the real constraint measured on the motivating render: the
    // stack fills ~55% of its slot and the leftover height CANNOT be spent
    // without wrapping an item, which would stop it reading as a list.
    // Widening the slot or allowing a two-line item is a design decision, not
    // a tuning one — this pins the trade-off rather than hiding it.
    const measured = fill(REAL, "LOOP INPUTS");
    expect(measured).toBeGreaterThan(0.4);
    expect(measured).toBeLessThan(0.7);
    // Short items in the same slot DO fill it — proof the model grows when it can.
    expect(fill(["ONE", "TWO", "THREE", "FOUR"], "LOOP INPUTS")).toBeGreaterThan(measured);
  });

  it("a tracked-out kicker is budgeted for width, not just ignored", () => {
    // letterSpacing 0.28em was unmodelled, so a long title could overrun.
    const long = bulletMetrics(REAL, SLOT.w, SLOT.h, true, "A".repeat(90));
    const short = bulletMetrics(REAL, SLOT.w, SLOT.h, true, "LOOP INPUTS");
    expect(long).toBeLessThan(short);
  });
});

describe("ClipScene fit (explainer plan Task 7)", () => {
  it("is never scaled: the video fills whatever slot it is given", () => {
    // `objectFit: contain` inside the slot does the fitting; a stage scale
    // would only shrink the box the video letterboxes into.
    expect(isSelfFitting("ClipScene")).toBe(true);
    const props = { src: "clips/a.webm", durationSec: 4.6, gainDb: -13, muted: false };
    for (const slot of [
      { widthPx: 1920, heightPx: 1080 },
      { widthPx: 1080, heightPx: 1920 },
      { widthPx: 831, heightPx: 691 },
      { widthPx: 120, heightPx: 80 },
    ]) {
      expect(fitScale("ClipScene", props, slot)).toBe(1);
    }
  });
});

describe("CardRow metrics (§161, plan Task 4 / Review Focus 3)", () => {
  const FRAMES = [
    { name: "16:9", w: 1920, h: 1080 },
    { name: "9:16", w: 1080, h: 1920 },
  ] as const;
  const SETS = [
    ["sparse", SPARSE.CardRow.cards],
    ["dense", DENSE.CardRow.cards],
    ["three", CARD_ROW_DENSE.slice(0, 3)],
  ] as const;
  type Cards = Parameters<typeof cardRowMetrics>[0];

  it("one row in a landscape frame, one column in a portrait one", () => {
    expect(cardRowMetrics(CARD_ROW_DENSE, 1920, 1080).mode).toBe("row");
    expect(cardRowMetrics(CARD_ROW_DENSE, 1080, 1920).mode).toBe("column");
  });

  it("keeps 100 px clear on every side on EVERY frame — a card at its peak bump included", () => {
    for (const f of FRAMES) {
      for (const [label, cards] of SETS) {
        const m = cardRowMetrics(cards as Cards, f.w, f.h);
        expect(m.marginPx, f.name).toBe(PATTERN_MARGIN_PX);
        // The block is centred; an edge card scaled about its centre reaches
        // (peak - 1) / 2 of its own size past its box.
        const growW = ((CARD_PEAK_SCALE - 1) / 2) * m.cardWidthPx;
        const growH = ((CARD_PEAK_SCALE - 1) / 2) * m.cardHeightPx;
        const side = (f.w - m.blockWidthPx) / 2 - growW;
        const top = (f.h - m.blockHeightPx) / 2 - growH;
        expect(side, `${f.name} ${label}: side margin`).toBeGreaterThanOrEqual(PATTERN_MARGIN_PX);
        expect(top, `${f.name} ${label}: top margin`).toBeGreaterThanOrEqual(PATTERN_MARGIN_PX);
      }
    }
  });

  it("a card at its peak never reaches its settled neighbour", () => {
    for (const f of FRAMES) {
      for (const [label, cards] of SETS) {
        const m = cardRowMetrics(cards as Cards, f.w, f.h);
        const along = m.mode === "row" ? m.cardWidthPx : m.cardHeightPx;
        expect(((CARD_PEAK_SCALE - 1) / 2) * along, `${f.name} ${label}`).toBeLessThan(m.gapPx);
      }
    }
  });

  it("never sets type under the 34 px floor, at schema-max copy in either aspect", () => {
    for (const f of FRAMES) {
      const m = cardRowMetrics(CARD_ROW_DENSE, f.w, f.h);
      expect(m.titlePx, f.name).toBeGreaterThanOrEqual(34);
      expect(m.subPx, f.name).toBeGreaterThanOrEqual(34);
      // Schema-max titles still fit whole words at the solved size.
      expect(m.titleWordsFit, f.name).toBe(true);
    }
  });

  it("less copy reads bigger, and a sub-line never outgrows its title", () => {
    const sparse = cardRowMetrics(SPARSE.CardRow.cards as Cards, 1920, 1080);
    const dense = cardRowMetrics(CARD_ROW_DENSE, 1920, 1080);
    expect(sparse.titlePx).toBeGreaterThan(dense.titlePx);
    for (const m of [sparse, dense]) expect(m.subPx).toBeLessThanOrEqual(m.titlePx);
  });

  it("is self-fitting: the stage leaves it at scale 1 in the whole frame", () => {
    expect(isSelfFitting("CardRow")).toBe(true);
    expect(fitScale("CardRow", DENSE.CardRow, { widthPx: 1920, heightPx: 1080 })).toBe(1);
  });

  it("an unbounded height still answers a finite estimate", () => {
    expect(Number.isFinite(estimateHeightPx("CardRow", DENSE.CardRow, 1080))).toBe(true);
  });
});

describe("CtaCard metrics (§161, plan Task 5 / Review Focus 3)", () => {
  const FRAMES = [
    { name: "16:9", w: 1920, h: 1080 },
    { name: "9:16", w: 1080, h: 1920 },
  ] as const;
  type Input = Parameters<typeof ctaCardMetrics>[0];
  const SPARSE_CTA: Input[] = [
    { action: "comment", text: "Want it?", keyword: "PROMPT" },
    { action: "subscribe", text: "Subscribe for more" },
    { action: "link", text: "Grab the template", keyword: "ossclip.dev" },
  ];
  const DENSE_CTA: Input[] = (["comment", "subscribe", "link"] as const).map((action) => ({
    ...CTA_DENSE,
    action,
    keyword: action === "link" ? "ossclip.dev/tmpl" : CTA_DENSE.keyword,
  }));
  // A comment with no keyword types its 40-character headline into the box.
  const BOX_HEADLINE: Input = { action: "comment", text: CTA_DENSE.text };
  const ALL: [string, Input][] = [
    ...SPARSE_CTA.map((p) => [`sparse ${p.action}`, p] as [string, Input]),
    ...DENSE_CTA.map((p) => [`dense ${p.action}`, p] as [string, Input]),
    ["dense comment, no keyword", BOX_HEADLINE],
    ["subscribe, no channel", { ...DENSE_CTA[1]!, channel: undefined }],
    ["link, no keyword", { action: "link", text: CTA_DENSE.text }],
  ];

  it("CTA_PEAK_SCALE covers popScale's overshoot, and the button peak is bump's", () => {
    let peak = 0;
    for (let t = 0; t <= 0.35; t += 0.0005) peak = Math.max(peak, popScale(t));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(CTA_PEAK_SCALE);
    expect(bump(0.15)).toBeCloseTo(CTA_BUTTON_PEAK_SCALE, 10);
  });

  it("keeps 100 px clear on every side on EVERY frame — the card at its pop peak included", () => {
    for (const f of FRAMES) {
      for (const [label, p] of ALL) {
        const m = ctaCardMetrics(p, f.w, f.h);
        expect(m.marginPx, f.name).toBe(PATTERN_MARGIN_PX);
        // Centred, scaled about its centre: the box grows (peak - 1) / 2 of its size per side.
        const side = (f.w - m.blockWidthPx * CTA_PEAK_SCALE) / 2;
        const top = (f.h - m.blockHeightPx * CTA_PEAK_SCALE) / 2;
        expect(side, `${f.name} ${label}: side margin`).toBeGreaterThanOrEqual(PATTERN_MARGIN_PX);
        expect(top, `${f.name} ${label}: top margin`).toBeGreaterThanOrEqual(PATTERN_MARGIN_PX);
      }
    }
  });

  it("a pressed button stays inside the card's 40 px padding", () => {
    for (const f of FRAMES) {
      for (const [label, p] of ALL) {
        const m = ctaCardMetrics(p, f.w, f.h);
        const growX = ((CTA_BUTTON_PEAK_SCALE - 1) / 2) * m.buttonWidthPx;
        const growY = ((CTA_BUTTON_PEAK_SCALE - 1) / 2) * m.buttonHeightPx;
        expect(growX, `${f.name} ${label}`).toBeLessThan(40);
        expect(growY, `${f.name} ${label}`).toBeLessThan(36);
      }
    }
  });

  it("never sets type under the floors (34 px, 26 px mono), and schema-max copy keeps whole words", () => {
    for (const f of FRAMES) {
      for (const [label, p] of ALL) {
        const m = ctaCardMetrics(p, f.w, f.h);
        expect(m.headPx, `${f.name} ${label}`).toBeGreaterThanOrEqual(34);
        expect(m.labelPx, `${f.name} ${label}`).toBeGreaterThanOrEqual(34);
        expect(m.actionPx, `${f.name} ${label}`).toBeGreaterThanOrEqual(p.action === "link" ? 26 : 34);
        expect(m.headWordsFit, `${f.name} ${label}: headline`).toBe(true);
        expect(m.actionWordsFit, `${f.name} ${label}: row`).toBe(true);
        expect(m.headLines, `${f.name} ${label}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("a keyword or a URL takes one line; a comment that is the headline, or a channel, two at most", () => {
    for (const f of FRAMES) {
      for (const p of DENSE_CTA) {
        const m = ctaCardMetrics(p, f.w, f.h);
        if (p.action === "subscribe") expect(m.actionLines, `${f.name} channel`).toBeLessThanOrEqual(2);
        else expect(m.actionLines, `${f.name} ${p.action}`).toBe(1);
      }
    }
    // The headline typed into the box: two lines in 16:9; in 9:16 the floor
    // binds first and it takes a third, which the box is held tall enough for.
    expect(ctaCardMetrics(BOX_HEADLINE, 1920, 1080).actionLines).toBeLessThanOrEqual(2);
    const portrait = ctaCardMetrics(BOX_HEADLINE, 1080, 1920);
    expect(portrait.actionPx).toBe(34);
    expect(portrait.actionLines).toBeLessThanOrEqual(3);
  });

  it("sizes the card to its content: a sparse card is narrower than a dense one, and less copy reads bigger", () => {
    expect(ctaCardMetrics(SPARSE_CTA[1]!, 1920, 1080).cardWidthPx).toBeLessThan(
      ctaCardMetrics(DENSE_CTA[1]!, 1920, 1080).cardWidthPx,
    );
    // In 16:9 both headlines fit two lines at the 72 px cap; 9:16 is where
    // the 40 characters have to come down.
    expect(ctaCardMetrics(SPARSE_CTA[1]!, 1080, 1920).headPx).toBeGreaterThan(
      ctaCardMetrics(DENSE_CTA[1]!, 1080, 1920).headPx,
    );
  });

  it("the action row never outgrows its headline", () => {
    for (const f of FRAMES) {
      for (const [label, p] of ALL) {
        const m = ctaCardMetrics(p, f.w, f.h);
        if (m.headLines === 0) continue;
        const floor = p.action === "link" ? 26 : 34;
        expect(m.actionPx, `${f.name} ${label}`).toBeLessThanOrEqual(Math.max(floor, Math.round(m.headPx * 0.8)));
      }
    }
  });

  it("the Subscribe button is as wide as its Subscribed state, so the press does not move the row", () => {
    const m = ctaCardMetrics(SPARSE_CTA[1]!, 1920, 1080);
    // "Subscribed" plus a tick is the wider of the two labels.
    expect(m.buttonWidthPx).toBeGreaterThan(m.labelPx * 6 + m.tickPx);
  });

  it("the channel sits beside the button in 16:9 and above it in 9:16", () => {
    expect(ctaCardMetrics(DENSE_CTA[1]!, 1920, 1080).mode).toBe("row");
    expect(ctaCardMetrics(DENSE_CTA[1]!, 1080, 1920).mode).toBe("column");
  });

  it("is self-fitting: the stage leaves it at scale 1 in the whole frame", () => {
    expect(isSelfFitting("CtaCard")).toBe(true);
    expect(fitScale("CtaCard", DENSE.CtaCard, { widthPx: 1920, heightPx: 1080 })).toBe(1);
    expect(Number.isFinite(estimateHeightPx("CtaCard", DENSE.CtaCard, 1080))).toBe(true);
  });
});

describe("ctaContent (§161, plan Task 5)", () => {
  it("a comment types its keyword under the headline, or the headline itself when there is none", () => {
    expect(ctaContent({ action: "comment", text: "Want it?", keyword: "PROMPT" })).toEqual({
      headline: "Want it?",
      field: "PROMPT",
      fieldId: "keyword",
      channel: null,
    });
    expect(ctaContent({ action: "comment", text: "Comment AGENT", keyword: "" })).toEqual({
      headline: null,
      field: "Comment AGENT",
      fieldId: "text",
      channel: null,
    });
  });

  it("subscribe shows the channel only when it has one, and never a keyword", () => {
    expect(ctaContent({ action: "subscribe", text: "Sub", keyword: "X", channel: "Ch" })).toEqual({
      headline: "Sub",
      field: null,
      fieldId: null,
      channel: "Ch",
    });
    expect(ctaContent({ action: "subscribe", text: "Sub", channel: "" }).channel).toBeNull();
  });

  it("a link with no keyword is the headline alone; a channel on any other action is not drawn", () => {
    expect(ctaContent({ action: "link", text: "Link below" })).toEqual({
      headline: "Link below",
      field: null,
      fieldId: null,
      channel: null,
    });
    expect(ctaContent({ action: "link", text: "L", keyword: "a.dev", channel: "Ch" })).toMatchObject({
      field: "a.dev",
      fieldId: "keyword",
      channel: null,
    });
  });
});

describe("BugCard metrics (§161, plan Task 6 / Review Focus 3)", () => {
  const FRAMES = [
    { name: "16:9", w: 1920, h: 1080 },
    { name: "9:16", w: 1080, h: 1920 },
  ] as const;
  type Input = Parameters<typeof bugCardMetrics>[0];
  const base: Input = { number: 1, headline: "Captions drift", mock: "none", mockLines: [], mockFault: "struck" };
  const CAPTION_WORDS = ["Claude", "wrote", "the", "migration"];
  const ALL: [string, Input][] = [
    ["sparse, no mock", base],
    ["sparse caption, struck", { ...base, mock: "caption", mockLines: ["Ask", "Cloud", "to", "refactor"], mockWrong: 1 }],
    [
      "caption, clipped",
      { ...base, mock: "caption", mockLines: CAPTION_WORDS, mockWrong: 3, mockFault: "clipped", sticker: "WATCH THE EDGE" },
    ],
    ["dense lines", { ...BUG_DENSE, mockLines: [...BUG_DENSE.mockLines] }],
    ["dense caption, struck", { ...BUG_DENSE, mock: "caption", mockLines: [...BUG_DENSE.mockLines] }],
    [
      "dense caption, clipped",
      { ...BUG_DENSE, mock: "caption", mockLines: [...BUG_DENSE.mockLines], mockFault: "clipped" },
    ],
    [
      "dense caption, clipped mid-row",
      { ...BUG_DENSE, mock: "caption", mockLines: [...BUG_DENSE.mockLines], mockFault: "clipped", mockWrong: 1 },
    ],
    ["dense, no mock", { ...BUG_DENSE, mock: "none" }],
    ["dense, no sticker", { ...BUG_DENSE, sticker: undefined }],
  ];
  const tilt = (Math.abs(BUG_STICKER_TILT_DEG) * Math.PI) / 180;
  const stickerPeak = (s: { w: number; h: number }) => ({
    w: (s.w * Math.cos(tilt) + s.h * Math.sin(tilt)) * BUG_STICKER_PEAK_SCALE,
    h: (s.w * Math.sin(tilt) + s.h * Math.cos(tilt)) * BUG_STICKER_PEAK_SCALE,
  });

  it("BUG_PEAK_SCALE covers popScale's overshoot; the sticker's peak is bump's", () => {
    let peak = 0;
    for (let t = 0; t <= 0.35; t += 0.0005) peak = Math.max(peak, popScale(t));
    expect(peak).toBeLessThanOrEqual(BUG_PEAK_SCALE);
    expect(bump(0.15)).toBeCloseTo(BUG_STICKER_PEAK_SCALE, 10);
  });

  it("keeps 100 px clear on every side on EVERY frame: each panel at its pop peak, the sticker at its bump", () => {
    for (const f of FRAMES) {
      for (const [label, p] of ALL) {
        const m = bugCardMetrics(p, f.w, f.h);
        expect(m.marginPx).toBe(PATTERN_MARGIN_PX);
        for (const r of [m.textPanel, m.mockPanel]) {
          if (r === null) continue;
          const gx = ((BUG_PEAK_SCALE - 1) / 2) * r.w;
          const gy = ((BUG_PEAK_SCALE - 1) / 2) * r.h;
          expect(r.x - gx, `${f.name} ${label}: left`).toBeGreaterThanOrEqual(PATTERN_MARGIN_PX);
          expect(r.x + r.w + gx, `${f.name} ${label}: right`).toBeLessThanOrEqual(f.w - PATTERN_MARGIN_PX);
          expect(r.y - gy, `${f.name} ${label}: top`).toBeGreaterThanOrEqual(PATTERN_MARGIN_PX);
          expect(r.y + r.h + gy, `${f.name} ${label}: bottom`).toBeLessThanOrEqual(f.h - PATTERN_MARGIN_PX);
        }
        if (m.sticker !== null) {
          const s = stickerPeak(m.sticker);
          expect(m.sticker.cx - s.w / 2, `${f.name} ${label}: sticker left`).toBeGreaterThanOrEqual(PATTERN_MARGIN_PX);
          expect(m.sticker.cx + s.w / 2, `${f.name} ${label}: sticker right`).toBeLessThanOrEqual(
            f.w - PATTERN_MARGIN_PX,
          );
          expect(m.sticker.cy + s.h / 2, `${f.name} ${label}: sticker bottom`).toBeLessThanOrEqual(
            f.h - PATTERN_MARGIN_PX,
          );
        }
      }
    }
  });

  it("the panels never touch, even with one at its pop peak", () => {
    for (const [label, p] of ALL) {
      const m = bugCardMetrics(p, 1920, 1080);
      if (m.mockPanel === null) continue;
      const gap = m.mockPanel.x - (m.textPanel.x + m.textPanel.w);
      expect(gap).toBe(BUG_PANEL_GAP_PX);
      expect(gap - ((BUG_PEAK_SCALE - 1) / 2) * m.mockPanel.w, label).toBeGreaterThan(0);
    }
  });

  it("the sticker overlaps its panel's bottom edge but never its content, so the fault stays in view", () => {
    for (const f of FRAMES) {
      for (const [label, p] of ALL) {
        const m = bugCardMetrics(p, f.w, f.h);
        if (m.sticker === null) continue;
        const anchor = m.mockPanel ?? m.textPanel;
        const content = m.mockPanel !== null ? m.mockContentPx : m.textContentPx;
        const contentBottom = anchor.y + (anchor.h + content) / 2;
        const s = stickerPeak(m.sticker);
        expect(m.sticker.cy - s.h / 2, `${f.name} ${label}`).toBeGreaterThanOrEqual(contentBottom);
        expect(m.sticker.cy - m.sticker.h / 2, `${f.name} ${label}: overlaps the edge`).toBeLessThan(
          anchor.y + anchor.h,
        );
        // Over the right half of the panel: its lower right corner.
        expect(m.sticker.cx, `${f.name} ${label}`).toBeGreaterThan(anchor.x + anchor.w / 2);
      }
    }
  });

  it("never sets type under the floors (34 px, 26 px mono), and schema-max copy keeps whole words", () => {
    for (const f of FRAMES) {
      for (const [label, p] of ALL) {
        const m = bugCardMetrics(p, f.w, f.h);
        expect(m.headPx, `${f.name} ${label}`).toBeGreaterThanOrEqual(34);
        if (p.sub) expect(m.subPx, `${f.name} ${label}`).toBeGreaterThanOrEqual(34);
        // NumberBadge sets its numeral at 0.58 of the disc.
        expect(Math.round(m.badgePx * 0.58), `${f.name} ${label}: badge`).toBeGreaterThanOrEqual(34);
        if (m.sticker !== null) expect(m.sticker.sizePx).toBeGreaterThanOrEqual(34);
        if (m.capPx > 0) expect(m.capPx, `${f.name} ${label}`).toBeGreaterThanOrEqual(34);
        if (m.linePx > 0) expect(m.linePx, `${f.name} ${label}`).toBeGreaterThanOrEqual(26);
        expect(m.headWordsFit, `${f.name} ${label}: headline`).toBe(true);
        expect(m.subWordsFit, `${f.name} ${label}: sub`).toBe(true);
        expect(m.headLines, `${f.name} ${label}`).toBeLessThanOrEqual(2);
        expect(m.subLines, `${f.name} ${label}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("draws the mock in 16:9 only, beside the text panel at one height", () => {
    const wide = bugCardMetrics(ALL[3]![1], 1920, 1080);
    expect(wide.mode).toBe("split");
    expect(wide.mockPanel!.h).toBe(wide.textPanel.h);
    expect(wide.mockPanel!.x).toBeGreaterThan(wide.textPanel.x);
    const tall = bugCardMetrics(ALL[3]![1], 1080, 1920);
    expect(tall.mode).toBe("single");
    expect(tall.mockPanel).toBeNull();
    // Centred.
    expect(tall.textPanel.x + tall.textPanel.w / 2).toBeCloseTo(540, 0);
  });

  it("schema-max code lines fit unwrapped, with the cross's gutter only when a line is marked", () => {
    const m = bugCardMetrics(ALL[3]![1], 1920, 1080);
    expect(m.lineFits).toEqual([true, true, true, true]);
    expect(m.gutterPx).toBeGreaterThan(0);
    expect(bugCardMetrics({ ...ALL[3]![1], mockWrong: undefined }, 1920, 1080).gutterPx).toBe(0);
  });

  it("a short caption stays on one row; schema-max entries take two at most above the floor", () => {
    const sparse = bugCardMetrics(ALL[1]![1], 1920, 1080);
    expect(sparse.capRows).toEqual([[0, 1, 2, 3]]);
    // Above the one-row floor (40), and as big as one row allows.
    expect(sparse.capPx).toBeGreaterThan(40);
    expect(bugCardMetrics({ ...ALL[1]![1], mockLines: ["Ask", "Cloud"] }, 1920, 1080).capPx).toBe(64);
    const dense = bugCardMetrics(ALL[4]![1], 1920, 1080);
    expect(dense.capRows.length <= 2 || dense.capPx === 34, `${dense.capRows.length} rows at ${dense.capPx}`).toBe(
      true,
    );
    expect(dense.capRows.flat()).toEqual([0, 1, 2, 3]);
  });

  it("a clipped caption fits whole before the fault, and its row is wider than the panel by half the word", () => {
    const m = bugCardMetrics(ALL[2]![1], 1920, 1080);
    expect(m.clipRow).toBe(0);
    expect(m.capRows).toEqual([[0, 1, 2, 3]]);
    const innerW = m.mockPanel!.w - 2 * (5 + 40);
    // The row runs past the inner edge and the padding: the clip edge.
    expect(m.clipRowWidthPx).toBeGreaterThan(innerW + 40);
    // Struck captions have no such row.
    expect(bugCardMetrics(ALL[1]![1], 1920, 1080).clipRow).toBe(-1);
  });

  it("marks nothing for an absent, out-of-range or blank mockWrong", () => {
    const p = ALL[1]![1];
    expect(bugCardMetrics({ ...p, mockWrong: undefined }, 1920, 1080).wrongIndex).toBeNull();
    expect(bugCardMetrics({ ...p, mockLines: ["a", "b"], mockWrong: 3 }, 1920, 1080).wrongIndex).toBeNull();
    expect(bugCardMetrics({ ...p, mockLines: ["a", " "], mockWrong: 1 }, 1920, 1080).wrongIndex).toBeNull();
    expect(bugCardMetrics(p, 1920, 1080).wrongIndex).toBe(1);
    // Not drawn, so nothing is marked either.
    expect(bugCardMetrics(p, 1080, 1920).wrongIndex).toBeNull();
  });

  it("bugMockVisible agrees with the metric's mode", () => {
    for (const f of FRAMES) {
      for (const [label, p] of ALL) {
        const m = bugCardMetrics(p, f.w, f.h);
        expect(m.mockPanel !== null, `${f.name} ${label}`).toBe(
          bugMockVisible(p, f.w >= f.h ? "16:9" : "9:16"),
        );
      }
    }
  });

  it("is self-fitting: the stage leaves it at scale 1 in the whole frame", () => {
    expect(isSelfFitting("BugCard")).toBe(true);
    expect(fitScale("BugCard", DENSE.BugCard, { widthPx: 1920, heightPx: 1080 })).toBe(1);
    expect(Number.isFinite(estimateHeightPx("BugCard", DENSE.BugCard, 1080))).toBe(true);
  });
});
