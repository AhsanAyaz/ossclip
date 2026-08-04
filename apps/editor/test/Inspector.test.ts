// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultTheme, type SceneCue } from "@ossclip/core/browser";
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
}) {
  const edits = useEdits();
  React.useEffect(() => {
    if (initialCuts) {
      edits.load({ theme: {}, scenes: {}, captions: {}, splits: [], cuts: initialCuts });
    }
    // Mount-once load, same shape as App.tsx's own `loadProduction` effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return React.createElement(Inspector, {
    selection,
    cue,
    frame: { width: 1080, height: 1920 },
    allSceneIds: ["scene-0"],
    edits,
    resolvedTheme: defaultTheme,
    onVideoPreview: vi.fn(),
  });
}

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

  it("delete-scene: the click swaps the whole panel (unmounts the button) — focus lands on body either way", async () => {
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
    // The button is gone — this IS the ghost/restore panel now.
    expect(container.querySelector('[data-testid="delete-scene"]')).toBeNull();
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
