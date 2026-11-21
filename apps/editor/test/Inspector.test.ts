// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOverrides,
  defaultTheme,
  LayoutSchema,
  OverrideDocSchema,
  scalarPropControls,
  livePreviewMap,
  plannerComponentIds,
  scriptComponentIds,
  previewClockMappers,
  type KeptSpan,
  type OverrideDoc,
  type SceneCue,
  type Segment,
} from "@ossclip/core/browser";
import { Inspector, componentSwapOptions, propControlHint } from "../src/Inspector";
import { useEdits } from "../src/useEdits";

// Same one-time act() opt-in as project-picker.test.ts — this is the
// second file in the repo to mount a component (rather than render static
// markup), and there is still no test-utils layer to infer it from.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const graphicCue: SceneCue = {
  id: "scene-0",
  kind: "graphic",
  layout: "lower-third",
  component: "TitleCard",
  props: { title: "SHIP IT", eyebrow: "BREAKING" },
  startSec: 0,
  endSec: 30,
  elements: { title: { scale: 1.4 } },
};

const takeCue: SceneCue = {
  id: "take-0",
  kind: "plain",
  layout: "video-top",
  startSec: 30,
  endSec: 40,
};

/**
 * Wires a real `useEdits()` reducer to `Inspector` so a button's `onClick`
 * runs the ACTUAL dispatch/re-render cycle — this is what distinguishes
 * "Delete scene" (which switches the whole panel to the restore view,
 * unmounting the button) from "Reset element" (which re-renders the SAME
 * panel shape, keeping the button's DOM node and its focus). Both cases are
 * covered because the bug 4 fix (`blurActive` in Inspector.tsx) has to hold
 * for both, not just the one where an incidental unmount already helped.
 */
function Harness({
  selection,
  cue = graphicCue,
  initialCuts,
  initialScenes,
  onSelect = () => {},
  onDocChange,
  fromLive,
  hasOldClockPreimage,
  toSourceSec,
  onClockRefused,
}: {
  selection: { sceneId: string; elementId: string | null };
  cue?: SceneCue;
  /** Pre-loads `doc.cuts` (like a workdir the editor re-opened) before the
   * Inspector ever mounts — for the "already cut" view, which the Harness's
   * own dispatch cycle can't reach any other way (there's no "select an
   * already-cut block" gesture to simulate; the match is on window). `src`
   * is settable so tests can cover the review fix wave's finding 1: an
   * ALREADY-APPLIED cut (src present) must NEVER trigger this view, even on
   * an exact window match. */
  initialCuts?: { startSec: number; endSec: number; src?: { startSec: number; endSec: number } }[];
  /**
   * Pre-loads `doc.scenes[id].elements` for one or more scene ids (PLAN
   * Task 2; keyed by id rather than fixed to "scene-0" per the review fix
   * wave — the split-half Restore test needs to preload the ROOT id, which
   * is a DIFFERENT scene than the half `selection.sceneId` points at) —
   * same mount-once-load shape as `initialCuts`. The `cue` prop this
   * Harness hands to `Inspector` is STATIC (it never re-derives from
   * `edits.doc` the way App.tsx's real `live` memo does), so a Restore
   * click's effect is only observable through `edits.doc` itself — this is
   * what gives that click a real entry to act on rather than a no-op
   * against an empty doc.
   */
  initialScenes?: Record<
    string,
    { elements: Record<string, { dx?: number; dy?: number; scale?: number; hidden?: boolean }> }
  >;
  onSelect?: (s: { sceneId: string; elementId: string | null } | null) => void;
  /** Fires on every render with the CURRENT `edits.doc` — the only way this
   * Harness exposes the real reducer state to a test's assertions. */
  onDocChange?: (doc: OverrideDoc) => void;
  /** The cut button's write boundary under a live cleanup veto (step 4
   * follow-up) — omitted everywhere else, so every pre-existing test pins
   * the identity-default (no-veto) path. `toSourceSec` omitted likewise
   * pins Inspector's null default: the no-source-mapper fallback, which is
   * the pre-rework flow verbatim. */
  fromLive?: (sec: number) => number;
  hasOldClockPreimage?: (sec: number) => boolean;
  toSourceSec?: ((sec: number) => number) | null;
  onClockRefused?: (message: string) => void;
}) {
  const edits = useEdits();
  React.useEffect(() => {
    if (initialCuts || initialScenes) {
      edits.load({
        theme: {},
        scenes: initialScenes
          ? Object.fromEntries(
              Object.entries(initialScenes).map(([id, s]) => [id, { props: {}, ...s }]),
            )
          : {},
        captions: {},
        splits: [],
        cuts: initialCuts ?? [],
      });
    }
    // Mount-once load, same shape as App.tsx's own `loadProduction` effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Runs after every render (no dep array) — a plain effect, not a render-
  // time call, so it stays a side effect rather than breaking React's
  // render-must-be-pure rule just to hand a test its assertion data.
  React.useEffect(() => {
    onDocChange?.(edits.doc);
  });
  return React.createElement(Inspector, {
    selection,
    cue,
    frame: { width: 1080, height: 1920 },
    allSceneIds: ["scene-0"],
    edits,
    onSelect,
    resolvedTheme: defaultTheme,
    onVideoPreview: vi.fn(),
    fromLive,
    hasOldClockPreimage,
    toSourceSec,
    onClockRefused,
  });
}

/**
 * Field report 2026-08-07: selecting a TerminalMock `window-N` showed the
 * element panel with NO text control at all (only Scale/X/Y/Reset/Delete) —
 * `elementTextOf` refused windows outright, and the window's lines carry no
 * per-line edit ids to fall back on. A window now edits as a multiline
 * TEXTAREA (one row per terminal line) committing through
 * `buildArrayPatch`'s window arm on every change, like every other field.
 */
describe("Inspector — TerminalMock window-N text edits via a textarea (field report 2026-08-07)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const terminalCue: SceneCue = {
    id: "scene-0",
    kind: "graphic",
    layout: "lower-third",
    component: "TerminalMock",
    props: { windows: [{ title: "terminal-01", lines: ["$ run", "ok"] }], fanOut: "OUTPUT ×1" },
    startSec: 0,
    endSec: 30,
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

  it("renders the window's lines newline-joined in a TEXTAREA, not the single-line input", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "scene-0", elementId: "window-0" },
          cue: terminalCue,
        }),
      );
    });
    const field = container.querySelector<HTMLTextAreaElement>('[data-testid="element-text"]')!;
    expect(field).not.toBeNull();
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.value).toBe("$ run\nok");
  });

  it("commits an edit through buildArrayPatch's window arm — newline per line, title untouched", async () => {
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "scene-0", elementId: "window-0" },
          cue: terminalCue,
          onDocChange: (d) => {
            doc = d;
          },
        }),
      );
    });
    const field = container.querySelector<HTMLTextAreaElement>('[data-testid="element-text"]')!;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(field, "$ build\n$ ship\ndone");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(doc?.scenes["scene-0"]?.props?.windows).toEqual([
      { title: "terminal-01", lines: ["$ build", "$ ship", "done"] },
    ]);
  });

  it("a plain top-level string prop still gets the single-line INPUT — the textarea is windows-only", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "scene-0", elementId: "title" },
        }),
      );
    });
    const field = container.querySelector<HTMLInputElement>('[data-testid="element-text"]')!;
    expect(field.tagName).toBe("INPUT");
    expect(field.value).toBe("SHIP IT");
  });
});

/**
 * CardRow (§161, plan Task 4): a card is two texts in one box, edited as two
 * lines of one textarea — and through the Overlay's single DYNAMIC_ID, which
 * the Inspector imports rather than restates (a copy without `card` would
 * have written the retype to a `card-0` prop nothing reads).
 */
