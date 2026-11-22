// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PlayerRef } from "@remotion/player";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADDED_OFFERED,
  OverrideDocSchema,
  SCENE_REGISTRY,
  applyOverrides,
  mapFromKeptSpans,
  resolveSrcTimingPins,
  type CaptionLine,
  type OverrideDoc,
  type SceneCue,
  type TimeMap,
  type Word,
} from "@ossclip/core/browser";
import {
  addGraphicCheck,
  addPreviewCue,
  previewBaseCues,
  type AddGraphicCheck,
  type AddGraphicWord,
} from "../src/addedGraphics";
import { GraphicEditorModal, type GraphicEditorSave } from "../src/GraphicEditorModal";
import { TranscriptPanel } from "../src/TranscriptPanel";
import { useEdits, type ItemPins } from "../src/useEdits";

// Same one-time act() opt-in as TranscriptPanel.test.ts.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The graphic editor (graphic-editor-modal §5, §6) through the real panel
 * and the real reducer: the bar's Graphic…, App's check (`addGraphicCheck`,
 * the real one), the modal and its one commit. The host below is App's
 * wiring in miniature — the modal, its add check and its `addScene` — with
 * an identity clock unless a case cuts, and no Player (the preview's
 * `renderPreview` is App's; the rules it would show are the model's).
 */

/** Source-timed words, 0.5 s apart from 6 s (identity clock: output ==
 * source), as both the transcript list and the panel's caption line. */
const TEXTS = [
  "so", //            0
  "they", //          1
  "hallucinate", //   2
  "and", //           3
  "they", //          4
  "forget", //        5
  "the", //           6
  "context", //       7
  "and", //           8
  "we", //            9
  "review", //        10
  "the", //           11
  "code", //          12
];
const AT = 6;
const WORDS: Word[] = TEXTS.map((text, i) => ({ text, start: AT + i * 0.5, end: AT + i * 0.5 + 0.4 }));
const LINE: CaptionLine = {
  words: WORDS.map((w) => ({ text: w.text, start: w.start, end: w.end, srcStart: w.start })),
  start: AT,
  end: AT + TEXTS.length * 0.5,
};
const identity = mapFromKeptSpans([{ srcIn: 0, srcOut: 40, outIn: 0, outOut: 40 }]);

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const origGetContext = HTMLCanvasElement.prototype.getContext;
let doc: OverrideDoc | null = null;
let edits: ReturnType<typeof useEdits> | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  doc = null;
  edits = null;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  HTMLCanvasElement.prototype.getContext = origGetContext;
});

