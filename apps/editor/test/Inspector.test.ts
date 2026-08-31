// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOverrides,
  defaultTheme,
  livePreviewMap,
  previewClockMappers,
  type KeptSpan,
  type OverrideDoc,
  type SceneCue,
  type Segment,
} from "@ossclip/core/browser";
import { Inspector } from "../src/Inspector";
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
  initialDoc,
  onDocChange,
}: {
  selection?: { sceneId: string; elementId: string | null } | null;
  cue?: SceneCue | null;
  captionsHiddenByFlag?: boolean;
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
