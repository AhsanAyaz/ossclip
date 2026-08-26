// @vitest-environment jsdom
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { PlayerRef } from "@remotion/player";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCaptionLineTiming,
  applyCaptionWordHides,
  captionKeyFor,
  livePreviewMap,
  previewClockMappers,
  TimeMap,
  type CaptionLine,
  type Segment,
} from "@ossclip/core/browser";
import {
  captionDragBounds,
  captionTimingEntries,
  clampCaptionSpan,
  dragCaptionSpan,
  loadSourceAudio,
  menuPlacement,
  postHideLineIndices,
  TranscriptPanel,
} from "../src/TranscriptPanel";
import type { DeleteWordsPlan } from "../src/deleteWords";
import { rebuildCaptionTrack } from "../src/liveCaptionTrack";
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
        // No hides in this harness, so the timed track IS the rendered one —
        // App passes the post-hide lines (`postHideLineIndices`).
        timingLines: lines,
        workdir: null,
        fps: 30,
        playerRef,
        edits,
        onDeleteWords: () => {},
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

/**
 * RTL + search normalization. An Urdu transcript in an LTR-base paragraph had
 * unclickable words: UAX #9 visually reordered each wrapped line's RTL run
 * while DOM order stayed spoken order, so the span under the cursor was not
 * the word the eye targeted. The fix is a first-strong `dir` on the body plus
 * per-word bidi isolation — and it must not disturb the §65 space text nodes,
 * which are the pane's only line-break opportunities.
 */
describe("TranscriptPanel direction and search normalization", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  /** One line of anchored words, 0.3s apart — the shape a repaired file holds. */
  const line = (texts: string[]): CaptionLine => ({
    words: texts.map((text, i) => ({
      text,
      start: i * 0.3,
      end: i * 0.3 + 0.3,
      srcStart: i * 0.3,
    })),
    start: 0,
    end: texts.length * 0.3,
  });

  function Harness({ lines }: { lines: CaptionLine[] }) {
    const edits = useEdits();
    const playerRef = useRef<PlayerRef>(null);
    return React.createElement(TranscriptPanel, {
      baseLines: lines,
      liveLines: lines,
      // No hides here, so the timed (post-hide) track IS the rendered one.
      timingLines: lines,
      workdir: null,
      fps: 30,
      playerRef,
      edits,
      onDeleteWords: () => {},
      width: 300,
    });
  }

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

  it('sets dir="rtl" on the body for an Urdu transcript', async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["سلام", "دنیا"])] }));
    });
    const body = container.querySelector('[data-testid="transcript-body"]')!;
    expect(body.getAttribute("dir")).toBe("rtl");
  });

  it('sets dir="ltr" on the body for an English transcript', async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["hello", "world"])] }));
    });
    const body = container.querySelector('[data-testid="transcript-body"]')!;
    expect(body.getAttribute("dir")).toBe("ltr");
  });

  it("keeps the §65 spaces as BARE text nodes BETWEEN the spans, never inside them", async () => {
    // The §65 guard. The space moved INSIDE the preceding span for one
    // release (2026-08-18 round 3, to paint the selection band across the
    // gap) and is back out: a trailing space at the end of a visual line
    // HANGS and costs no width, but inside a padded inline box the box keeps
    // it — the e2e wrap assertion measured scrollWidth 289 vs clientWidth 285
    // on the fixture, exactly one space (CI run 32195920547). The band is
    // bridged by `selectedStyle`'s box-shadow instead, which paints outside
    // the border box and adds nothing to `scrollWidth`.
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["سلام", "دنیا"])] }));
    });
    const body = container.querySelector('[data-testid="transcript-body"]')!;
    const bareSpaces = Array.from(body.childNodes).filter(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent === " ",
    );
    // One per inter-word gap — real whitespace, not a margin (§65: margins
    // are not line-break opportunities).
    expect(bareSpaces).toHaveLength(1);
    // No span carries whitespace of its own.
    const spans = Array.from(body.querySelectorAll('[data-testid^="transcript-word-"]'));
    expect(spans.map((s) => s.textContent)).toEqual(["سلام", "دنیا"]);
    expect(body.textContent).toBe("سلام دنیا");
  });

  it("matches a composed word from a decomposed query (NFC)", async () => {
    // The word carries composed \u0622 (alef-with-madda); the query spells
    // the SAME glyph decomposed (\u0627 alef + \u0653 madda). Escapes, not
    // literals: the two render identically, and a literal would let any tool
    // that normalizes on save quietly rewrite this test into a tautology.
    // Without NFC on both sides, byte-wise `includes` finds nothing.
    const composedWord = "\u0622\u0645";
    const decomposedQuery = "\u0627\u0653\u0645";
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line([composedWord, "\u062F\u0646\u06CC\u0627"])] }));
    });
    const input = container.querySelector<HTMLInputElement>('[data-testid="transcript-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, decomposedQuery);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="transcript-match-count"]')!.textContent).toBe(
      "1/1 match",
    );
  });
});

/**
 * Multi-word selection + the caption word-hide layer (§59b, revisited
 * 2026-08-18). The selection is a range over LOGICAL word indices; the hide
 * writes `OverrideDoc.captionWordsHidden` (source-time keys, §137) and the
 * word stays in the transcript struck-through — non-destructive, restorable.
 * Keyboard handling is PANEL-scoped (`onKeyDown` on the focusable body, never
 * a window listener): Overlay owns the global Delete for scenes, and a second
 * window listener would fire both gestures from one keypress.
 */