const q = (testid: string) => container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
const qa = (prefix: string) => Array.from(container.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`));
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
const mount = async (el: React.ReactElement) => {
  await act(async () => {
    root.render(el);
  });
};
/** A word in the modal's strip, by transcript index. */
const stripWord = (i: number) => q(`graphic-editor-word-${i}`)!;

/** App's add wiring in miniature: the panel, the check at the press, the
 * modal over it, and `addScene` with the Save's `scenes` patch. */
function AddHost({
  lines = [LINE],
  cues = [],
  clock = identity,
  words = WORDS,
  withGraphic = true,
  onAdded,
  onPreview,
}: {
  lines?: CaptionLine[];
  cues?: SceneCue[];
  clock?: TimeMap;
  words?: Word[] | null;
  withGraphic?: boolean;
  onAdded?: (save: GraphicEditorSave) => void;
  /** Each cue the preview is asked to play, as App's Player would get it. */
  onPreview?: (cue: SceneCue) => void;
}) {
  const e = useEdits();
  edits = e;
  doc = e.doc;
  const playerRef = useRef({
    seekTo: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as PlayerRef);
  const [open, setOpen] = useState<{
    words: AddGraphicWord[];
    check: AddGraphicCheck;
    done: (added: boolean) => void;
  } | null>(null);
  const onAddGraphic = (picked: AddGraphicWord[], done: (added: boolean) => void): void => {
    const check = addGraphicCheck({ words: picked, cues, clock, toPlayerSec: (s) => s, deferred: false });
    setOpen({ words: picked, check, done });
  };
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(TranscriptPanel, {
      baseLines: lines,
      liveLines: lines,
      timingLines: lines,
      workdir: null,
      fps: 30,
      playerRef,
      edits: e,
      onDeleteWords: () => {},
      width: 300,
      ...(withGraphic ? { onAddGraphic } : {}),
    }),
    open === null
      ? null
      : React.createElement(GraphicEditorModal, {
          mode: "add",
          words,
          liveMap: clock,
          window: open.check.span,
          fps: 30,
          prevGraphicEndSec: null,
          ...(onPreview
            ? {
                renderPreview: ({ cue }: { cue: SceneCue }) => {
                  onPreview(cue);
                  return null;
                },
              }
            : {}),
          selectionText: open.words.map((w) => w.text).join(" "),
          selectionWordCount: open.words.length,
          check: open.check,
          previewFor: (component, props) =>
            addPreviewCue({
              component,
              props,
              span: open.check.span,
              words,
              map: clock,
              landscape: false,
              scriptProject: false,
            }),
          onAdd: (component, save) => {
            onAdded?.(save);
            e.addScene({
              component,
              props: save.props,
              ...open.check.span,
              baseIds: [],
              scenePatch: {
                ...(save.itemPins !== undefined ? { itemPins: save.itemPins } : {}),
                ...(save.timing !== undefined ? { timing: save.timing } : {}),
              },
            });
            setOpen(null);
            open.done(true);
          },
          onClose: () => {
            setOpen(null);
            open.done(false);
          },
        }),
  );
}

/** Select words `from`..`to` in the panel and press Graphic…. */
const openOver = async (from: number, to: number) => {
  await click(q(`transcript-word-${from}`)!);
  if (to !== from) await click(q(`transcript-word-${to}`)!, true);
  await click(q("transcript-add-graphic")!);
};

/** Choose BulletList and type `items`, one row each. */
const bulletList = async (items: string[]) => {
  await click(q("graphic-editor-type-BulletList")!);
  for (const [k, text] of items.entries()) {
    await click(q("graphic-editor-add-item")!);
    await type(q(`graphic-editor-item-${k}`) as HTMLInputElement, text);
  }
};

describe("the bar's Graphic… (editor-added-graphics §5)", () => {
  it("sits between Timing and Delete ▾, with ✕ still last", async () => {
    await mount(React.createElement(AddHost));
    await click(q("transcript-word-0")!);
    const bar = q("transcript-selection-menu")!;
    expect(Array.from(bar.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent)).toEqual([
      "Edit",
      "Timing",
      "Graphic…",
      "Delete ▾",
      "✕",
    ]);
  });

  it("is not offered when App passes no callback (every harness predating it)", async () => {
    await mount(React.createElement(AddHost, { withGraphic: false }));
    await click(q("transcript-word-0")!);
    expect(q("transcript-add-graphic")).toBeNull();
  });

  it("is disabled, with the panel's reason, for a word with no source anchor", async () => {
    const legacy: CaptionLine = {
      words: [{ text: "old", start: 6, end: 6.4 } as CaptionLine["words"][number]],
      start: 6,
      end: 6.4,
    };
    await mount(React.createElement(AddHost, { lines: [legacy] }));
    await click(q("transcript-word-0")!);
    const btn = q("transcript-add-graphic") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("A selected word has no source anchor (this project predates them) — re-run produce first");
  });

  it("opens the modal over the selection: the panel hands App the words as it holds them", async () => {
    await mount(React.createElement(AddHost));
    await openOver(1, 3);
    expect(q("graphic-editor")).not.toBeNull();
    expect(q("graphic-editor")!.getAttribute("role")).toBe("dialog");
    // One row per offered type, in menu order, none chosen yet.
    expect(qa("graphic-editor-type-").map((r) => r.getAttribute("data-testid"))).toEqual(
      ADDED_OFFERED.map((c) => `graphic-editor-type-${c}`),
    );
    expect(qa("graphic-editor-type-").some((r) => r.getAttribute("aria-checked") === "true")).toBe(false);
    expect((q("graphic-editor-save") as HTMLButtonElement).disabled).toBe(true);
    // The strip shows the selected words, as the transcript list has them.
    expect(qa("graphic-editor-type-")).toHaveLength(ADDED_OFFERED.length);
    await click(q("graphic-editor-type-TitleCard")!);
    expect(qa("graphic-editor-word-").map((w) => w.getAttribute("data-testid"))).toEqual([
      "graphic-editor-word-1",
      "graphic-editor-word-2",
      "graphic-editor-word-3",
    ]);
  });
});

describe("refusals render in place of the form (§5)", () => {
  it("an overlap: the reason, no type list, no form, and Close", async () => {
    const cues: SceneCue[] = [
      { id: "scene-1", layout: "video-top", component: "StatCard", props: {}, startSec: 6.2, endSec: 9 },
    ];
    await mount(React.createElement(AddHost, { cues }));
    await openOver(0, 0);
    expect(q("graphic-editor-refusal")!.textContent).toBe(
      "These words overlap the graphic ‘StatCard’ at 0:06. Trim that block or pick other words.",
    );
    expect(qa("graphic-editor-type-")).toHaveLength(0);
    expect(q("graphic-editor-strip")).toBeNull();
    expect(q("graphic-editor-save")).toBeNull();
    expect(q("graphic-editor-cancel")!.textContent).toBe("Close");
  });

  it("every word cut: its own reason", async () => {
    // The kept span stops at 5 s, before every word.
    const cut = mapFromKeptSpans([{ srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 }]);
    await mount(React.createElement(AddHost, { clock: cut }));
    await openOver(0, 1);
    expect(q("graphic-editor-refusal")!.textContent).toBe(
      "These words are cut from the video. Pick words that are still in it.",
    );
    expect(qa("graphic-editor-type-")).toHaveLength(0);
  });
});

describe("adding (§5, §6)", () => {
  it("type, text, pin item 3, Add: ONE addScene carrying the entry and its itemPins", async () => {
    const saves: GraphicEditorSave[] = [];
    await mount(React.createElement(AddHost, { onAdded: (s) => saves.push(s) }));
    await openOver(1, 12);
    await bulletList(["Hallucinate", "Forget the context", "Review the code"]);
    // Auto items find their words from the first preview (G2).
    expect(q("graphic-editor-lands-0")!.dataset.state).toBe("auto");
    expect(q("graphic-editor-lands-0")!.textContent).toContain("“hallucinate”");
    // Pin item 3 on "code" (word 12), not the "review" its text would find.
    await click(q("graphic-editor-lands-2")!);
    await click(stripWord(12));
    expect(q("graphic-editor-lands-2")!.dataset.state).toBe("pinned");
    expect(q("graphic-editor-lands-2")!.textContent).toContain("“code”");
    expect(stripWord(12).querySelector('[data-mark="pinned"]')!.textContent).toBe("3");

    await click(q("graphic-editor-save")!);
    expect(saves).toHaveLength(1);
    expect(q("graphic-editor")).toBeNull();
    expect(doc!.addedScenes).toEqual([
      {
        id: "added-1",
        component: "BulletList",
        props: { items: ["Hallucinate", "Forget the context", "Review the code"] },
        srcStart: 6.5,
        srcEnd: 12.4,
      },
    ]);
    const pins: ItemPins = { component: "BulletList", pins: [null, null, { src: 12, text: "Review the code" }] };
    expect(doc!.scenes["added-1"]).toEqual({ props: {}, elements: {}, itemPins: pins });
    // One commit: one undo takes back the entry and its marker together.
    await act(async () => edits!.undo());
    expect(doc!.addedScenes).toBeUndefined();
    expect(doc!.scenes["added-1"]).toBeUndefined();
  });

  it("the add consumes the selection, and focus goes back to the panel body", async () => {
    await mount(React.createElement(AddHost));
    await openOver(0, 0);
    await click(q("graphic-editor-type-TitleCard")!);
    expect((q("graphic-editor-field-title") as HTMLInputElement).value).toBe("so");
    await click(q("graphic-editor-save")!);
    expect(doc!.addedScenes!.map((e) => e.props)).toEqual([{ title: "so" }]);
    expect(q("transcript-selection-menu")).toBeNull();
    expect(document.activeElement).toBe(q("transcript-body"));
  });

  it("TitleCard: the title is prefilled with the selection and Add stores it with no marker", async () => {
    await mount(React.createElement(AddHost));
    await openOver(1, 2);
    await click(q("graphic-editor-type-TitleCard")!);
    expect((q("graphic-editor-field-title") as HTMLInputElement).value).toBe("they hallucinate");
    // A type without item timing: no item rows, no marker (§5).
    expect(qa("graphic-editor-lands-")).toHaveLength(0);
    await click(q("graphic-editor-save")!);
    expect(doc!.addedScenes).toEqual([
      { id: "added-1", component: "TitleCard", props: { title: "they hallucinate" }, srcStart: 6.5, srcEnd: 7.4 },
    ]);
    expect(doc!.scenes["added-1"]).toBeUndefined();
  });

  it("Add is off while a field is empty, with the reason in the footer; Enter adds once it is on", async () => {
    await mount(React.createElement(AddHost));
    await openOver(0, 0);
    await click(q("graphic-editor-type-TitleCard")!);
    const title = q("graphic-editor-field-title") as HTMLInputElement;
    await type(title, "");
    expect((q("graphic-editor-save") as HTMLButtonElement).disabled).toBe(true);
    expect(q("graphic-editor-footer")!.textContent).toBe("Title needs text.");
    await key(title, "Enter");
    expect(doc!.addedScenes).toBeUndefined();
    await type(title, "Agents");
    await key(title, "Enter");
    expect(doc!.addedScenes!.map((e) => e.props)).toEqual([{ title: "Agents" }]);
  });

  it("an empty item says Needs text inline and in the footer", async () => {
    await mount(React.createElement(AddHost));
    await openOver(1, 12);
    await bulletList(["Hallucinate", "Forget the context"]);
    await click(q("graphic-editor-add-item")!);
    expect(q("graphic-editor-need-2")!.textContent).toBe("Needs text");
    expect(q("graphic-editor-item-2")!.getAttribute("aria-invalid")).toBe("true");
    expect(q("graphic-editor-footer")!.textContent).toBe("1 item needs text. Type it or delete the row.");
    expect((q("graphic-editor-save") as HTMLButtonElement).disabled).toBe(true);
    expect(q("graphic-editor-lands-2")!.textContent).toContain("Type the item first");
  });

  it("Escape closes it and keeps the selection; the window never sees the key; a second Escape clears", async () => {
    await mount(React.createElement(AddHost));
    await openOver(0, 1);
    await click(q("graphic-editor-type-TitleCard")!);
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    await key(q("graphic-editor-field-title")!, "Escape");
    window.removeEventListener("keydown", onWindowKey);
    expect(q("graphic-editor")).toBeNull();
    expect(onWindowKey).not.toHaveBeenCalled();
    expect(doc!.addedScenes).toBeUndefined();
    // The selection is still there, and the body has focus again.
    expect(q("transcript-selection-menu")!.textContent).toContain("2 words");
    expect(document.activeElement).toBe(q("transcript-body"));
    await key(document.activeElement as HTMLElement, "Escape");
    expect(q("transcript-selection-menu")).toBeNull();
  });

  it("Cancel adds nothing and keeps the selection", async () => {
    await mount(React.createElement(AddHost));
    await openOver(0, 0);
    await click(q("graphic-editor-type-TitleCard")!);
    await click(q("graphic-editor-cancel")!);
    expect(q("graphic-editor")).toBeNull();
    expect(doc!.addedScenes).toBeUndefined();
    expect(edits!.canUndo).toBe(false);
    expect(q("transcript-selection-menu")).not.toBeNull();
  });

  it("the preview never plays one type's component over another's props, mid-edit or after a type change", async () => {
    const played: SceneCue[] = [];
    await mount(React.createElement(AddHost, { onPreview: (c) => played.push(c) }));
    await openOver(1, 12);
    await bulletList(["Hallucinate", "Forget the context"]);
    expect(played.at(-1)!.component).toBe("BulletList");
    // The selection is too long to prefill a title: nothing to preview yet,
    // and not the list it was a moment ago.
    const before = played.length;
    await click(q("graphic-editor-type-TitleCard")!);
    expect(played).toHaveLength(before);
    expect(q("graphic-editor-preview")!.textContent).toBe("Fill in the graphic to preview it.");
    await type(q("graphic-editor-field-title") as HTMLInputElement, "Agents");
    expect(played.at(-1)!.component).toBe("TitleCard");
    // Emptied again: the last title that rendered stays up.
    await type(q("graphic-editor-field-title") as HTMLInputElement, "");
    expect(played.at(-1)!.component).toBe("TitleCard");
    for (const cue of played) {
      expect(SCENE_REGISTRY[cue.component!].propsSchema.safeParse(cue.props).success, cue.component).toBe(true);
    }
  });

  it("a ChatMock's rows carry their sender; names its controls by row", async () => {
    await mount(React.createElement(AddHost));
    await openOver(0, 0);
    await click(q("graphic-editor-type-ChatMock")!);
    await click(q("graphic-editor-add-item")!);
    await click(q("graphic-editor-add-item")!);
    expect(q("graphic-editor-item-1")!.getAttribute("aria-label")).toBe("Message 2 text");
    expect(q("graphic-editor-from-1")!.getAttribute("aria-label")).toBe("Message 2 sender");
    expect(q("graphic-editor-delete-1")!.getAttribute("aria-label")).toBe("Delete message 2");
    // A new bubble answers the last one.
    expect((q("graphic-editor-from-0") as HTMLSelectElement).value).not.toBe(
      (q("graphic-editor-from-1") as HTMLSelectElement).value,
    );
  });
});

describe("picking (§5)", () => {
  /** Three items, item 1 pinned on "they" (1) and item 3 on "code" (12). */
  const pinnedAround = async () => {
    await mount(React.createElement(AddHost));
    await openOver(1, 12);
    await bulletList(["Hallucinate", "Forget the context", "Review the code"]);
    await click(q("graphic-editor-lands-0")!);
    await click(stripWord(1));
    await click(q("graphic-editor-lands-2")!);
    await click(stripWord(12));
  };

  it("enables only the block words strictly between the neighbouring pins, with the chip and a tinted row", async () => {
    await pinnedAround();
    await click(q("graphic-editor-lands-1")!);
    expect(q("graphic-editor-picking")!.textContent).toContain("Pick the word item 2 lands on");
    expect(q("graphic-editor-picking")!.textContent).toContain("Esc");
    const enabled = qa("graphic-editor-word-")
      .filter((w) => w.getAttribute("aria-disabled") !== "true")
      .map((w) => Number(w.dataset.stripWord));
    expect(enabled).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(q("graphic-editor-row-1")!.getAttribute("style")).toContain("background");
    // A refused word does nothing but say why.
    await click(stripWord(12));
    expect(q("graphic-editor-picking")).not.toBeNull();
    expect(q("graphic-editor-live")!.textContent).toBe(
      "Pick a word between this item's neighbours, so the list stays in order.",
    );
    expect(q("graphic-editor-lands-1")!.dataset.state).toBe("auto");
  });

  it("the word strip is one tab stop; the arrows move it, skipping words a pick cannot take", async () => {
    await pinnedAround();
    await click(q("graphic-editor-lands-1")!);
    const stops = qa("graphic-editor-word-").filter((w) => w.tabIndex === 0);
    expect(stops).toHaveLength(1);
    // The word the pick would change has the focus: item 2's auto word.
    expect(document.activeElement).toBe(stripWord(5));
    await key(stripWord(5), "ArrowRight");
    expect(document.activeElement).toBe(stripWord(6));
    // Home and End go to the first and last word the pick may take, the
    // neighbouring pins' words (1 and 12) excluded.
    await key(stripWord(6), "End");
    expect(document.activeElement).toBe(stripWord(11));
    await key(stripWord(11), "Home");
    expect(document.activeElement).toBe(stripWord(2));
  });

  it("Escape cancels the pick first, then closes the modal", async () => {
    await pinnedAround();
    await click(q("graphic-editor-lands-1")!);
    await key(document.activeElement as HTMLElement, "Escape");
    expect(q("graphic-editor-picking")).toBeNull();
    expect(q("graphic-editor")).not.toBeNull();
    await key(document.activeElement as HTMLElement, "Escape");
    expect(q("graphic-editor")).toBeNull();
    expect(doc!.addedScenes).toBeUndefined();
  });

  it("focus returns to the lands-on box after a pick, and after a cancelled one", async () => {
    await pinnedAround();
    expect(document.activeElement).toBe(q("graphic-editor-lands-2"));
    await click(q("graphic-editor-lands-1")!);
    await key(document.activeElement as HTMLElement, "Escape");
    expect(document.activeElement).toBe(q("graphic-editor-lands-1"));
  });

  it("unpin is its own button, beside delete, and puts the row back on its text", async () => {
    await pinnedAround();
    expect(q("graphic-editor-unpin-1")).toBeNull();
    expect(q("graphic-editor-delete-2")).not.toBeNull();
    await click(q("graphic-editor-unpin-2")!);
    expect(q("graphic-editor-lands-2")!.dataset.state).toBe("auto");
    expect(q("graphic-editor-lands-2")!.textContent).toContain("“review”");
    expect(q("graphic-editor-unpin-2")).toBeNull();
  });

  it("the start flag shows only when the graphic does not start on item 1's word", async () => {
    await pinnedAround();
    // Item 1 is pinned on the block's first word: no flag, "With item 1".
    expect(q("graphic-editor-strip")!.querySelector('[data-mark="start"]')).toBeNull();
    expect(q("graphic-editor-start")!.textContent).toContain("With item 1");
    await click(q("graphic-editor-unpin-0")!);
    await click(q("graphic-editor-lands-0")!);
    await click(stripWord(2));
    // Now item 1 is on word 2 and the block still starts on word 1.
    expect(stripWord(1).querySelector('[data-mark="start"]')).not.toBeNull();
    expect(q("graphic-editor-start")!.textContent).toContain("“they”");
    // A reset, not the rows' delete ×: its own label and glyph.
    const reset = q("graphic-editor-start-item1")!;
    expect(reset.getAttribute("aria-label")).toBe("Start with item 1");
    expect(reset.innerHTML).not.toBe(q("graphic-editor-delete-0")!.innerHTML);
    await click(reset);
    expect(q("graphic-editor-start")!.textContent).toContain("With item 1");
    expect(q("graphic-editor-start-item1")).toBeNull();
  });

  it("switching type keeps typed rows when the new type keeps its items in a list too", async () => {
    await mount(React.createElement(AddHost));
    await openOver(1, 12);
    await bulletList(["Hallucinate", "Forget the context"]);
    await key(q("graphic-editor-type-BulletList")!, "ArrowDown");
    expect(q("graphic-editor-type-FlowDiagram")!.getAttribute("aria-checked")).toBe("true");
    expect((q("graphic-editor-item-0") as HTMLInputElement).value).toBe("Hallucinate");
    expect((q("graphic-editor-item-1") as HTMLInputElement).value).toBe("Forget the context");
    await click(q("graphic-editor-type-TitleCard")!);
    await click(q("graphic-editor-type-BulletList")!);
    // Through a type with no list, they are gone: nothing to carry them.
    expect(q("graphic-editor-item-0")).toBeNull();
  });
});

/** The edit host: the modal over a stored graphic, Save through
 * `patchProps` as App does. */
function EditHost({
  initial,
  sceneId = "scene-0",
  component = "BulletList",
  props,
  liveCue,
  onSaved,
}: {
  initial: OverrideDoc;
  sceneId?: string;
  component?: "BulletList" | "ChatMock" | "CardRow" | "TitleCard";
  props: Record<string, unknown>;
  liveCue: SceneCue;
  onSaved?: () => void;
}) {
  const e = useEdits();
  edits = e;
  doc = e.doc;
  const [open, setOpen] = useState(true);
  React.useEffect(() => {
    e.load(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!open) return null;
  const own = initial.scenes[sceneId];
  return React.createElement(GraphicEditorModal, {
    mode: "edit",
    sceneId,
    component,
    props,
    itemPins: own?.itemPins,
    timing: own?.timing,
    ownReveal: own?.props.reveal,
    liveCue,
    words: WORDS,
    liveMap: identity,
    window: { srcStart: WORDS[1]!.start, srcEnd: WORDS[12]!.end },
    fps: 30,
    prevGraphicEndSec: null,
    onSave: (save) => {
      onSaved?.();
      e.patchProps(sceneId, save.props, {
        clearKeys: save.clearKeys,
        ...(save.itemPins !== undefined ? { itemPins: save.itemPins } : {}),
        ...(save.timing !== undefined ? { timing: save.timing } : {}),
      });
      setOpen(false);
    },
    onClose: () => setOpen(false),
  });
}

const ITEMS = ["Hallucinate", "Forget the context", "Review the code"];
const planCue = (props: Record<string, unknown> = { items: ITEMS }, component = "BulletList"): SceneCue => ({
  id: "scene-0",
  layout: "video-top",
  component: component as SceneCue["component"],
  props,
  startSec: WORDS[1]!.start,
  endSec: WORDS[12]!.end,
  anchor: { startWord: 1, endWord: 12 },
});
const marked = OverrideDocSchema.parse({
  scenes: { "scene-0": { itemPins: { component: "BulletList", pins: [null, null, null] } } },
});

describe("editing (§5, §6)", () => {
  it("hides the type column and says Save; an empty item turns Save off with its reason", async () => {
    await mount(React.createElement(EditHost, { initial: marked, props: { items: ITEMS }, liveCue: planCue() }));
    expect(q("graphic-editor")!.textContent).toContain("Edit graphic");
    expect(qa("graphic-editor-type-")).toHaveLength(0);
    const save = q("graphic-editor-save") as HTMLButtonElement;
    expect(save.textContent).toBe("Save");
    expect(save.disabled).toBe(false);
    expect(q("graphic-editor-footer")!.textContent).toBe("Saving keeps the block where it is on the timeline.");
    await type(q("graphic-editor-item-1") as HTMLInputElement, "");
    expect(save.disabled).toBe(true);
    expect(q("graphic-editor-need-1")!.textContent).toBe("Needs text");
    expect(q("graphic-editor-footer")!.textContent).toBe("1 item needs text. Type it or delete the row.");
  });

  it("Save with no change dispatches nothing, and closes", async () => {
    const onSaved = vi.fn();
    await mount(React.createElement(EditHost, { initial: marked, props: { items: ITEMS }, liveCue: planCue(), onSaved }));
    const before = doc;
    await click(q("graphic-editor-save")!);
    expect(q("graphic-editor")).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(doc).toBe(before);
    expect(edits!.canUndo).toBe(false);
  });

  it("Cancel after changes dispatches nothing", async () => {
    await mount(React.createElement(EditHost, { initial: marked, props: { items: ITEMS }, liveCue: planCue() }));
    const before = doc;
    await type(q("graphic-editor-item-0") as HTMLInputElement, "Something else");
    await click(q("graphic-editor-lands-2")!);
    await click(stripWord(12));
    await click(q("graphic-editor-cancel")!);
    expect(q("graphic-editor")).toBeNull();
    expect(doc).toBe(before);
    expect(edits!.canUndo).toBe(false);
  });

  it("editing an auto item's text moves its marker to the word it now finds", async () => {
    await mount(React.createElement(EditHost, { initial: marked, props: { items: ITEMS }, liveCue: planCue() }));
    expect(stripWord(2).querySelector('[data-mark="auto"]')!.textContent).toBe("1");
    await type(q("graphic-editor-item-0") as HTMLInputElement, "Context");
    expect(stripWord(2).querySelector('[data-mark="auto"]')).toBeNull();
    expect(stripWord(7).querySelector('[data-mark="auto"]')!.textContent).toBe("1");
    expect(q("graphic-editor-lands-0")!.textContent).toContain("“context”");
  });

  it("the When row writes a timing pin on the chosen word, one patchProps step", async () => {
    await mount(React.createElement(EditHost, { initial: marked, props: { items: ITEMS }, liveCue: planCue() }));
    await click(q("graphic-editor-start")!);
    expect(q("graphic-editor-picking")!.textContent).toContain("Pick the word the graphic starts on");
    // The start may not come after item 1's word ("hallucinate", 2).
    expect(stripWord(3).getAttribute("aria-disabled")).toBe("true");
    await click(stripWord(2));
    expect(document.activeElement).toBe(q("graphic-editor-start"));
    // Still item 1's word, so "With item 1" and no flag.
    expect(q("graphic-editor-start")!.textContent).toContain("With item 1");
    await click(q("graphic-editor-save")!);
    const timing = doc!.scenes["scene-0"]!.timing as { srcStart: number; srcEnd: number };
    // ENTRY_LEAD_SEC (0.3) ahead of the word, on an identity clock.
    expect(timing.srcStart).toBeCloseTo(WORDS[2]!.start - 0.3, 6);
    expect(timing.srcEnd).toBeCloseTo(WORDS[12]!.end, 6);
    // The marker is unchanged: a When-row pin is not an item change (§6).
    expect(doc!.scenes["scene-0"]!.itemPins).toEqual(marked.scenes["scene-0"]!.itemPins);
    await act(async () => edits!.undo());
    expect(doc!.scenes["scene-0"]!.timing).toBeUndefined();
  });

  it("a ChatMock whose keyword is its one item offers no row to add or delete", async () => {
    const props = {
      messages: [
        { from: "user", text: "they forget" },
        { from: "agent", text: "review the code" },
      ],
      keyword: "context",
    };
    await mount(
      React.createElement(EditHost, {
        initial: OverrideDocSchema.parse({
          scenes: { "scene-0": { itemPins: { component: "ChatMock", pins: [null] } } },
        }),
        component: "ChatMock",
        props,
        liveCue: planCue(props, "ChatMock"),
      }),
    );
    expect(q("graphic-editor-add-item")).toBeNull();
    expect(qa("graphic-editor-delete-")).toHaveLength(0);
    // The keyword is the one row that lands on a word.
    expect(qa("graphic-editor-lands-")).toHaveLength(1);
    expect(q("graphic-editor-lands-0")!.textContent).toContain("“context”");
  });

  it("a row on its component's legacy stagger shows no time", async () => {
    // A stored BulletList, no marker, no item times: the 7-frame stagger.
    await mount(
      React.createElement(EditHost, { initial: OverrideDocSchema.parse({}), props: { items: ITEMS }, liveCue: planCue() }),
    );
    for (const k of [0, 1, 2]) {
      expect(q(`graphic-editor-lands-${k}`)!.textContent).not.toMatch(/\d:\d\d\.\d/);
    }
  });
});

/**
 * The author's report (2026-11-22, folded into Task 7): after adding a
 * bullet list over the first words, a selection well past it was refused
 * as overlapping "BulletList". The check runs on what the stage holds: an
 * unbaked add (`previewBaseCues` on the old clock), its window after an
 * edge drag (a src timing pin, resolved as the live memo resolves it), and
 * the same doc read back from disk.
 */
describe("the add check after an earlier add (author report 2026-11-22)", () => {
  // A cut at the head, as the author's project has (the first span starts
  // at 1.7 s source), so output and source seconds differ.
  const LONG = Array.from({ length: 80 }, (_, i) => ({ text: `w${i}`, start: i * 0.4, end: i * 0.4 + 0.3 }));
  const map = mapFromKeptSpans([
    { srcIn: 1.69919, srcOut: 6, outIn: 0, outOut: 4.30081 },
    { srcIn: 8.15, srcOut: 40, outIn: 4.30081, outOut: 36.15081 },
  ]);
  const first = { id: "added-1", component: "BulletList", props: { items: ["one", "two"] }, srcStart: 0, srcEnd: 4.6 };
  /** The selection the panel would hand over, source-anchored. */
  const pick = (from: number, to: number): AddGraphicWord[] =>
    LONG.slice(from, to + 1).map((w) => ({ srcStart: w.start, start: w.start, end: w.end, text: w.text }));
  /** The stage's cues for `raw`, as the live memo builds them on the old clock. */
  const stage = (raw: unknown): SceneCue[] => {
    const d = OverrideDocSchema.parse(raw);
    const base = previewBaseCues({
      baseCues: [],
      added: d.addedScenes ?? [],
      issueIds: new Set(),
      words: LONG,
      map,
      landscape: false,
      scriptProject: false,
    }).cues;
    return applyOverrides(base, resolveSrcTimingPins(d, map).doc).cues;
  };
  const check = (cues: SceneCue[], from: number, to: number) =>
    addGraphicCheck({ words: pick(from, to), cues, clock: map, toPlayerSec: (s) => s, deferred: false });

  it("a bullet list over words 0–11, not rendered: a selection far later is not refused", () => {
    const cues = stage({ addedScenes: [first] });
    expect(cues.map((c) => c.component)).toEqual(["BulletList"]);
    for (const [from, to] of [
      [30, 34],
      [50, 52],
      [70, 75],
    ] as const) {
      expect(check(cues, from, to).refusal, `${from}–${to}`).toBeNull();
    }
    // And one that does overlap still is.
    expect(check(cues, 10, 13).refusal).toContain("BulletList");
  });

  it("the same after the block's right edge is dragged (a src timing pin)", () => {
    const cues = stage({ addedScenes: [first], scenes: { "added-1": { timing: { srcStart: 1.7, srcEnd: 12 } } } });
    expect(cues[0]!.pinned).toBe(true);
    for (const [from, to] of [
      [40, 44],
      [70, 75],
    ] as const) {
      expect(check(cues, from, to).refusal, `${from}–${to}`).toBeNull();
    }
  });

  it("the same after Save and reload (the doc read back through the schema)", () => {
    const saved = JSON.parse(
      JSON.stringify(OverrideDocSchema.parse({ addedScenes: [first], scenes: { "added-1": { itemPins: { component: "BulletList", pins: [null, null] } } } })),
    );
    const cues = stage(saved);
    expect(check(cues, 50, 52).refusal).toBeNull();
  });
});
