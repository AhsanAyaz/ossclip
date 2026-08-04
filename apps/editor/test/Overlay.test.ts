// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { blurTypingElement, buildArrayPatch, elementTextOf } from "../src/Overlay";

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
