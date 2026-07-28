import { describe, expect, it } from "vitest";
import { SCENE_REGISTRY, resolveSceneProps } from "../src/scene-registry";
import { SceneComponentIdSchema } from "../src/scene-schema";

describe("scene registry", () => {
  it("covers every component id, with defaults that self-validate", () => {
    for (const id of SceneComponentIdSchema.options) {
      const meta = SCENE_REGISTRY[id];
      expect(meta, id).toBeDefined();
      const parsed = meta.propsSchema.safeParse(meta.defaultProps);
      expect(parsed.success, `${id} defaultProps must validate`).toBe(true);
    }
  });

  it("fills omitted fields from defaults (partial LLM output still renders)", () => {
    const props = resolveSceneProps("StatCard", { label: "SPEED", value: "2x" });
    expect(props).toMatchObject({ label: "SPEED", value: "2x", inverted: false });
  });

  it("strikethrough lines take a verdict mark, defaulting to none (R16 §66)", () => {
    // Pre-§66 props (no mark key) resolve unchanged — every existing
    // production renders byte-identically.
    const legacy = resolveSceneProps("StrikethroughReveal", {
      lines: [{ text: "PROMPT", struck: true }],
    }) as { lines: Array<{ mark: string }> };
    expect(legacy.lines[0]!.mark).toBe("none");
    const marked = resolveSceneProps("StrikethroughReveal", {
      lines: [
        { text: "GUESSING", mark: "cross" },
        { text: "MEASURING", mark: "check" },
      ],
    }) as { lines: Array<{ mark: string; struck: boolean }> };
    expect(marked.lines.map((l) => l.mark)).toEqual(["cross", "check"]);
    expect(
      resolveSceneProps("StrikethroughReveal", { lines: [{ text: "X", mark: "tick" }] }),
    ).toBeNull();
  });

  it("rejects invalid props", () => {
    expect(resolveSceneProps("TitleCard", { title: "" })).toBeNull();
    expect(resolveSceneProps("FlowDiagram", { nodes: ["only-one"] })).toBeNull();
    expect(
      resolveSceneProps("StatCard", { label: "X", value: "a-value-way-too-long" }),
    ).toBeNull();
  });

  it("applies overrides over LLM props (user edits win)", () => {
    const props = resolveSceneProps(
      "TitleCard",
      { title: "LLM TITLE", emphasis: "42%" },
      { title: "USER TITLE" },
    );
    expect(props).toMatchObject({ title: "USER TITLE", emphasis: "42%" });
  });
});
