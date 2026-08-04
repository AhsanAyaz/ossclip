// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeptSpan, SceneCue } from "@ossclip/core/browser";
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

function Harness({
  cuts,
  spans,
}: {
  /** Pre-loaded into `edits.doc.cuts` before Timeline ever renders (mirrors
   * App.tsx's real wiring, `cuts={edits.doc.cuts}`) — NOT a static prop.
   * `restoreChunk`'s effect on the timeline can only be observed if
   * Timeline is fed the SAME reducer state the click mutates; a bare static
   * `cuts` prop would make the seam immortal no matter what the click does. */
  cuts?: { startSec: number; endSec: number; src?: { startSec: number; endSec: number } }[];
  spans?: KeptSpan[];
} = {}) {
  const edits = useEdits();
  React.useEffect(() => {
    if (cuts) {
      edits.load({ theme: {}, scenes: {}, captions: {}, splits: [], cuts });
    }
    // Re-loads whenever the TEST passes a new `cuts` array reference — some
    // tests re-render the Harness mid-test with a different `cuts` prop to
    // simulate "the doc changed"; a mount-once effect would miss that.
    // Internal state changes (e.g. a click dispatching `restoreChunk`)
    // re-render Harness with the SAME `cuts` prop reference, so this does
    // NOT fire again and clobber what the click just did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cuts]);
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
      cuts: edits.doc.cuts,
      spans,
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

describe("Timeline — user cuts render as a dead-region overlay (PLAN 2026-08-04 Task 4c)", () => {
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

  it("draws one overlay per cut, positioned at the cut's own window — and none when `cuts` is omitted", async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    // No `cuts` prop at all (the default-parameter path every pre-existing
    // caller/test takes) — nothing renders, nothing throws.
    expect(container.querySelectorAll('[data-testid^="timeline-cut-"]')).toHaveLength(0);

    await act(async () => {
      root.render(React.createElement(Harness, { cuts: [{ startSec: 2, endSec: 4 }] }));
    });
    const overlay = container.querySelector<HTMLElement>('[data-testid="timeline-cut-2-4"]')!;
    expect(overlay).not.toBeNull();
    // durationSec is 10 in the Harness — 20%/20% for a [2, 4] window.
    expect(overlay.style.left).toBe("20%");
    expect(overlay.style.width).toBe("20%");
  });

  it("draws every cut independently, and the overlay is pointer-inert (the real block underneath stays the click target)", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          cuts: [
            { startSec: 1, endSec: 2 },
            { startSec: 7, endSec: 9 },
          ],
        }),
      );
    });
    // NOT the seam prefix too (`^=` would also match `timeline-cut-seam-…`,
    // which starts with the same string) — both of these are band-mode.
    const bands = Array.from(container.querySelectorAll('[data-testid^="timeline-cut-"]')).filter(
      (el) => !el.getAttribute("data-testid")!.startsWith("timeline-cut-seam-"),
    );
    expect(bands).toHaveLength(2);
    const overlay = container.querySelector<HTMLElement>('[data-testid="timeline-cut-1-2"]')!;
    expect(overlay.style.pointerEvents).toBe("none");
  });

  it("clamps a stale (past-duration) NOT-YET-APPLIED cut to the timeline's own bounds (review finding 1)", async () => {
    // durationSec is 10 in the Harness — a [12, 15] window is entirely past
    // the current (shorter, in this scenario) output.
    await act(async () => {
      root.render(React.createElement(Harness, { cuts: [{ startSec: 12, endSec: 15 }] }));
    });
    const overlay = container.querySelector<HTMLElement>('[data-testid="timeline-cut-12-15"]')!;
    expect(overlay).not.toBeNull();
    expect(overlay.style.left).toBe("100%");
    expect(overlay.style.width).toBe("0%"); // never past the right edge
  });

  it("an ALREADY-APPLIED cut (src present) draws a SEAM, not a band — positioned via spans, never the stale startSec/endSec (review finding 1)", async () => {
    const spans: KeptSpan[] = [{ srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 }];
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          // startSec/endSec are deliberately wild/stale — a src-anchored
          // cut must NEVER be positioned from them.
          cuts: [{ startSec: 99, endSec: 999, src: { startSec: 2, endSec: 4 } }],
          spans,
        }),
      );
    });
    expect(container.querySelector('[data-testid="timeline-cut-99-999"]')).toBeNull();
    const seam = container.querySelector<HTMLElement>('[data-testid="timeline-cut-seam-99-999"]')!;
    expect(seam).not.toBeNull();
    // sourceToOutputClamped(spans, 2) = 2 (inside the one kept span,
    // 0-5, mapped directly) — 2/10 * 100 = 20%, NOT anything derived from
    // 99/999.
    expect(seam.style.left).toBe("20%");
  });

  it("clicking the seam restores the cut directly — the entry (and the seam) disappears", async () => {
    const spans: KeptSpan[] = [{ srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 }];
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          cuts: [{ startSec: 1, endSec: 3, src: { startSec: 1, endSec: 2 } }],
          spans,
        }),
      );
    });
    const seam = container.querySelector<HTMLElement>('[data-testid="timeline-cut-seam-1-3"]')!;
    expect(seam).not.toBeNull();
    act(() => {
      seam.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 5 }));
    });
    expect(container.querySelector('[data-testid="timeline-cut-seam-1-3"]')).toBeNull();
  });

  it("Minor (a): duplicate-window cuts don't collide on their React key", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          cuts: [
            { startSec: 2, endSec: 4 },
            { startSec: 2, endSec: 4 },
          ],
        }),
      );
    });
    const warnedAboutKeys = consoleError.mock.calls.some((args) =>
      String(args[0]).includes("same key"),
    );
    expect(warnedAboutKeys).toBe(false);
    consoleError.mockRestore();
  });
});