describe("TranscriptPanel selection and caption word hide (§59b revisited)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  /** One line of anchored words, 0.3s apart, srcStart offset so the SOURCE
   * key is visibly distinct from the output start. */
  const line = (texts: string[]): CaptionLine => ({
    words: texts.map((text, i) => ({
      text,
      start: i * 0.3,
      end: i * 0.3 + 0.3,
      srcStart: 10 + i,
    })),
    start: 0,
    end: texts.length * 0.3,
  });

  /** A line whose SECOND word predates source anchors (no `srcStart`). */
  const withAnchorless = (): CaptionLine => ({
    words: [
      { text: "alpha", start: 0, end: 0.3, srcStart: 10 },
      { text: "beta", start: 0.3, end: 0.6 } as CaptionLine["words"][number],
    ],
    start: 0,
    end: 0.6,
  });

  function Harness({
    lines,
    baseLines,
    seekTo,
    onDeleteWords,
    onFrame,
    toPlayerSec,
  }: {
    lines: CaptionLine[];
    /** Pristine pre-edit lines when they differ from the live ones — the
     * base-`was` capture assertions need the two to diverge. */
    baseLines?: CaptionLine[];
    seekTo?: (frame: number) => void;
    /** Spy on the plan the Delete gesture hands App. */
    onDeleteWords?: (plan: DeleteWordsPlan) => void;
    /** Captures the panel's frameupdate listener so a test can DRIVE the
     * playhead — the underline-composition assertions need `currentIndex`
     * set, and only the player event sets it. */
    onFrame?: (fire: (frame: number) => void) => void;
    /** The live-clock mapping App threads under a cleanup veto (step 4
     * follow-up); absent takes the panel's own identity default, exactly
     * like a session with no veto. */
    toPlayerSec?: (sec: number) => number;
  }) {
    const edits = useEdits();
    // A fake player rather than a null ref: the seek-suppression assertion
    // needs `seekTo` observable, and the frameupdate effect needs the
    // listener pair to exist.
    const playerRef = useRef({
      seekTo: seekTo ?? (() => {}),
      addEventListener: (name: string, cb: (e: { detail: { frame: number } }) => void) => {
        if (name === "frameupdate") onFrame?.((frame) => cb({ detail: { frame } }));
      },
      removeEventListener: () => {},
    } as unknown as PlayerRef);
    return React.createElement(
      "div",
      null,
      React.createElement("div", {
        "data-testid": "hidden-doc",
        children: JSON.stringify(edits.doc.captionWordsHidden),
      }),
      React.createElement("div", {
        "data-testid": "range-doc",
        children: JSON.stringify(edits.doc.captionRangeEdits),
      }),
      React.createElement("div", {
        "data-testid": "captions-doc",
        children: JSON.stringify(edits.doc.captions),
      }),
      React.createElement(TranscriptPanel, {
        baseLines: baseLines ?? lines,
        liveLines: lines,
        // No hides in this harness, so the timed track IS the rendered one —
        // App passes the post-hide lines (`postHideLineIndices`).
        timingLines: lines,
        workdir: null,
        fps: 30,
        playerRef,
        edits,
        // App's shape, collapsed for the harness: the spy stands in for the
        // modal opening, and the caption-only arm — the modal's preselected
        // default — is applied immediately so the hide-layer assertions
        // below exercise the same reducer path App's confirm does.
        onDeleteWords: (plan) => {
          onDeleteWords?.(plan);
          edits.hideCaptionWords(plan.words);
        },
        width: 300,
        ...(toPlayerSec ? { toPlayerSec } : {}),
      }),
    );
  }

  const word = (i: number) =>
    container.querySelector<HTMLElement>(`[data-testid="transcript-word-${i}"]`)!;
  const click = async (el: HTMLElement, shiftKey = false) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey }));
    });
  };
  const keydown = async (key: string) => {
    const body = container.querySelector<HTMLElement>('[data-testid="transcript-body"]')!;
    await act(async () => {
      body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  };
  // The selection bar (2026-08-18, round 3: a horizontal row anchored INSIDE
  // the scrollable body) — the item testids carried over from the old header
  // toolbar and vertical menu, so tests re-anchor rather than rewrite.
  const menu = () => container.querySelector('[data-testid="transcript-selection-menu"]');
  /** Both delete scopes live behind the bar's Delete ▾ flyout now. */
  const openDeleteFlyout = async () => {
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-delete-menu"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };
  const hiddenDoc = () =>
    JSON.parse(container.querySelector('[data-testid="hidden-doc"]')!.textContent!);
  const rangeDoc = () =>
    JSON.parse(container.querySelector('[data-testid="range-doc"]')!.textContent!);
  const captionsDoc = () =>
    JSON.parse(container.querySelector('[data-testid="captions-doc"]')!.textContent!);
  const origGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // The Timing test below opens the popover, whose canvas draw effect
    // probes getContext — jsdom logs "not implemented" noise for it without
    // the canvas package. The effect guards a null return, so return null
    // quietly (the timing describe's rule).
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    HTMLCanvasElement.prototype.getContext = origGetContext;
  });

  it("click selects one word and shift-click extends the range — both directions", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c", "d"])] }));
    });
    expect(menu()).toBeNull();
    await click(word(1));
    expect(menu()!.textContent).toContain("1 word");
    await click(word(3), true);
    expect(menu()!.textContent).toContain("3 words");
    // Backwards past the anchor: [0, 1], still contiguous.
    await click(word(0), true);
    expect(menu()!.textContent).toContain("2 words");
  });

  it("a word click seeks THROUGH the live-clock mapping — old + revived past a kept pause (step 4 follow-up)", async () => {
    // The real mapping, end to end: produce proposed a 2s pause at source
    // 5..7 and the last render cut it (oldSpans); the user vetoes it, so the
    // player is on the NEW clock while the panel's word times stay on the
    // old one (the pre-retime `appliedCaptionRanges` stream, App.tsx).
    const proposal: Segment[] = [
      { srcIn: 0, srcOut: 5, kind: "keep" },
      { srcIn: 5, srcOut: 7, kind: "remove", reason: "pause", confidence: 0.9 },
      { srcIn: 7, srcOut: 10, kind: "keep" },
    ];
    const clocks = livePreviewMap(
      proposal,
      { reasons: { pause: false } },
      [],
      new TimeMap(proposal).spans,
    )!;
    expect(clocks).not.toBeNull();
    const m = previewClockMappers(clocks);
    const straddle: CaptionLine = {
      words: [
        { text: "early", start: 3, end: 3.3, srcStart: 3 },
        { text: "late", start: 6, end: 6.3, srcStart: 8 },
      ],
      start: 3,
      end: 6.3,
    };
    const seeks: number[] = [];
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: [straddle],
          seekTo: (f: number) => seeks.push(f),
          toPlayerSec: m.toLive,
        }),
      );
    });
    // "late" sits past the revived pause: old output 6 is source 8, which
    // the new clock plays at 8 — the unmapped seek (ceil(6 × 30) = 180)
    // landed exactly the revived 2s early.
    await click(word(1));
    expect(seeks).toEqual([Math.ceil(8 * 30)]);
    // "early" precedes the pause and does not move.
    await click(word(0));
    expect(seeks).toEqual([Math.ceil(8 * 30), Math.ceil(3 * 30)]);
  });

  it("without the mapping the seek is bit-identical to before — the identity default (step 4 follow-up)", async () => {
    const seeks: number[] = [];
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: [line(["a", "b", "c"])],
          seekTo: (f: number) => seeks.push(f),
        }),
      );
    });
    await click(word(1));
    // The exact pre-change expression: Math.ceil(w.start * fps).
    expect(seeks).toEqual([Math.ceil(0.3 * 30)]);
  });

  it("shift-click never seeks — extending a selection must not yank the playhead", async () => {
    const seeks: number[] = [];
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: [line(["a", "b", "c"])],
          seekTo: (f: number) => seeks.push(f),
        }),
      );
    });
    await click(word(0));
    expect(seeks).toHaveLength(1);
    await click(word(2), true);
    expect(seeks).toHaveLength(1);
  });

  it("Escape clears the selection and closes the menu", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
    });
    await click(word(0));
    expect(menu()).not.toBeNull();
    await keydown("Escape");
    expect(menu()).toBeNull();
  });

  it("Delete hands App a PLAN — SOURCE-keyed words, LIVE text as `was`, prev-end clamp", async () => {
    const plans: DeleteWordsPlan[] = [];
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: [line(["a", "b", "c"])],
          onDeleteWords: (p: DeleteWordsPlan) => plans.push(p),
        }),
      );
    });
    await click(word(1));
    await click(word(2), true);
    await keydown("Delete");
    expect(plans).toHaveLength(1);
    // srcStart 11 and 12, never the output starts (0.3/0.6) or positions.
    expect(plans[0]!.words).toEqual([
      { srcStart: 11, was: "b" },
      { srcStart: 12, was: "c" },
    ]);
    expect(plans[0]!.targets).toEqual(["caption", "caption-video"]);
    // The window: clamped to word 0's output end on the left, word 2's end
    // on the right (the deleteWords.ts smeared-start rationale).
    expect(plans[0]!.startSec).toBeCloseTo(0.3, 6);
    expect(plans[0]!.endSec).toBeCloseTo(0.9, 6);
    // The harness's caption-only confirm applied — same keys, live text.
    expect(hiddenDoc()).toEqual({ w11000: { was: "b" }, w12000: { was: "c" } });
    // The gesture consumed the selection.
    expect(menu()).toBeNull();
  });

  it("keyboard Delete on an ALL-HIDDEN selection RESTORES — never a video-cut-only modal", async () => {
    // The toolbar already swaps Delete… for Restore on an all-hidden
    // selection; the keydown path must mirror it. Before this, the key still
    // opened the modal whose only remaining target was the DESTRUCTIVE video
    // cut — preselected and Enter-armed, so the Delete→Enter reflex
    // escalated a recoverable hide into a video cut. (The plan-null no-modal
    // guard itself is deleteWords.test.ts's ground.)
    const plans: DeleteWordsPlan[] = [];
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: [line(["a", "b"])],
          onDeleteWords: (p: DeleteWordsPlan) => plans.push(p),
        }),
      );
    });
    await click(word(0));
    await keydown("Delete");
    // First Delete: the normal flow — one plan, and the harness hides the word.
    expect(plans).toHaveLength(1);
    expect(hiddenDoc()).toEqual({ w10000: { was: "a" } });
    // Second Delete on the now all-hidden selection: NO plan, NO modal — the
    // key restores, exactly like the toolbar's Restore.
    await click(word(0));
    await keydown("Delete");
    expect(plans).toHaveLength(1);
    expect(hiddenDoc()).toEqual({});
  });

  it("handled keys never bubble to window — Overlay's global Delete/Escape must not double-fire", async () => {
    // Overlay listens for Delete (delete-scene) and Escape (deselect) on
    // WINDOW; the panel's div-scoped handler does not stop the keydown from
    // bubbling there, so before stopPropagation one Delete opened BOTH the
    // word modal and the scene modal. Only HANDLED keys are stopped: an
    // Escape with nothing selected must still reach Overlay's deselect.
    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", spy);
    try {
      await act(async () => {
        root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
      });
      await click(word(0));
      await keydown("Delete"); // handled: selection present
      expect(seen).toEqual([]);
      await click(word(0));
      await keydown("Escape"); // handled: clears the selection
      expect(seen).toEqual([]);
      await keydown("Escape"); // NOT handled: no selection — Overlay's turn
      expect(seen).toEqual(["Escape"]);
    } finally {
      window.removeEventListener("keydown", spy);
    }
  });

  it("a hidden word stays in the transcript, struck through, with the restore hint", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
    });
    await click(word(0));
    // The flyout's Delete + video… item takes the same plan path as the key.
    await openDeleteFlyout();
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-delete"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(hiddenDoc()).toEqual({ w10000: { was: "a" } });
    const w = word(0);
    // The span holds the word and nothing else — the §65 space is a bare
    // text node beside it.
    expect(w.textContent).toBe("a");
    expect(w.style.textDecoration).toBe("line-through");
    expect(w.title).toBe("hidden from captions — select and Restore");
  });

  it("an all-hidden selection offers Restore, which DELETES the keys", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
    });
    await click(word(0));
    await keydown("Delete");
    expect(hiddenDoc()).toEqual({ w10000: { was: "a" } });
    // Re-select the hidden word: the bar swaps the Delete ▾ slot for Restore.
    await click(word(0));
    expect(container.querySelector('[data-testid="transcript-delete-menu"]')).toBeNull();
    expect(container.querySelector('[data-testid="transcript-delete"]')).toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-restore"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(hiddenDoc()).toEqual({});
    expect(word(0).style.textDecoration).toBe("");
  });

  it("disables Delete…, with a reason, when any selected word has no source anchor (§137)", async () => {
    const plans: DeleteWordsPlan[] = [];
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: [withAnchorless()],
          onDeleteWords: (p: DeleteWordsPlan) => plans.push(p),
        }),
      );
    });
    await click(word(0));
    await click(word(1), true);
    await openDeleteFlyout();
    const del = container.querySelector<HTMLButtonElement>('[data-testid="transcript-delete"]')!;
    expect(del.disabled).toBe(true);
    expect(del.title).toContain("no source anchor");
    // The Delete key takes the same refusal — no plan, nothing written.
    await keydown("Delete");
    expect(plans).toEqual([]);
    expect(hiddenDoc()).toEqual({});
  });

  it("Edit on a multi-word selection opens the prefilled range editor; commit writes patchCaptionRange with the endpoints' srcStarts and the joined was", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c"])] }));
    });
    await click(word(0));
    await click(word(2), true);
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="transcript-range-edit"]',
    )!;
    expect(input).not.toBeNull();
    // Prefilled with the NFC-joined live run text — also the stored `was`.
    expect(input.value).toBe("a b c");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, "hello world");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.activeElement).toBe(input);
    // Plain Enter commits. Blur deliberately does NOT any more (2026-08-18):
    // the popover carries Apply/Cancel buttons, and a blur-commit would fire
    // on the way to pressing Cancel.
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    // Keyed by the ENDPOINTS' source starts (srcStart 10 and 12), never by
    // panel indices or output times.
    expect(rangeDoc()).toEqual([
      { fromKey: "w10000", toKey: "w12000", text: "hello world", was: "a b c" },
    ]);
    // The gesture consumed the selection and closed the editor.
    expect(menu()).toBeNull();
    expect(container.querySelector('[data-testid="transcript-range-edit"]')).toBeNull();
  });

  it("the range editor prefills the LIVE run but stores the BASE-joined run as `was`", async () => {
    // The reducer scrubs every per-word retype inside the interval in the
    // same commit, so the run the apply-time whole-run guard reads IS the
    // base run — capturing the live (post-retype) join as `was` made the
    // guard fail on the very next apply and the rewrite dropped permanently.
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: [line(["hello", "b", "c"])],
          // The same anchors, pre-retype text: "hello" was typed over "helo".
          baseLines: [line(["helo", "b", "c"])],
        }),
      );
    });
    await click(word(0));
    await click(word(2), true);
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="transcript-range-edit"]',
    )!;
    // The DRAFT is what the user sees — the live run, retype included.
    expect(input.value).toBe("hello b c");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, "x y");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Commit via the Apply BUTTON this time — the popover's other commit
    // path (its sibling test above commits with Enter).
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-apply"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    // The stored guard is the BASE join.
    expect(rangeDoc()).toEqual([
      { fromKey: "w10000", toKey: "w12000", text: "x y", was: "helo b c" },
    ]);
  });

  /** Type into the open range editor and press Enter to commit (blur no
   * longer commits — the popover has explicit Apply/Cancel buttons). */
  const commitRangeDraft = async (value: string) => {
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="transcript-range-edit"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
  };

  it("Edit on a SINGLE word opens the range editor — a multi-token draft SPLITS the word", async () => {
    // The field case (2026-08-18): whisper merges a terminal ۔ and the next
    // token into one word; splitting it is a one-word range edit.
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "merged.b"])] }));
    });
    await click(word(1));
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="transcript-range-edit"]',
    )!;
    expect(input.value).toBe("merged.b");
    await commitRangeDraft("merged. b");
    // fromKey === toKey — the core's single-word run.
    expect(rangeDoc()).toEqual([
      { fromKey: "w11000", toKey: "w11000", text: "merged. b", was: "merged.b" },
    ]);
    expect(captionsDoc()).toEqual({});
  });

  it("Edit on a single word committing ONE token stays a 1:1 retype — no range entry minted", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "helo"])] }));
    });
    await click(word(1));
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await commitRangeDraft("hello");
    expect(rangeDoc()).toEqual([]);
    expect(captionsDoc()).toEqual({ w11000: { text: "hello", was: "helo" } });
  });

  /**
   * The two caption layers guard differently, and the one-token Edit route
   * writes to the STRICTER one (2026-08-19 review). `applyCaptionRangeEdits`
   * normalizes both sides of its whole-run comparison; `applyCaptionEdits`
   * compares raw (`w.text !== edit.was`). Storing the NFC join on the
   * per-word route therefore minted an entry that can never match a
   * decomposed word — it reverts on the next apply and the "could not be
   * placed" banner fires, on the exact text this file normalizes its search
   * box for.
   */
  it("a one-token Edit on a DECOMPOSED word stores the word's RAW text as `was`", async () => {
    // One glyph, two encodings: composed آ (U+0622) vs alef + madda
    // (U+0627 U+0653). Escapes, never literals — a literal lets any tool
    // that normalizes on save rewrite this test into a tautology.
    const decomposed = "\u0627\u0653\u0645";
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", decomposed])] }));
    });
    await click(word(1));
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await commitRangeDraft("x");
    expect(rangeDoc()).toEqual([]);
    // VERBATIM the caption word's own bytes — what core will compare against.
    expect(captionsDoc()).toEqual({ w11000: { text: "x", was: decomposed } });
    expect(captionsDoc().w11000.was).not.toBe(decomposed.normalize("NFC"));
  });

  it("Apply to all on a decomposed word stores the RAW base for EVERY occurrence", async () => {
    // The bulk route lands in `patchCaptionAllOccurrences` — the same
    // per-word layer, so the same raw-`was` rule, for the selection's own
    // entry AND for each occurrence the sweep found.
    const decomposed = "\u0627\u0653\u0645";
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", decomposed, "b", decomposed])] }));
    });
    await click(word(1));
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const draft = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="transcript-range-edit"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
        draft,
        "x",
      );
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-apply-all"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(rangeDoc()).toEqual([]);
    expect(captionsDoc()).toEqual({
      w11000: { text: "x", was: decomposed },
      w13000: { text: "x", was: decomposed },
    });
  });

  /**
   * The bar and the retype box share one anchor, and the bar is NOT a
   * backdrop-covered menu: left on screen over an open input, its Delete
   * item blurred the box — committing the retype through `onBlur` — and
   * opened the delete confirm in the same click (2026-08-19 review).
   */
  it("the selection bar is GONE while the retype box is open", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["alpha", "beta"])] }));
    });
    await click(word(1));
    expect(menu()).not.toBeNull();
    await act(async () => {
      word(1).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="transcript-edit"]')).not.toBeNull();
    expect(menu()).toBeNull();
    // Escape closes the box; the selection — and with it the bar — survives.
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(menu()).not.toBeNull();
  });

  it("click seeks with CEIL — the quantized playhead may not land in the PREVIOUS word", async () => {
    const seeks: number[] = [];
    // 50ms words (the degenerate-ASR repair shape): word 1 starts at 0.05s,
    // 0.05 * 30fps = 1.5 — round() would seek frame 1 (t = 0.033s, inside
    // word 0) and box the neighbour; ceil() seeks frame 2 (t = 0.067s).
    const cramped: CaptionLine = {
      words: [
        { text: "a", start: 0, end: 0.05, srcStart: 10 },
        { text: "b", start: 0.05, end: 0.1, srcStart: 10.05 },
      ],
      start: 0,
      end: 0.1,
    };
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: [cramped],
          seekTo: (f: number) => seeks.push(f),
        }),
      );
    });
    await click(word(1));
    expect(seeks).toEqual([2]);
  });

  it("disables Edit, with a reason, when any selected word has no source anchor (§137)", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [withAnchorless()] }));
    });
    await click(word(0));
    await click(word(1), true);
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="transcript-edit-range"]',
    )!;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain("no source anchor");
  });

  it("clears the selection when the word COUNT changes — the positional-index caveat", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c"])] }));
    });
    await click(word(2));
    expect(menu()).not.toBeNull();
    // A completed render swapping in lines with a different word count is
    // exactly the swap the `editing.index` caveat documents; a kept range
    // would highlight (or Delete) different words than the user selected.
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
    });
    expect(menu()).toBeNull();
  });

  it("Delete captions hides DIRECTLY — live text as `was`, no plan, no modal", async () => {
    // The menu names the caption-only scope on the item itself (2026-08-18),
    // so the modal's caption/video decision is reserved for the Delete +
    // video… item — this one writes the hide layer straight away.
    const plans: DeleteWordsPlan[] = [];
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: [line(["hello", "b"])],
          // Diverged base: the hide layer applies AFTER retypes, so `was`
          // must be the LIVE text, never the base.
          baseLines: [line(["helo", "b"])],
          onDeleteWords: (p: DeleteWordsPlan) => plans.push(p),
        }),
      );
    });
    await click(word(0));
    await openDeleteFlyout();
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-hide"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(plans).toEqual([]);
    expect(hiddenDoc()).toEqual({ w10000: { was: "hello" } });
    // The gesture consumed the selection.
    expect(menu()).toBeNull();
  });

  it("disables Delete captions, with the §137 reason, on an anchorless selection", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [withAnchorless()] }));
    });
    await click(word(0));
    await click(word(1), true);
    await openDeleteFlyout();
    const hide = container.querySelector<HTMLButtonElement>('[data-testid="transcript-hide"]')!;
    expect(hide.disabled).toBe(true);
    expect(hide.title).toContain("no source anchor");
  });

  it("the bar is anchored INSIDE the body (absolute) and SURVIVES a scroll — no close listener", async () => {
    // Round 3 field bug: the old fixed-position menu closed on the body's
    // scroll event — which the playhead-follow `scrollIntoView` itself
    // fires whenever the followed word left the pane, so the menu could be
    // destroyed within a frame of appearing. Anchoring the bar in CONTENT
    // coordinates (absolute inside the relative body) makes it scroll with
    // its anchor, so no scroll/resize close listener exists at all.
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
    });
    await click(word(0));
    const bar = menu()! as HTMLElement;
    const body = container.querySelector<HTMLElement>('[data-testid="transcript-body"]')!;
    expect(body.contains(bar)).toBe(true);
    expect(bar.style.position).toBe("absolute");
    await act(async () => {
      body.dispatchEvent(new Event("scroll"));
    });
    expect(menu()).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(menu()).not.toBeNull();
  });

  it("the bar is a horizontal row: Edit · Timing · Delete ▾ · count", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
    });
    await click(word(0));
    const bar = menu()!;
    expect(bar.querySelector('[data-testid="transcript-edit-range"]')).not.toBeNull();
    expect(bar.querySelector('[data-testid="transcript-timing"]')).not.toBeNull();
    expect(bar.querySelector('[data-testid="transcript-delete-menu"]')).not.toBeNull();
    expect(bar.textContent).toContain("1 word");
    // The delete scopes live behind the flyout, closed until asked for.
    expect(bar.querySelector('[data-testid="transcript-hide"]')).toBeNull();
    expect(bar.querySelector('[data-testid="transcript-delete"]')).toBeNull();
  });

  it("Delete ▾ opens the two-row flyout, which closes on selection change", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
    });
    await click(word(0));
    await openDeleteFlyout();
    // Both scopes on offer — the routing itself is each item's own test
    // ("Delete captions hides DIRECTLY…" / "a hidden word stays…").
    expect(container.querySelector('[data-testid="transcript-hide"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="transcript-delete"]')).not.toBeNull();
    // A flyout that outlived the selection would offer its rows for words
    // the user is no longer looking at.
    await click(word(1));
    expect(menu()).not.toBeNull();
    expect(container.querySelector('[data-testid="transcript-hide"]')).toBeNull();
  });

  // The button is offered for ANY selection, and its title names the CAPTIONS
  // the gesture will move — the selection snaps to whole lines, so a two-word
  // selection inside one caption is still one caption (`captionLineTiming`:
  // a caption's on-screen life is its LINE's window).
  it("Timing is offered on a multi-word selection, titled with the CAPTION count", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
    });
    await click(word(0));
    await click(word(1), true);
    const timing = container.querySelector<HTMLButtonElement>('[data-testid="transcript-timing"]')!;
    expect(timing.disabled).toBe(false);
    expect(timing.title).toBe("Adjust when this caption appears and leaves");
    await click(word(0));
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="transcript-timing"]')!.title,
    ).toBe("Adjust when this caption appears and leaves");
    const single = container.querySelector<HTMLButtonElement>(
      '[data-testid="transcript-timing"]',
    )!;
    expect(single.disabled).toBe(false);
    await act(async () => {
      single.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    // The popover REPLACES the bar at the same anchor (the range editor's
    // swap idiom). Its own behaviors are the timing describe's ground.
    expect(container.querySelector('[data-testid="transcript-timing-popover"]')).not.toBeNull();
    expect(menu()).toBeNull();
  });

  it("Timing is disabled with the §137 reason on an anchorless single word", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [withAnchorless()] }));
    });
    await click(word(1));
    const timing = container.querySelector<HTMLButtonElement>('[data-testid="transcript-timing"]')!;
    expect(timing.disabled).toBe(true);
    expect(timing.title).toContain("no source anchor");
  });

  it("clicking another word while the range editor is open CLOSES it — nothing committed", async () => {
    // The round-3 field bug: the popover is anchored to the selection, so a
    // moved selection re-rendered it at the NEW words while it still held
    // its stale capture — Apply then rewrote the PREVIOUS run while
    // visually pointing at the new one. The click must unmount the editor
    // and show the bar for the new selection instead.
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c"])] }));
    });
    await click(word(0));
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="transcript-range-edit"]')).not.toBeNull();
    await click(word(1));
    expect(container.querySelector('[data-testid="transcript-range-edit"]')).toBeNull();
    expect(menu()!.textContent).toContain("1 word");
    expect(rangeDoc()).toEqual([]);
    // Shift-extending is a selection move too — same close.
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await click(word(2), true);
    expect(container.querySelector('[data-testid="transcript-range-edit"]')).toBeNull();
    expect(menu()!.textContent).toContain("2 words");
    expect(rangeDoc()).toEqual([]);
  });

  it("selection paints ONE continuous yellow band — every span filled, no outline", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c"])] }));
    });
    await click(word(0));
    await click(word(1), true);
    for (const i of [0, 1]) {
      // The band color on the span itself.
      expect(word(i).style.background.toLowerCase()).toMatch(/ffe14d|255,\s*225,\s*77/);
      expect(word(i).style.outline).toBe("");
      // The gap between two selected words is a BARE space node (§65), so
      // the band is bridged by a box-shadow — 4px each side, the `word`
      // style's own horizontal padding, so each span's bridge meets its
      // neighbour's. Guarded here because the shadow is the ONLY thing
      // keeping the band continuous: without it the selection re-stripes
      // per word, silently. It paints outside the border box, so unlike the
      // trailing-space-inside-the-span version it costs no layout width
      // (the §65 wrap guard, CI run 32195920547).
      const shadow = word(i).style.boxShadow.toLowerCase();
      expect(shadow).toMatch(/-4px 0(px)? 0(px)? 0(px)? (#ffe14d|rgb\(255,\s*225,\s*77\))/);
      expect(shadow).toMatch(/(^|,\s*)4px 0(px)? 0(px)? 0(px)? (#ffe14d|rgb\(255,\s*225,\s*77\))/);
    }
    expect(word(2).style.background).toBe("");
    // No stray bridge on an UNSELECTED word — it would paint yellow into the
    // gap beside a word that is not in the band.
    expect(word(2).style.boxShadow).toBe("");
  });

  it("the playhead word is UNDERLINED — and composes with the selection band", async () => {
    let fire: ((frame: number) => void) | null = null;
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: [line(["a", "b", "c"])],
          onFrame: (f: (frame: number) => void) => {
            fire = f;
          },
        }),
      );
    });
    // Frame 10 at 30fps → t ≈ 0.33s, inside word 1's [0.3, 0.6) window.
    await act(async () => {
      fire!(10);
    });
    expect(word(1).style.textDecoration).toBe("underline");
    expect(word(1).style.background).toBe("");
    // Layered ON the band: the underline survives (presence only — jsdom
    // computes no layout), and the band's fill is untouched by it.
    await click(word(0));
    await click(word(2), true);
    expect(word(1).style.textDecoration).toBe("underline");
    expect(word(1).style.background.toLowerCase()).toMatch(/ffe14d|255,\s*225,\s*77/);
  });

  it("Apply to all (n) on a single word retypes EVERY occurrence, each guarded by its own base", async () => {
    // Two other "hello"s besides the selection; base text diverges so the
    // stored `was` must be each occurrence's BASE, never the live join.
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: [line(["hello", "x", "hello", "hello"])],
          baseLines: [line(["helo", "x", "helo", "helo"])],
        }),
      );
    });
    await click(word(0));
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const all = container.querySelector<HTMLElement>('[data-testid="transcript-apply-all"]')!;
    // n counts the OTHER occurrences — the selection itself is not one.
    expect(all.textContent).toBe("Apply to all (2)");
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="transcript-range-edit"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "world",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      all.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    // A single token on single words routes through patchCaption semantics —
    // per-word entries, no range entries minted.
    expect(captionsDoc()).toEqual({
      w10000: { text: "world", was: "helo" },
      w12000: { text: "world", was: "helo" },
      w13000: { text: "world", was: "helo" },
    });
    expect(rangeDoc()).toEqual([]);
    expect(menu()).toBeNull();
    expect(container.querySelector('[data-testid="transcript-range-edit"]')).toBeNull();
  });

  it("Apply to all on a multi-word run writes a range entry per occurrence, selection included", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "x", "a", "b"])] }));
    });
    await click(word(0));
    await click(word(1), true);
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const all = container.querySelector<HTMLElement>('[data-testid="transcript-apply-all"]')!;
    expect(all.textContent).toBe("Apply to all (1)");
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="transcript-range-edit"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "q r",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      all.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(rangeDoc()).toEqual([
      { fromKey: "w10000", toKey: "w11000", text: "q r", was: "a b" },
      { fromKey: "w13000", toKey: "w14000", text: "q r", was: "a b" },
    ]);
  });

  it("no Apply to all button when the text occurs nowhere else", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c"])] }));
    });
    await click(word(0));
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="transcript-apply"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="transcript-apply-all"]')).toBeNull();
  });
});

