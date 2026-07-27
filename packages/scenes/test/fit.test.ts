import { describe, expect, it } from "vitest";
import { SCENE_REGISTRY, SceneComponentIdSchema, type SceneComponentId } from "@ossclip/core";
import {
  FILL_TARGET,
  MAX_SCALE,
  estimateHeightPx,
  estimateMinWidthPx,
  fitScale,
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
    for (const id of ["TitleCard", "StrikethroughReveal", "ChatMock", "TerminalMock"] as const) {
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
      // FlowDiagram solves its own type against the slot and is bounded by
      // legibility caps rather than this target — see flow.test.ts.
      if (id === "FlowDiagram") continue;
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
    const slot = slotOf("ChatMock");
    const one = fitScale("ChatMock", { messages: [{ from: "user", text: "why?" }] }, slot);
    const four = fitScale("ChatMock", DENSE.ChatMock, slot);
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
