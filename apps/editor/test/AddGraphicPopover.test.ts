// @vitest-environment jsdom
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { PlayerRef } from "@remotion/player";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADDED_OFFERED,
  SCENE_REGISTRY,
  mapFromKeptSpans,
  resolveSceneProps,
  type CaptionLine,
  type OverrideDoc,
  type SceneCue,
} from "@ossclip/core/browser";
import {
  ADD_TYPE_COPY,
  addFormFieldsFor,
  addFormIssue,
  initialAddValues,
} from "../src/AddGraphicPopover";
import { addGraphicCheck, type AddGraphicRequest, type AddGraphicWord } from "../src/addedGraphics";
import { TranscriptPanel } from "../src/TranscriptPanel";
import { useEdits } from "../src/useEdits";

// Same one-time act() opt-in as TranscriptPanel.test.ts.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ADD_TYPE_COPY (editor-added-graphics §5, step 1)", () => {
  it("names every offered type with one plain line under 60 characters", () => {
    expect(Object.keys(ADD_TYPE_COPY).sort()).toEqual([...ADDED_OFFERED].sort());
    for (const c of ADDED_OFFERED) {
      const { name, line } = ADD_TYPE_COPY[c];
      expect(line.length, c).toBeLessThan(60);
      // Plain names: no shouted labels, no arrows tacked on.
      for (const text of [name, line]) {
        expect(text, c).not.toMatch(/\b[A-Z]{3,}\b/);
        expect(text, c).not.toMatch(/[→›»>]/);
      }
    }
  });
});

describe("addFormFieldsFor", () => {
  it("builds each type's fields once — the JSON-schema walk is not per render", () => {
    expect(addFormFieldsFor("StatCard")).toBe(addFormFieldsFor("StatCard"));
    expect(addFormFieldsFor("StatCard").map((f) => f.key)).toEqual(["value", "label"]);
  });
});

describe("initialAddValues (§5 prefill)", () => {
  it("prefills the FIRST text field with the selected words when they fit", () => {
    expect(initialAddValues("StatCard", "two words")).toEqual({ value: "two words", label: "" });
  });

  it("leaves it empty when the words exceed that field's max", () => {
    // StatCard.value is capped at 12.
    expect(initialAddValues("StatCard", "thirteen char")).toEqual({ value: "", label: "" });
  });

  it("skips a leading choice and number for the first TEXT field, and starts lists empty", () => {
    expect(initialAddValues("CtaCard", "follow me")).toEqual({ action: undefined, text: "follow me" });
    expect(initialAddValues("BugCard", "it breaks")).toEqual({ number: undefined, headline: "it breaks" });
    expect(initialAddValues("BulletList", "a b")).toEqual({ items: [] });
    expect(initialAddValues("ChatMock", "hi")).toEqual({ messages: [] });
  });
});

describe("addFormIssue — the Add gate", () => {
  it("is null for a form that parses RAW", () => {
    expect(addFormIssue("TitleCard", { title: "Hello" })).toBeNull();
  });

  it("gates on the RAW schema, not resolveSceneProps — registry defaults would mask an empty title", () => {
    // resolveSceneProps fills TitleCard's default "TITLE" and passes; the
    // conversion parses raw and would skip the entry (editor-added-graphics §2).
    expect(resolveSceneProps("TitleCard", {})).not.toBeNull();
    expect(SCENE_REGISTRY.TitleCard.propsSchema.safeParse({}).success).toBe(false);
    expect(addFormIssue("TitleCard", { title: "" })).not.toBeNull();
    expect(addFormIssue("TitleCard", {})).not.toBeNull();
  });

  it("holds a list below its minimum, and opens at it", () => {
    expect(addFormIssue("BulletList", { items: ["one"] })).not.toBeNull();
    expect(addFormIssue("BulletList", { items: ["one", "two"] })).toBeNull();
  });
});

/**
 * The gesture through the real panel: the bar's Graphic… button, the overlap
 * refusal, the type list, the form and Add. The request is built with App's
 * own pure check (`addGraphicCheck`) so the refusal is the real one; `add`
 * goes through the real reducer, as App's does.
 */
