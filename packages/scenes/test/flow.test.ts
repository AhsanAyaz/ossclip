import { describe, expect, it } from "vitest";
import { flowLayout } from "../src/components/FlowDiagram";
import { applyCtaKeyword } from "../src/components/ChatMock";

/** Mirrors the component's conservative width/height model. */
const rowWidth = (nodes: string[], font: number): number => {
  const chars = nodes.reduce((a, n) => a + n.length, 0);
  return font * (0.78 * chars + 1.6 * nodes.length + 1.8 * (nodes.length - 1));
};

describe("flowLayout (FINDINGS §1/§12)", () => {
  it("short labels fit one row at a readable size", () => {
    const { mode, fontSize } = flowLayout(["TEAM", "AI", "CHURN"]);
    expect(mode).toBe("row");
    expect(fontSize).toBeGreaterThanOrEqual(26);
    expect(fontSize).toBeLessThanOrEqual(44);
  });

  it("the copy that wrapped in the v3 render now fits its row", () => {
    // "1 AGENT → 1 DIR / → 1 DONE BAR" — the §12 evidence.
    const nodes = ["1 AGENT", "1 DIR", "1 DONE BAR"];
    const { mode, fontSize } = flowLayout(nodes);
    expect(mode).toBe("row");
    expect(rowWidth(nodes, fontSize)).toBeLessThanOrEqual(820);
  });

  it("long real-copy labels switch to the vertical stack instead of wrapping", () => {
    const nodes = ["RECORD THE TAKE", "CUT THE SILENCE", "CAPTION IT ALL", "SHIP THE SHORT"];
    const { mode, fontSize } = flowLayout(nodes);
    expect(mode).toBe("stack");
    expect(fontSize).toBeGreaterThanOrEqual(22);
    expect(fontSize).toBeLessThanOrEqual(40);
    // Widest chip fits the safe width; the whole stack fits the slot height.
    const longest = Math.max(...nodes.map((n) => n.length));
    expect(fontSize * (0.78 * longest + 1.6)).toBeLessThanOrEqual(820);
    expect(fontSize * (2.1 * nodes.length + 2.05 * (nodes.length - 1))).toBeLessThanOrEqual(900);
  });

  it("worst-case schema copy (5 nodes × 16 chars) still fits as a stack", () => {
    const nodes = Array.from({ length: 5 }, () => "SIXTEEN CHARS AB");
    const { mode, fontSize } = flowLayout(nodes);
    expect(mode).toBe("stack");
    expect(fontSize * (0.78 * 16 + 1.6)).toBeLessThanOrEqual(820);
    expect(fontSize * (2.1 * 5 + 2.05 * 4)).toBeLessThanOrEqual(900);
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