/**
 * The one-line hint + collapsed help (2026-08-18): the old always-on scope
 * paragraph cost four lines of pane height; the contract now lives behind a
 * `?` toggle, collapsed by default.
 */
describe("TranscriptPanel hint and help toggle", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const line = (texts: string[]): CaptionLine => ({
    words: texts.map((text, i) => ({
      text,
      start: i * 0.3,
      end: i * 0.3 + 0.3,
      srcStart: 10 + i,
    })),
    start: 0,
    end: texts.length * 0.3,
  });

  function Harness() {
    const edits = useEdits();
    const playerRef = useRef<PlayerRef>(null);
    return React.createElement(TranscriptPanel, {
      baseLines: [line(["a", "b"])],
      liveLines: [line(["a", "b"])],
      timingLines: [line(["a", "b"])],
      workdir: null,
      fps: 30,
      playerRef,
      edits,
      onDeleteWords: () => {},
      width: 300,
    });
  }

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

  it("shows the one-line hint; the full help is collapsed until ? toggles it", async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    expect(container.textContent).toContain(
      "Click to jump · double-click to retype · drag to select",
    );
    expect(container.querySelector('[data-testid="transcript-help"]')).toBeNull();
    const toggle = container.querySelector<HTMLElement>(
      '[data-testid="transcript-help-toggle"]',
    )!;
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const help = container.querySelector('[data-testid="transcript-help"]')!;
    // The tightened paragraph keeps the two load-bearing distinctions: the
    // caption-only vs video delete, and the split-a-merged-word tip.
    expect(help.textContent).toContain("captions only");
    expect(help.textContent).toContain("from the video too");
    expect(help.textContent).toContain("split a merged one");
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="transcript-help"]')).toBeNull();
  });
});

/**
 * Base lookup by ANCHOR, not position (2026-08-18). Range edits change word
 * COUNT, so positional base/live pairing (`base.words[wi]`) misaligns every
 * word after a rewritten run — mis-titling neighbours the user never touched.
 * A live word with no base match at its anchor was MINTED by a rewrite and is
 * styled as edited, its title naming the range's `was`.
 */
describe("TranscriptPanel base lookup by anchor (range edits)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const lineOf = (ws: Array<[string, number]>): CaptionLine => ({
    words: ws.map(([text, srcStart], i) => ({
      text,
      start: i * 0.3,
      end: i * 0.3 + 0.3,
      srcStart,
    })),
    start: 0,
    end: ws.length * 0.3,
  });

  function Harness({
    baseLines,
    liveLines,
    seedRange,
  }: {
    baseLines: CaptionLine[];
    liveLines: CaptionLine[];
    /** A stored range edit, so a minted word's title can name its `was`. */
    seedRange?: { from: number; to: number; text: string; was: string };
  }) {
    const edits = useEdits();
    const playerRef = useRef({
      seekTo: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as PlayerRef);
    const seeded = useRef(false);
    React.useEffect(() => {
      if (!seedRange || seeded.current) return;
      seeded.current = true;
      edits.patchCaptionRange(seedRange.from, seedRange.to, seedRange.text, seedRange.was);
    });
    return React.createElement(TranscriptPanel, {
      baseLines,
      liveLines,
      // No hides in this harness: the timed track is the rendered one.
      timingLines: liveLines,
      workdir: null,
      fps: 30,
      playerRef,
      edits,
      onDeleteWords: () => {},
      width: 300,
    });
  }

  const word = (i: number) =>
    container.querySelector<HTMLElement>(`[data-testid="transcript-word-${i}"]`)!;

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

  it("a NEIGHBOUR after a shrunk run keeps its OWN base — positional pairing would blame it", async () => {
    // Base "a b c d"; a rewrite collapsed "b c" into one word "X" (which
    // carries the run's fromSrc verbatim — the endpoint-preservation rule).
    // Positionally, live index 2 ("d") would pair with base "c" and show as
    // edited; by anchor it pairs with its own base "d" and stays neutral.
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          baseLines: [lineOf([["a", 10], ["b", 11], ["c", 12], ["d", 13]])],
          liveLines: [lineOf([["a", 10], ["X", 11], ["d", 13]])],
        }),
      );
    });
    expect(word(1).title).toContain("was “b”");
    expect(word(2).title).toBe("click to jump · double-click to retype");
    expect(word(2).title).not.toContain("was “c”");
  });

  it("a MINTED word (no base word at its anchor) is edited-styled, titled with the range's was", async () => {
    // "b c" (11..12) rewritten to three tokens: the middle one's srcStart is
    // interpolated (11.5) and matches no base word.
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          baseLines: [lineOf([["a", 10], ["b", 11], ["c", 12], ["d", 13]])],
          liveLines: [lineOf([["a", 10], ["t1", 11], ["t2", 11.5], ["t3", 12], ["d", 13]])],
          seedRange: { from: 11, to: 12, text: "t1 t2 t3", was: "b c" },
        }),
      );
    });
    const minted = word(2);
    // Covered by the LIVE entry, so the title routes to the range editor —
    // the 1:1 retype is refused on it (`openRetype`'s coverage refusal).
    expect(minted.title).toBe("part of a rewritten range (was “b c”) — select it and use Edit");
    // Same edited color as a retyped word — the base-map miss is the flag.
    expect(minted.style.color).toBe(word(1).style.color);
    expect(word(4).title).toBe("click to jump · double-click to retype");
  });

  it("duplicate-anchor base words pair by ORDINAL — the second claimant keeps its OWN base", async () => {
    // `backfillSrcStart` MANUFACTURES shared source instants
    // (captions.ts:44-50 — a seam's two preimages, a word clamped to a kept
    // edge), so two DIFFERENT words can carry one anchor. First-claimant
    // pairing handed the second word the first's base text ("foo"), styling
    // it falsely edited and capturing the wrong `was`.
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          baseLines: [lineOf([["foo", 5], ["bar", 5]])],
          liveLines: [lineOf([["foo", 5], ["bar", 5]])],
        }),
      );
    });
    expect(word(0).title).toBe("click to jump · double-click to retype");
    // The second claimant pairs with ITS base ("bar"), not its neighbour's.
    expect(word(1).title).toBe("click to jump · double-click to retype");
  });
});

/**
 * Gestures over an ALREADY-REWRITTEN run (2026-08-18 review fixes). A live
 * `captionRangeEdits` entry owns every word inside its interval: the 1:1
 * retype is refused on them (either it stales the whole entry or it keys to
 * a minted anchor no apply pass ever finds), a partial selection's Edit
 * expands to the entry's full run and commits under the entry's OWN pair
 * (minted anchors exist only while their entry does — re-keying a partial
 * overlap loses BOTH rewrites), and Delete never offers the video cut
 * through a minted word (its stamps are interpolations, not measurements).
 */
