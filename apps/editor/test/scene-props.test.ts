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

  it("CardRow's cards are edited through their card-N ids, not a control here (§161)", () => {
    const keys = scalarPropControls("CardRow").map((c) => c.key);
    expect(keys).not.toContain("cards");
    // It reveals one card per beat, so it gets the reveal controls.
    expect(keys).toEqual(expect.arrayContaining(["reveal", "pacing", "revealSpeed", "entrance"]));
  });

  it("CtaCard's action is a dropdown of its three; its copy is edited through its ids (§161)", () => {
    const controls = scalarPropControls("CtaCard");
    expect(controls.find((c) => c.key === "action")).toMatchObject({
      kind: "enum",
      options: ["comment", "subscribe", "link"],
    });
    // No reveal items, so no reveal controls; the strings are not scalars here.
    expect(controls.map((c) => c.key)).toEqual(["action"]);
  });

  it("BugCard's mock and its fault are dropdowns; its integers are step-1 sliders (§161)", () => {
    const controls = scalarPropControls("BugCard");
    expect(controls.find((c) => c.key === "mock")).toEqual({
      key: "mock",
      kind: "enum",
      options: ["none", "caption", "lines"],
    });
    expect(controls.find((c) => c.key === "mockFault")).toEqual({
      key: "mockFault",
      kind: "enum",
      options: ["struck", "clipped"],
    });
    // `number` and `mockWrong` are z.number().int(), which JSON Schema writes
    // as type "integer". Until §161 the slider derivation read type "number"
    // only, so neither had a control; now each is a slider stepping by 1.
    // `number` is required, so it has no unset state and no clear button.
    expect(controls.find((c) => c.key === "number")).toEqual({
      key: "number",
      kind: "number",
      min: 1,
      max: 9,
      step: 1,
      fallback: 1,
    });
    // `mockWrong` unset marks nothing — not entry 0 — so the control says
    // so, and the slider merely rests at the minimum.
    expect(controls.find((c) => c.key === "mockWrong")).toEqual({
      key: "mockWrong",
      kind: "number",
      min: 0,
      max: 3,
      step: 1,
      fallback: 0,
      optional: true,
      unsetIsNone: true,
    });
    expect(controls.map((c) => c.key)).toEqual(["number", "mock", "mockWrong", "mockFault"]);
  });

  it("CardRow's highlight is a step-1 slider whose unset is no card, not card 0 (§161)", () => {
    expect(scalarPropControls("CardRow")[0]).toEqual({
      key: "highlight",
      kind: "number",
      min: 0,
      max: 3,
      step: 1,
      fallback: 0,
      optional: true,
      unsetIsNone: true,
    });
  });

  it("PhoneDemo's words and pills are edited through word-N and pill-N; only the reveal controls show (§161)", () => {
    // `emphasis` and `state` live inside the arrays, so no control reaches
    // them: a known gap (plan Task 7, recorded for §161).
    expect(scalarPropControls("PhoneDemo").map((c) => c.key)).toEqual(["reveal", "pacing", "revealSpeed", "entrance"]);
  });

  it("the integer sliders change no existing control: the nine, CtaCard and ClipScene are as they were", () => {
    // Pinned whole, not by key: the integer rule must add controls only
    // where an integer prop was, and touch no field of any other control.
    const revealCtl = [
      { key: "reveal", kind: "enum", options: ["auto", "synced", "paced"], optional: true },
      { key: "pacing", kind: "enum", options: ["even", "accelerate", "decelerate", "ease-in-out"], optional: true },
      { key: "revealSpeed", kind: "number", min: 0.1, max: 1, step: 0.01, fallback: 0.66, optional: true },
      { key: "entrance", kind: "enum", options: ["pop", "fade", "rise", "bounce"], optional: true },
    ];
    const expected = {
      TitleCard: [],
      StatCard: [{ key: "inverted", kind: "boolean", fallback: false }],
      RuleCard: [],
      StrikethroughReveal: revealCtl,
      FlowDiagram: [{ key: "emphasizeLast", kind: "boolean", fallback: true }, ...revealCtl],
      TerminalMock: revealCtl,
      ChatMock: revealCtl,
      ScreenshotFrame: [{ key: "kenBurns", kind: "boolean", fallback: true }],
      BulletList: [],
      CtaCard: [{ key: "action", kind: "enum", options: ["comment", "subscribe", "link"] }],
      ClipScene: [
        { key: "speed", kind: "number", min: 0.25, max: 4, step: 0.01, fallback: 1 },
        { key: "gainDb", kind: "number", min: -40, max: 0, step: 0.01, fallback: -13 },
        { key: "muted", kind: "boolean", fallback: false },
      ],
    } as const;
    for (const [id, controls] of Object.entries(expected)) {
      expect(scalarPropControls(id as keyof typeof expected), id).toEqual(controls);
    }
    // And the existing optional number keeps its "default", not "not set".
    expect(scalarPropControls("CardRow").find((c) => c.key === "revealSpeed")).not.toHaveProperty("unsetIsNone");
  });

  it("every registry component resolves without throwing", () => {
    for (const id of ["TitleCard", "StatCard", "RuleCard", "StrikethroughReveal",
      "FlowDiagram", "TerminalMock", "ChatMock", "ScreenshotFrame", "BulletList", "CardRow", "CtaCard",
      "BugCard", "PhoneDemo"] as const) {
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
