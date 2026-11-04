import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  ChatMockProps,
  FlowDiagramProps,
  REVEAL_PROP_KEYS,
  REVEAL_SPEED_DEFAULT,
  SCENE_REGISTRY,
  StrikethroughRevealProps,
  TerminalMockProps,
  llmPropsSchema,
} from "../src/scene-registry";
import { scalarPropControls } from "../src/scene-props-controls";

/**
 * Reveal-timing spec §5: the four item-revealing components gain author-only
 * reveal props. They parse from the registry schema (so the editor and the
 * renderer read them) but never reach the prop-writing LLM call.
 */
const VALID = {
  FlowDiagram: { nodes: ["A", "B"] },
  ChatMock: { messages: [{ from: "user", text: "hi" }] },
  TerminalMock: { windows: [{ title: "t", lines: ["$ run"] }] },
  StrikethroughReveal: { lines: [{ text: "NOT THIS", struck: true }] },
} as const;

const SCHEMAS = {
  FlowDiagram: FlowDiagramProps,
  ChatMock: ChatMockProps,
  TerminalMock: TerminalMockProps,
  StrikethroughReveal: StrikethroughRevealProps,
} as const;

describe("reveal props on the four item-revealing components", () => {
  for (const [id, schema] of Object.entries(SCHEMAS)) {
    const valid = VALID[id as keyof typeof VALID];

    it(`${id} parses the reveal props`, () => {
      const parsed = schema.parse({
        ...valid,
        reveal: "paced",
        pacing: "accelerate",
        revealSpeed: 0.5,
        entrance: "bounce",
      });
      expect(parsed).toMatchObject({
        reveal: "paced",
        pacing: "accelerate",
        revealSpeed: 0.5,
        entrance: "bounce",
      });
    });

    it(`${id} rejects an out-of-range speed and an unknown pacing`, () => {
      expect(schema.safeParse({ ...valid, revealSpeed: 1.5 }).success).toBe(false);
      expect(schema.safeParse({ ...valid, pacing: "fast" }).success).toBe(false);
    });

    it(`${id} leaves the reveal props ABSENT when unset — no defaults`, () => {
      // Absence is how the renderer tells "author never touched it" from an
      // explicit choice (plan Review Focus 5): a default here would flip every
      // legacy scene onto the paced path.
      const parsed = schema.parse(valid) as Record<string, unknown>;
      for (const k of REVEAL_PROP_KEYS) expect(k in parsed).toBe(false);
    });
  }
});

describe("llmPropsSchema", () => {
  it("hides the reveal props from the LLM but keeps the content props", () => {
    const text = JSON.stringify(z.toJSONSchema(llmPropsSchema("FlowDiagram")));
    for (const k of REVEAL_PROP_KEYS) expect(text).not.toContain(`"${k}"`);
    expect(text).toContain("nodes");
  });

  it("is the registry schema verbatim for components without reveal props", () => {
    expect(llmPropsSchema("StatCard")).toBe(SCENE_REGISTRY.StatCard.propsSchema);
  });
});

describe("scalarPropControls — reveal controls", () => {
  it("gives FlowDiagram a speed slider and the three enum dropdowns", () => {
    const controls = scalarPropControls("FlowDiagram");
    expect(controls).toContainEqual(
      expect.objectContaining({
        key: "revealSpeed",
        kind: "number",
        min: 0.1,
        max: 1,
        step: 0.05,
        fallback: REVEAL_SPEED_DEFAULT,
      }),
    );
    for (const key of ["reveal", "pacing", "entrance"]) {
      // `optional` lets the dropdown offer "unset" — picking "even" is NOT
      // the same as never touching pacing (Review Focus 5).
      expect(controls).toContainEqual(
        expect.objectContaining({ key, kind: "enum", optional: true }),
      );
    }
  });

  it("StatCard gains nothing", () => {
    expect(scalarPropControls("StatCard")).toEqual([
      { key: "inverted", kind: "boolean", fallback: false },
    ]);
  });
});