describe("TranscriptPanel re-editing a rewritten run", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const lineOf = (ws: Array<[string, number]>): CaptionLine => ({
    words: ws.map(([text, srcStart], i) => ({
      text,
      start: i * 0.3,
      end: i * 0.3 + 0.3,
      srcStart,
    })),
    start: 0,
    end: ws.length * 0.3,
  });

  // Base "a b c d"; "b c" (11..12) rewritten to "t1 t2 t3" — endpoints keep
  // verbatim anchors, t2's srcStart is interpolated (11.5): synthetic.
  const baseLines = [lineOf([["a", 10], ["b", 11], ["c", 12], ["d", 13]])];
  const liveLines = [lineOf([["a", 10], ["t1", 11], ["t2", 11.5], ["t3", 12], ["d", 13]])];

  function Harness({ onDeleteWords }: { onDeleteWords?: (plan: DeleteWordsPlan) => void }) {
    const edits = useEdits();
    const playerRef = useRef({
      seekTo: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as PlayerRef);
    const seeded = useRef(false);
    React.useEffect(() => {
      if (seeded.current) return;
      seeded.current = true;
      edits.patchCaptionRange(11, 12, "t1 t2 t3", "b c");
    });
    return React.createElement(
      "div",
      null,
      React.createElement("div", {
        "data-testid": "range-doc",
        children: JSON.stringify(edits.doc.captionRangeEdits),
      }),
      React.createElement(TranscriptPanel, {
        baseLines,
        liveLines,
        // No hides here: the timed (post-hide) track is the rendered one.
        timingLines: liveLines,
        workdir: null,
        fps: 30,
        playerRef,
        edits,
        onDeleteWords: onDeleteWords ?? (() => {}),
        width: 300,
      }),
    );
  }

  const word = (i: number) =>
    container.querySelector<HTMLElement>(`[data-testid="transcript-word-${i}"]`)!;
  const click = async (el: HTMLElement, shiftKey = false) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey }));
    });
  };
  const rangeDoc = () =>
    JSON.parse(container.querySelector('[data-testid="range-doc"]')!.textContent!);

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

  it("refuses the 1:1 retype on a word covered by a live rewrite — even a verbatim endpoint", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, {}));
    });
    // t1 keeps a VERBATIM base anchor (w11000), so the anchor guard alone
    // would let it through — the coverage refusal is what stops it: an
    // equal-count retype would stale the whole entry's `was` guard, and a
    // retype on minted t2 would key to an anchor no apply pass ever finds.
    await act(async () => {
      word(1).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="transcript-edit"]')).toBeNull();
    await act(async () => {
      word(2).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="transcript-edit"]')).toBeNull();
    // An uncovered neighbour still opens — the refusal is scoped to the run.
    await act(async () => {
      word(4).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="transcript-edit"]')).not.toBeNull();
  });

  it("Edit on a PARTIAL selection expands to the entry's run and commits under the ORIGINAL pair", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, {}));
    });
    // Select ONLY the minted middle word.
    await click(word(2));
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    // The selection expanded to the entry's whole run: the editor prefills
    // the FULL run's current text, not the one selected word. (The menu
    // itself is gone while the popover is open — the popover replaces it at
    // the same anchor — so the prefill is the observable expansion.)
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="transcript-range-edit"]',
    )!;
    expect(input.value).toBe("t1 t2 t3");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, "q r");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    // ONE entry, keyed to the ORIGINAL pair, `was` inherited from the
    // original base run (`captionRangeEditWas`) — never a second entry keyed
    // to minted anchors that would resolve `found: null` forever.
    expect(rangeDoc()).toEqual([
      { fromKey: "w11000", toKey: "w12000", text: "q r", was: "b c" },
    ]);
  });

  it("Delete on a selection containing a MINTED word withholds the video cut", async () => {
    const plans: DeleteWordsPlan[] = [];
    await act(async () => {
      root.render(
        React.createElement(Harness, { onDeleteWords: (p: DeleteWordsPlan) => plans.push(p) }),
      );
    });
    await click(word(1));
    await click(word(3), true);
    // The delete scopes live behind the bar's Delete ▾ flyout (round 3).
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-delete-menu"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-delete"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(plans).toHaveLength(1);
    // t2's stamps are interpolations — caption-only is all that is offered.
    expect(plans[0]!.targets).toEqual(["caption"]);
  });
});

/**
 * The timing popover — the "when does this caption appear, and when does it
 * leave" adjuster, CAPTION-shaped since the `captionLineTiming` rewrite.
 *
 * IT IS TESTED AGAINST A PACKED FIXTURE, and that is the point. The previous
 * suite's fixture gave its words 0.2s of slack between them and parked the
 * next word 0.8s away, "so an unclamped nudge has room to land" — on a real
 * transcript there is no such room (116/116 inter-line gaps and 184/184
 * intra-line word boundaries measured exactly 0.0; `captionLineTiming`'s
 * docstring has the numbers). Against the packed stream the old per-word
 * clamp collapsed to each word's own `[start, end]`: every drag was clamped
 * to identity and Apply stored nothing — the field bug, invisible because the
 * fixture had slack the product does not. `describe("the fixture itself")`
 * below pins the packing so this can never quietly come back.
 *
 * jsdom ground rules, unchanged: no AudioContext (the waveform loader must
 * resolve null, never throw) and no 2d canvas context (the draw effect must
 * bail) — the popover still opens, drags and applies.
 */
