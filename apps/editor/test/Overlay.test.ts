// @vitest-environment jsdom
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { PlayerRef } from "@remotion/player";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Overlay, blurTypingElement, buildArrayPatch, elementTextOf } from "../src/Overlay";
import { useEdits } from "../src/useEdits";

// Same one-time act() opt-in as project-picker.test.ts/Inspector.test.ts —
// needed the moment a file mounts a component instead of calling pure
// functions.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("buildArrayPatch — ChatMock CTA keyword mapping", () => {
  const props = { keyword: "agents" };

  it("maps a fresh full retype (no decoration) straight through", () => {
    expect(buildArrayPatch("message-0", props, "friends")).toEqual({ keyword: "friends" });
  });

  it("strips quotes and undoes the uppercasing from an in-place edit of the decorated display string", () => {
    // The inline edit box seeds from the live (decorated) `textContent`:
    // `"AGENTS"`. An in-place edit — say, fixing a typo — leaves most of
    // that decoration intact rather than replacing the whole string, so the
    // mapping must still produce a clean, lowercase keyword.
    expect(buildArrayPatch("message-0", props, '"AGENTZ"')).toEqual({ keyword: "agentz" });
  });

  it("undoes uppercasing even without surrounding quotes", () => {
    expect(buildArrayPatch("message-0", props, "AGENTS")).toEqual({ keyword: "agents" });
  });

  it("still strips quotes when the casing is already lowercase", () => {
    expect(buildArrayPatch("message-0", props, '"agents"')).toEqual({ keyword: "agents" });
  });

  it("returns null for an empty mapped keyword", () => {
    expect(buildArrayPatch("message-0", props, '""')).toBeNull();
  });
});

describe("BulletList items — the item-N id family (R16 §67)", () => {
  it("patches an item in place — items is a plain string[], like nodes", () => {
    expect(buildArrayPatch("item-1", { items: ["A", "B", "C"] }, "REPLACED")).toEqual({
      items: ["A", "REPLACED", "C"],
    });
    expect(buildArrayPatch("item-9", { items: ["A"] }, "X")).toBeNull();
  });

  it("reads an item back for the panel's text field", () => {
    expect(elementTextOf("item-2", { items: ["A", "B", "C"] })).toBe("C");
    expect(elementTextOf("item-0", {})).toBeNull();
  });
});

describe("elementTextOf — the panel's read direction (R12 §49)", () => {
  it("reads top-level string props directly, and refuses non-strings", () => {
    expect(elementTextOf("title", { title: "SHIP IT" })).toBe("SHIP IT");
    expect(elementTextOf("value", { value: 42 })).toBeNull();
  });

  it("reads array-backed ids out of their arrays — what the double-click alone could reach", () => {
    expect(elementTextOf("node-1", { nodes: ["A", "B"] })).toBe("B");
    expect(elementTextOf("line-0", { lines: [{ text: "RULE", struck: false }] })).toBe("RULE");
    expect(elementTextOf("message-1", { messages: [{ text: "hi" }, { text: "there" }] })).toBe("there");
  });

  it("reads the CTA keyword for message-0 in keyword mode — matching what a patch there writes", () => {
    expect(elementTextOf("message-0", { keyword: "agents", messages: [{ text: "x" }] })).toBe("agents");
  });

  it("returns null for a window (its lines carry their own ids) and out-of-range indices", () => {
    expect(elementTextOf("window-0", { windows: [] })).toBeNull();
    expect(elementTextOf("node-5", { nodes: ["A"] })).toBeNull();
  });
});

describe("blurTypingElement — bug 6's fix (PLAN 2026-08-04 Task 2)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("blurs a focused INPUT", () => {
    document.body.innerHTML = '<input id="f" />';
    const input = document.getElementById("f") as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    blurTypingElement();
    expect(document.activeElement).toBe(document.body);
  });

  it("blurs a focused TEXTAREA", () => {
    document.body.innerHTML = "<textarea id=\"t\"></textarea>";
    const textarea = document.getElementById("t") as HTMLTextAreaElement;
    textarea.focus();
    blurTypingElement();
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves a focused BUTTON alone — a click-away has no typed value to lose there", () => {
    document.body.innerHTML = '<button id="b">go</button>';
    const btn = document.getElementById("b") as HTMLButtonElement;
    btn.focus();
    blurTypingElement();
    expect(document.activeElement).toBe(btn);
  });

  it("leaves a focused SELECT alone — no free-typed value to discard, unlike a text field", () => {
    document.body.innerHTML = '<select id="s"><option>a</option></select>';
    const select = document.getElementById("s") as HTMLSelectElement;
    select.focus();
    blurTypingElement();
    expect(document.activeElement).toBe(select);
  });

  it("is a no-op when nothing is focused", () => {
    expect(document.activeElement).toBe(document.body);
    expect(() => blurTypingElement()).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });
});