describe("Inspector — CardRow card-N edits as two lines", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const cardCue: SceneCue = {
    id: "scene-0",
    kind: "graphic",
    layout: "full-bleed",
    component: "CardRow",
    props: { cards: [{ text: "Draft", sub: "one", icon: "doc" }, { text: "Review", icon: "none" }] },
    startSec: 0,
    endSec: 30,
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

  it("shows text and sub in a TEXTAREA and commits both through buildArrayPatch", async () => {
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "scene-0", elementId: "card-0" },
          cue: cardCue,
          onDocChange: (d) => {
            doc = d;
          },
        }),
      );
    });
    const field = container.querySelector<HTMLTextAreaElement>('[data-testid="element-text"]')!;
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.value).toBe("Draft\none");
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(field, "Write\ntests first");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(doc?.scenes["scene-0"]?.props?.cards).toEqual([
      { text: "Write", sub: "tests first", icon: "doc" },
      { text: "Review", icon: "none" },
    ]);
  });
});

describe("Inspector — destructive/mutating buttons blur on click (PLAN 2026-08-04 Task 2, bug 4)", () => {
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

  it("delete-scene: the click hides the scene and blurs — the panel swap is App's remap now", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { selection: { sceneId: "scene-0", elementId: null } }));
    });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="delete-scene"]')!;
    expect(btn).not.toBeNull();
    btn.focus();
    expect(document.activeElement).toBe(btn);
    await act(async () => {
      btn.click();
    });
    // Since the 2026-08-31 redesign the Inspector no longer branches on
    // `hidden` itself — a hidden selection is remapped by App onto the
    // covering take (which carries the Restore chip), so in this harness the
    // panel stays mounted. The button's own blur contract still holds.
    expect(document.activeElement).toBe(document.body);
  });

  it("reset-element: the SAME button survives the re-render, and must lose focus explicitly", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, { selection: { sceneId: "scene-0", elementId: "title" } }),
      );
    });
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Reset element",
    )!;
    expect(btn).toBeTruthy();
    btn.focus();
    expect(document.activeElement).toBe(btn);
    await act(async () => {
      btn.click();
    });
    // Without the fix this assertion is exactly where it fails: React
    // reuses the identical node (same position, same type — only the
    // element's `scale` changed), so the button is still mounted and would
    // still hold focus if its own click handler didn't blur it.
    expect(container.contains(btn)).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("delete-element: blurs, dispatches hideElement, and drops the selection to the scene (not to nothing) (PLAN Task 2)", async () => {
    let doc: OverrideDoc | undefined;
    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "scene-0", elementId: "title" },
          onSelect,
          onDocChange: (d) => {
            doc = d;
          },
        }),
      );
    });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="delete-element"]')!;
    expect(btn).not.toBeNull();
    btn.focus();
    expect(document.activeElement).toBe(btn);
    await act(async () => {
      btn.click();
    });
    // Unlike delete-scene, this click does NOT unmount the button: the
    // element branch is gated on `selection?.elementId` (a prop this
    // Harness — like the real App.tsx — holds separately from `edits.doc`),
    // and `onSelect(null)` only updates that prop in the real app, where
    // App's own `setSelection` re-renders Inspector with a different
    // `selection`. This static-selection Harness can't reproduce that
    // second hop, so the SAME button survives its own click here — the
    // blur assertion below is exactly the non-vacuous case the reset-element
    // test above already established the pattern for.
    expect(container.contains(btn)).toBe(true);
    expect(document.activeElement).toBe(document.body);
    expect(doc?.scenes["scene-0"]?.elements?.title).toEqual({ hidden: true });
    // Drops to the SCENE, not to nothing — lands the user on the very panel
    // ("Hidden elements" Restore, tested below) that now offers a way back.
    expect(onSelect).toHaveBeenCalledWith({ sceneId: "scene-0", elementId: null });
  });

  // No dedicated cut-chunk/restore-chunk blur tests here (fix wave Minor
  // (b), PLAN 2026-08-04 Task 4c): BOTH always swap the whole panel to a
  // different view shape on click (cut-chunk → the Restore view;
  // restore-chunk → back to the normal take/scene view), exactly like
  // delete-scene above — there is no way to construct a version of either
  // where the SAME button survives its own click, so a dedicated test could
  // only ever repeat delete-scene's own already-acknowledged non-discriminating
  // assertion under a different name. Their functional behavior (the button
  // disappearing, the OTHER view's button appearing) is covered by the
  // "Inspector — user cuts" describe block below.
});

const graphicCueWithHiddenElement: SceneCue = {
  ...graphicCue,
  elements: { title: { scale: 1.4 }, eyebrow: { hidden: true } },
};

describe("Inspector — the SCENE panel's hidden-elements Restore list (PLAN Task 2)", () => {
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

  it("lists a hidden element by id, alongside the scene's other controls (not instead of them)", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "scene-0", elementId: null },
          cue: graphicCueWithHiddenElement,
        }),
      );
    });
    expect(container.querySelector('[data-testid="restore-element-eyebrow"]')).not.toBeNull();
    // Not the exclusive ghost/marked-for-removal view — the scene itself is
    // live, only one of its elements is hidden.
    expect(container.querySelector('[data-testid="delete-scene"]')).not.toBeNull();
  });

  it("nothing rendered when no element on this cue is hidden", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, { selection: { sceneId: "scene-0", elementId: null } }),
      );
    });
    expect(container.querySelector('[data-testid^="restore-element-"]')).toBeNull();
  });

  it("Restore blurs and dispatches restoreElement, deleting only the hidden key", async () => {
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "scene-0", elementId: null },
          cue: graphicCueWithHiddenElement,
          // A REAL doc entry to restore — the `cue` prop above is display-only
          // (see the Harness's own doc comment on `initialScenes`).
          initialScenes: { "scene-0": { elements: { eyebrow: { hidden: true } } } },
          onDocChange: (d) => {
            doc = d;
          },
        }),
      );
    });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="restore-element-eyebrow"]')!;
    expect(btn).not.toBeNull();
    btn.focus();
    expect(document.activeElement).toBe(btn);
    await act(async () => {
      btn.click();
    });
    expect(document.activeElement).toBe(document.body);
    // The hidden key is gone; there was nothing else on this entry to
    // survive (no prior nudge), so the whole entry is deleted rather than
    // left as an empty `{}` leftover (review fix wave, bundled minor (a) —
    // an empty entry would still shadow an inherited root nudge on a split
    // half; see `restoreElement`'s own comment in overrides.ts, and its
    // unit tests for the case WITH a prior nudge to preserve).
    expect(doc?.scenes["scene-0"]?.elements?.eyebrow).toBeUndefined();
    expect("eyebrow" in (doc?.scenes["scene-0"]?.elements ?? {})).toBe(false);
  });

  it("split half: a hidden id inherited from the ROOT dispatches Restore against the ROOT id, not the half's own (silently no-op-ing) entry (review fix wave, Important 1)", async () => {
    let doc: OverrideDoc | undefined;
    // The RESOLVED half cue, exactly as `effectiveOverride` +
    // `applyOverrides` would actually produce it: `elements` merges per id
    // across root/half (unlike `timing`/`hidden`, which are excluded from
    // that inheritance), so the half's own resolved `cue.elements` already
    // shows the root's hidden flag even though nothing was ever written
    // directly onto the half's own doc entry.
    const halfCue: SceneCue = {
      ...takeCue,
      id: "take-0@4000",
      elements: { title: { hidden: true } },
    };
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "take-0@4000", elementId: null },
          cue: halfCue,
          // The hidden flag lives on the ROOT's own raw doc entry — the
          // half ("take-0@4000") has NO entry of its own at all, which is
          // exactly the shape that made the pre-fix Restore button a silent
          // no-op (it dispatched against the half id and found nothing).
          initialScenes: { "take-0": { elements: { title: { hidden: true } } } },
          onDocChange: (d) => {
            doc = d;
          },
        }),
      );
    });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="restore-element-title"]')!;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn.click();
    });
    // The ROOT's raw entry lost `hidden` — not the half's (it never had one
    // to lose).
    expect("title" in (doc?.scenes["take-0"]?.elements ?? {})).toBe(false);
    expect(doc?.scenes["take-0@4000"]).toBeUndefined();
  });
});