describe("TranscriptPanel timing popover", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const origGetContext = HTMLCanvasElement.prototype.getContext;

  /**
   * Three captions, GAP-FREE: every word chains onto the next, every line
   * ends exactly where the next begins, and each line's window is its own
   * words' extent. `srcStart` is the output start + 10 — a distinct key space
   * (§137), so a test that confused source and output time fails instead of
   * passing by coincidence, and an identity-plus-offset source map, which is
   * what a workdir with no cut inside the window has.
   */
  const packed = (): CaptionLine[] => [
    {
      start: 0,
      end: 1.2,
      words: [
        { text: "one", start: 0, end: 0.6, srcStart: 10 },
        { text: "two", start: 0.6, end: 1.2, srcStart: 10.6 },
      ],
    },
    {
      start: 1.2,
      end: 2.4,
      words: [
        { text: "three", start: 1.2, end: 1.8, srcStart: 11.2 },
        { text: "four", start: 1.8, end: 2.4, srcStart: 11.8 },
      ],
    },
    {
      start: 2.4,
      end: 3.6,
      words: [
        { text: "five", start: 2.4, end: 3, srcStart: 12.4 },
        { text: "six", start: 3, end: 3.6, srcStart: 13 },
      ],
    },
  ];

  /** The three lines' keys — each caption is addressed by its FIRST word's
   * source anchor (`applyCaptionLineTiming`). */
  const LINE_A = "w10000";
  const LINE_B = "w11200";
  const LINE_C = "w12400";

  function Harness({
    lines,
    seeds,
    seekTo,
    onPlay,
    onPause,
    onFrame,
    onPauseEvent,
  }: {
    lines: CaptionLine[];
    /** Pre-stored LINE timing entries — the marker test needs the doc primed
     * (the seedRange idiom above). */
    seeds?: Array<{ srcStart: number; lead: number; tail: number }>;
    seekTo?: (frame: number) => void;
    onPlay?: () => void;
    onPause?: () => void;
    /** Hands the test a fire(frame) that drives EVERY registered frameupdate
     * listener — the panel's playhead follow and the popover's span-end
     * watcher both subscribe, and a real player fires both. */
    onFrame?: (fire: (frame: number) => void) => void;
    /** Hands the test a fire() for the player's own `pause` EVENT — what the
     * global Space transport produces without going through the popover's
     * button (App.tsx:444 mirrors the same two events). */
    onPauseEvent?: (fire: () => void) => void;
  }) {
    const edits = useEdits();
    const frameCbs = useRef(new Set<(e: { detail: { frame: number } }) => void>());
    const pauseCbs = useRef(new Set<() => void>());
    const playerRef = useRef({
      seekTo: seekTo ?? (() => {}),
      play: onPlay ?? (() => {}),
      pause: onPause ?? (() => {}),
      addEventListener: (name: string, cb: (e: { detail: { frame: number } }) => void) => {
        if (name === "frameupdate") frameCbs.current.add(cb);
        if (name === "pause") pauseCbs.current.add(cb as unknown as () => void);
      },
      removeEventListener: (name: string, cb: (e: { detail: { frame: number } }) => void) => {
        if (name === "frameupdate") frameCbs.current.delete(cb);
        if (name === "pause") pauseCbs.current.delete(cb as unknown as () => void);
      },
    } as unknown as PlayerRef);
    React.useEffect(() => {
      // Copy before iterating: a callback pausing mid-fire unsubscribes the
      // watcher, and mutating the Set while walking it skips listeners.
      onFrame?.((frame) => {
        for (const cb of [...frameCbs.current]) cb({ detail: { frame } });
      });
      onPauseEvent?.(() => {
        for (const cb of [...pauseCbs.current]) cb();
      });
    });
    const seeded = useRef(false);
    React.useEffect(() => {
      if (!seeds || seeded.current) return;
      seeded.current = true;
      edits.patchCaptionLineTiming(seeds);
    });
    // App's own layer order, collapsed to the two layers this suite
    // exercises: the panel RENDERS the pre-hide lines (a hidden word stays on
    // screen, struck through) while `applyCaptionLineTiming` runs on the
    // POST-hide ones, which is the whole reason `timingLines` is a separate
    // prop.
    const timingLines = applyCaptionWordHides(lines, edits.doc.captionWordsHidden).lines;
    return React.createElement(
      "div",
      null,
      // The doc probe: what the reducer actually stored, without reaching
      // into the hook.
      React.createElement("div", {
        "data-testid": "timing-doc",
        children: JSON.stringify(edits.doc.captionLineTiming),
      }),
      // What the RENDER will actually show: core's own apply pass over the
      // timed track. A stored entry that addresses no post-hide line leaves
      // this identical to the input, which is the "it looks stored but the
      // caption never moves" failure in its observable form.
      React.createElement("div", {
        "data-testid": "timed-lines",
        children: JSON.stringify(
          applyCaptionLineTiming(timingLines, edits.doc.captionLineTiming).lines.map((l) => [
            Number(l.start.toFixed(4)),
            Number(l.end.toFixed(4)),
          ]),
        ),
      }),
      // A caption drag's promise is ONE undo step for the whole gesture —
      // both sides of the seam included — which only the hook's own undo can
      // prove.
      React.createElement("button", {
        "data-testid": "timing-undo",
        onClick: () => edits.undo(),
      }),
      React.createElement(TranscriptPanel, {
        baseLines: lines,
        // The panel is fed the PRE-timing stream (App.tsx passes the
        // post-range, pre-hide lines) — the derived windows the deltas are
        // measured against.
        liveLines: lines,
        timingLines,
        workdir: null,
        fps: 30,
        playerRef,
        edits,
        onDeleteWords: () => {},
        width: 300,
      }),
    );
  }

  const word = (i: number) =>
    container.querySelector<HTMLElement>(`[data-testid="transcript-word-${i}"]`)!;
  const click = async (el: HTMLElement, shiftKey = false) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey }));
    });
  };
  const clickTestid = async (testid: string) => {
    await click(container.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!);
  };
  const popover = () => container.querySelector('[data-testid="transcript-timing-popover"]');
  const menu = () => container.querySelector('[data-testid="transcript-selection-menu"]');
  const timingDoc = () =>
    JSON.parse(container.querySelector('[data-testid="timing-doc"]')!.textContent!);
  /** The timed track core would render — `[start, end]` per post-hide line. */
  const timedLines = (): Array<[number, number]> =>
    JSON.parse(container.querySelector('[data-testid="timed-lines"]')!.textContent!);
  /** Open the popover over word `i` — select it, then hit Timing. */
  const openOn = async (i: number) => {
    await click(word(i));
    await clickTestid("transcript-timing");
  };
  /** The same, over the word run `from…to` — shift-click extends. */
  const openRun = async (from: number, to: number) => {
    await click(word(from));
    await click(word(to), true);
    await clickTestid("transcript-timing");
  };
  const spanText = () =>
    container.querySelector('[data-testid="transcript-timing-span"]')!.textContent;
  /** Drag a handle by dispatching pointer-typed MouseEvents (jsdom has no
   * PointerEvent constructor; React dispatches on the TYPE, and the handler
   * only reads clientX). The move and the release go to WINDOW, where a real
   * drag's events land the moment the pointer leaves the 12px zone. */
  const dragHandle = async (testid: string, fromX: number, toX: number) => {
    const h = container.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!;
    await act(async () => {
      h.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: fromX }),
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: toX }),
      );
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    });
  };
  /**
   * The px→seconds factor the panel derives for a one-caption group in the
   * middle of `packed`: the strip's window is the group PLUS the neighbours'
   * territory (line A's srcStart 10 → line C's source end 13.6) plus the two
   * 1s pads, over a 280px canvas — 5.6s / 280px = exactly 0.02 s/px.
   */
  const SEC_PER_PX = 0.02;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // jsdom's getContext logs "not implemented" noise without the canvas
    // package; the draw effect guards a null return, so return null quietly.
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    HTMLCanvasElement.prototype.getContext = origGetContext;
  });

  describe("the fixture itself", () => {
    // The suite's own foundation, asserted rather than assumed: the previous
    // fixture's accidental slack is exactly what let an inert feature pass
    // its tests for two rounds.
    it("is a GAP-FREE PARTITION — no inter-line gaps, no intra-line gaps, edges on the words", () => {
      const lines = packed();
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i]!.start - lines[i - 1]!.end).toBe(0);
      }
      for (const line of lines) {
        for (let w = 1; w < line.words.length; w++) {
          expect(line.words[w]!.start - line.words[w - 1]!.end).toBe(0);
        }
        expect(line.start).toBe(line.words[0]!.start);
        expect(line.end).toBe(line.words[line.words.length - 1]!.end);
      }
    });
  });

  it("opens on a word selection and SNAPS to its caption — canvas, handles, readout", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    // jsdom defines no AudioContext: the waveform loader must resolve null
    // (the useTakeThumbs failure posture) — opening simply draws flat.
    expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined();
    // Word 3 is the SECOND word of caption B — the popover still opens on the
    // whole caption, because a nudge moves a line's window and nothing
    // smaller.
    await openOn(3);
    const pop = popover()!;
    expect(pop).not.toBeNull();
    expect(menu()).toBeNull();
    expect(pop.querySelector('[data-testid="transcript-timing-canvas"]')).not.toBeNull();
    expect(pop.querySelector('[data-testid="transcript-timing-handle-lead"]')).not.toBeNull();
    expect(pop.querySelector('[data-testid="transcript-timing-handle-tail"]')).not.toBeNull();
    expect(pop.querySelector('[data-testid="transcript-timing-play"]')).not.toBeNull();
    expect(pop.querySelector('[data-testid="transcript-timing-apply"]')).not.toBeNull();
    expect(pop.querySelector('[data-testid="transcript-timing-cancel"]')).not.toBeNull();
    // Caption B's own window, not word 3's [1.8, 2.4] — and the count says
    // "caption", singular.
    expect(spanText()).toBe("1.20s – 2.40s · 1 caption");
  });

  it("a selection spanning two captions opens on BOTH — the readout counts captions, not words", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    // Words 1–2 straddle the A/B seam: one word of each caption.
    await openRun(1, 2);
    expect(spanText()).toBe("0.00s – 2.40s · 2 captions");
  });

  it("dragging the opening handle on a PACKED stream MOVES the span and stores non-zero deltas", async () => {
    // THE regression test. On the packed stream the old per-word clamp
    // collapsed to identity here: the handle did not move, the readout did
    // not change, and Apply stored nothing.
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    expect(spanText()).toBe("1.20s – 2.40s · 1 caption");
    // −10px = −0.2s: caption B now comes in 0.2s earlier, taking the time
    // from caption A, which is what the bounds exist to allow.
    await dragHandle("transcript-timing-handle-lead", 100, 90);
    expect(spanText()).toBe("1.00s – 2.40s · 1 caption");
    await clickTestid("transcript-timing-apply");
    const doc = timingDoc();
    expect(doc[LINE_B].lead).toBeCloseTo(-10 * SEC_PER_PX, 9);
    expect(doc[LINE_B].tail).toBeCloseTo(0, 9);
    // Apply keeps the selection (a nudge is iterated on) — the bar is back.
    expect(popover()).toBeNull();
    expect(menu()).not.toBeNull();
  });

  it("writes the PREVIOUS caption's matching tail — the partition stays consistent", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    await dragHandle("transcript-timing-handle-lead", 100, 90);
    await clickTestid("transcript-timing-apply");
    const doc = timingDoc();
    // ONE seam, TWO windows: B's opening seam IS A's closing seam, so a doc
    // that recorded only B's lead would still claim A ends at 1.2 — and a
    // popover reopened on A would seed from that stale tail and snap the seam
    // back.
    expect(Object.keys(doc).sort()).toEqual([LINE_A, LINE_B]);
    expect(doc[LINE_A].tail).toBeCloseTo(-10 * SEC_PER_PX, 9);
    // A's own OPENING seam is untouched — this gesture has nothing to say
    // about it.
    expect(doc[LINE_A].lead).toBe(0);
    // The far neighbour was never touched: the closing seam did not move.
    expect(doc[LINE_C]).toBeUndefined();
    // ONE gesture, ONE undo step — both sides of the seam go back together.
    await clickTestid("timing-undo");
    expect(timingDoc()).toEqual({});
  });

  it("the BAND pans both edges by the SAME delta — the caption keeps its duration", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    const d = 10 * SEC_PER_PX;
    await dragHandle("transcript-timing-band", 100, 110);
    expect(spanText()).toBe(`${(1.2 + d).toFixed(2)}s – ${(2.4 + d).toFixed(2)}s · 1 caption`);
    await clickTestid("transcript-timing-apply");
    const doc = timingDoc();
    expect(doc[LINE_B].lead).toBeCloseTo(d, 9);
    expect(doc[LINE_B].tail).toBeCloseTo(d, 9);
    // Both neighbours followed: a pan moves two seams, so both sides are
    // recorded.
    expect(doc[LINE_A].tail).toBeCloseTo(d, 9);
    expect(doc[LINE_C].lead).toBeCloseTo(d, 9);
    expect(doc[LINE_C].tail).toBe(0);
  });

  it("a pan into a bound is LIMITED, never squashed — the delta shrinks, the caption stays rigid", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    // +100px ≈ +2s, but the span may only reach caption C's end minus the
    // MIN_CAPTION_SEC floor (3.6 − 0.05): the pan stops at +1.15s with its
    // 1.2s width intact. Clamping the two edges independently would have
    // pinned the end while the start kept travelling — a pan that stretches.
    await dragHandle("transcript-timing-band", 100, 200);
    const start = 1.2 + (3.55 - 2.4);
    expect(spanText()).toBe(`${start.toFixed(2)}s – 3.55s · 1 caption`);
    await clickTestid("transcript-timing-apply");
    const doc = timingDoc();
    expect(doc[LINE_B].tail - doc[LINE_B].lead).toBeCloseTo(0, 9);
  });

  it("the span moves INTO the neighbour's territory but never past it", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    // −100px ≈ −2s: far past caption A's own start (0). The bound is A's
    // start plus the MIN_CAPTION_SEC floor, so the drag stops at 0.05 —
    // deep inside A's territory (it began at 1.2), and never through it.
    await dragHandle("transcript-timing-handle-lead", 100, 0);
    expect(spanText()).toBe("0.05s – 2.40s · 1 caption");
    await clickTestid("transcript-timing-apply");
    const doc = timingDoc();
    // A survives with exactly the floor: 0 → 1.2 + tail.
    expect(1.2 + doc[LINE_A].tail).toBeCloseTo(0.05, 9);
    expect(1.2 + doc[LINE_B].lead).toBeCloseTo(0.05, 9);
  });

  it("reopening resumes from the stored deltas, and re-applying changes nothing (a fixpoint)", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    await dragHandle("transcript-timing-handle-lead", 100, 90);
    const moved = spanText();
    await clickTestid("transcript-timing-apply");
    const before = timingDoc();
    expect(Object.keys(before).sort()).toEqual([LINE_A, LINE_B]);
    // Apply keeps the selection, so Timing reopens on the same caption — and
    // it must resume where the drag left it, not snap back to the derived
    // window. The panel's `liveLines` are PRE-timing, so this only works if
    // the seed reads the doc.
    await clickTestid("transcript-timing");
    expect(spanText()).toBe(moved);
    // Re-applying an undragged reopen re-derives the SAME deltas, so the doc
    // is byte-identical and the reducer mints no phantom undo step.
    await clickTestid("transcript-timing-apply");
    expect(timingDoc()).toEqual(before);
  });

  it("dragging back to the derived window DELETES both entries", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    await dragHandle("transcript-timing-handle-lead", 100, 90);
    await clickTestid("transcript-timing-apply");
    expect(Object.keys(timingDoc())).toHaveLength(2);
    // The same drag backwards lands the lead on exactly zero — and a sub-ms
    // pair on Apply is a DELETE (the clear-override rule), not a stored
    // no-op. The neighbour's bookkeeping entry clears with it.
    await clickTestid("transcript-timing");
    await dragHandle("transcript-timing-handle-lead", 90, 100);
    await clickTestid("transcript-timing-apply");
    expect(timingDoc()).toEqual({});
  });

  it("Escape cancels the popover but KEEPS the selection — the bar returns", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    expect(popover()).not.toBeNull();
    const body = container.querySelector<HTMLElement>('[data-testid="transcript-body"]')!;
    await act(async () => {
      body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(popover()).toBeNull();
    expect(menu()).not.toBeNull();
    expect(timingDoc()).toEqual({});
  });

  it("Play seeks to the span start and plays; a frameupdate past the end pauses", async () => {
    const seeks: number[] = [];
    let plays = 0;
    let pauses = 0;
    let fire: ((frame: number) => void) | null = null;
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: packed(),
          seekTo: (f: number) => seeks.push(f),
          onPlay: () => plays++,
          onPause: () => pauses++,
          onFrame: (f: (frame: number) => void) => {
            fire = f;
          },
        }),
      );
    });
    await openOn(2); // the word click itself seeks (ceil(1.2·30) = 36)
    await clickTestid("transcript-timing-play");
    // The span play seeks the SAME frame (the caption starts on its first
    // word) and starts playback.
    expect(seeks).toEqual([36, 36]);
    expect(plays).toBe(1);
    expect(pauses).toBe(0);
    // Inside the span: nothing pauses.
    await act(async () => {
      fire!(60); // 2.0s < 2.4s
    });
    expect(pauses).toBe(0);
    // Past the span end (75/30 = 2.5s ≥ 2.4s): the watcher pauses — the
    // seek+play+watch shape stands in for the playbackRange
    // @remotion/player does not offer.
    await act(async () => {
      fire!(75);
    });
    expect(pauses).toBe(1);
  });

  it("closing the popover while playing pauses playback", async () => {
    let pauses = 0;
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: packed(),
          onPause: () => pauses++,
        }),
      );
    });
    await openOn(2);
    await clickTestid("transcript-timing-play");
    expect(pauses).toBe(0);
    await clickTestid("transcript-timing-cancel");
    expect(popover()).toBeNull();
    expect(pauses).toBe(1);
    // Cancel discarded — nothing stored.
    expect(timingDoc()).toEqual({});
  });

  it("a selection change closes the popover — its capture describes the OLD caption", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    expect(popover()).not.toBeNull();
    await click(word(0));
    expect(popover()).toBeNull();
    expect(menu()!.textContent).toContain("1 word");
  });

  it("EVERY word of a nudged caption wears the dotted marker and the title suffix", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: packed(),
          seeds: [{ srcStart: 11.2, lead: 0.08, tail: -0.02 }],
        }),
      );
    });
    // The record is per LINE, so both of caption B's words carry it — a
    // dotted BORDER, never textDecoration (underline is the playhead marker
    // and line-through the hide marker; the border composes with both).
    for (const i of [2, 3]) {
      expect(word(i).style.borderBottom).toContain("dotted");
      expect(word(i).style.textDecoration).toBe("");
      expect(word(i).title).toContain(
        "caption timing adjusted (80ms in / -20ms out) — Timing to change",
      );
      // The suffix COMPOSES with the base title rather than replacing it.
      expect(word(i).title).toContain("click to jump");
    }
    // Caption A is untouched, marker and all.
    for (const i of [0, 1]) {
      expect(word(i).style.borderBottom).toBe("");
      expect(word(i).title).not.toContain("timing adjusted");
    }
  });

  /**
   * THE post-hide regression (2026-08-19 review). The panel renders the
   * PRE-hide lines and core times the POST-hide ones, so hiding a caption's
   * first word RE-KEYS that caption. A capture taken against the rendered
   * lines stored the hidden word's anchor: core reported `found: null`, the
   * caption never moved, and the panel still painted the "timing adjusted"
   * marker and resumed the next drag from the orphaned entry — it looked
   * stored and did nothing.
   */
  it("nudging a caption whose FIRST word is hidden keys the POST-hide line — and the caption moves", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    // Hide caption B's first word ("three", w11200): post-hide, caption B
    // begins on "four" (w11800) and that is the key core will look for.
    await click(word(2));
    await clickTestid("transcript-delete-menu");
    await clickTestid("transcript-hide");
    const before = timedLines();
    // Nudge the caption via its surviving word.
    await openOn(3);
    await dragHandle("transcript-timing-handle-lead", 100, 90);
    await clickTestid("transcript-timing-apply");

    const doc = timingDoc();
    // Keyed to a line that EXISTS post-hide — never to the hidden word.
    expect(Object.keys(doc)).toContain("w11800");
    expect(Object.keys(doc)).not.toContain(LINE_B);
    // …and the caption actually moves when core applies it. The stored key
    // is only worth anything if the render sees it.
    const after = timedLines();
    expect(after).not.toEqual(before);
    expect(after[1]![0]).toBeLessThan(before[1]![0]);
  });

  it("the hidden-first-word caption's marker reads the POST-hide entry too", async () => {
    // The doc is seeded on the SURVIVING first word, which is what an Apply
    // now writes: every rendered word of that caption — the hidden one
    // included — must find it, or the marker and the doc disagree.
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: packed(),
          seeds: [{ srcStart: 11.8, lead: 0.08, tail: -0.02 }],
        }),
      );
    });
    await click(word(2));
    await clickTestid("transcript-delete-menu");
    await clickTestid("transcript-hide");
    for (const i of [2, 3]) {
      expect(word(i).style.borderBottom).toContain("dotted");
      expect(word(i).title).toContain("caption timing adjusted (80ms in / -20ms out)");
    }
    // Caption A never moved.
    expect(word(0).style.borderBottom).toBe("");
  });

  /**
   * The span-end watcher is armed by the popover's own Play and by nothing
   * else (its docstring). `timingPlaying` used to be set only by that button,
   * so the global Space transport could pause and resume underneath it: the
   * watcher stayed armed and stopped ORDINARY playback dead at the caption's
   * end, with no visible cause and a button still reading "Pause"
   * (2026-08-19 review).
   */
  it("an EXTERNAL pause disarms the span-end watcher and honestly reads Play", async () => {
    let pauses = 0;
    let fire: ((frame: number) => void) | null = null;
    let firePause: (() => void) | null = null;
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          lines: packed(),
          onPause: () => pauses++,
          onFrame: (f: (frame: number) => void) => {
            fire = f;
          },
          onPauseEvent: (f: () => void) => {
            firePause = f;
          },
        }),
      );
    });
    await openOn(2);
    await clickTestid("transcript-timing-play");
    const playButton = () =>
      container.querySelector('[data-testid="transcript-timing-play"]')!.textContent;
    expect(playButton()).toBe("Pause");
    // The global transport pauses the PLAYER; the panel hears its event.
    await act(async () => {
      firePause!();
    });
    expect(playButton()).toBe("Play");
    // Resumed with Space, playback runs THROUGH the caption's end — the
    // popover no longer reaches in and pauses it.
    await act(async () => {
      fire!(75); // 2.5s ≥ caption B's 2.4s end
    });
    expect(pauses).toBe(0);
    expect(popover()).not.toBeNull();
  });
});

/**
 * Native drag-select (2026-08-18 round 5). Shift-click was the only way to
 * mark a run, which nobody reaches for first — the browser already resolves a
 * mouse drag to a Range through the bidi-reordered layout, so the panel maps
 * that Range's two ENDPOINTS onto word indices and drops the native highlight
 * so only its own yellow band is on screen. jsdom implements the Selection
 * API well enough to build the exact Range a drag would leave behind.
 */
describe("TranscriptPanel native drag-select", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const line = (texts: string[]): CaptionLine => ({
    words: texts.map((text, i) => ({
      text,
      start: i * 0.3,
      end: i * 0.3 + 0.3,
      srcStart: 10 + i,
    })),
    start: 0,
    end: texts.length * 0.3,
  });

  function Harness({ lines }: { lines: CaptionLine[] }) {
    const edits = useEdits();
    const playerRef = useRef({
      seekTo: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as PlayerRef);
    return React.createElement(TranscriptPanel, {
      baseLines: lines,
      liveLines: lines,
      // No hides here, so the timed (post-hide) track IS the rendered one.
      timingLines: lines,
      workdir: null,
      fps: 30,
      playerRef,
      edits,
      onDeleteWords: () => {},
      width: 300,
    });
  }

  const body = () => container.querySelector<HTMLElement>('[data-testid="transcript-body"]')!;
  const word = (i: number) =>
    container.querySelector<HTMLElement>(`[data-testid="transcript-word-${i}"]`)!;
  const menu = () => container.querySelector('[data-testid="transcript-selection-menu"]');
  /** The Range a mouse drag from word `from` to word `to` would leave: the
   * endpoints are TEXT nodes (a selection's boundaries are offsets into
   * text), which is why the panel's mapping walks to `parentElement` first. */
  const selectWords = (from: number, to: number) => {
    const range = document.createRange();
    range.setStart(word(from).firstChild!, 0);
    range.setEnd(word(to).firstChild!, word(to).firstChild!.textContent!.length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };
  /** The mouseup that COMMITS the drag. `detail` is the click count the
   * browser stamps on it — 2 on the second click of a double-click. */
  const mouseup = async (detail = 1) => {
    await act(async () => {
      body().dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, detail }));
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
    document.getSelection()?.removeAllRanges();
  });

  it("a drag across two words selects the run and DROPS the native highlight", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c"])] }));
    });
    selectWords(0, 1);
    await mouseup();
    expect(menu()!.textContent).toContain("2 words");
    // Exactly ONE selection on screen: the yellow band every gesture acts on.
    // Two would disagree at the edges — the band snaps to whole words, the
    // native range does not.
    expect(document.getSelection()!.rangeCount).toBe(0);
    expect(word(0).style.background.toLowerCase()).toMatch(/ffe14d|255,\s*225,\s*77/);
    expect(word(1).style.background.toLowerCase()).toMatch(/ffe14d|255,\s*225,\s*77/);
    expect(word(2).style.background).toBe("");
  });

  it("a drag that ends where it started (COLLAPSED) changes nothing — the click path seeks", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c"])] }));
    });
    const range = document.createRange();
    range.setStart(word(1).firstChild!, 1);
    range.collapse(true);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await mouseup();
    // No selection was made: a plain click must stay a seek, and the word's
    // own onClick owns it.
    expect(menu()).toBeNull();
  });

  it("the browser's DOUBLE-CLICK word-select is left alone — the retype path keeps it", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c"])] }));
    });
    // Both endpoints inside ONE word, detail 2: this is the UA selecting the
    // word under a double-click, not a drag. Consuming it would clear the
    // highlight and steal the gesture from the retype box.
    selectWords(1, 1);
    await mouseup(2);
    expect(menu()).toBeNull();
    expect(document.getSelection()!.rangeCount).toBe(1);
  });

  it("ignores a mouseup while the range editor is open — an open box owns the pointer", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c"])] }));
    });
    await act(async () => {
      word(0).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="transcript-edit-range"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="transcript-range-edit"]',
    )!;
    expect(textarea.value).toBe("a");
    // A drag inside the popover (selecting text to retype) ends with a
    // mouseup that BUBBLES through the body — the popover renders inside it.
    // Re-selecting words here would move the selection and the staleness
    // sweep would close the very box being typed into.
    selectWords(1, 2);
    await mouseup();
    expect(container.querySelector('[data-testid="transcript-range-edit"]')).not.toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="transcript-range-edit"]')!.value,
    ).toBe("a");
  });
});

