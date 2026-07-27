import { describe, expect, it } from "vitest";
import { flowLayout } from "../src/components/FlowDiagram";
import { applyCtaKeyword } from "../src/components/ChatMock";

/**
 * The real `graphic-only` slot the diagram is laid out in. The old tests
 * asserted against hardcoded 820/900 budgets that matched no actual slot —
 * which is part of why the diagram under-filled by 90% (FINDINGS §23).
 */
const SLOT_W = 0.8 * 1080;
const SLOT_H = 0.54 * 1920;
/** flowMetrics reserves the root's "0 10px" padding. */
const BUDGET_W = SLOT_W - 20;

/** Mirrors the component's conservative width/height model. */
const rowWidth = (nodes: string[], font: number): number => {
  const chars = nodes.reduce((a, n) => a + n.length, 0);
  return font * (0.78 * chars + 1.6 * nodes.length + 1.8 * (nodes.length - 1));
};
const stackWidth = (nodes: string[], font: number): number =>
  font * (0.78 * Math.max(...nodes.map((n) => n.length)) + 1.6);
const stackHeight = (nodes: string[], font: number): number =>
  font * (2.1 * nodes.length + 2.05 * (nodes.length - 1));

describe("flowLayout (FINDINGS §1/§12/§23)", () => {
  it("never overflows its slot, in either orientation", () => {
    for (const nodes of [
      ["TEAM", "AI", "CHURN"],
      ["1 AGENT", "1 DIR", "1 DONE BAR"],
      ["RECORD THE TAKE", "CUT THE SILENCE", "CAPTION IT ALL", "SHIP THE SHORT"],
      Array.from({ length: 5 }, () => "SIXTEEN CHARS AB"),
      ["A", "B"],
    ]) {
      const { mode, fontSize } = flowLayout(nodes, SLOT_W, SLOT_H);
      const w = mode === "row" ? rowWidth(nodes, fontSize) : stackWidth(nodes, fontSize);
      const h = mode === "row" ? fontSize * 2.1 : stackHeight(nodes, fontSize);
      expect(w, `${mode} too wide for ${nodes.length} nodes`).toBeLessThanOrEqual(BUDGET_W + 1);
      expect(h, `${mode} too tall for ${nodes.length} nodes`).toBeLessThanOrEqual(SLOT_H + 1);
      expect(fontSize).toBeGreaterThanOrEqual(22);
    }
  });

  it("a tall slot gets the vertical flow, not a thin strip (§23)", () => {
    // Three short chips in graphic-only used to render one 88px row in a
    // 1037px slot — 8% fill, the defect §23 reported.
    const nodes = ["LOOP", "BUILD", "VERIFY"];
    const { mode, fontSize } = flowLayout(nodes, SLOT_W, SLOT_H);
    expect(mode).toBe("stack");
    expect(stackHeight(nodes, fontSize) / SLOT_H).toBeGreaterThan(0.6);
  });

  it("a band too short to stack keeps the horizontal flow", () => {
    // A row is bounded by WIDTH, so it can only ever fill a short band. Where
    // a legible stack does not fit, the reference's horizontal flow is used.
    const { mode } = flowLayout(["TEAM", "AI", "CHURN"], SLOT_W, 220);
    expect(mode).toBe("row");
  });

  it("the copy that wrapped in the v3 render still fits its row (§12)", () => {
    // "1 AGENT → 1 DIR / → 1 DONE BAR" — the §12 evidence. Forced into row
    // mode by a short band; the guarantee is that it never wraps.
    const nodes = ["1 AGENT", "1 DIR", "1 DONE BAR"];
    const { mode, fontSize } = flowLayout(nodes, SLOT_W, 200);
    expect(mode).toBe("row");
    expect(rowWidth(nodes, fontSize)).toBeLessThanOrEqual(BUDGET_W);
  });

  it("long real-copy labels never wrap — they stack", () => {
    const nodes = ["RECORD THE TAKE", "CUT THE SILENCE", "CAPTION IT ALL", "SHIP THE SHORT"];
    const { mode, fontSize } = flowLayout(nodes, SLOT_W, SLOT_H);
    expect(mode).toBe("stack");
    expect(stackWidth(nodes, fontSize)).toBeLessThanOrEqual(BUDGET_W);
    expect(stackHeight(nodes, fontSize)).toBeLessThanOrEqual(SLOT_H);
  });
});

describe("applyCtaKeyword (FINDINGS §16)", () => {
  it("quotes and capitalizes the keyword inside a message", () => {
    expect(applyCtaKeyword("comment agents and find out", "agents")).toBe(
      'comment "AGENTS" and find out',
    );
  });
  it("absorbs quotes the LLM already wrote instead of doubling them", () => {
    expect(applyCtaKeyword('type "agents" below', "agents")).toBe('type "AGENTS" below');
  });
  it("matches case-insensitively and leaves other words alone", () => {
    expect(applyCtaKeyword("AGENTS. that's the word", "agents")).toBe('"AGENTS". that\'s the word');
  });
  it("no keyword — text unchanged", () => {
    expect(applyCtaKeyword("hello there", undefined)).toBe("hello there");
  });
});