/**
 * A cue that RE-DERIVES from `edits.doc` on every render, via the same
 * `applyOverrides` call App.tsx's real `live` memo makes — unlike `Harness`
 * above, whose `cue` prop is a fixed fixture the test hands it once. Every
 * other test in this file necessarily proves its claims across TWO static
 * fixtures (a "before" cue and, where needed, an "after" one) because
 * `Harness` can't show a click's effect on the thing it just clicked. This
 * one instead runs the full delete → relist → restore → delist loop through
 * ONE mounted component and ONE re-rendering cue, the seam the review named.
 */
function DynamicHarness({ baseCue }: { baseCue: SceneCue }) {
  const edits = useEdits();
  const [selection, setSelection] = React.useState<{ sceneId: string; elementId: string | null } | null>(
    { sceneId: baseCue.id, elementId: "title" },
  );
  const cue = React.useMemo(() => applyOverrides([baseCue], edits.doc).cues[0]!, [baseCue, edits.doc]);
  return React.createElement(Inspector, {
    selection,
    cue,
    frame: { width: 1080, height: 1920 },
    allSceneIds: [baseCue.id],
    edits,
    onSelect: setSelection,
    resolvedTheme: defaultTheme,
    onVideoPreview: vi.fn(),
  });
}

describe("Inspector — delete → list → restore → delist, through one re-rendering cue (PLAN Task 2 review fix)", () => {
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

  it("Delete element puts it in the scene's Hidden-elements list; Restore takes it back out", async () => {
    await act(async () => {
      root.render(React.createElement(DynamicHarness, { baseCue: graphicCue }));
    });
    // Starts on the element panel — `title` is selected.
    const deleteBtn = container.querySelector<HTMLButtonElement>('[data-testid="delete-element"]')!;
    expect(deleteBtn).not.toBeNull();
    await act(async () => {
      deleteBtn.click();
    });
    // Selection dropped to the scene (per `onSelect`'s own contract), and
    // the resolved cue re-derived through the REAL `edits.doc` now carries
    // the hidden flag — landing the Inspector on the scene panel with the
    // element listed for Restore.
    const restoreBtn = container.querySelector<HTMLButtonElement>('[data-testid="restore-element-title"]')!;
    expect(restoreBtn).not.toBeNull();
    await act(async () => {
      restoreBtn.click();
    });
    // Gone from the list — the SAME re-rendering cue now shows it unhidden.
    expect(container.querySelector('[data-testid="restore-element-title"]')).toBeNull();
  });
});

describe("Inspector — user cuts (PLAN 2026-08-04 Task 4c)", () => {
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

  it("offers Delete this chunk on a plain TAKE, not just a scene — the actual dogfooding ask", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "take-0", elementId: null },
          cue: takeCue,
        }),
      );
    });
    expect(container.querySelector('[data-testid="cut-chunk"]')).not.toBeNull();
    // A take has no "Delete scene" — that button only ever hides a graphic.
    expect(container.querySelector('[data-testid="delete-scene"]')).toBeNull();
  });

  it("offers Delete this chunk on a scene too, alongside (not instead of) Delete scene", async () => {
    await act(async () => {
      root.render(React.createElement(Harness, { selection: { sceneId: "scene-0", elementId: null } }));
    });
    expect(container.querySelector('[data-testid="cut-chunk"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="delete-scene"]')).not.toBeNull();
  });

  it("shows Restore instead of Delete this chunk once the cue's window has a matching cut", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "scene-0", elementId: null },
          initialCuts: [{ startSec: graphicCue.startSec, endSec: graphicCue.endSec }],
        }),
      );
    });
    expect(container.querySelector('[data-testid="restore-chunk"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cut-chunk"]')).toBeNull();
    // The marked-for-removal view is exclusive, same as the hidden-scene
    // view above it — no editing controls should be reachable underneath.
    expect(container.querySelector('[data-testid="delete-scene"]')).toBeNull();
  });

  it("review finding 1: an ALREADY-APPLIED cut (src present) never triggers the marked-for-removal view, even on an exact window match", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "scene-0", elementId: null },
          initialCuts: [
            {
              startSec: graphicCue.startSec,
              endSec: graphicCue.endSec,
              src: { startSec: 43.4, endSec: 55.3 },
            },
          ],
        }),
      );
    });
    // The window matches exactly — a src-LESS cut here would show Restore
    // (proven by the sibling test below). With `src` present, the material
    // at this window is a HISTORICAL record only (schema comment on
    // `OverrideDocSchema.cuts`) — this scene is live content, so the normal
    // edit view (with "Delete this chunk") is what must show.
    expect(container.querySelector('[data-testid="cut-chunk"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="restore-chunk"]')).toBeNull();
  });

  it("a cut recorded at a DIFFERENT window than the selected cue does not trigger the Restore view", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "scene-0", elementId: null },
          initialCuts: [{ startSec: 100, endSec: 110 }],
        }),
      );
    });
    expect(container.querySelector('[data-testid="cut-chunk"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="restore-chunk"]')).toBeNull();
  });

  it("clicking Delete this chunk writes exactly the cue's own window, and Restore removes it again", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "take-0", elementId: null },
          cue: takeCue,
        }),
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="cut-chunk"]')!.click();
    });
    expect(container.querySelector('[data-testid="restore-chunk"]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="restore-chunk"]')!.click();
    });
    expect(container.querySelector('[data-testid="cut-chunk"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="restore-chunk"]')).toBeNull();
  });
});

/**
 * "Delete this chunk" under a LIVE cleanup veto (cut review step 4
 * follow-up, WRITE direction; reworked 2026-08-26): the cue window speaks
 * the player's re-cut NEW clock, while a `cuts[]` entry's own seconds speak
 * the LAST RENDER's and its `src` speaks SOURCE time — so the button
 * DUAL-WRITES, the ⌘B posture. The mappers are the real ones —
 * `livePreviewMap` + `previewClockMappers`, produce's own functions — over
 * the canonical one-vetoed-pause case (source 5..7 revived; old clock 8s,
 * live clock 10s), so every expected number is hand-mappable: live t past
 * the pause is old t − 2, and live t IS source t (the re-kept cutlist keeps
 * all of 0..10). The last two tests pin the OTHER flow — `toSourceSec` null,
 * where the refusal and the shrink warning survive unchanged.
 */