/**
 * The anchored surfaces' placement (2026-08-18 round 5). `menuPlacement` is
 * the whole decision — jsdom lays nothing out, so the clamp and the flip can
 * only be tested by handing it numbers, exactly the openCommand/openInBrowser
 * split. The panel-level tests below stub the offsets the layout effect
 * reads, which is the other half: that the effect feeds it the right ones.
 */
describe("menuPlacement", () => {
  const base = {
    anchorTop: 100,
    anchorHeight: 20,
    anchorLeft: 100,
    anchorWidth: 40,
    menuW: 200,
    menuH: 40,
    scrollTop: 0,
    clientWidth: 400,
    clientHeight: 400,
  };

  it("sits below the anchor, centred on it", () => {
    // 6px gap under the word; centre 120 minus half the bar.
    expect(menuPlacement(base)).toEqual({ top: 126, left: 20 });
  });

  it("clamps to the pane's left and right margins", () => {
    expect(menuPlacement({ ...base, anchorLeft: 0, anchorWidth: 10 }).left).toBe(8);
    expect(menuPlacement({ ...base, anchorLeft: 380, anchorWidth: 20 }).left).toBe(400 - 200 - 8);
  });

  it("keeps the MARGIN when the pane is narrower than the bar — never a negative left", () => {
    // The clamp's upper bound goes negative here (150 − 200 − 8); taking it
    // would push the bar off the left edge, where the first buttons are.
    expect(menuPlacement({ ...base, clientWidth: 150 }).left).toBe(8);
  });

  it("flips ABOVE when the surface would fall past the body's visible bottom", () => {
    // Visible window [100, 250); below is 226 and 226 + 40 overruns it,
    // while above (154) is still inside — so the bar goes above.
    expect(menuPlacement({ ...base, scrollTop: 100, clientHeight: 150, anchorTop: 200 })).toEqual({
      top: 200 - 40 - 6,
      left: 20,
    });
  });

  it("stays BELOW when flipping would only trade one overflow for another", () => {
    // A pane shorter than the surface: above (−46) is outside the visible
    // window too, and below at least scrolls into reach.
    expect(menuPlacement({ ...base, anchorTop: 0, scrollTop: 0, clientHeight: 30 }).top).toBe(26);
  });
});

/**
 * The RENDERED-line → TIMED-line translation (2026-08-19 review). Pure, and
 * tested here rather than through the panel for the `menuPlacement` reason:
 * this is the whole decision, and the panel can only show one of its
 * consequences at a time.
 */
describe("postHideLineIndices", () => {
  const line = (words: Array<[string, number]>): CaptionLine => ({
    start: words[0]![1],
    end: words[words.length - 1]![1] + 1,
    words: words.map(([text, srcStart]) => ({
      text,
      start: srcStart,
      end: srcStart + 1,
      srcStart,
    })),
  });

  it("is the identity when nothing is hidden", () => {
    const lines = [line([["a", 1]]), line([["b", 2]]), line([["c", 3]])];
    expect(postHideLineIndices(lines, lines)).toEqual([0, 1, 2]);
  });

  it("pairs a line whose FIRST word was hidden — the caption survives, re-keyed", () => {
    const pre = [line([["a", 1], ["b", 2]]), line([["c", 3], ["d", 4]])];
    const post = [pre[0]!, line([["d", 4]])];
    expect(postHideLineIndices(pre, post)).toEqual([0, 1]);
  });

  it("maps a line the hides EMPTIED to null, and the rest keep their real indices", () => {
    const pre = [line([["a", 1]]), line([["b", 2]]), line([["c", 3]])];
    // The middle caption lost every word: post-hide it is gone, and caption
    // C — index 2 on screen — is index 1 in the timed track.
    const post = [pre[0]!, pre[2]!];
    expect(postHideLineIndices(pre, post)).toEqual([0, null, 1]);
  });

  it("pairs in ORDER, so a MANUFACTURED duplicate anchor cannot claim a namesake's line", () => {
    // `backfillSrcStart` manufactures shared source instants (captions.ts:
    // 44-50): two lines can legitimately open on the same anchor. An
    // anchor-keyed map would pair the second with the first's line.
    const pre = [line([["x", 5]]), line([["y", 6]]), line([["x", 5]])];
    const post = [pre[0]!, pre[2]!];
    expect(postHideLineIndices(pre, post)).toEqual([0, null, 1]);
  });

  it("maps an ANCHORLESS line to null rather than guessing — the §137 posture", () => {
    const anchorless: CaptionLine = {
      start: 0,
      end: 1,
      words: [{ text: "old", start: 0, end: 1 } as CaptionLine["words"][number]],
    };
    expect(postHideLineIndices([anchorless], [anchorless])).toEqual([null]);
  });
});

/**
 * The waveform cache belongs to ONE project: `/media/*` resolves against the
 * server's CURRENT workdir, and switches happen in-page (R17 §83), so a bare
 * module singleton aligned project B's captions against project A's audio.
 */
