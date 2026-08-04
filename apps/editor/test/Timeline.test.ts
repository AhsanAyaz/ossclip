// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneCue } from "@ossclip/core/browser";
import { Timeline } from "../src/Timeline";
import { useEdits } from "../src/useEdits";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cue: SceneCue = {
  id: "scene-0",
  kind: "graphic",
  layout: "lower-third",
  component: "TitleCard",
  props: { title: "SHIP IT" },
  startSec: 0,
  endSec: 10,
};

function Harness() {
  const edits = useEdits();
  return React.createElement(
    "div",
    null,
    // A stand-in for the Inspector's own text field, focused independently
    // of Timeline — the fix under test is that ANY mousedown on the
    // timeline strip blurs whatever field currently has focus, wherever it
    // lives in the app, not just inside Timeline's own DOM.
    React.createElement("input", { "data-testid": "outside-field" }),
    React.createElement(Timeline, {
      cues: [cue],
      ghosts: [],
      durationSec: 10,
      fps: 30,
      playerRef: { current: null },
      selection: null,
      onSelect: vi.fn(),
      edits,
    }),
  );
}

describe("Timeline — mousedown blurs a stale-focused field (PLAN 2026-08-04 Task 2, bug 6)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("mousedown on the track background blurs a focused input elsewhere in the app", async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    const field = container.querySelector<HTMLInputElement>('[data-testid="outside-field"]')!;
    field.focus();
    expect(document.activeElement).toBe(field);
    const track = container.querySelector<HTMLElement>('[data-testid="ruler"]')!.nextElementSibling as HTMLElement;
    act(() => {
      track.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 5 }));
    });
    expect(document.activeElement).toBe(document.body);
  });

  it("mousedown on a scene block blurs it too — capture phase on the wrapping strip runs before the block's own bubble-phase handler (and its stopPropagation) ever gets a turn", async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    const field = container.querySelector<HTMLInputElement>('[data-testid="outside-field"]')!;
    field.focus();
    const block = container.querySelector<HTMLElement>('[data-testid="timeline-block-scene-0"]')!;
    act(() => {
      block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 5 }));
    });
    expect(document.activeElement).toBe(document.body);
  });
});