describe("Inspector — Delete this chunk anchors to source under a live veto (cut-review rework)", () => {
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
  /** A take at a LIVE-clock window — what App's retimed cues hand Inspector. */
  const liveTake = (startSec: number, endSec: number): SceneCue => ({
    id: "take-0",
    kind: "plain",
    layout: "video-top",
    startSec,
    endSec,
  });

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
    vi.restoreAllMocks();
  });

  const mount = async (
    cue: SceneCue,
    onClockRefused: (m: string) => void,
    capture: { doc?: OverrideDoc },
    /** Explicit so each test says which of the two flows it is pinning: the
     * dual-write (a mapper present) or the no-mapper fallback (null). */
    toSourceSec: ((sec: number) => number) | null = mappers.toSourceSec,
  ) => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "take-0", elementId: null },
          cue,
          fromLive: mappers.fromLive,
          hasOldClockPreimage: mappers.hasOldClockPreimage,
          toSourceSec,
          onClockRefused,
          onDocChange: (doc) => {
            capture.doc = doc;
          },
        }),
      );
    });
  };

  const clickCut = async () => {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="cut-chunk"]')!.click();
    });
  };

  it("a window in kept material DUAL-writes: the last render's own seconds plus the source anchor — live 8..9 stores 6..7 + src 8..9", async () => {
    const refused = vi.fn();
    const capture: { doc?: OverrideDoc } = {};
    await mount(liveTake(8, 9), refused, capture);
    await clickCut();
    // The live clock keeps all of 0..10, so live seconds ARE source seconds
    // here — while the old-clock record sits the revived 2s earlier.
    expect(capture.doc!.cuts).toEqual([
      { startSec: 6, endSec: 7, src: { startSec: 8, endSec: 9 } },
    ]);
    expect(refused).not.toHaveBeenCalled();
  });

  it("a window entirely inside REVIVED material writes a src cut with a CLAMPED record — the field report's own gesture, no longer refused", async () => {
    const refused = vi.fn();
    const capture: { doc?: OverrideDoc } = {};
    await mount(liveTake(5.5, 6.5), refused, capture);
    await clickCut();
    // No old-clock extent at all (both ends clamp to the seam at old 5), so
    // the record is degenerate-but-honest — it is never authoritative once
    // `src` is present (the schema comment) — and the source anchor is exact.
    expect(capture.doc!.cuts).toEqual([
      { startSec: 5, endSec: 5, src: { startSec: 5.5, endSec: 6.5 } },
    ]);
    expect(refused).not.toHaveBeenCalled();
  });

  it("a window straddling a revived edge anchors EXACTLY — live 4..6 stores src 4..6, no shrink, no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = vi.fn();
    const capture: { doc?: OverrideDoc } = {};
    await mount(liveTake(4, 6), refused, capture);
    await clickCut();
    // The record still shrinks to what the old clock can express (4..5), but
    // nothing is LOST any more: `src` carries the whole window, so the shrink
    // warning would be a lie.
    expect(capture.doc!.cuts).toEqual([
      { startSec: 4, endSec: 5, src: { startSec: 4, endSec: 6 } },
    ]);
    expect(refused).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("NO source mapper: the pre-rework flow verbatim — a window with no old-clock extent is refused out loud and writes nothing", async () => {
    const refused = vi.fn();
    const capture: { doc?: OverrideDoc } = {};
    await mount(liveTake(5.5, 6.5), refused, capture, null);
    await clickCut();
    expect(refused).toHaveBeenCalledWith(expect.stringContaining("isn't in the last render yet"));
    expect(capture.doc!.cuts).toEqual([]);
  });

  it("NO source mapper: a shrunk window still proceeds src-less and says so on the console — live 4..6 stores 4..5", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = vi.fn();
    const capture: { doc?: OverrideDoc } = {};
    await mount(liveTake(4, 6), refused, capture, null);
    await clickCut();
    expect(capture.doc!.cuts).toEqual([{ startSec: 4, endSec: 5 }]);
    expect(refused).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ossclip cut preview: cut"));
  });
});

/**
 * The no-selection (theme/global) view plus the doc-global Captions toggle.
 * Its own harness rather than `Harness` above: that one's `selection` prop
 * is typed non-null because every earlier suite selects something, and the
 * captions toggle lives precisely where nothing is selected. `initialDoc`
 * preloads doc-global state (`captionsHidden`) the same mount-once way
 * `initialCuts`/`initialScenes` do.
 */
function GlobalHarness({
  selection = null,
  cue = null,
  captionsHiddenByFlag,
  baseCaptionTheme,
  initialDoc,
  onDocChange,
}: {
  selection?: { sceneId: string; elementId: string | null } | null;
  cue?: SceneCue | null;
  captionsHiddenByFlag?: boolean;
  baseCaptionTheme?: "default" | "founder" | "punch" | "boxed" | "minimal";
  initialDoc?: Partial<OverrideDoc>;
  onDocChange?: (doc: OverrideDoc) => void;
}) {
  const edits = useEdits();
  React.useEffect(() => {
    if (initialDoc) {
      edits.load({ theme: {}, scenes: {}, captions: {}, splits: [], cuts: [], ...initialDoc });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    onDocChange?.(edits.doc);
  });
  return React.createElement(Inspector, {
    selection,
    cue,
    frame: { width: 1080, height: 1920 },
    allSceneIds: ["scene-0"],
    edits,
    onSelect: () => {},
    resolvedTheme: defaultTheme,
    onVideoPreview: vi.fn(),
    captionsHiddenByFlag,
    baseCaptionTheme,
  });
}

describe("Inspector — the global Captions toggle (no-selection view)", () => {
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

  it("renders checked (checked = visible) on a doc that never touched captions", async () => {
    await act(async () => {
      root.render(React.createElement(GlobalHarness, {}));
    });
    const box = container.querySelector<HTMLInputElement>('[data-testid="captions-visible-toggle"]')!;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(true);
  });

  it("unchecking writes captionsHidden: true; re-checking DELETES the key", async () => {
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(GlobalHarness, {
          onDocChange: (d) => {
            doc = d;
          },
        }),
      );
    });
    const box = container.querySelector<HTMLInputElement>('[data-testid="captions-visible-toggle"]')!;
    await act(async () => {
      box.click();
    });
    expect(doc?.captionsHidden).toBe(true);
    expect(box.checked).toBe(false);
    await act(async () => {
      box.click();
    });
    // Deleted, not written false — the clearVideo/restoreScene rule the
    // reducer enforces; the toggle must round-trip back to a clean doc.
    expect(doc && "captionsHidden" in doc).toBe(false);
    expect(box.checked).toBe(true);
  });

  it("reflects a doc loaded with captions already hidden — unchecked on mount", async () => {
    await act(async () => {
      root.render(React.createElement(GlobalHarness, { initialDoc: { captionsHidden: true } }));
    });
    const box = container.querySelector<HTMLInputElement>('[data-testid="captions-visible-toggle"]')!;
    expect(box.checked).toBe(false);
  });

  it("names --no-captions when the last produce pinned the flag — the toggle can't out-vote it", async () => {
    await act(async () => {
      root.render(React.createElement(GlobalHarness, { captionsHiddenByFlag: true }));
    });
    expect(container.querySelector('[data-testid="captions-flag-note"]')).not.toBeNull();
    // Review minor 2: flag-hidden with a CLEAN doc must read unchecked AND
    // disabled — a checked box over a captionless preview was a lie, and
    // the toggle writes only the override half of the OR, so enabling it
    // would promise a power it doesn't have.
    const box = container.querySelector<HTMLInputElement>('[data-testid="captions-visible-toggle"]')!;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
  });

  it("under the flag, a doc-hidden entry keeps the box ENABLED so the user's own override stays clearable", async () => {
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(GlobalHarness, {
          captionsHiddenByFlag: true,
          initialDoc: { captionsHidden: true },
          onDocChange: (d) => {
            doc = d;
          },
        }),
      );
    });
    const box = container.querySelector<HTMLInputElement>('[data-testid="captions-visible-toggle"]')!;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    // Clicking clears the DOC override (the key is deleted), then the box
    // lands on the disabled-by-flag state — the flag still keeps captions off.
    await act(async () => {
      box.click();
    });
    expect(doc && "captionsHidden" in doc).toBe(false);
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
  });

  it("no flag note on an ordinary workdir", async () => {
    await act(async () => {
      root.render(React.createElement(GlobalHarness, {}));
    });
    expect(container.querySelector('[data-testid="captions-flag-note"]')).toBeNull();
  });

  it("renders caption-theme-select with all 5 presets and writes/deletes doc.captionTheme cleanly", async () => {
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(GlobalHarness, {
          onDocChange: (d) => {
            doc = d;
          },
        }),
      );
    });
    const select = container.querySelector<HTMLSelectElement>('[data-testid="caption-theme-select"]')!;
    expect(select).not.toBeNull();
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "default",
      "founder",
      "punch",
      "boxed",
      "minimal",
    ]);
    expect(select.value).toBe("default");
    expect(doc && "captionTheme" in doc).toBe(false);

    await act(async () => setControl(select, "punch"));
    expect(doc?.captionTheme).toBe("punch");
    expect(select.value).toBe("punch");

    // Returning to the base theme ("default") deletes the override key rather than keeping dead weight
    await act(async () => setControl(select, "default"));
    expect(doc && "captionTheme" in doc).toBe(false);
    expect(select.value).toBe("default");
  });

  it("allows overriding a non-default baseCaptionTheme back to 'default' and clearing when matching baseCaptionTheme", async () => {
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(GlobalHarness, {
          baseCaptionTheme: "founder",
          onDocChange: (d) => {
            doc = d;
          },
        }),
      );
    });
    const select = container.querySelector<HTMLSelectElement>('[data-testid="caption-theme-select"]')!;
    expect(select.value).toBe("founder");
    expect(doc && "captionTheme" in doc).toBe(false);

    // Selecting "default" when baseCaptionTheme is "founder" must store "default" explicitly
    await act(async () => setControl(select, "default"));
    expect(doc?.captionTheme).toBe("default");
    expect(select.value).toBe("default");

    // Selecting "founder" (matching baseCaptionTheme) clears the override key
    await act(async () => setControl(select, "founder"));
    expect(doc && "captionTheme" in doc).toBe(false);
    expect(select.value).toBe("founder");
  });
});

