import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  BugCardProps,
  CardRowProps,
  CtaCardProps,
  PhoneDemoProps,
  SCENE_REGISTRY,
  plannerComponentIds,
  llmPropsSchema,
  resolveSceneProps,
  scriptComponentIds,
} from "../src/scene-registry";
import {
  PlannerComponentIdSchema,
  SceneComponentIdSchema,
  ScriptComponentIdSchema,
  ScriptOnlyComponentIdSchema,
} from "../src/scene-schema";
import { BeatSheetSchema, type ScriptMoment } from "../src/producer/beats";
import type { LlmProvider } from "../src/producer/provider";
import { generateScenes } from "../src/producer/scene-props";
import type { Transcript } from "../src/schema";
import { ScriptPlanSchema } from "../src/producer/script-plan";
import { scalarPropControls } from "../src/scene-props-controls";

describe("scene registry", () => {
  it("covers every component id", () => {
    for (const id of SceneComponentIdSchema.options) {
      expect(SCENE_REGISTRY[id], id).toBeDefined();
    }
  });

  it("every LLM-fillable component's defaults self-validate", () => {
    // The defaults exist so partial LLM output still renders, and the
    // editor's swap falls back to them (`resolveSwappedProps`) — which offers
    // the script-only cards too (plan decision 5). ClipScene is never
    // LLM-filled and has no honest default source, so it is not held to this
    // (its props come from the clip import, or the scene is dropped).
    for (const id of scriptComponentIds()) {
      const meta = SCENE_REGISTRY[id];
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

  describe("ClipScene (explainer phase 1, spec 1.4)", () => {
    it("is registered but never selectable by a planner, full frame with no scrim", () => {
      const meta = SCENE_REGISTRY.ClipScene;
      expect(meta.plannerSelectable).toBe(false);
      expect(meta.scrim).toBe(false);
      expect(meta.defaultLayout).toBe("full-bleed");
      expect(meta.altLayouts).toEqual([]);
    });

    it("plannerComponentIds is today's nine, in registry order (G6)", () => {
      expect(plannerComponentIds()).toEqual([
        "TitleCard",
        "StatCard",
        "RuleCard",
        "StrikethroughReveal",
        "FlowDiagram",
        "TerminalMock",
        "ChatMock",
        "ScreenshotFrame",
        "BulletList",
      ]);
      // The menu and the schema enum are two lists of one thing; they agree.
      expect(plannerComponentIds()).toEqual(PlannerComponentIdSchema.options);
    });

    it("resolves gain and mute defaults", () => {
      expect(resolveSceneProps("ClipScene", { src: "clips/a.webm", durationSec: 4.6 })).toEqual({
        src: "clips/a.webm",
        durationSec: 4.6,
        gainDb: -13,
        muted: false,
      });
    });

    it("rejects a clip with no source or no length", () => {
      expect(resolveSceneProps("ClipScene", { durationSec: 4.6 })).toBeNull();
      expect(resolveSceneProps("ClipScene", { src: "", durationSec: 4.6 })).toBeNull();
      expect(resolveSceneProps("ClipScene", { src: "clips/a.webm", durationSec: 0 })).toBeNull();
    });

    it("bounds gain to -40..0 dB: a media volume above 1 throws in the browser", () => {
      const base = { src: "clips/a.webm", durationSec: 4.6 };
      expect(resolveSceneProps("ClipScene", { ...base, gainDb: 0 })).toMatchObject({ gainDb: 0 });
      expect(resolveSceneProps("ClipScene", { ...base, gainDb: -40 })).toMatchObject({ gainDb: -40 });
      expect(resolveSceneProps("ClipScene", { ...base, gainDb: 6 })).toBeNull();
      expect(resolveSceneProps("ClipScene", { ...base, gainDb: -41 })).toBeNull();
    });

    it("the bounded gain gets an Inspector slider (§153)", () => {
      expect(scalarPropControls("ClipScene")).toContainEqual({
        key: "gainDb",
        kind: "number",
        min: -40,
        max: 0,
        step: 0.01,
        fallback: -13,
      });
    });

    it("is the one full-frame component", () => {
      expect(SCENE_REGISTRY.ClipScene.fullFrame).toBe(true);
      for (const id of plannerComponentIds()) {
        expect(SCENE_REGISTRY[id].fullFrame, id).toBeUndefined();
      }
    });

    it("lasts the clip's length; other components follow their words", () => {
      const props = resolveSceneProps("ClipScene", { src: "clips/a.webm", durationSec: 4.6 })!;
      expect(SCENE_REGISTRY.ClipScene.fixedDurationSec!(props)).toBe(4.6);
      for (const id of plannerComponentIds()) {
        expect(SCENE_REGISTRY[id].fixedDurationSec, id).toBeUndefined();
      }
    });
  });
  describe("script-only components (§161, plan Task 4)", () => {
    it("the planner list is still the nine; the script list appends the cards", () => {
      expect(plannerComponentIds()).toEqual(PlannerComponentIdSchema.options);
      expect(scriptComponentIds()).toEqual([
        ...PlannerComponentIdSchema.options,
        "CardRow",
        "CtaCard",
        "BugCard",
        "PhoneDemo",
      ]);
      // The id lists and the registry agree, as the planner pair does.
      expect(scriptComponentIds()).toEqual(ScriptComponentIdSchema.options);
      expect(SceneComponentIdSchema.options).toEqual([...ScriptComponentIdSchema.options, "ClipScene"]);
    });

    it("every script-only id is flagged scriptOnly, and nothing else is", () => {
      const flagged = SceneComponentIdSchema.options.filter((id) => SCENE_REGISTRY[id].scriptOnly);
      expect(flagged).toEqual(ScriptOnlyComponentIdSchema.options);
    });

    it("a run without --script cannot name a CardRow (G6)", () => {
      // The beat sheet's enum, the --force-component parse, and the schema
      // text every beat_sheet call sends.
      expect(PlannerComponentIdSchema.safeParse("CardRow").success).toBe(false);
      expect(JSON.stringify(z.toJSONSchema(BeatSheetSchema))).not.toContain("CardRow");
      // The script plan's own schema is where it lives.
      expect(JSON.stringify(z.toJSONSchema(ScriptPlanSchema))).toContain("CardRow");
    });

    it("CardRow is a full-frame card with no scrim, fillable and swappable", () => {
      const meta = SCENE_REGISTRY.CardRow;
      expect(meta.scriptOnly).toBe(true);
      expect(meta.scrim).toBe(false);
      expect(meta.fullFrame).toBe(true);
      expect(meta.plannerSelectable).toBeUndefined();
      expect(meta.defaultLayout).toBe("full-bleed");
      expect(meta.altLayouts).toEqual([]);
      expect(meta.fixedDurationSec).toBeUndefined();
    });

    it("CardRowProps: two to four cards, icon defaults to none, caps at 18 / 24", () => {
      expect(CardRowProps.safeParse({ cards: [{ text: "A" }] }).success).toBe(false);
      expect(CardRowProps.parse({ cards: [{ text: "A" }, { text: "B" }] }).cards[0]!.icon).toBe("none");
      const five = Array.from({ length: 5 }, () => ({ text: "X" }));
      expect(CardRowProps.safeParse({ cards: five }).success).toBe(false);
      expect(CardRowProps.safeParse({ cards: [{ text: "x".repeat(19) }, { text: "B" }] }).success).toBe(false);
      expect(
        CardRowProps.safeParse({ cards: [{ text: "A", sub: "y".repeat(25) }, { text: "B" }] }).success,
      ).toBe(false);
      expect(CardRowProps.safeParse({ cards: [{ text: "A", icon: "rocket" }, { text: "B" }] }).success).toBe(
        false,
      );
      expect(CardRowProps.safeParse({ cards: [{ text: "A" }, { text: "B" }], highlight: 4 }).success).toBe(false);
    });

    it("CtaCard is a full-frame card with no scrim, fillable and swappable (plan Task 5)", () => {
      const meta = SCENE_REGISTRY.CtaCard;
      expect(meta.scriptOnly).toBe(true);
      expect(meta.scrim).toBe(false);
      expect(meta.fullFrame).toBe(true);
      expect(meta.plannerSelectable).toBeUndefined();
      expect(meta.defaultLayout).toBe("full-bleed");
      expect(meta.altLayouts).toEqual([]);
      expect(meta.defaultProps).toEqual({ action: "subscribe", text: "Subscribe for more" });
      expect(PlannerComponentIdSchema.safeParse("CtaCard").success).toBe(false);
      expect(JSON.stringify(z.toJSONSchema(BeatSheetSchema))).not.toContain("CtaCard");
    });

    it("CtaCardProps: three actions, text 1-40, keyword up to 16, channel up to 24", () => {
      expect(CtaCardProps.safeParse({ action: "share", text: "Share it" }).success).toBe(false);
      expect(CtaCardProps.safeParse({ action: "comment", text: "x".repeat(41) }).success).toBe(false);
      expect(CtaCardProps.safeParse({ action: "comment", text: "" }).success).toBe(false);
      expect(CtaCardProps.safeParse({ action: "comment", text: "A", keyword: "k".repeat(17) }).success).toBe(false);
      expect(CtaCardProps.safeParse({ action: "subscribe", text: "A", channel: "c".repeat(25) }).success).toBe(
        false,
      );
      expect(
        CtaCardProps.safeParse({ action: "link", text: "x".repeat(40), keyword: "k".repeat(16) }).success,
      ).toBe(true);
    });

    it("BugCard is a full-frame card with no scrim, fillable and swappable (plan Task 6)", () => {
      const meta = SCENE_REGISTRY.BugCard;
      expect(meta.scriptOnly).toBe(true);
      expect(meta.scrim).toBe(false);
      expect(meta.fullFrame).toBe(true);
      expect(meta.plannerSelectable).toBeUndefined();
      expect(meta.defaultLayout).toBe("full-bleed");
      expect(meta.altLayouts).toEqual([]);
      expect(meta.defaultProps).toEqual({ number: 1, headline: "The problem" });
      expect(BugCardProps.safeParse(meta.defaultProps).success).toBe(true);
      expect(PlannerComponentIdSchema.safeParse("BugCard").success).toBe(false);
      expect(JSON.stringify(z.toJSONSchema(BeatSheetSchema))).not.toContain("BugCard");
    });

    it("BugCardProps: number 1-9, headline 1-40, sub 40, up to four 32-char mock entries, sticker 14", () => {
      expect(BugCardProps.safeParse({ number: 0, headline: "A" }).success).toBe(false);
      expect(BugCardProps.safeParse({ number: 1.5, headline: "A" }).success).toBe(false);
      expect(BugCardProps.safeParse({ number: 1, headline: "" }).success).toBe(false);
      expect(BugCardProps.safeParse({ number: 1, headline: "x".repeat(41) }).success).toBe(false);
      expect(BugCardProps.safeParse({ number: 1, headline: "A", sub: "s".repeat(41) }).success).toBe(false);
      expect(BugCardProps.safeParse({ number: 1, headline: "A", mockLines: ["a", "b", "c", "d", "e"] }).success).toBe(
        false,
      );
      expect(BugCardProps.safeParse({ number: 1, headline: "A", mockFault: "hidden" }).success).toBe(false);
      expect(BugCardProps.safeParse({ number: 1, headline: "A", sticker: "k".repeat(15) }).success).toBe(false);
      expect(BugCardProps.parse({ number: 3, headline: "A" })).toMatchObject({
        mock: "none",
        mockLines: [],
        mockFault: "struck",
      });
      expect(
        BugCardProps.safeParse({
          number: 9,
          headline: "x".repeat(40),
          sub: "s".repeat(40),
          mock: "lines",
          mockLines: Array.from({ length: 4 }, () => "l".repeat(32)),
          mockWrong: 3,
          mockFault: "clipped",
          sticker: "k".repeat(14),
        }).success,
      ).toBe(true);
    });

    it("PhoneDemo is a full-frame card with no scrim, fillable and swappable (plan Task 7)", () => {
      const meta = SCENE_REGISTRY.PhoneDemo;
      expect(meta.scriptOnly).toBe(true);
      expect(meta.scrim).toBe(false);
      expect(meta.fullFrame).toBe(true);
      expect(meta.plannerSelectable).toBeUndefined();
      expect(meta.defaultLayout).toBe("full-bleed");
      expect(meta.altLayouts).toEqual([]);
      expect(meta.defaultProps).toEqual({ caption: [{ text: "YOUR" }, { text: "CAPTIONS", emphasis: "yellow" }] });
      expect(PhoneDemoProps.safeParse(meta.defaultProps).success).toBe(true);
      expect(PlannerComponentIdSchema.safeParse("PhoneDemo").success).toBe(false);
      expect(JSON.stringify(z.toJSONSchema(BeatSheetSchema))).not.toContain("PhoneDemo");
    });

    it("PhoneDemoProps: one to six caption words of 12, up to four pills of 22, enums defaulted", () => {
      expect(PhoneDemoProps.safeParse({ caption: [] }).success).toBe(false);
      expect(PhoneDemoProps.safeParse({ caption: Array.from({ length: 7 }, () => ({ text: "w" })) }).success).toBe(
        false,
      );
      expect(PhoneDemoProps.safeParse({ caption: [{ text: "x".repeat(13) }] }).success).toBe(false);
      expect(PhoneDemoProps.safeParse({ caption: [{ text: "" }] }).success).toBe(false);
      expect(PhoneDemoProps.safeParse({ caption: [{ text: "A", emphasis: "pink" }] }).success).toBe(false);
      const five = Array.from({ length: 5 }, () => ({ text: "p" }));
      expect(PhoneDemoProps.safeParse({ caption: [{ text: "A" }], pills: five }).success).toBe(false);
      expect(PhoneDemoProps.safeParse({ caption: [{ text: "A" }], pills: [{ text: "p".repeat(23) }] }).success).toBe(
        false,
      );
      expect(PhoneDemoProps.safeParse({ caption: [{ text: "A" }], pills: [{ text: "p", state: "maybe" }] }).success).toBe(
        false,
      );
      expect(PhoneDemoProps.parse({ caption: [{ text: "A" }], pills: [{ text: "p" }] })).toMatchObject({
        caption: [{ text: "A", emphasis: "none" }],
        pills: [{ text: "p", state: "ok" }],
      });
      expect(PhoneDemoProps.parse({ caption: [{ text: "A" }] }).pills).toEqual([]);
      expect(
        PhoneDemoProps.safeParse({
          caption: Array.from({ length: 6 }, () => ({ text: "x".repeat(12), emphasis: "orange" })),
          pills: Array.from({ length: 4 }, () => ({ text: "p".repeat(22), state: "plain" })),
        }).success,
      ).toBe(true);
    });

    it("the reveal props stay out of what the LLM is shown", () => {
      const text = JSON.stringify(z.toJSONSchema(llmPropsSchema("CardRow")));
      for (const k of ["reveal", "pacing", "revealSpeed", "entrance"]) expect(text).not.toContain(`"${k}"`);
      expect(text).toContain("cards");
    });

    // The acceptance run (§161): the planner picked the right card every time
    // and wrote weak props — no `mockWrong`, a "channel" placeholder. The
    // field notes are `.describe()`s, which reach the model only because the
    // props prompt embeds `z.toJSONSchema` of the LLM-facing copy.
    const MOCK_WRONG_NOTE =
      "Index of the entry in mockLines that shows the fault. Always set it when mock is not 'none'.";

    it("the script-mode BugCard schema the LLM is shown carries the mockWrong note", () => {
      const json = z.toJSONSchema(llmPropsSchema("BugCard", "script")) as {
        properties: Record<string, { description?: string }>;
      };
      expect(json.properties.mockWrong!.description).toBe(MOCK_WRONG_NOTE);
      expect(JSON.stringify(json)).toContain(MOCK_WRONG_NOTE);
    });

    it("the note reaches the props prompt itself (batch path)", async () => {
      const transcript: Transcript = {
        language: "en",
        words: Array.from({ length: 8 }, (_, i) => ({ text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 })),
      };
      const moment = (startWord: number): ScriptMoment => ({
        startWord,
        endWord: startWord + 2,
        purpose: "p",
        onScreenCopy: "COPY",
        sceneKind: "BugCard",
      });
      const prompts: string[] = [];
      const provider: LlmProvider = {
        name: "fake",
        usage: [],
        async complete<T>(req: { user: string; schema: z.ZodType<T> }): Promise<T> {
          prompts.push(req.user);
          return req.schema.parse({
            scenes: [0, 1].map((index) => ({ index, props: { number: 1, headline: "X" } })),
          });
        },
      };
      await generateScenes(provider, [moment(0), moment(4)], transcript, { mode: "script" });
      expect(prompts[0]).toContain(JSON.stringify(MOCK_WRONG_NOTE));
    });

    it("the field notes leave the Inspector's derived controls as they were", () => {
      expect(scalarPropControls("BugCard")).toEqual([
        { key: "number", kind: "number", min: 1, max: 9, step: 1, fallback: 1 },
        { key: "mock", kind: "enum", options: ["none", "caption", "lines"] },
        { key: "mockWrong", kind: "number", min: 0, max: 3, step: 1, fallback: 0, optional: true, unsetIsNone: true },
        { key: "mockFault", kind: "enum", options: ["struck", "clipped"] },
      ]);
      expect(scalarPropControls("CardRow").map((c) => c.key)).toEqual([
        "highlight",
        "reveal",
        "pacing",
        "revealSpeed",
        "entrance",
      ]);
      expect(scalarPropControls("CtaCard")).toEqual([
        { key: "action", kind: "enum", options: ["comment", "subscribe", "link"] },
      ]);
    });
  });
});
