import { describe, expect, it } from "vitest";
import { scalarPropControls } from "@ossclip/core/browser";

/**
 * The controls the Inspector shows for a scene's non-text props (§153).
 *
 * Derived from the component's own schema rather than hand-listed per
 * component, because hand-wiring is what let ScreenshotFrame ship with an
 * unreachable prop in the first place. A component that gains a boolean gets
 * a checkbox the day it lands, without anyone remembering to add one.
 *
 * Scope is deliberately narrow: booleans and enums. Strings already have the
 * per-element Text field, and arrays are edited by selecting the element they
 * back (`line-2`, `window-0`) — duplicating either here would give two
 * controls writing the same prop.
 */
describe("scalarPropControls", () => {
  it("finds the boolean a component would otherwise hide", () => {
    // StatCard.inverted had no control anywhere in the UI.
    expect(scalarPropControls("StatCard")).toEqual([
      { key: "inverted", kind: "boolean", fallback: false },
    ]);
  });

  it("carries the schema default, so an unset prop renders as what it IS", () => {
    // kenBurns defaults TRUE — a checkbox defaulting to false would misreport
    // the scene it is describing.
    expect(scalarPropControls("ScreenshotFrame")).toEqual([
      { key: "kenBurns", kind: "boolean", fallback: true },
    ]);
  });

  it("skips strings and arrays — the element Text field already owns those", () => {
    const keys = scalarPropControls("TitleCard").map((c) => c.key);
    expect(keys).not.toContain("title");
    expect(keys).not.toContain("sub");
  });

  it("skips array props, which are edited through their element ids", () => {
    const keys = scalarPropControls("TerminalMock").map((c) => c.key);
    expect(keys).not.toContain("windows");
    // fanOut is a STRING with its own data-edit-id, so the Text field already
    // owns it — a checkbox here would be a second control for the same prop.
    expect(keys).not.toContain("fanOut");
  });

  it("every registry component resolves without throwing", () => {
    for (const id of ["TitleCard", "StatCard", "RuleCard", "StrikethroughReveal",
      "FlowDiagram", "TerminalMock", "ChatMock", "ScreenshotFrame", "BulletList"] as const) {
      expect(() => scalarPropControls(id)).not.toThrow();
    }
  });

  it("covers every boolean that had no control before this", () => {
    // Three, not four: TerminalMock.fanOut looks like a toggle from its name
    // but is a string in the schema, and was already editable as text.
    const found = new Set(
      (["StatCard", "ScreenshotFrame", "FlowDiagram"] as const).flatMap((id) =>
        scalarPropControls(id).map((c) => `${id}.${c.key}`),
      ),
    );
    for (const k of [
      "StatCard.inverted",
      "ScreenshotFrame.kenBurns",
      "FlowDiagram.emphasizeLast",
    ]) {
      expect(found).toContain(k);
    }
  });
});