describe("Inspector — per-scene caption controls under a global hide", () => {
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

  it("shows the hidden-globally hint, and keeps the sliders usable (hint over disable — see Inspector's own comment)", async () => {
    await act(async () => {
      root.render(
        React.createElement(GlobalHarness, {
          selection: { sceneId: "scene-0", elementId: null },
          cue: graphicCue,
          initialDoc: { captionsHidden: true },
        }),
      );
    });
    expect(container.querySelector('[data-testid="captions-hidden-hint"]')).not.toBeNull();
    // Deliberately NOT disabled: "reposition now, un-hide later" is a real
    // edit the global switch keeps, so the controls stay live.
    const slider = container.querySelector<HTMLInputElement>('[data-testid="caption-y-slider"]')!;
    expect(slider).not.toBeNull();
    expect(slider.disabled).toBe(false);
  });

  it("no hint when captions are visible", async () => {
    await act(async () => {
      root.render(
        React.createElement(GlobalHarness, {
          selection: { sceneId: "scene-0", elementId: null },
          cue: graphicCue,
        }),
      );
    });
    expect(container.querySelector('[data-testid="captions-hidden-hint"]')).toBeNull();
  });

  // Review minor 3: the FLAG-sourced variant of the hint — clean doc, the
  // last produce typed --no-captions. The hint must show AND name the flag,
  // not the Theme panel (there is no doc entry for that panel to clear).
  it("flag-sourced hide: the hint shows and names --no-captions", async () => {
    await act(async () => {
      root.render(
        React.createElement(GlobalHarness, {
          selection: { sceneId: "scene-0", elementId: null },
          cue: graphicCue,
          captionsHiddenByFlag: true,
        }),
      );
    });
    const hint = container.querySelector('[data-testid="captions-hidden-hint"]')!;
    expect(hint).not.toBeNull();
    expect(hint.textContent).toContain("--no-captions");
    expect(hint.textContent).not.toContain("Theme panel");
  });
});

/**
 * Reveal-timing Task 7: the reveal controls round-trip through the REAL
 * reducer and a cue re-derived from `edits.doc` (App.tsx's `live` memo), so
 * "default" is observed as an absent key, not just as a select's value.
 */
function RevealHarness({ onDocChange }: { onDocChange: (doc: OverrideDoc) => void }) {
  const edits = useEdits();
  const base: SceneCue = {
    id: "scene-1",
    kind: "graphic",
    layout: "video-top",
    component: "FlowDiagram",
    props: { nodes: ["PLAN", "BUILD", "SHIP"] },
    startSec: 0,
    endSec: 6,
  };
  const cue = React.useMemo(() => applyOverrides([base], edits.doc).cues[0]!, [edits.doc]);
  React.useEffect(() => {
    onDocChange(edits.doc);
  });
  return React.createElement(Inspector, {
    selection: { sceneId: "scene-1", elementId: null },
    cue,
    frame: { width: 1080, height: 1920 },
    allSceneIds: ["scene-1"],
    edits,
    onSelect: () => {},
    resolvedTheme: defaultTheme,
    onVideoPreview: vi.fn(),
  });
}

/** Set a form control's value the way a user gesture does — through the
 * native setter, so React's tracked value sees a change and fires onChange. */
const setControl = (el: HTMLSelectElement | HTMLInputElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
};

describe("Inspector — reveal controls: unset is its own state (reveal-timing Task 7)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let doc: OverrideDoc;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(RevealHarness, { onDocChange: (d) => (doc = d) }));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const q = <T extends Element>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`)!;
  const props = () => doc.scenes["scene-1"]?.props ?? {};

  it("an unset optional enum shows a leading default entry; picking it deletes the key", async () => {
    const pacing = q<HTMLSelectElement>("prop-pacing");
    expect(pacing.options[0]!.value).toBe("");
    expect(pacing.value).toBe("");
    // "even" is now a real change — it used to be the displayed unset value.
    await act(async () => setControl(pacing, "even"));
    expect(props().pacing).toBe("even");
    await act(async () => setControl(q<HTMLSelectElement>("prop-pacing"), ""));
    expect("pacing" in props()).toBe(false);
    expect(q<HTMLSelectElement>("prop-pacing").value).toBe("");
  });

  it("the speed slider shows the fallback when unset, writes a number, and default deletes it", async () => {
    const speed = q<HTMLInputElement>("prop-revealSpeed");
    expect(speed.min).toBe("0.1");
    expect(speed.max).toBe("1");
    const control = scalarPropControls("FlowDiagram").find((c) => c.key === "revealSpeed")!;
    if (control.kind !== "number") throw new Error("revealSpeed should be a number control");
    // Read from core, not a literal: the step is core's call, and the claim
    // here is only that the Inspector passes it through.
    expect(speed.step).toBe(String(control.step));
    expect(q<HTMLButtonElement>("prop-revealSpeed-default").disabled).toBe(true);
    // Displayed, never written: nothing in the doc until the author moves it.
    expect("revealSpeed" in props()).toBe(false);
    await act(async () => setControl(speed, "0.4"));
    expect(props().revealSpeed).toBe(0.4);
    const reset = q<HTMLButtonElement>("prop-revealSpeed-default");
    expect(reset.disabled).toBe(false);
    await act(async () => reset.click());
    expect("revealSpeed" in props()).toBe(false);
  });
});

/**
 * §161: an optional integer prop's slider. CardRow's `highlight` unset means
 * NO card highlighted, so the control must say "not set" while unset (the
 * slider resting at 0 would otherwise read as card 0) and must be able to
 * get back there — the optional-number "default" button, labelled "clear".
 */
