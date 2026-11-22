import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import type { LlmProvider } from "../src/producer/provider";
import type { Moment } from "../src/producer/beats";
import { generateScenes } from "../src/producer/scene-props";
import type { Transcript } from "../src/schema";
import type { SceneComponentId } from "../src/scene-schema";
import {
  BulletListProps,
  ChatMockProps,
  FlowDiagramProps,
  REVEAL_PROP_KEYS,
  REVEAL_SPEED_DEFAULT,
  SCENE_REGISTRY,
  SCRIPT_ONLY_PROP_KEYS,
  StrikethroughRevealProps,
  TerminalMockProps,
  llmPropsSchema,
  plannerComponentIds,
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
  // Joined the reveal system in graphic-editor-modal §1.
  BulletList: { items: ["A", "B"] },
} as const;

const SCHEMAS = {
  FlowDiagram: FlowDiagramProps,
  ChatMock: ChatMockProps,
  TerminalMock: TerminalMockProps,
  StrikethroughReveal: StrikethroughRevealProps,
  BulletList: BulletListProps,
} as const;

describe("reveal props on the item-revealing components (FlowDiagram, ChatMock, TerminalMock, StrikethroughReveal, BulletList)", () => {
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

/**
 * The LLM-facing props schema of every component exactly as it was BEFORE the
 * reveal props existed — generated from the registry at 8d81238 (the commit
 * before reveal-timing Task 2) with `JSON.stringify(z.toJSONSchema(schema))`.
 * Regenerate it only for a deliberate change to what the LLM is shown; a
 * reveal prop leaking into the prompt is exactly the diff this catches.
 */
const PRE_REVEAL_LLM_SCHEMAS = JSON.parse(
  readFileSync(new URL("./fixtures/llm-props-schemas.pre-reveal.json", import.meta.url), "utf8"),
) as Record<SceneComponentId, string>;

describe("llmPropsSchema", () => {
  for (const [id, content] of [
    ["FlowDiagram", "nodes"],
    ["ChatMock", "messages"],
    ["TerminalMock", "windows"],
    ["StrikethroughReveal", "lines"],
    ["BulletList", "items"],
  ] as const) {
    it(`hides the reveal props of ${id} from the LLM but keeps its content props`, () => {
      const text = JSON.stringify(z.toJSONSchema(llmPropsSchema(id)));
      for (const k of REVEAL_PROP_KEYS) expect(text).not.toContain(`"${k}"`);
      expect(text).toContain(content);
    });
  }

  it("shows the LLM byte-for-byte the schema it saw before reveal props existed", () => {
    // Spec, "The LLM does not set": the prop-writing prompt is untouched.
    // Every component an LLM can be shown — the planner ids, not the whole
    // registry: ClipScene's props come from the clip import and no prompt
    // ever carries its schema (explainer G6).
    expect(Object.keys(PRE_REVEAL_LLM_SCHEMAS).sort()).toEqual([...plannerComponentIds()].sort());
    for (const id of plannerComponentIds()) {
      expect(JSON.stringify(z.toJSONSchema(llmPropsSchema(id))), id).toBe(
        PRE_REVEAL_LLM_SCHEMAS[id],
      );
    }
  });

  it("is the registry schema verbatim for components without reveal props", () => {
    expect(llmPropsSchema("StatCard")).toBe(SCENE_REGISTRY.StatCard.propsSchema);
  });

  // Plan Task 8 (§161): a script-only prop of a frozen component is offered
  // to a script run's props call and to nothing else (G6).
  it("shows TerminalMock's badge only in script mode", () => {
    expect(JSON.stringify(z.toJSONSchema(llmPropsSchema("TerminalMock")))).not.toContain("badge");
    expect(JSON.stringify(z.toJSONSchema(llmPropsSchema("TerminalMock", "auto")))).not.toContain(
      "badge",
    );
    const script = JSON.stringify(z.toJSONSchema(llmPropsSchema("TerminalMock", "script")));
    expect(script).toContain("badge");
    // Script mode still hides the reveal props — they are never the model's.
    for (const k of REVEAL_PROP_KEYS) expect(script).not.toContain(`"${k}"`);
  });

  it("is still the registry schema itself in script mode when nothing is hidden", () => {
    expect(llmPropsSchema("StatCard", "script")).toBe(SCENE_REGISTRY.StatCard.propsSchema);
  });

  it("names only real keys of real object schemas as script-only", () => {
    for (const [id, keys] of Object.entries(SCRIPT_ONLY_PROP_KEYS)) {
      const schema = SCENE_REGISTRY[id as SceneComponentId].propsSchema;
      expect(schema, id).toBeInstanceOf(z.ZodObject);
      for (const k of keys!) expect(k in (schema as z.ZodObject).shape, `${id}.${k}`).toBe(true);
    }
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
        step: 0.01,
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

describe("generateScenes never lets the LLM set a reveal prop", () => {
  const transcript: Transcript = {
    language: "en",
    words: Array.from({ length: 8 }, (_, i) => ({ text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 })),
  };
  const moment = (sceneKind: Moment["sceneKind"]): Moment => ({
    startWord: 0,
    endWord: 3,
    purpose: "p",
    onScreenCopy: "COPY",
    sceneKind,
  });
  /** Answers every call with `reply`, parsed by the schema it was handed — as real providers do. */
  const replying = (reply: (schemaName: string) => unknown): LlmProvider => ({
    name: "fake",
    usage: [],
    async complete<T>(req: { schema: z.ZodType<T>; schemaName: string }): Promise<T> {
      return req.schema.parse(reply(req.schemaName));
    },
  });
  const invented = { pacing: "accelerate", revealSpeed: 0.3, entrance: "bounce", reveal: "paced" };

  it("strips reveal keys an LLM invents in a BATCH reply", async () => {
    const provider = replying(() => ({
      scenes: [
        { index: 0, props: { nodes: ["A", "B"], ...invented } },
        { index: 1, props: { messages: [{ from: "user", text: "hi" }], ...invented } },
      ],
    }));
    const { scenes, failures } = await generateScenes(
      provider,
      [moment("FlowDiagram"), moment("ChatMock")],
      transcript,
    );
    expect(failures).toHaveLength(0);
    expect(scenes).toHaveLength(2);
    for (const scene of scenes) {
      for (const k of REVEAL_PROP_KEYS) expect(k in scene.props).toBe(false);
    }
    expect(scenes[0]!.props).toMatchObject({ nodes: ["A", "B"] });
  });

  it("strips them from a PER-MOMENT reply too", async () => {
    const provider = replying(() => ({ nodes: ["A", "B"], ...invented }));
    const { scenes } = await generateScenes(provider, [moment("FlowDiagram")], transcript);
    expect(scenes[0]!.component).toBe("FlowDiagram");
    for (const k of REVEAL_PROP_KEYS) expect(k in scenes[0]!.props).toBe(false);
  });

  // Plan Task 8: the run's mode decides whether a script-only prop survives.
  const terminal = { windows: [{ title: "t", lines: ["$ run"] }], badge: "+12 lines" };

  it("drops a TerminalMock badge outside script mode, batch and per-moment", async () => {
    const batch = replying(() => ({
      scenes: [0, 1].map((index) => ({ index, props: terminal })),
    }));
    const two = await generateScenes(batch, [moment("TerminalMock"), moment("TerminalMock")], transcript);
    expect(two.scenes.map((s) => "badge" in s.props)).toEqual([false, false]);
    const one = await generateScenes(replying(() => terminal), [moment("TerminalMock")], transcript);
    expect("badge" in one.scenes[0]!.props).toBe(false);
  });

  it("keeps it in script mode, batch and per-moment, and still strips reveal keys", async () => {
    const batch = replying(() => ({
      scenes: [0, 1].map((index) => ({ index, props: { ...terminal, ...invented } })),
    }));
    const two = await generateScenes(batch, [moment("TerminalMock"), moment("TerminalMock")], transcript, {
      mode: "script",
    });
    for (const scene of two.scenes) {
      expect(scene.props.badge).toBe("+12 lines");
      for (const k of REVEAL_PROP_KEYS) expect(k in scene.props).toBe(false);
    }
    const one = await generateScenes(replying(() => terminal), [moment("TerminalMock")], transcript, {
      mode: "script",
    });
    expect(one.scenes[0]!.props.badge).toBe("+12 lines");
  });
});
