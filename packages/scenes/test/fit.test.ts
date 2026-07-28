import { describe, expect, it } from "vitest";
import { SCENE_REGISTRY, SceneComponentIdSchema, type SceneComponentId } from "@ossclip/core";
import {
  FILL_TARGET,
  MAX_SCALE,
  chatBubbles,
  chatMetrics,
  estimateHeightPx,
  estimateMinWidthPx,
  fitScale,
  isSelfFitting,
  revealMetrics,
  revealRows,
} from "../src/fit";
import { layoutSlots } from "../src/stage";

const FRAME_W = 1080;
const FRAME_H = 1920;

function slotOf(component: SceneComponentId) {
  const layout = SCENE_REGISTRY[component].defaultLayout;
  const g = layoutSlots(layout).graphic!;
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
    for (const set of [SPARSE, DENSE]) {
      for (const id of ["TerminalMock", "StatCard"] as const) {
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