function HighlightHarness({ onDocChange }: { onDocChange: (doc: OverrideDoc) => void }) {
  const edits = useEdits();
  const base: SceneCue = {
    id: "scene-1",
    kind: "graphic",
    layout: "full-bleed",
    component: "CardRow",
    props: { cards: [{ text: "Draft" }, { text: "Review" }, { text: "Ship" }] },
    startSec: 0,
    endSec: 6,
  };
  const cue = React.useMemo(() => applyOverrides([base], edits.doc).cues[0]!, [edits.doc]);
  React.useEffect(() => {
    onDocChange(edits.doc);
  });
  return React.createElement(Inspector, {
    selection: { sceneId: "scene-1", elementId: null },
    cue,
    frame: { width: 1920, height: 1080 },
    allSceneIds: ["scene-1"],
    edits,
    onSelect: () => {},
    resolvedTheme: defaultTheme,
    onVideoPreview: vi.fn(),
  });
}

describe("Inspector — an optional integer slider can return to unset (§161)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let doc: OverrideDoc;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(HighlightHarness, { onDocChange: (d) => (doc = d) }));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const q = <T extends Element>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
  const props = () => doc.scenes["scene-1"]?.props ?? {};

  it("unset reads 'not set' with the slider at its minimum, a whole-number step, and writes nothing", () => {
    const slider = q<HTMLInputElement>("prop-highlight")!;
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("3");
    expect(slider.step).toBe("1");
    expect(slider.value).toBe("0");
    expect(q("prop-highlight-unset")!.textContent).toBe("not set");
    const clear = q<HTMLButtonElement>("prop-highlight-default")!;
    expect(clear.textContent).toBe("clear");
    expect(clear.disabled).toBe(true);
    expect("highlight" in props()).toBe(false);
  });

  it("writes an integer, shows it whole, and clear deletes the key", async () => {
    await act(async () => setControl(q<HTMLInputElement>("prop-highlight")!, "2"));
    expect(props().highlight).toBe(2);
    expect(q("prop-highlight-unset")).toBeNull();
    expect(q("prop-highlight")!.parentElement!.textContent).toContain("highlight  2");
    const clear = q<HTMLButtonElement>("prop-highlight-default")!;
    expect(clear.disabled).toBe(false);
    await act(async () => clear.click());
    expect("highlight" in props()).toBe(false);
    expect(q("prop-highlight-unset")!.textContent).toBe("not set");
  });

  it("revealSpeed beside it keeps its 'default (0.66)' readout and its 'default' button", () => {
    const speedRow = q("prop-revealSpeed")!.parentElement!;
    expect(speedRow.textContent).toContain("default (0.66)");
    expect(q("prop-revealSpeed-default")!.textContent).toBe("default");
  });
});

/**
 * The swap control (explainer plan Task 7, "Editor decisions"). A clip
 * cannot become a card or the reverse: neither has the other's props, and
 * ClipScene has no default clip to fall back to.
 */
/**
 * A clip's speed resizes its block (decided after 493597a): an unpinned clip
 * through `applyOverrides`, a pinned (dragged) one through the Inspector
 * rewriting its pin in the same commit as the speed. The harness merges the
 * doc onto the base cues the way App's live memo does, so the slider reads
 * back what it wrote and `sceneCues` carries the neighbour.
 */
function ClipSpeedHarness({
  pin,
  onEdits,
}: {
  pin?: { startSec: number; endSec: number };
  onEdits: (edits: ReturnType<typeof useEdits>) => void;
}) {
  const edits = useEdits();
  React.useEffect(() => {
    if (pin) {
      edits.load(
        OverrideDocSchema.parse({ scenes: { "clip-1": { props: {}, timing: pin } } }),
      );
    }
    // Mount-once load, the Harness above's shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const base = React.useMemo<SceneCue[]>(
    () => [
      {
        id: "clip-1",
        kind: "graphic",
        layout: "full-bleed",
        component: "ClipScene",
        props: { src: "clips/a.webm", durationSec: 4, gainDb: -13, muted: false },
        startSec: 10,
        endSec: 14,
      },
      { id: "card", kind: "graphic", layout: "video-top", component: "TitleCard", props: { title: "NEXT" }, startSec: 30, endSec: 33 },
    ],
    [],
  );
  const cues = React.useMemo(() => applyOverrides(base, edits.doc).cues, [base, edits.doc]);
  React.useEffect(() => {
    onEdits(edits);
  });
  return React.createElement(Inspector, {
    selection: { sceneId: "clip-1", elementId: null },
    cue: cues[0]!,
    frame: { width: 1080, height: 1920 },
    allSceneIds: cues.map((c) => c.id),
    edits,
    onSelect: () => {},
    resolvedTheme: defaultTheme,
    onVideoPreview: vi.fn(),
    sceneCues: cues,
    outputDurationSec: 60,
  });
}

describe("Inspector — a clip's speed resizes its block", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let edits: ReturnType<typeof useEdits>;

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

  const mount = async (pin?: { startSec: number; endSec: number }) => {
    await act(async () => {
      root.render(React.createElement(ClipSpeedHarness, { pin, onEdits: (e) => (edits = e) }));
    });
  };
  const q = <T extends Element>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);

  it("a PINNED clip: speed 2 rewrites the pin to the clip's new length, and one undo restores both", async () => {
    // Dragged LONGER than the clip (a deliberate 2 s hold) before the edit.
    await mount({ startSec: 10, endSec: 16 });
    await act(async () => setControl(q<HTMLInputElement>("prop-speed")!, "2"));
    expect(edits.doc.scenes["clip-1"]!.props.speed).toBe(2);
    expect(edits.doc.scenes["clip-1"]!.timing).toEqual({ startSec: 10, endSec: 12 });
    await act(async () => edits.undo());
    expect(edits.doc.scenes["clip-1"]!.props.speed).toBeUndefined();
    expect(edits.doc.scenes["clip-1"]!.timing).toEqual({ startSec: 10, endSec: 16 });
  });

  it("an UNPINNED clip writes no pin: applyOverrides re-derives its window", async () => {
    await mount();
    await act(async () => setControl(q<HTMLInputElement>("prop-speed")!, "2"));
    expect(edits.doc.scenes["clip-1"]!.props.speed).toBe(2);
    expect(edits.doc.scenes["clip-1"]!.timing).toBeUndefined();
  });

  it("says so under the slider; the label stays the key", async () => {
    await mount();
    expect(q("prop-speed-hint")!.textContent).toBe(
      "Changing speed resizes the block to the clip's new length. A block can be trimmed, not made longer than its clip.",
    );
    expect(q("prop-speed")!.parentElement!.firstElementChild!.textContent).toMatch(/^speed/);
    // Only a clip's speed: the muted box beside it has no hint.
    expect(q("prop-muted-hint")).toBeNull();
    expect(propControlHint("FlowDiagram", "revealSpeed")).toBeNull();
    expect(propControlHint("ClipScene", "gainDb")).toBeNull();
  });
});