describe("loadSourceAudio", () => {
  it("re-fetches when the workdir changes, and only then", async () => {
    const g = globalThis as unknown as { fetch?: unknown; AudioContext?: unknown };
    const origFetch = g.fetch;
    const origAudioContext = g.AudioContext;
    const fetched: string[] = [];
    g.fetch = async (url: string) => {
      fetched.push(url);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    g.AudioContext = class {
      async decodeAudioData() {
        return { getChannelData: () => new Float32Array([0.5]), sampleRate: 48000 };
      }
      async close() {}
    };
    try {
      await loadSourceAudio("/w/a");
      await loadSourceAudio("/w/a");
      // One decode per project, however many popovers open in it.
      expect(fetched.length).toBe(1);
      await loadSourceAudio("/w/b");
      expect(fetched.length).toBe(2);
      // Switching BACK re-fetches too: the cache holds one project's decode,
      // never a map that outlives the projects in it.
      await loadSourceAudio("/w/a");
      expect(fetched.length).toBe(3);
    } finally {
      g.fetch = origFetch;
      g.AudioContext = origAudioContext;
    }
  });
});

/**
 * The caption drag's arithmetic — the `menuPlacement` split again: the whole
 * decision is pure, and the window listener only feeds it pixels. Every value
 * below is in the DERIVED (pre-timing) space `captionLineTiming`'s deltas are
 * measured in, over a packed three-caption track `[0, 1.2] [1.2, 2.4]
 * [2.4, 3.6]`.
 */
describe("captionDragBounds / clampCaptionSpan / dragCaptionSpan / captionTimingEntries", () => {
  /** `MIN_CAPTION_SEC`, restated: the tests name the number the sweep uses. */
  const MIN = 0.05;

  /** The middle caption of the packed track, and its two neighbours. */
  const SPAN = { start: 1.2, end: 2.4 };

  it("bounds the drag by the NEIGHBOURS, not by the dragged captions", () => {
    // The whole reason the tool works on a packed stream: bounds taken from
    // the group's own window would be `[1.2, 2.4]` — every drag clamped to
    // identity, which is the field bug.
    expect(
      captionDragBounds({
        prev: { start: 0, end: 1.2 },
        next: { start: 2.4, end: 3.6 },
        span: SPAN,
        track: { start: 0, end: 3.6 },
      }),
    ).toEqual({ lo: 0 + MIN, hi: 3.6 - MIN });
  });

  it("falls back to the track's own seams at either end", () => {
    // A caption must not appear before the first caption of the track or
    // linger past the last — the sweep's non-growing outer bounds.
    expect(
      captionDragBounds({
        prev: null,
        next: { start: 2.4, end: 3.6 },
        span: SPAN,
        track: { start: 0, end: 3.6 },
      }),
    ).toEqual({ lo: 0, hi: 3.6 - MIN });
    expect(
      captionDragBounds({
        prev: { start: 0, end: 1.2 },
        next: null,
        span: SPAN,
        track: { start: 0, end: 3.6 },
      }),
    ).toEqual({ lo: 0 + MIN, hi: 3.6 });
  });

  it("bounds a GAPPED side at the neighbour's OWN adjacent edge — the gap is consumable, the neighbour is not", () => {
    // `[0, 2] [3, 5] [6, 8]`: neither boundary is shared, so neither
    // neighbour follows the drag (`captionTimingEntries`' coincidence rule)
    // and core's sweep blocks the moved edge at the neighbour's own edge.
    // Bounding at `prev.start + MIN` would let the handle travel to 0.05
    // while the previewed edge sat still at 2.
    expect(
      captionDragBounds({
        prev: { start: 0, end: 2 },
        next: { start: 6, end: 8 },
        span: { start: 3, end: 5 },
        track: { start: 0, end: 8 },
      }),
    ).toEqual({ lo: 2, hi: 6 });
  });

  it("mixes the two rules per SIDE — a shared boundary on one side, a gap on the other", () => {
    // `[0, 3] [3, 5] [6, 8]`: the opening boundary is shared (the previous
    // caption's last moments are on offer, down to its own floor); the
    // closing one is not (the drag stops at the third caption's start).
    expect(
      captionDragBounds({
        prev: { start: 0, end: 3 },
        next: { start: 6, end: 8 },
        span: { start: 3, end: 5 },
        track: { start: 0, end: 8 },
      }),
    ).toEqual({ lo: 0 + MIN, hi: 6 });
  });

  it("clampCaptionSpan forces a seed inside the window, end never before start", () => {
    expect(clampCaptionSpan({ start: -5, end: 9 }, 0.05, 3.55)).toEqual({
      start: 0.05,
      end: 3.55,
    });
    expect(clampCaptionSpan({ start: 1.2, end: 2.4 }, 0.05, 3.55)).toEqual({
      start: 1.2,
      end: 2.4,
    });
    // An inverted pair (a hand-edited doc's deltas) collapses rather than
    // seeding a span whose own drag could never reach it.
    expect(clampCaptionSpan({ start: 2, end: 0.2 }, 0.05, 3.55)).toEqual({ start: 2, end: 2 });
  });

  it("a handle moves ONE edge and stops at the window", () => {
    const span = { start: 1.2, end: 2.4 };
    expect(dragCaptionSpan({ edge: "tail", span, dSec: 0.4, lo: 0.05, hi: 3.55 })).toEqual({
      start: 1.2,
      end: 2.8,
    });
    expect(dragCaptionSpan({ edge: "tail", span, dSec: 9, lo: 0.05, hi: 3.55 })).toEqual({
      start: 1.2,
      end: 3.55,
    });
    expect(dragCaptionSpan({ edge: "lead", span, dSec: -9, lo: 0.05, hi: 3.55 })).toEqual({
      start: 0.05,
      end: 2.4,
    });
  });

  it("a handle collapses the span but never INVERTS it", () => {
    // A negative ratio in `captionTimingEntries` would mirror the group's
    // caption order; a collapsed span is pushed back apart by the sweep's
    // MIN_CAPTION_SEC floor, which the preview runs.
    const span = { start: 1.2, end: 2.4 };
    expect(dragCaptionSpan({ edge: "lead", span, dSec: 5, lo: 0.05, hi: 3.55 })).toEqual({
      start: 2.4,
      end: 2.4,
    });
    expect(dragCaptionSpan({ edge: "tail", span, dSec: -5, lo: 0.05, hi: 3.55 })).toEqual({
      start: 1.2,
      end: 1.2,
    });
  });

  it("the BAND pans rigidly — a delta into a bound SHRINKS, it never squashes the group", () => {
    const span = { start: 1.2, end: 2.4 };
    expect(dragCaptionSpan({ edge: "band", span, dSec: 0.5, lo: 0.05, hi: 3.55 })).toEqual({
      start: 1.7,
      end: 2.9,
    });
    // +9s would put the end past 3.55; the DELTA is reduced and the span
    // keeps its 1.2s width. Clamping the edges independently would have
    // pinned the end and let the start travel — a pan that stretches.
    const limited = dragCaptionSpan({ edge: "band", span, dSec: 9, lo: 0.05, hi: 3.55 });
    expect(limited.end).toBeCloseTo(3.55, 9);
    expect(limited.end - limited.start).toBeCloseTo(1.2, 9);
    // And the same leftward, into `lo`.
    const left = dragCaptionSpan({ edge: "band", span, dSec: -9, lo: 0.05, hi: 3.55 });
    expect(left.start).toBeCloseTo(0.05, 9);
    expect(left.end - left.start).toBeCloseTo(1.2, 9);
  });

  /** Caption B of the packed track, with A before it and C after it. */
  const middle = {
    lines: [{ srcStart: 11.2, start: 1.2, end: 2.4 }],
    span: { start: 1.2, end: 2.4 },
    prev: { srcStart: 10, end: 1.2, lead: 0 },
    next: { srcStart: 12.4, start: 2.4, tail: 0 },
  };

  it("an opening drag writes the caption's lead AND the previous caption's matching tail", () => {
    const entries = captionTimingEntries({ ...middle, newSpan: { start: 1, end: 2.4 } });
    // One seam, two windows — the doc records both sides or a popover
    // reopened on the neighbour seeds from a stale tail.
    expect(entries.map((e) => e.srcStart)).toEqual([10, 11.2, 12.4]);
    expect(entries[0]!.lead).toBe(0);
    expect(entries[0]!.tail).toBeCloseTo(-0.2, 9);
    expect(entries[1]!.lead).toBeCloseTo(-0.2, 9);
    expect(entries[1]!.tail).toBeCloseTo(0, 9);
    // The NEXT caption is written too, all-zero: the closing seam did not
    // move, and an all-zero entry is the reducer's DELETE instruction — which
    // is what clears a stale entry left by an earlier drag of this same seam.
    // (The popover test's doc probe shows the key absent afterwards.)
    expect(entries[2]).toEqual({ srcStart: 12.4, lead: 0, tail: 0 });
  });

  it("a rigid pan moves every seam by the same delta — both neighbours included", () => {
    const entries = captionTimingEntries({ ...middle, newSpan: { start: 1.4, end: 2.6 } });
    expect(entries.map((e) => e.srcStart)).toEqual([10, 11.2, 12.4]);
    for (const e of entries) {
      // The far side of each neighbour is untouched: `prev.lead` and
      // `next.tail` are this gesture's business only where it moved a seam.
      if (e.srcStart === 10) expect(e.lead).toBe(0);
      if (e.srcStart === 12.4) expect(e.tail).toBe(0);
    }
    expect(entries[0]!.tail).toBeCloseTo(0.2, 9);
    expect(entries[1]!.lead).toBeCloseTo(0.2, 9);
    expect(entries[1]!.tail).toBeCloseTo(0.2, 9);
    expect(entries[2]!.lead).toBeCloseTo(0.2, 9);
  });

  it("a stretch scales the INTERIOR seams — a multi-caption group keeps its rhythm", () => {
    // Captions A and B dragged as one group, their shared seam at 1.2. The
    // window doubles, so the interior seam lands at the middle of the new
    // window rather than sitting still while the outer two moved.
    const entries = captionTimingEntries({
      lines: [
        { srcStart: 10, start: 0, end: 1.2 },
        { srcStart: 11.2, start: 1.2, end: 2.4 },
      ],
      span: { start: 0, end: 2.4 },
      newSpan: { start: 0, end: 4.8 },
      prev: null,
      next: { srcStart: 12.4, start: 2.4, tail: 0 },
    });
    expect(entries[0]!.lead).toBeCloseTo(0, 9);
    // The shared seam: 1.2 → 2.4, written on BOTH sides of itself.
    expect(entries[0]!.tail).toBeCloseTo(1.2, 9);
    expect(entries[1]!.lead).toBeCloseTo(1.2, 9);
    expect(entries[1]!.tail).toBeCloseTo(2.4, 9);
    // No previous caption — the group opens the track, so nothing to record.
    expect(entries.map((e) => e.srcStart)).toEqual([10, 11.2, 12.4]);
  });

  it("carries the neighbours' OWN stored deltas through untouched", () => {
    // A zero here would drag a neighbour's own earlier nudge back to base —
    // an edit nobody asked this gesture to make.
    const entries = captionTimingEntries({
      ...middle,
      prev: { srcStart: 10, end: 1.2, lead: -0.4 },
      next: { srcStart: 12.4, start: 2.4, tail: 0.3 },
      newSpan: { start: 1, end: 2.4 },
    });
    expect(entries[0]!.lead).toBe(-0.4);
    // The closing seam did not move, so the next caption's lead is zero —
    // but its own tail survives, and the reducer keeps the entry for it.
    expect(entries[entries.length - 1]!.tail).toBe(0.3);
    expect(entries[entries.length - 1]!.lead).toBeCloseTo(0, 9);
  });

  it("a degenerate derived window moves the group rigidly instead of storing NaN", () => {
    // `0/0` would put NaN deltas in the doc — `scaleWordsIntoWindow` takes
    // the same identity escape for the same reason.
    const entries = captionTimingEntries({
      lines: [{ srcStart: 11.2, start: 1.2, end: 1.2 }],
      span: { start: 1.2, end: 1.2 },
      newSpan: { start: 1.5, end: 1.7 },
      prev: null,
      next: null,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.srcStart).toBe(11.2);
    expect(entries[0]!.lead).toBeCloseTo(0.3, 9);
    expect(entries[0]!.tail).toBeCloseTo(0.3, 9);
  });
});

/**
 * The GAPPED track (2026-08-19 review). The entry builder used to assume the
 * partition and write both neighbours unconditionally, so a lead-only drag on
 * a track with gaps moved captions the user never touched — the editor-side
 * twin of the bug core fixed in its own sweep. The model both sides now state:
 * dragging a caption's edge moves the boundary it SHARES with its neighbour,
 * and a gap means there is no shared boundary on that side.
 *
 * Asserted THROUGH core's real apply pass, not just on the entries: the point
 * of the rule is that the editor and core express one model, which only the
 * composed result can show. The fixture is `[0, 2] [3, 5] [6, 8]` — the shape
 * `applyCaptionWordHides` produces when a hide re-bases a line's window.
 */
describe("captionTimingEntries on a GAPPED track", () => {
  const L = (start: number, end: number, srcStart: number, text: string): CaptionLine => ({
    start,
    end,
    words: [{ text, start, end, srcStart }],
  });
  const lines = [L(0, 2, 10, "a"), L(3, 5, 13, "b"), L(6, 8, 16, "c")];
  const span = { start: 3, end: 5 };
  /** The middle caption's drag, through the same three steps the popover
   * takes: entries → record → core's apply. */
  const applied = (newSpan: { start: number; end: number }) => {
    const entries = captionTimingEntries({
      lines: [{ srcStart: 13, start: 3, end: 5 }],
      span,
      newSpan,
      prev: { srcStart: 10, end: 2, lead: 0 },
      next: { srcStart: 16, start: 6, tail: 0 },
    });
    const record: Record<string, { lead: number; tail: number }> = {};
    for (const e of entries) record[captionKeyFor(e.srcStart)] = { lead: e.lead, tail: e.tail };
    const out = applyCaptionLineTiming(lines, record);
    return {
      entries,
      windows: out.lines.map((l) => [Number(l.start.toFixed(4)), Number(l.end.toFixed(4))]),
      dropped: out.dropped,
    };
  };

  it("writes NO neighbour entry across a gap — a lead-only drag moves the dragged caption ALONE", () => {
    const { entries, windows, dropped } = applied({ start: 2.5, end: 5 });
    // One entry: the caption the user dragged. The old builder wrote three,
    // and the two extras were the untouched neighbours.
    expect(entries.map((e) => e.srcStart)).toEqual([13]);
    // A and C stay EXACTLY where they were; B took the gap it moved into.
    expect(windows).toEqual([
      [0, 2],
      [2.5, 5],
      [6, 8],
    ]);
    expect(dropped).toEqual([]);
  });

  it("a drag into the neighbour is BLOCKED at its own edge — the preview and the applied result agree", () => {
    // The bound stops the handle at 2 (`captionDragBounds`' gapped side);
    // even a hand-edited target past it can only reach the same place,
    // because core's sweep blocks the edge against the neighbour's own.
    const { windows } = applied({ start: 1, end: 5 });
    expect(windows[0]).toEqual([0, 2]);
    expect(windows[1]).toEqual([2, 5]);
    expect(windows[2]).toEqual([6, 8]);
  });

  it("a tail drag toward a gapped neighbour never PUSHES it later", () => {
    const { entries, windows } = applied({ start: 3, end: 5.5 });
    expect(entries.map((e) => e.srcStart)).toEqual([13]);
    expect(windows).toEqual([
      [0, 2],
      [3, 5.5],
      [6, 8],
    ]);
  });

  it("still writes the neighbour where the boundary IS shared — one side gapped, one side not", () => {
    // `[0, 3] [3, 5] [6, 8]`: the opening boundary is shared, so the previous
    // caption's closing edge travels with the drag (one edit, two windows);
    // the closing boundary is a gap, so the third caption is left alone.
    const mixed = [L(0, 3, 10, "a"), L(3, 5, 13, "b"), L(6, 8, 16, "c")];
    const entries = captionTimingEntries({
      lines: [{ srcStart: 13, start: 3, end: 5 }],
      span,
      newSpan: { start: 2.5, end: 5 },
      prev: { srcStart: 10, end: 3, lead: 0 },
      next: { srcStart: 16, start: 6, tail: 0 },
    });
    expect(entries.map((e) => e.srcStart)).toEqual([10, 13]);
    const record: Record<string, { lead: number; tail: number }> = {};
    for (const e of entries) record[captionKeyFor(e.srcStart)] = { lead: e.lead, tail: e.tail };
    const out = applyCaptionLineTiming(mixed, record);
    expect(out.lines.map((l) => [l.start, l.end])).toEqual([
      [0, 2.5],
      [2.5, 5],
      [6, 8],
    ]);
  });
});

/**
 * The bar as CHROME (2026-08-18 round 5). Two field reports: an Urdu
 * transcript reversed the whole button row (`word 1 · Delete · Timing ·
 * Edit`) because the bar inherits the body's `dir="rtl"`, and the bar's
 * position came from a 340px WIDTH GUESS that could not know where the pane's
 * edge was. jsdom reports all-zero offsets, so the layout half is tested by
 * stubbing the four `offset*` getters plus the body's own metrics.
 */
describe("TranscriptPanel bar chrome and placement", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const origGetContext = HTMLCanvasElement.prototype.getContext;

  /** The synthetic layout the stubs below report. Mutable so a test can put
   * the anchor word wherever the assertion needs it. */
  let layout: {
    wordTop: (i: number) => number;
    wordLeft: (i: number) => number;
    wordW: number;
    wordH: number;
    menuW: number;
    menuH: number;
    bodyW: number;
    bodyH: number;
    scrollTop: number;
  };

  const boxOf = (el: HTMLElement): { top: number; left: number; w: number; h: number } => {
    const id = el.getAttribute("data-testid") ?? "";
    const m = /^transcript-word-(\d+)$/.exec(id);
    if (m) {
      const i = Number(m[1]);
      return { top: layout.wordTop(i), left: layout.wordLeft(i), w: layout.wordW, h: layout.wordH };
    }
    if (
      id === "transcript-selection-menu" ||
      id === "transcript-range-popover" ||
      id === "transcript-timing-popover"
    ) {
      return { top: 0, left: 0, w: layout.menuW, h: layout.menuH };
    }
    return { top: 0, left: 0, w: 0, h: 0 };
  };

  /** Saved own-descriptors so the prototype is left exactly as found — some
   * of these live on Element.prototype, where an own-prop delete is the
   * restore and a redefine would MINT one. */
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const stub = (key: string, get: (el: HTMLElement) => number): void => {
    originals.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        return get(this);
      },
      // scrollTop is written by jsdom's own scrolling paths; swallow it.
      set() {},
    });
  };
  const isBody = (el: HTMLElement): boolean =>
    el.getAttribute("data-testid") === "transcript-body";

  function Harness({ lines }: { lines: CaptionLine[] }) {
    const edits = useEdits();
    const playerRef = useRef({
      seekTo: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as PlayerRef);
    return React.createElement(TranscriptPanel, {
      baseLines: lines,
      liveLines: lines,
      // No hides here, so the timed (post-hide) track IS the rendered one.
      timingLines: lines,
      workdir: null,
      fps: 30,
      playerRef,
      edits,
      onDeleteWords: () => {},
      width: 300,
    });
  }

  const line = (texts: string[]): CaptionLine => ({
    words: texts.map((text, i) => ({
      text,
      start: i * 0.3,
      end: i * 0.3 + 0.3,
      srcStart: 10 + i,
    })),
    start: 0,
    end: texts.length * 0.3,
  });

  const word = (i: number) =>
    container.querySelector<HTMLElement>(`[data-testid="transcript-word-${i}"]`)!;
  const click = async (el: HTMLElement, shiftKey = false) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey }));
    });
  };
  const clickTestid = async (testid: string) => {
    await click(container.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!);
  };
  const menu = () => container.querySelector<HTMLElement>('[data-testid="transcript-selection-menu"]');

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext;
    layout = {
      wordTop: () => 40,
      wordLeft: (i) => 20 + i * 50,
      wordW: 30,
      wordH: 20,
      menuW: 200,
      menuH: 40,
      bodyW: 400,
      bodyH: 400,
      scrollTop: 0,
    };
    stub("offsetTop", (el) => boxOf(el).top);
    stub("offsetLeft", (el) => boxOf(el).left);
    stub("offsetWidth", (el) => boxOf(el).w);
    stub("offsetHeight", (el) => boxOf(el).h);
    stub("clientWidth", (el) => (isBody(el) ? layout.bodyW : 0));
    stub("clientHeight", (el) => (isBody(el) ? layout.bodyH : 0));
    stub("scrollTop", (el) => (isBody(el) ? layout.scrollTop : 0));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    HTMLCanvasElement.prototype.getContext = origGetContext;
    for (const [key, desc] of originals) {
      if (desc) Object.defineProperty(HTMLElement.prototype, key, desc);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
    originals.clear();
  });

  it('pins the bar, the flyout and both popovers to dir="ltr" — chrome, not content', async () => {
    // The field screenshot: an Urdu transcript's bar read `word 1 · Delete ·
    // Timing · Edit` because the row inherited the body's rtl base.
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["سلام", "دنیا"])] }));
    });
    expect(
      container.querySelector('[data-testid="transcript-body"]')!.getAttribute("dir"),
    ).toBe("rtl");
    await click(word(0));
    expect(menu()!.getAttribute("dir")).toBe("ltr");
    await clickTestid("transcript-delete-menu");
    expect(
      container.querySelector('[data-testid="transcript-delete-flyout"]')!.getAttribute("dir"),
    ).toBe("ltr");
    await clickTestid("transcript-timing");
    expect(
      container.querySelector('[data-testid="transcript-timing-popover"]')!.getAttribute("dir"),
    ).toBe("ltr");
    await clickTestid("transcript-timing-cancel");
    await clickTestid("transcript-edit-range");
    const pop = container.querySelector('[data-testid="transcript-range-popover"]')!;
    expect(pop.getAttribute("dir")).toBe("ltr");
    // …but the box holding TRANSCRIPT text keeps a first-strong base, or an
    // Urdu rewrite would type left-to-right inside LTR chrome.
    expect(
      pop.querySelector('[data-testid="transcript-range-edit"]')!.getAttribute("dir"),
    ).toBe("auto");
  });

  it("orders the row Edit · Timing · Delete ▾, with the count LAST", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
    });
    await click(word(0));
    const bar = menu()!;
    expect(Array.from(bar.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent)).toEqual([
      "Edit",
      "Timing",
      "Delete ▾",
    ]);
    // The muted count is a readout, not an action — it trails the actions.
    expect(bar.lastElementChild!.textContent).toBe("1 word");
  });

  it("centres the bar on the selection's union and clamps it inside the pane", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c"])] }));
    });
    // Words 0 and 2 share a line here: union [20, 150), centre 85, so a
    // 200px bar wants left 85 − 100 = −15 and takes the 8px margin instead.
    await click(word(0));
    await click(word(2), true);
    expect(menu()!.style.left).toBe("8px");
    // Six px under the word's own line (top 40 + height 20 + 6).
    expect(menu()!.style.top).toBe("66px");
    // Shift the anchor right: the centre now clears both margins.
    layout.wordLeft = (i) => 100 + i * 50;
    await click(word(1));
    // Single word: the union IS the word — left 150, centre 165, minus half
    // the 200px bar.
    expect(menu()!.style.left).toBe("65px");
  });

  it("anchors to the LAST word when the endpoints wrapped onto different lines", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b", "c"])] }));
    });
    // Word 2 wrapped: its own line, its own left. The union across a wrap
    // spans the whole pane and its centre means nothing.
    layout.wordTop = (i) => (i === 2 ? 80 : 40);
    layout.wordLeft = (i) => (i === 2 ? 120 : 20 + i * 50);
    await click(word(0));
    await click(word(2), true);
    expect(menu()!.style.top).toBe("106px");
    expect(menu()!.style.left).toBe("35px");
  });

  it("flips ABOVE the anchor when the bar would fall past the body's visible bottom", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
    });
    // The anchor sits near the bottom of a scrolled 150px window [500, 650):
    // below (626) plus the bar (40) overruns it, and above (554) does not.
    layout.wordTop = () => 600;
    layout.bodyH = 150;
    layout.scrollTop = 500;
    await click(word(0));
    expect(menu()!.style.top).toBe(`${600 - 40 - 6}px`);
  });

  it("re-measures for the TALLER popovers — they replace the bar at the same anchor", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: [line(["a", "b"])] }));
    });
    layout.wordTop = () => 300;
    await click(word(0));
    // The 40px bar fits below the word inside the 400px window.
    expect(menu()!.style.top).toBe("326px");
    // The timing popover is 160px tall: below (326 + 160) overruns the
    // window, so the SAME anchor must flip it above. Without the re-measure
    // it inherited the bar's placement and hung off the bottom of the pane.
    layout.menuH = 160;
    layout.menuW = 300;
    await clickTestid("transcript-timing");
    const pop = container.querySelector<HTMLElement>('[data-testid="transcript-timing-popover"]')!;
    expect(pop.style.top).toBe(`${300 - 160 - 6}px`);
    // 300 wide in a 400 pane, centred on a 30px word at 20 → clamped left.
    expect(pop.style.left).toBe("8px");
  });
});