/**
 * The gap a review flagged: the tests above prove `blurTypingElement` works
 * in isolation, but never through the actual wiring — Overlay's window
 * `mousedown` listener calling it (`onWindowMouseDown` in Overlay.tsx). A
 * future edit that dropped that one call, or moved it to the wrong side of
 * the `e.altKey || e.button !== 0` early return, would pass every test
 * above. This mounts the real `Overlay` and dispatches real `mousedown`
 * events at `window` (bubbled up from a DOM target, the same path a real
 * click takes — not a hand-built event with a spoofed `target`) to close
 * that gap.
 */
describe("Overlay's window mousedown listener — the real wiring for bug 6", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function Harness() {
    const edits = useEdits();
    const stageRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<PlayerRef>(null);
    return React.createElement(
      React.Fragment,
      null,
      // Stands in for an Inspector field elsewhere in the app — Overlay's
      // listener has to blur THIS, not anything of its own.
      React.createElement("input", { "data-testid": "outside-field" }),
      React.createElement(
        "div",
        { ref: stageRef, "data-testid": "stage" },
        React.createElement("div", { "data-testid": "inside-stage-target" }),
      ),
      React.createElement("div", { "data-testid": "outside-stage-target" }),
      React.createElement(Overlay, {
        stageRef,
        selection: null,
        onSelect: vi.fn(),
        edits,
        onSave: vi.fn(),
        settings: { width: 1080, height: 1920, fps: 30 },
        cues: [],
        onToggleHelp: vi.fn(),
        playerRef,
        onTransport: vi.fn(),
        onVideoPreview: vi.fn(),
        onGraphicPreview: vi.fn(),
        cue: null,
      }),
    );
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // jsdom implements no layout, so `elementFromPoint` isn't defined at all
    // (not even a stub returning null) — `elementBelow`'s hit-test walk
    // calls it unconditionally once a press reaches the stage. None of
    // these tests care what it hit (selection stays null throughout; the
    // blur happens before that logic runs either way), only that the walk
    // doesn't throw and abort the dispatch before `blurTypingElement()` had
    // its chance to run.
    document.elementFromPoint = () => null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("a left-click mousedown inside the stage blurs a focused field elsewhere in the app", async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    const field = container.querySelector<HTMLInputElement>('[data-testid="outside-field"]')!;
    const target = container.querySelector<HTMLElement>('[data-testid="inside-stage-target"]')!;
    field.focus();
    expect(document.activeElement).toBe(field);
    act(() => {
      target.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    expect(document.activeElement).toBe(document.body);
  });

  it("a mousedown OUTSIDE the stage does not blur — `stage.contains(e.target)` returns before `blurTypingElement()` is ever reached", async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    const field = container.querySelector<HTMLInputElement>('[data-testid="outside-field"]')!;
    const outside = container.querySelector<HTMLElement>('[data-testid="outside-stage-target"]')!;
    field.focus();
    act(() => {
      outside.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    // Still focused: this press never touched the stage, so the guard
    // returned before blurring runs at all — the negative case.
    expect(document.activeElement).toBe(field);
  });

  it("an alt-click inside the stage (a view-gesture, not a selection) still blurs — the actual designed order: `blurTypingElement()` sits BEFORE the `e.altKey || e.button !== 0` early return, so every press that reaches the stage drops stale focus, not just the ones that go on to select or drag something", async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    const field = container.querySelector<HTMLInputElement>('[data-testid="outside-field"]')!;
    const target = container.querySelector<HTMLElement>('[data-testid="inside-stage-target"]')!;
    field.focus();
    act(() => {
      target.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true }),
      );
    });
    expect(document.activeElement).toBe(document.body);
  });

  it("a middle-button mousedown inside the stage also still blurs, for the same reason", async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    const field = container.querySelector<HTMLInputElement>('[data-testid="outside-field"]')!;
    const target = container.querySelector<HTMLElement>('[data-testid="inside-stage-target"]')!;
    field.focus();
    act(() => {
      target.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 }),
      );
    });
    expect(document.activeElement).toBe(document.body);
  });
});