describe("Inspector — the component swap offers every card, script-only ones included", () => {
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

  it("componentSwapOptions is scriptComponentIds() for a card, and nothing for a clip", () => {
    // Plan decision 5: the script-only cards are offered in every project,
    // though the beat sheet never sees them.
    expect(componentSwapOptions("TitleCard")).toEqual(scriptComponentIds());
    expect(componentSwapOptions("TitleCard")).toEqual([
      ...plannerComponentIds(),
      "CardRow",
      "CtaCard",
      "BugCard",
      "PhoneDemo",
    ]);
    expect(componentSwapOptions("CardRow")).toEqual(scriptComponentIds());
    expect(componentSwapOptions("TitleCard")).not.toContain("ClipScene");
    expect(componentSwapOptions("ClipScene")).toBeNull();
  });

  it("a card's dropdown lists exactly the script components", async () => {
    await act(async () => {
      root.render(
        React.createElement(Harness, { selection: { sceneId: "scene-0", elementId: null } }),
      );
    });
    const select = container.querySelector<HTMLSelectElement>('[data-testid="component-swap"]')!;
    expect(select).not.toBeNull();
    expect([...select.options].map((o) => o.value)).toEqual(scriptComponentIds());
  });

  it("a clip shows no swap control at all", async () => {
    const clipCue: SceneCue = {
      id: "scene-0",
      kind: "graphic",
      layout: "full-bleed",
      component: "ClipScene",
      props: { src: "clips/a.webm", durationSec: 4.6, gainDb: -13, muted: false },
      startSec: 0,
      endSec: 4.6,
    };
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          selection: { sceneId: "scene-0", elementId: null },
          cue: clipCue,
        }),
      );
    });
    expect(container.querySelector('[data-testid="component-swap"]')).toBeNull();
  });
});

/**
 * Backdrop choice, Task 5 (§163, design 5). The layout select speaks the
 * author's three backdrops only in a 16:9 script project; everywhere else
 * it is the flat list it always was. The graphic box gains "Below the face"
 * in 16:9, and a 16:9 pip-bubble scene's fields edit the STORED box, not the
 * one the picture cuts at draw time.
 */
function BackdropHarness({
  base,
  frame,
  scriptProject,
  face,
  onDocChange,
  onPatchLayout,
}: {
  base: SceneCue;
  frame: { width: number; height: number };
  scriptProject?: boolean;
  face?: { centerYFrac: number; sizeFrac?: number; subject?: "face" | "screen" } | null;
  onDocChange?: (doc: OverrideDoc) => void;
  onPatchLayout?: (...args: unknown[]) => void;
}) {
  const real = useEdits();
  const edits = React.useMemo(
    () =>
      onPatchLayout
        ? {
            ...real,
            patchLayout: (...args: Parameters<typeof real.patchLayout>) => {
              onPatchLayout(...args);
              real.patchLayout(...args);
            },
          }
        : real,
    [real, onPatchLayout],
  );
  const cue = React.useMemo(() => applyOverrides([base], real.doc).cues[0]!, [real.doc, base]);
  React.useEffect(() => {
    onDocChange?.(real.doc);
  });
  return React.createElement(Inspector, {
    selection: { sceneId: base.id, elementId: null },
    cue,
    frame,
    allSceneIds: [base.id],
    edits,
    onSelect: () => {},
    resolvedTheme: defaultTheme,
    onVideoPreview: vi.fn(),
    scriptProject,
    face,
  });
}

