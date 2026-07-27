// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findEditableFrom } from "../src/hitTest";

describe("findEditableFrom", () => {
  it("finds the nearest tagged ancestor of the clicked node", () => {
    document.body.innerHTML = `
      <div data-edit-scene="scene-0">
        <div data-edit-id="value"><span id="inner">861%</span></div>
      </div>`;
    const hit = findEditableFrom(document.getElementById("inner")!);
    expect(hit).toEqual({ sceneId: "scene-0", elementId: "value" });
  });

  it("returns null when the click was not inside anything editable", () => {
    document.body.innerHTML = `<div><span id="loose">x</span></div>`;
    expect(findEditableFrom(document.getElementById("loose")!)).toBeNull();
  });

  it("returns null for a tagged element with no scene ancestor", () => {
    // A leaf outside a scene is not addressable — the override doc keys on both.
    document.body.innerHTML = `<div data-edit-id="value"><span id="inner">x</span></div>`;
    expect(findEditableFrom(document.getElementById("inner")!)).toBeNull();
  });
});
