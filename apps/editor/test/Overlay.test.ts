// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PlayerRef } from "@remotion/player";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  livePreviewMap,
  previewClockMappers,
  type KeptSpan,
  type OverrideDoc,
  type SceneCue,
  type Segment,
} from "@ossclip/core/browser";
import { Overlay, blurTypingElement, buildArrayPatch, elementTextOf } from "../src/Overlay";
import { useEdits } from "../src/useEdits";
import { onSaveEffect } from "../src/save";

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

  it("returns null for an out-of-range index", () => {
    expect(elementTextOf("window-0", { windows: [] })).toBeNull();
    expect(elementTextOf("node-5", { nodes: ["A"] })).toBeNull();
  });
});

/**
 * TerminalMock windows (field report 2026-08-07): `window-N` used to return
 * null from both helpers — its lines carry no per-line edit ids (only the
 * window div is tagged, see TerminalMock.tsx), so the Inspector showed NO
 * text control at all for the one component whose whole point is text. The
 * window now round-trips as a newline-joined blob: `elementTextOf` joins
 * `lines`, `buildArrayPatch` splits back, and `title` never rides along.
 */
describe("TerminalMock windows — the window-N id family (field report 2026-08-07)", () => {
  const props = {
    windows: [
      { title: "terminal-01", lines: ["$ run", "ok"] },
      { title: "terminal-02", lines: ["$ test"] },
    ],
    fanOut: "OUTPUT ×1",
  };

  it("reads a window's lines newline-joined for the panel's textarea", () => {
    expect(elementTextOf("window-0", props)).toBe("$ run\nok");
    expect(elementTextOf("window-1", props)).toBe("$ test");
  });

  it("splits the textarea blob back into lines, leaving the title and sibling windows alone", () => {
    expect(buildArrayPatch("window-0", props, "$ build\n$ ship\ndone")).toEqual({
      windows: [
        { title: "terminal-01", lines: ["$ build", "$ ship", "done"] },
        { title: "terminal-02", lines: ["$ test"] },
      ],
    });
  });

  it("preserves deliberate blank lines — split(\"\\n\") keeps empties", () => {
    expect(buildArrayPatch("window-1", props, "$ test\n\npassed")).toEqual({
      windows: [
        { title: "terminal-01", lines: ["$ run", "ok"] },
        { title: "terminal-02", lines: ["$ test", "", "passed"] },
      ],
    });
  });

  it("refuses out-of-range and malformed windows", () => {
    expect(buildArrayPatch("window-2", props, "x")).toBeNull();
    expect(buildArrayPatch("window-0", { windows: ["not-an-object"] }, "x")).toBeNull();
    expect(elementTextOf("window-0", { windows: [{ title: "t", lines: [1, 2] }] })).toBeNull();
  });

  // TerminalMockProps caps windows at 6 lines of 40 chars, and the override
  // merge never re-validates props — so the COMMIT path is where the bound
  // lives: a 7th line or a 41st char silently truncates rather than writing
  // an out-of-schema override that a swap-away-and-back would drop.
  it("clamps a 7-line blob to the schema's 6 lines", () => {
    const patch = buildArrayPatch("window-1", props, "1\n2\n3\n4\n5\n6\n7");
    expect((patch?.windows as Array<{ lines: string[] }>)[1]?.lines).toEqual([
      "1", "2", "3", "4", "5", "6",
    ]);
  });

  it("clamps a 41-char line to the schema's 40", () => {
    const long = "x".repeat(41);
    const patch = buildArrayPatch("window-1", props, long);
    const lines = (patch?.windows as Array<{ lines: string[] }>)[1]?.lines;
    expect(lines).toEqual(["x".repeat(40)]);
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

/**
 * Field report 2026-08-07: double-clicking a caption opened the inline edit
 * box, but clicking INSIDE it — to place the cursor or select text — closed
 * it again. The bug-6 blur above fired on every stage mousedown, including
 * the one that landed on the caption editor itself (App.tsx renders Overlay
 * INSIDE the stage div, so the editor's fixed-position input is
 * `stage.contains()`-true); the editor commits-and-closes on blur, so the
 * click killed the edit the double-click just opened. This drives the REAL
 * caption flow — dblclick to open, mousedown inside, mousedown away — so
 * both the fix and bug 6's surviving behavior stay pinned together.
 */
describe("caption editor vs. the stage-mousedown blur (field report 2026-08-07)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function Harness() {
    const edits = useEdits();
    const stageRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<PlayerRef>(null);
    // Overlay mounts INSIDE the stage div — App.tsx's real nesting, and the
    // detail that puts the caption editor's input under the stage listener.
    return React.createElement(
      "div",
      { ref: stageRef, "data-testid": "stage" },
      React.createElement("div", {
        "data-testid": "caption-word",
        "data-caption-word": "0",
        "data-caption-text": "hello",
        // The SOURCE anchor CaptionTrack emits since §137 — without it the
        // word is one the editor refuses to retype, and the double-click
        // below would never open the editor this test is about.
        "data-caption-src": "1.7675",
      }),
      // A word from a pre-§137 workdir: CaptionTrack omits `data-caption-src`
      // for anything it cannot anchor, so this is what the DOM really looks
      // like when the load-path repair could not run (a spans-less or corrupt
      // render-props.json). Its own test is below.
      React.createElement("div", {
        "data-testid": "caption-word-anchorless",
        "data-caption-word": "1",
        "data-caption-text": "hello",
      }),
      React.createElement("div", { "data-testid": "stage-elsewhere" }),
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
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("mousedown INSIDE the open caption editor keeps it open and focused; mousedown elsewhere on the stage still commits-and-closes it (bug 6 survives)", async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    const word = container.querySelector<HTMLElement>('[data-testid="caption-word"]')!;
    // jsdom has no layout: point the hit-test walk straight at the word so
    // the dblclick handler resolves it the way `elementBelow` would.
    document.elementFromPoint = () => word;
    await act(async () => {
      word.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    const editor = container.querySelector<HTMLInputElement>('[data-testid="caption-edit"]')!;
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);

    // The reported gesture: a click inside the box to place the cursor.
    await act(async () => {
      editor.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    expect(container.querySelector('[data-testid="caption-edit"]')).toBe(editor);
    expect(document.activeElement).toBe(editor);

    // Bug 6 must survive: a mousedown AWAY from the editor still blurs it,
    // which is exactly the editor's commit-and-close path.
    document.elementFromPoint = () => null;
    const elsewhere = container.querySelector<HTMLElement>('[data-testid="stage-elsewhere"]')!;
    await act(async () => {
      elsewhere.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    expect(container.querySelector('[data-testid="caption-edit"]')).toBeNull();
    expect(document.activeElement).not.toBe(editor);
  });

  /**
   * §137 review, Important 2. A caption word with no `data-caption-src` is one
   * the editor cannot key an edit on — a pre-§137 workdir whose spans could not
   * be repaired. Opening the box anyway would let the user type a correction
   * and blur, and the commit would call `captionKeyFor` with a non-finite
   * anchor: that THROWS by design, from a `window` event handler with no error
   * boundary above it (`main.tsx` renders `<App/>` bare), so the whole editor
   * white-screens over a file that merely predates a field. Today's behaviour
   * on such a workdir is a no-op; the guard is what keeps it one.
   */
  it("refuses to open the retype box on a word carrying no source anchor", async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    const word = container.querySelector<HTMLElement>('[data-testid="caption-word-anchorless"]')!;
    document.elementFromPoint = () => word;
    await act(async () => {
      word.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="caption-edit"]')).toBeNull();
  });
});

/**
 * The gap the scoped re-review flagged: Finding 1's guard (`onSaveEffect`,
 * save.ts) had correct render-running logic, but App.tsx's first cut wired
 * a block through `setError` — the app's FATAL, full-screen, no-dismiss
 * view — so a ⌘S during a render killed the whole editor instead of
 * showing a routine notice. A pure test of `onSaveEffect` alone (its own
 * `save.test.ts`) cannot see that: the bug was in the GLUE, not the
 * decision. This mounts `Overlay` with the SAME `onSaveEffect` App.tsx
 * calls, wired to real `useState` standing in for `error`/
 * `saveBlockedNotice` exactly as App.tsx wires them, and dispatches a real
 * `keydown` at `window` (Overlay's own listener target) — the actual path
 * a user's ⌘S takes, not a direct function call.
 */
describe("⌘S while a render is running — the real onSave wiring (PLAN 2026-08-04 fix wave, scoped re-review)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function SaveHarness({
    renderRunning,
    startDirty,
  }: {
    renderRunning: boolean;
    startDirty: boolean;
  }) {
    const edits = useEdits();
    const stageRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<PlayerRef>(null);
    const [error, setError] = useState<string | null>(null);
    const [saveBlockedNotice, setSaveBlockedNotice] = useState(false);
    // Seeds a real dirty doc through the actual reducer — never a hand-set
    // boolean standing in for `edits.dirty` — so this test exercises the
    // same `dirty` value App.tsx's `onSave` reads.
    React.useEffect(() => {
      if (startDirty) edits.patchProps("scene-0", { value: "1%" });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Byte-identical to App.tsx's `onSave` — see that file's own comment
    // beside its call to `onSaveEffect`.
    const onSave = () => {
      onSaveEffect({
        dirty: edits.dirty,
        renderRunning,
        save: edits.save,
        onBlocked: () => setSaveBlockedNotice(true),
        onSaveError: (message) => setError(message),
      });
    };
    return React.createElement(
      React.Fragment,
      null,
      // Stand-ins for App.tsx's `error`/`saveBlockedNotice`-driven UI —
      // enough to assert on without mounting the whole app shell.
      React.createElement("div", { "data-testid": "error", "data-value": error ?? "" }),
      React.createElement("div", {
        "data-testid": "save-blocked-notice",
        "data-value": saveBlockedNotice ? "shown" : "hidden",
      }),
      React.createElement("div", { ref: stageRef, "data-testid": "stage" }),
      React.createElement(Overlay, {
        stageRef,
        selection: null,
        onSelect: vi.fn(),
        edits,
        onSave,
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
    document.elementFromPoint = () => null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  const cmdS = () =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }),
      );
    });

  it("blocks the PUT, shows the dismissible notice, and does NOT switch to the fatal error view", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await act(async () => {
      root.render(React.createElement(SaveHarness, { renderRunning: true, startDirty: true }));
    });
    await cmdS();
    // (a) no PUT fires.
    expect(fetchSpy).not.toHaveBeenCalled();
    // (b) the fatal view's trigger (`error`) never got set.
    expect(container.querySelector('[data-testid="error"]')!.getAttribute("data-value")).toBe("");
    // (c) the dismissible notice DID show — the block was surfaced, just not fatally.
    expect(
      container.querySelector('[data-testid="save-blocked-notice"]')!.getAttribute("data-value"),
    ).toBe("shown");
  });

  it("does nothing on a CLEAN doc — a reflexive ⌘S with nothing to save is a no-op, not a lockout", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await act(async () => {
      root.render(React.createElement(SaveHarness, { renderRunning: true, startDirty: false }));
    });
    await cmdS();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="error"]')!.getAttribute("data-value")).toBe("");
    expect(
      container.querySelector('[data-testid="save-blocked-notice"]')!.getAttribute("data-value"),
    ).toBe("hidden");
  });

  it("saves normally through the same wiring once no render is running", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await act(async () => {
      root.render(React.createElement(SaveHarness, { renderRunning: false, startDirty: true }));
    });
    // The dispatch AND the `save()` promise chain it kicks off (which ends
    // in a `dispatch({type:"saved"})` React update) must be in the SAME
    // `act` call — splitting them, as an earlier draft of this test did,
    // let the state update land after `act` had already returned and
    // warned about testing outside of `act`.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/overrides",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(container.querySelector('[data-testid="error"]')!.getAttribute("data-value")).toBe("");
    expect(
      container.querySelector('[data-testid="save-blocked-notice"]')!.getAttribute("data-value"),
    ).toBe("hidden");
  });
});

/**
 * ⌘B under a LIVE cleanup veto (cut review step 4 follow-up, WRITE
 * direction): the playhead speaks the player's re-cut NEW clock, but
 * `splits[].at` speaks the LAST RENDER's output seconds. Mounted like the
 * ⌘S suite above — a real keydown at `window`, a real `useEdits` reducer —
 * with the REAL mappers (`livePreviewMap` + `previewClockMappers`, produce's
 * own functions) over the canonical one-vetoed-pause case: source 5..7
 * revived, old clock 8s, live clock 10s, so live t past the pause is old
 * t − 2 by hand.
 */
describe("⌘B split under a live cleanup veto — old-clock write, revived-material refusal (step 4 follow-up)", () => {
  const proposal: Segment[] = [
    { srcIn: 0, srcOut: 5, kind: "keep" },
    { srcIn: 5, srcOut: 7, kind: "remove", reason: "pause", confidence: 0.9 },
    { srcIn: 7, srcOut: 10, kind: "keep" },
  ];
  const oldSpans: KeptSpan[] = [
    { srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 },
    { srcIn: 7, srcOut: 10, outIn: 5, outOut: 8 },
  ];
  const mappers = previewClockMappers(
    livePreviewMap(proposal, { reasons: { pause: false } }, [], oldSpans),
  );
  /** One take covering the whole live clock, so any mid-timeline playhead
   * clears the SPLIT_MIN_PIECE_SEC edge guard — that guard is not under
   * test here. */
  const take: SceneCue = {
    id: "take-0",
    kind: "plain",
    layout: "video-top",
    startSec: 0,
    endSec: 10,
  };
  const FPS = 30;

  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function SplitHarness({
    playheadSec,
    withMappers,
    onClockRefused,
    onDocChange,
  }: {
    playheadSec: number;
    /** Omitted = the identity-default (no-veto) path — the regression anchor. */
    withMappers?: boolean;
    onClockRefused?: (message: string) => void;
    onDocChange?: (doc: OverrideDoc) => void;
  }) {
    const edits = useEdits();
    const stageRef = useRef<HTMLDivElement>(null);
    // The ⌘B handler only reads `getCurrentFrame()` — a tiny stub, the
    // Timeline tests' own posture, not a whole Remotion player.
    const playerRef = useRef<PlayerRef>({
      getCurrentFrame: () => Math.round(playheadSec * FPS),
    } as unknown as PlayerRef);
    React.useEffect(() => {
      onDocChange?.(edits.doc);
    });
    return React.createElement(
      React.Fragment,
      null,
      React.createElement("div", { ref: stageRef, "data-testid": "stage" }),
      React.createElement(Overlay, {
        stageRef,
        selection: null,
        onSelect: vi.fn(),
        edits,
        onSave: vi.fn(),
        settings: { width: 1080, height: 1920, fps: FPS },
        cues: [take],
        onToggleHelp: vi.fn(),
        playerRef,
        onTransport: vi.fn(),
        onVideoPreview: vi.fn(),
        onGraphicPreview: vi.fn(),
        cue: null,
        ...(withMappers
          ? {
              fromLive: mappers.fromLive,
              hasOldClockPreimage: mappers.hasOldClockPreimage,
            }
          : {}),
        onClockRefused,
      }),
    );
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    document.elementFromPoint = () => null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const cmdB = () =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true, cancelable: true }),
      );
    });

  it("no veto (identity defaults): the playhead second is stored bit-identically to before", async () => {
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(SplitHarness, { playheadSec: 4, onDocChange: (d) => (doc = d) }),
      );
    });
    await cmdB();
    expect(doc!.splits).toHaveLength(1);
    expect(doc!.splits[0]!.at).toBe(4);
  });

  it("live veto, playhead in kept material: stores the last render's own second — live 8 stores 6", async () => {
    const refused = vi.fn();
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(SplitHarness, {
          playheadSec: 8,
          withMappers: true,
          onClockRefused: refused,
          onDocChange: (d) => (doc = d),
        }),
      );
    });
    await cmdB();
    expect(doc!.splits).toHaveLength(1);
    expect(doc!.splits[0]!.at).toBe(6);
    expect(refused).not.toHaveBeenCalled();
  });

  it("live veto, playhead inside REVIVED material: refuses out loud, writes nothing", async () => {
    const refused = vi.fn();
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(SplitHarness, {
          playheadSec: 6,
          withMappers: true,
          onClockRefused: refused,
          onDocChange: (d) => (doc = d),
        }),
      );
    });
    await cmdB();
    expect(refused).toHaveBeenCalledWith(expect.stringContaining("isn't in the last render yet"));
    expect(doc!.splits).toEqual([]);
  });
});