describe("Inspector — backdrop names and a below-the-face box (§163, Task 5)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const LS = { width: 1920, height: 1080 };
  const PT = { width: 1080, height: 1920 };
  const FACE = { centerYFrac: 0.38, sizeFrac: 0.3 };
  // Today's flat list, literally: LayoutSchema's order, each under its id.
  const FLAT = [
    "full-bleed",
    "video-top",
    "pip-bubble",
    "graphic-only",
    "blurred-behind",
    "lower-third",
    "split-left",
    "split-right",
  ];
  const card: SceneCue = {
    id: "scene-7",
    kind: "graphic",
    layout: "full-bleed",
    component: "CardRow",
    props: { cards: [{ text: "Draft" }, { text: "Review" }] },
    startSec: 0,
    endSec: 6,
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

  const q = <T extends Element>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
  const mount = async (props: Parameters<typeof BackdropHarness>[0]) => {
    await act(async () => {
      root.render(React.createElement(BackdropHarness, props));
    });
  };
  const select = () => q<HTMLSelectElement>("layout-select")!;
  const selectLabel = () => select().parentElement!.querySelector("span")!.textContent;

  it("pins today's flat list as LayoutSchema's own order", () => {
    expect([...LayoutSchema.options]).toEqual(FLAT);
  });

  it("a 16:9 script project: 'Behind the graphic', the three backdrops by name, then the other five", async () => {
    await mount({ base: card, frame: LS, scriptProject: true });
    expect(selectLabel()).toBe("Behind the graphic");
    const groups = [...select().querySelectorAll("optgroup")];
    expect(groups.map((g) => g.label)).toEqual(["Backdrops", "Other layouts"]);
    expect([...groups[0]!.querySelectorAll("option")].map((o) => [o.value, o.textContent])).toEqual([
      ["full-bleed", "Over the speaker"],
      ["graphic-only", "Full background"],
      ["pip-bubble", "Background with speaker picture"],
    ]);
    expect([...groups[1]!.querySelectorAll("option")].map((o) => [o.value, o.textContent])).toEqual([
      ["video-top", "video-top"],
      ["blurred-behind", "blurred-behind"],
      ["lower-third", "lower-third"],
      ["split-left", "split-left"],
      ["split-right", "split-right"],
    ]);
    expect(select().value).toBe("full-bleed");
  });

  it("a scene on one of the other layouts shows it selected under 'Other layouts'", async () => {
    await mount({ base: { ...card, component: "TitleCard", props: { title: "X" }, layout: "lower-third" }, frame: LS, scriptProject: true });
    const chosen = select().selectedOptions[0]!;
    expect(chosen.value).toBe("lower-third");
    expect((chosen.parentElement as HTMLOptGroupElement).label).toBe("Other layouts");
  });

  it("choosing 'Full background' calls patchLayout(sceneId, 'graphic-only', the current layout)", async () => {
    const spy = vi.fn();
    let doc: OverrideDoc | undefined;
    await mount({ base: card, frame: LS, scriptProject: true, onPatchLayout: spy, onDocChange: (d) => (doc = d) });
    await act(async () => setControl(select(), "graphic-only"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("scene-7", "graphic-only", "full-bleed");
    expect(doc!.scenes["scene-7"]?.layout).toBe("graphic-only");
  });

  for (const [name, frame, scriptProject] of [
    ["a 9:16 script project", PT, true],
    ["a 16:9 project without a script", LS, false],
    ["a 16:9 project that never said", LS, undefined],
  ] as const) {
    it(`${name}: exactly today's control — 'Layout', no groups, the flat list under its ids`, async () => {
      await mount({ base: card, frame, scriptProject });
      expect(selectLabel()).toBe("Layout");
      expect(select().querySelectorAll("optgroup")).toHaveLength(0);
      expect([...select().options].map((o) => o.value)).toEqual(FLAT);
      expect([...select().options].map((o) => o.textContent)).toEqual(FLAT);
    });
  }

  it("'Below the face' writes belowFaceBox through patchGraphicRect on a 16:9 full-frame scene", async () => {
    let doc: OverrideDoc | undefined;
    await mount({ base: card, frame: LS, face: FACE, onDocChange: (d) => (doc = d) });
    const btn = q<HTMLButtonElement>("graphic-below-face")!;
    expect(btn.textContent).toBe("Below the face");
    expect(btn.disabled).toBe(false);
    await act(async () => btn.click());
    const rect = doc!.scenes["scene-7"]!.graphicRect!;
    // headBand(0.38, 0.3).end = 0.59 → y 0.62, h 0.34 (stage.test.ts).
    expect(rect.x).toBeCloseTo(0.04, 9);
    expect(rect.y).toBeCloseTo(0.62, 9);
    expect(rect.w).toBeCloseTo(0.92, 9);
    expect(rect.h).toBeCloseTo(0.34, 9);
    expect(Number(q<HTMLInputElement>("field-box-y")!.value)).toBeCloseTo(0.62, 3);
  });

  it("on a slot component the box stays inside the caption-safe rect AND under the head", async () => {
    let doc: OverrideDoc | undefined;
    await mount({
      base: { ...card, component: "TitleCard", props: { title: "X" }, layout: "lower-third" },
      frame: LS,
      face: FACE,
      onDocChange: (d) => (doc = d),
    });
    await act(async () => q<HTMLButtonElement>("graphic-below-face")!.click());
    const rect = doc!.scenes["scene-7"]!.graphicRect!;
    // Landscape safe rect x 0.05..0.95, y 0.06..0.88; head ends at 0.59.
    expect(rect.x).toBeCloseTo(0.05, 9);
    expect(rect.y).toBeCloseTo(0.62, 9);
    expect(rect.w).toBeCloseTo(0.9, 9);
    expect(rect.h).toBeCloseTo(0.26, 9);
  });

  it("is disabled for a screen recording's face, saying it is a camera inset", async () => {
    await mount({ base: card, frame: LS, face: { ...FACE, subject: "screen" } });
    const btn = q<HTMLButtonElement>("graphic-below-face")!;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("The measured face is a camera inset, not the speaker");
  });

  it("is shown in any 16:9 project, script or not, and on a slot component too", async () => {
    await mount({ base: { ...card, component: "TitleCard", props: { title: "X" }, layout: "lower-third" }, frame: LS, face: FACE, scriptProject: false });
    expect(q("graphic-below-face")).not.toBeNull();
  });

  it("is disabled, saying why, with no measured face and with no room below it", async () => {
    await mount({ base: card, frame: LS, face: null });
    let btn = q<HTMLButtonElement>("graphic-below-face")!;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("No face was measured in this video");
    await mount({ base: card, frame: LS, face: { centerYFrac: 0.6, sizeFrac: 0.3 } });
    btn = q<HTMLButtonElement>("graphic-below-face")!;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("No room below the face");
  });

  it("is not offered in a 9:16 frame, nor on a plain take", async () => {
    await mount({ base: card, frame: PT, face: FACE });
    expect(q("graphic-below-face")).toBeNull();
    await mount({ base: { id: "take-1", kind: "plain", layout: "full-bleed", startSec: 0, endSec: 4 }, frame: LS, face: FACE });
    expect(q("graphic-below-face")).toBeNull();
  });

  it("a 16:9 pip-bubble scene's fields show and edit the STORED box, with a note that it is cut when drawn", async () => {
    let doc: OverrideDoc | undefined;
    await mount({ base: { ...card, layout: "pip-bubble" }, frame: LS, onDocChange: (d) => (doc = d) });
    // No box yet: the whole frame, not the frame cut back from the picture.
    expect(q<HTMLInputElement>("field-box-x")!.value).toBe("0");
    expect(q<HTMLInputElement>("field-box-w")!.value).toBe("1");
    expect(q("graphic-box-cut-note")!.textContent).toBe("Kept clear of the speaker picture when drawn.");
    await act(async () => setControl(q<HTMLInputElement>("field-box-h")!, "0.5"));
    // Editing one field stores the uncut box with that field changed.
    expect(doc!.scenes["scene-7"]!.graphicRect).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  });

  it("no cut note outside a 16:9 pip-bubble", async () => {
    await mount({ base: { ...card, layout: "pip-bubble" }, frame: PT });
    expect(q("graphic-box-cut-note")).toBeNull();
    await mount({ base: { ...card, layout: "graphic-only" }, frame: LS });
    expect(q("graphic-box-cut-note")).toBeNull();
    await mount({ base: card, frame: LS });
    expect(q("graphic-box-cut-note")).toBeNull();
  });
});

/**
 * Editor-added graphics (editor-added-graphics §6, §7): Delete on an added
 * ROOT removes its entry; on a split half it hides that half, as for a plan
 * graphic. The no-selection view lists entries that are not shown, each with
 * Remove. Its own harness because these need `addedScenes` preloaded, which
 * `Harness` above has no slot for.
 */
describe("Inspector — added graphics", () => {
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

  const seeded = OverrideDocSchema.parse({
    addedScenes: [
      { id: "added-1", component: "TitleCard", props: { title: "HELLO" }, srcStart: 1, srcEnd: 2 },
      { id: "added-2", component: "OldCard", props: {}, srcStart: 5, srcEnd: 6 },
    ],
    scenes: { "added-1": { props: { title: "EDITED" } } },
  });

  function AddedHarness({
    selection,
    cue,
    addedSkipped,
    onDocChange,
  }: {
    selection: { sceneId: string; elementId: string | null } | null;
    cue: SceneCue | null;
    addedSkipped?: { id: string; component: string; reason: string }[];
    onDocChange: (doc: OverrideDoc) => void;
  }) {
    const edits = useEdits();
    React.useEffect(() => {
      edits.load(seeded);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    React.useEffect(() => {
      onDocChange(edits.doc);
    });
    return React.createElement(Inspector, {
      selection,
      cue,
      frame: { width: 1080, height: 1920 },
      allSceneIds: cue ? [cue.id] : [],
      edits,
      onSelect: () => {},
      resolvedTheme: defaultTheme,
      onVideoPreview: vi.fn(),
      addedSkipped,
    });
  }

  const addedCue = (id: string): SceneCue => ({
    id,
    kind: "graphic",
    layout: "lower-third",
    component: "TitleCard",
    props: { title: "EDITED" },
    startSec: 1,
    endSec: 3,
  });

  it("Delete on the ROOT removes the entry and its edits", async () => {
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(AddedHarness, {
          selection: { sceneId: "added-1", elementId: null },
          cue: addedCue("added-1"),
          onDocChange: (d) => (doc = d),
        }),
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="delete-scene"]')!.click();
    });
    expect(doc!.addedScenes!.map((e) => e.id)).toEqual(["added-2"]);
    expect(doc!.scenes["added-1"]).toBeUndefined();
  });

  it("Delete on a split HALF hides that half and keeps the entry", async () => {
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(AddedHarness, {
          selection: { sceneId: "added-1@k1", elementId: null },
          cue: addedCue("added-1@k1"),
          onDocChange: (d) => (doc = d),
        }),
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="delete-scene"]')!.click();
    });
    expect(doc!.addedScenes!.map((e) => e.id)).toEqual(["added-1", "added-2"]);
    expect(doc!.scenes["added-1@k1"]?.hidden).toBe(true);
  });

  it("the no-selection view lists entries not shown, and Remove removes one", async () => {
    let doc: OverrideDoc | undefined;
    await act(async () => {
      root.render(
        React.createElement(AddedHarness, {
          selection: null,
          cue: null,
          addedSkipped: [{ id: "added-2", component: "OldCard", reason: "graphic type OldCard no longer exists" }],
          onDocChange: (d) => (doc = d),
        }),
      );
    });
    const list = container.querySelector('[data-testid="added-skipped"]')!;
    expect(list).not.toBeNull();
    expect(list.textContent).toContain("1 added graphic is not shown");
    expect(list.textContent).toContain("added-2 · OldCard · graphic type OldCard no longer exists");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="added-skipped-remove-added-2"]')!.click();
    });
    expect(doc!.addedScenes!.map((e) => e.id)).toEqual(["added-1"]);
  });

  it("no list at all when nothing is skipped", async () => {
    await act(async () => {
      root.render(
        React.createElement(AddedHarness, { selection: null, cue: null, onDocChange: () => {} }),
      );
    });
    expect(container.querySelector('[data-testid="added-skipped"]')).toBeNull();
  });
});