describe("TranscriptPanel — add a graphic from the selection", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const origGetContext = HTMLCanvasElement.prototype.getContext;

  /** Words at 6 s and on, 0.4 s each, srcStart == start (identity clock). */
  const line = (texts: string[], at = 6): CaptionLine => ({
    words: texts.map((text, i) => ({ text, start: at + i * 0.5, end: at + i * 0.5 + 0.4, srcStart: at + i * 0.5 })),
    start: at,
    end: at + texts.length * 0.5,
  });
  const clock = mapFromKeptSpans([{ srcIn: 0, srcOut: 30, outIn: 0, outOut: 30 }]);

  let doc: OverrideDoc | null = null;
  let asked: AddGraphicWord[] | null = null;

  function Harness({
    lines,
    cues = [],
    withGraphic = true,
  }: {
    lines: CaptionLine[];
    cues?: SceneCue[];
    withGraphic?: boolean;
  }) {
    const edits = useEdits();
    doc = edits.doc;
    const playerRef = useRef({
      seekTo: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as PlayerRef);
    const onAddGraphic = (words: AddGraphicWord[]): AddGraphicRequest => {
      asked = words;
      const check = addGraphicCheck({ words, cues, clock, toPlayerSec: (s) => s, deferred: false });
      return {
        ...check,
        add: (component, props) => {
          edits.addScene({ component, props, ...check.span, baseIds: [] });
        },
      };
    };
    return React.createElement(TranscriptPanel, {
      baseLines: lines,
      liveLines: lines,
      timingLines: lines,
      workdir: null,
      fps: 30,
      playerRef,
      edits,
      onDeleteWords: () => {},
      width: 300,
      ...(withGraphic ? { onAddGraphic } : {}),
    });
  }

  const q = (testid: string) => container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  const word = (i: number) => q(`transcript-word-${i}`)!;
  const click = async (el: HTMLElement, shiftKey = false) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey }));
    });
  };
  const key = async (el: HTMLElement, k: string) => {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      // React dedupes on the node's own value; set it through the prototype.
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const render = async (props: Parameters<typeof Harness>[0]) => {
    await act(async () => {
      root.render(React.createElement(Harness, props));
    });
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
    doc = null;
    asked = null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    HTMLCanvasElement.prototype.getContext = origGetContext;
  });

  it("puts Graphic… between Timing and Delete ▾, with ✕ still last", async () => {
    await render({ lines: [line(["a", "b"])] });
    await click(word(0));
    const bar = q("transcript-selection-menu")!;
    expect(Array.from(bar.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent)).toEqual([
      "Edit",
      "Timing",
      "Graphic…",
      "Delete ▾",
      "✕",
    ]);
    expect(q("transcript-add-graphic")!.textContent).toBe("Graphic…");
  });

  it("offers no Graphic… when App passes no callback (every harness predating it)", async () => {
    await render({ lines: [line(["a", "b"])], withGraphic: false });
    await click(word(0));
    expect(q("transcript-add-graphic")).toBeNull();
  });

  it("refuses an overlapping selection in the popover, before any type list", async () => {
    await render({ lines: [line(["a", "b"])], cues: [{ id: "scene-1", layout: "video-top", component: "StatCard", props: {}, startSec: 6.2, endSec: 9 }] });
    await click(word(0));
    await click(q("transcript-add-graphic")!);
    expect(q("add-graphic-refusal")!.textContent).toBe(
      "These words overlap the graphic ‘StatCard’ at 0:06. Trim that block or pick other words.",
    );
    expect(container.querySelector('[data-testid^="add-graphic-type-"]')).toBeNull();
  });

  it("TitleCard: the title is prefilled with the selected words, and Add stores it", async () => {
    await render({ lines: [line(["Agents", "in", "loops"])] });
    await click(word(0));
    await click(word(2), true);
    await click(q("transcript-add-graphic")!);
    // The panel hands App the selected words as it holds them.
    expect(asked).toEqual([
      { srcStart: 6, start: 6, end: 6.4, text: "Agents" },
      { srcStart: 6.5, start: 6.5, end: 6.9, text: "in" },
      { srcStart: 7, start: 7, end: 7.4, text: "loops" },
    ]);
    expect(q("add-graphic-words")!.textContent).toContain("Agents in loops");
    // One row per offered type, in menu order.
    const rows = Array.from(container.querySelectorAll('[data-testid^="add-graphic-type-"]'));
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(ADDED_OFFERED.map((c) => `add-graphic-type-${c}`));
    await click(q("add-graphic-type-TitleCard")!);
    const title = q("add-graphic-field-title") as HTMLInputElement;
    expect(title.value).toBe("Agents in loops");
    await click(q("add-graphic-add")!);
    expect(doc!.addedScenes).toEqual([
      { id: "added-1", component: "TitleCard", props: { title: "Agents in loops" }, srcStart: 6, srcEnd: 7.4 },
    ]);
    // The popover closes and the gesture consumed the selection.
    expect(q("transcript-add-graphic-popover")).toBeNull();
    expect(q("transcript-selection-menu")).toBeNull();
  });

  it("keeps Add disabled while a required field is empty", async () => {
    await render({ lines: [line(["a"])] });
    await click(word(0));
    await click(q("transcript-add-graphic")!);
    await click(q("add-graphic-type-TitleCard")!);
    const add = q("add-graphic-add") as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    await type(q("add-graphic-field-title") as HTMLInputElement, "");
    expect(add.disabled).toBe(true);
    await click(add);
    expect(doc!.addedScenes).toBeUndefined();
    await type(q("add-graphic-field-title") as HTMLInputElement, "Back");
    expect(add.disabled).toBe(false);
  });

  it("Escape closes the popover and keeps the selection", async () => {
    await render({ lines: [line(["a", "b"])] });
    await click(word(0));
    await click(q("transcript-add-graphic")!);
    await click(q("add-graphic-type-TitleCard")!);
    // From inside the form's own field — the keys bubble to the panel.
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    await key(q("add-graphic-field-title")!, "Escape");
    window.removeEventListener("keydown", onWindowKey);
    expect(q("transcript-add-graphic-popover")).toBeNull();
    // The bar is back over the same words, and Overlay's window Escape
    // (deselect the block) never saw the key.
    expect(q("transcript-selection-menu")).not.toBeNull();
    expect(q("transcript-selection-menu")!.textContent).toContain("1 word");
    expect(onWindowKey).not.toHaveBeenCalled();
    expect(doc!.addedScenes).toBeUndefined();
  });

  it("a word with no source anchor disables Graphic…, with the panel's reason", async () => {
    const legacy: CaptionLine = {
      words: [{ text: "old", start: 6, end: 6.4 } as CaptionLine["words"][number]],
      start: 6,
      end: 6.4,
    };
    await render({ lines: [legacy] });
    await click(word(0));
    const btn = q("transcript-add-graphic") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("A selected word has no source anchor (this project predates them) — re-run produce first");
  });
});
