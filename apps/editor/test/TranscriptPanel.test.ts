// @vitest-environment jsdom
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { PlayerRef } from "@remotion/player";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptionLine } from "@ossclip/core/browser";
import { TranscriptPanel } from "../src/TranscriptPanel";
import { useEdits } from "../src/useEdits";

// Same one-time act() opt-in as Overlay.test.ts/Inspector.test.ts.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * §137 review, Important 2 + Minor 3. The transcript's retype is the second
 * path into `patchCaption`, and the only one with no DOM attribute standing
 * between it and a word — it reads `liveLines` directly, so a word with no
 * `srcStart` reaches it as a plain object with a missing field.
 *
 * The reducer derives the key with `captionKeyFor`, which THROWS on a
 * non-finite anchor by design. This handler is a React `onBlur`, with no error
 * boundary above `<App/>`, so an unguarded commit here white-screens the editor
 * on any workdir the load-path repair could not fix. And the refusal has to be
 * at the OPEN, not the commit: gating at the commit let the user type a
 * correction, press Enter, and watch it silently revert — the exact experience
 * §137 exists to remove.
 */
describe("TranscriptPanel retype guard (§137)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  /** A word as a REPAIRED file holds it. */
  const anchored = (text: string, start: number, srcStart: number): CaptionLine => ({
    words: [{ text, start, end: start + 0.3, srcStart }],
    start,
    end: start + 0.3,
  });

  /** A word as a pre-§137 file holds it: no `srcStart` at all. */
  const legacy = (text: string, start: number): CaptionLine => ({
    words: [{ text, start, end: start + 0.3 } as CaptionLine["words"][number]],
    start,
    end: start + 0.3,
  });

  function Harness({ lines }: { lines: CaptionLine[] }) {
    const edits = useEdits();
    const playerRef = useRef<PlayerRef>(null);
    // The doc is rendered so the assertions can read what the retype wrote
    // without reaching into the hook.
    return React.createElement(
      "div",
      null,
      React.createElement("div", {
        "data-testid": "doc",
        children: JSON.stringify(edits.doc.captions),
      }),
      React.createElement(TranscriptPanel, {
        baseLines: lines,
        liveLines: lines,
        fps: 30,
        playerRef,
        edits,
        width: 300,
      }),
    );
  }

  const dblclick = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
  };

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

  it("refuses to open the retype box on a word with no source anchor", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [legacy("Claude", 0.09)] }));
    });
    await dblclick(container.querySelector<HTMLElement>('[data-testid="transcript-word-0"]')!);
    expect(container.querySelector('[data-testid="transcript-edit"]')).toBeNull();
  });

  it("opens, and writes the SOURCE key, on a word that has one", async () => {
    // The other half of the guard: it must refuse the anchorless word without
    // refusing every word. Without this, deleting the retype entirely would
    // still pass the test above.
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [anchored("Claude", 0.09, 1.7675)] }));
    });
    await dblclick(container.querySelector<HTMLElement>('[data-testid="transcript-word-0"]')!);
    const input = container.querySelector<HTMLInputElement>('[data-testid="transcript-edit"]')!;
    expect(input).not.toBeNull();

    await act(async () => {
      // React tracks the DOM node's own value to dedupe change events, so a
      // plain `input.value = …` is swallowed; set it through the prototype.
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "CLAWD");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // `autoFocus` put the caret here (the same thing Overlay.test.ts relies
    // on), so a real `blur()` is the gesture the user makes — and React 17+
    // maps `onBlur` to the bubbling `focusout`, which a hand-built
    // non-bubbling `FocusEvent("blur")` would never reach.
    expect(document.activeElement).toBe(input);
    await act(async () => {
      input.blur();
    });

    // Keyed by SOURCE time (1.7675s → w1768), never by the word's OUTPUT start
    // (0.09s → w90) and never by its position ("0").
    const doc = JSON.parse(container.querySelector('[data-testid="doc"]')!.textContent!);
    expect(doc).toEqual({ w1768: { text: "CLAWD", was: "Claude" } });
  });
});