/**
 * The timing handle drag (2026-08-18 round 5). Field report: "dragged and
 * left the mouse button and it was still dragging." The listeners lived on
 * the 10px handle and relied on a `setPointerCapture` whose every failure was
 * swallowed, so a pointer that left the strip — which every real drag does
 * immediately — lost both the moves and the UP; and the drag lived in a ref
 * no close path cleared, so a stale `startX` made the next BARE HOVER jump
 * the handle. Window listeners plus drag-as-state are the fix.
 */
describe("TranscriptPanel timing handle drag", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const origGetContext = HTMLCanvasElement.prototype.getContext;

  /** The popover describe's PACKED track — three gap-free captions, which is
   * the only shape a drag can actually move (that describe's docstring has
   * the measurements). */
  const packed = (): CaptionLine[] => [
    {
      start: 0,
      end: 1.2,
      words: [
        { text: "one", start: 0, end: 0.6, srcStart: 10 },
        { text: "two", start: 0.6, end: 1.2, srcStart: 10.6 },
      ],
    },
    {
      start: 1.2,
      end: 2.4,
      words: [
        { text: "three", start: 1.2, end: 1.8, srcStart: 11.2 },
        { text: "four", start: 1.8, end: 2.4, srcStart: 11.8 },
      ],
    },
    {
      start: 2.4,
      end: 3.6,
      words: [
        { text: "five", start: 2.4, end: 3, srcStart: 12.4 },
        { text: "six", start: 3, end: 3.6, srcStart: 13 },
      ],
    },
  ];

  function Harness({ lines }: { lines: CaptionLine[] }) {
    const edits = useEdits();
    const playerRef = useRef({
      seekTo: () => {},
      play: () => {},
      pause: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as PlayerRef);
    return React.createElement(TranscriptPanel, {
      baseLines: lines,
      liveLines: lines,
      // No hides here, so the timed (post-hide) track IS the rendered one.
      timingLines: lines,
      workdir: null,
      fps: 30,
      playerRef,
      edits,
      onDeleteWords: () => {},
      width: 300,
    });
  }

  const word = (i: number) =>
    container.querySelector<HTMLElement>(`[data-testid="transcript-word-${i}"]`)!;
  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };
  const clickTestid = async (testid: string) => {
    await click(container.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!);
  };
  const openOn = async (i: number) => {
    await click(word(i));
    await clickTestid("transcript-timing");
  };
  const span = () => container.querySelector('[data-testid="transcript-timing-span"]')!.textContent;
  /** jsdom has no PointerEvent constructor; React and the window listeners
   * both dispatch on the TYPE, and only `clientX` is read. */
  const pointerDown = async (testid: string, clientX: number) => {
    await act(async () => {
      container
        .querySelector<HTMLElement>(`[data-testid="${testid}"]`)!
        .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX }));
    });
  };
  /** The moves and the terminators go to WINDOW — where a real drag's events
   * land the moment the pointer leaves the 12px handle. */
  const windowPointer = async (type: string, clientX = 0) => {
    await act(async () => {
      window.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
    });
  };
  /** The strip's window for the middle caption: its two neighbours' territory
   * (source 10 → 13.6) plus the two 1s pads over 280px — 0.02 s/px exactly. */
  const SEC_PER_PX = 0.02;
  /** The lead handle's readout after `dx` px of drag on caption B. */
  const spanAfter = (dx: number) =>
    `${(1.2 + dx * SEC_PER_PX).toFixed(2)}s – 2.40s · 1 caption`;
  /** The band's readout after `dx` px of a rigid pan of caption B. */
  const bandAfter = (dx: number) =>
    `${(1.2 + dx * SEC_PER_PX).toFixed(2)}s – ${(2.4 + dx * SEC_PER_PX).toFixed(2)}s · 1 caption`;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    HTMLCanvasElement.prototype.getContext = origGetContext;
  });

  it("a WINDOW pointermove drives the drag, and a WINDOW pointerup ends it for good", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    expect(span()).toBe("1.20s – 2.40s · 1 caption");
    await pointerDown("transcript-timing-handle-lead", 100);
    await windowPointer("pointermove", 110);
    expect(span()).toBe(spanAfter(10));
    await windowPointer("pointerup");
    // THE reported bug: before the window listeners the release was never
    // heard, so the next move — a bare hover, no button down — kept dragging.
    await windowPointer("pointermove", 160);
    expect(span()).toBe(spanAfter(10));
  });

  it("pointercancel ends the drag too — a touch that became a scroll delivers no pointerup", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    await pointerDown("transcript-timing-handle-lead", 100);
    await windowPointer("pointermove", 110);
    expect(span()).toBe(spanAfter(10));
    await windowPointer("pointercancel");
    await windowPointer("pointermove", 160);
    expect(span()).toBe(spanAfter(10));
  });

  it("losing window focus ends the drag — an OS drag away delivers no pointerup either", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    await pointerDown("transcript-timing-handle-lead", 100);
    await windowPointer("pointermove", 110);
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await windowPointer("pointermove", 160);
    expect(span()).toBe(spanAfter(10));
  });

  it("closing the popover MID-drag leaves nothing behind — a reopened handle is inert until pressed", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    // Cancel while the button is still down: the old ref survived this, and
    // the stale startX made the next bare hover jump the handle by
    // `clientX − staleStartX`.
    await pointerDown("transcript-timing-handle-lead", 100);
    await clickTestid("transcript-timing-cancel");
    await clickTestid("transcript-timing");
    await windowPointer("pointermove", 300);
    expect(span()).toBe("1.20s – 2.40s · 1 caption");
    // And the handle still WORKS once pressed again.
    await pointerDown("transcript-timing-handle-lead", 100);
    await windowPointer("pointermove", 110);
    expect(span()).toBe(spanAfter(10));
  });

  // The band is a THIRD drag target on the same window machinery — so it
  // inherits these invariants, and the tests say so rather than assuming a
  // shared code path stays shared.

  it("the BAND drags on the window too, and a window pointerup ends it for good", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    expect(span()).toBe("1.20s – 2.40s · 1 caption");
    await pointerDown("transcript-timing-band", 100);
    await windowPointer("pointermove", 130);
    expect(span()).toBe(bandAfter(30));
    await windowPointer("pointerup");
    // The reported bug's shape, on the pan target: a bare hover after the
    // release must not keep panning.
    await windowPointer("pointermove", 200);
    expect(span()).toBe(bandAfter(30));
  });

  it("closing the popover MID-band-drag leaves nothing behind", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    await pointerDown("transcript-timing-band", 100);
    await clickTestid("transcript-timing-cancel");
    await clickTestid("transcript-timing");
    await windowPointer("pointermove", 300);
    expect(span()).toBe("1.20s – 2.40s · 1 caption");
  });

  it("unmounting mid-drag leaves no live window listener", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { lines: packed() }));
    });
    await openOn(2);
    await pointerDown("transcript-timing-handle-lead", 100);
    await act(async () => {
      root.render(React.createElement("div", null));
    });
    // A move after the panel is gone must reach nothing — an update on an
    // unmounted tree is React's warning, not a crash, so the assertion is
    // simply that dispatching is safe and the panel stays gone.
    await windowPointer("pointermove", 300);
    expect(container.querySelector('[data-testid="transcript-timing-popover"]')).toBeNull();
  });
});

/**
 * The panel over REBUILT live lines (cut-review rework phase 2). Field report:
 * keep a proposed removal, then try to fix a word inside the revived stretch —
 * impossible, because every stream the panel was fed came from
 * `renderProps.baseCaptionLines`, the LAST RENDER's cut, where that word has no
 * image at all (`liveCaptionTrack.test.ts` pins that blindness).
 *
 * App now feeds `rebuildCaptionTrack`'s three stops instead, with IDENTITY
 * clocks — the streams are already on the player's clock, so converting them
 * would move every word by the revived seconds a second time. This is that
 * wiring, exercised end to end: the same rebuilt streams App computes, the
 * same identity mappers, the real reducer behind them.
 */
describe("TranscriptPanel over REBUILT live lines (cut-review rework)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  /** The last render cut source 5..7; the user's veto revives it. */
  const proposal: Segment[] = [
    { srcIn: 0, srcOut: 5, kind: "keep" },
    { srcIn: 5, srcOut: 7, kind: "remove", reason: "pause", confidence: 0.9 },
    { srcIn: 7, srcOut: 10, kind: "keep" },
  ];
  /** "during" is the revived word — inside the stretch the render removed. */
  const transcript = {
    language: "en",
    words: [
      { text: "early", start: 3, end: 3.3 },
      { text: "during", start: 6, end: 6.3 },
      { text: "late", start: 8, end: 8.3 },
    ],
  };

  function Harness({ onDeleteWords }: { onDeleteWords?: (plan: DeleteWordsPlan) => void }) {
    const edits = useEdits();
    const playerRef = useRef(null as unknown as PlayerRef);
    // App's own composition, collapsed: `livePreviewMap` → the live clock →
    // `rebuildCaptionTrack` over the doc the user is editing RIGHT NOW, which
    // is why it lives inside the render rather than beside the fixture.
    const clocks = livePreviewMap(
      proposal,
      { reasons: { pause: false } },
      [],
      new TimeMap(proposal).spans,
    )!;
    const track = rebuildCaptionTrack(transcript, clocks.newMap, edits.doc, {
      breakpoints: [],
      landscape: false,
    });
    return React.createElement(
      "div",
      null,
      React.createElement("div", {
        "data-testid": "captions-doc",
        children: JSON.stringify(edits.doc.captions),
      }),
      React.createElement("div", {
        "data-testid": "hidden-doc",
        children: JSON.stringify(edits.doc.captionWordsHidden),
      }),
      React.createElement(TranscriptPanel, {
        baseLines: track.baseLines,
        liveLines: track.liveLines,
        // DISTINCT from `liveLines` here, unlike the older harnesses: the hide
        // below removes a word, and the timing surfaces must key against the
        // surviving track (`postHideLineIndices`).
        timingLines: track.timingLines,
        workdir: null,
        fps: 30,
        playerRef,
        edits,
        onDeleteWords: (plan) => {
          onDeleteWords?.(plan);
          edits.hideCaptionWords(plan.words);
        },
        width: 300,
        // App's `identitySec`, both directions — the phase-2 wiring.
        toPlayerSec: (sec: number) => sec,
        fromPlayerSec: (sec: number) => sec,
      }),
    );
  }

  const word = (i: number) =>
    container.querySelector<HTMLElement>(`[data-testid="transcript-word-${i}"]`)!;
  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };
  const keydown = async (key: string) => {
    const body = container.querySelector<HTMLElement>('[data-testid="transcript-body"]')!;
    await act(async () => {
      body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
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

  it("the revived word is ON SCREEN, in spoken order", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, {}));
    });
    expect([word(0).textContent, word(1).textContent, word(2).textContent]).toEqual([
      "early",
      "during",
      "late",
    ]);
  });

  it("retyping the revived word writes its SOURCE key — the gesture that was impossible", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, {}));
    });
    await act(async () => {
      word(1).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    const input = container.querySelector<HTMLInputElement>('[data-testid="transcript-edit"]')!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "DURING",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.blur();
    });
    // Keyed by SOURCE time (6s → w6000), so the edit outlives the veto: the
    // next render bakes the revived stretch in and the key still finds it.
    const doc = JSON.parse(container.querySelector('[data-testid="captions-doc"]')!.textContent!);
    expect(doc).toEqual({ w6000: { text: "DURING", was: "during" } });
    // And it lands on the rebuilt lines the panel re-renders from.
    expect(word(1).textContent).toBe("DURING");
  });

  it("hiding the revived word lands, and it stays on screen struck through", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, {}));
    });
    await click(word(1));
    await keydown("Delete");
    expect(JSON.parse(container.querySelector('[data-testid="hidden-doc"]')!.textContent!)).toEqual({
      w6000: { was: "during" },
    });
    // The pre-hide stream is what renders, so the word is still selectable
    // and restorable — the same contract the old-clock wiring had.
    expect(word(1).textContent).toBe("during");
    expect(word(1).style.textDecoration).toBe("line-through");
  });

  it("the delete PLAN's window is LIVE-clock seconds — what routes App's `src` resolution", async () => {
    const plans: DeleteWordsPlan[] = [];
    await act(async () => {
      root.render(React.createElement(Harness, { onDeleteWords: (p) => plans.push(p) }));
    });
    await click(word(1));
    await keydown("Delete");
    expect(plans).toHaveLength(1);
    // Source 6 plays at 6 with the pause revived. On the OLD clock output 6
    // is source 8 — a different word entirely — which is exactly why App
    // resolves this window's `src` through `clock.toSourceSec` (live) rather
    // than `oldToSourceSec` whenever these rebuilt streams are the ones fed,
    // routed on the SAME boolean that chose them.
    expect(plans[0]!.startSec).toBeCloseTo(6, 6);
    expect(plans[0]!.endSec).toBeCloseTo(6.3, 6);
    expect(plans[0]!.words).toEqual([{ srcStart: 6, was: "during" }]);
  });
});
