// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultTheme,
  mapFromKeptSpans,
  type OverlayEntrySnapshot,
  type OverrideDoc,
  type SceneCue,
  type Word,
} from "@ossclip/core/browser";
import { Timeline } from "../src/Timeline";
import { Inspector } from "../src/Inspector";
import { TranscriptPanel } from "../src/TranscriptPanel";
import { useEdits } from "../src/useEdits";
import { sfxWordAnchors } from "../src/sfxLane";
import { overlayLaneMarkers, overlayPreview, type OverlayPlan, type OverlayTrayRequest } from "../src/overlayLane";

/**
 * The overlay lane and Inspector panel mounted with a real reducer behind
 * them (sfx-panel.test.ts' harness shape): chips re-derive from the LIVE doc
 * on every render, so a write is observable both in the doc and on screen.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORDS: Word[] = [0, 1, 2, 3, 4].map((i) => ({ text: `w${i}`, start: i, end: i + 0.5 }));
const DURATION = 5;
const PX_PER_SEC = 100;
const MAP = mapFromKeptSpans([{ srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 }]);
const ANCHORS = sfxWordAnchors(WORDS, MAP);
const GDE: OverlayEntrySnapshot = { id: "gde", name: "GDE", names: ["GDE"], kind: "logo", ext: "png" };
const PLAN: OverlayPlan = { entries: [GDE], placements: [{ id: "gde@1", entryId: "gde", word: 1, source: "match" }] };

const cue: SceneCue = {
  id: "scene-0",
  kind: "graphic",
  layout: "lower-third",
  component: "TitleCard",
  props: { title: "SHIP IT" },
  startSec: 0,
  endSec: DURATION,
};

function Harness({
  initial,
  onDocChange,
  onAddOverlayAt,
  onOpenOverlayTray,
  selectedId = null,
}: {
  initial?: OverrideDoc["overlays"];
  onDocChange?: (doc: OverrideDoc) => void;
  onAddOverlayAt?: (sec: number) => void;
  onOpenOverlayTray?: (req: OverlayTrayRequest) => void;
  selectedId?: string | null;
}) {
  const edits = useEdits();
  React.useEffect(() => {
    if (initial) edits.load({ theme: {}, scenes: {}, captions: {}, splits: [], cuts: [], overlays: initial });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    onDocChange?.(edits.doc);
  });
  const markers = overlayLaneMarkers(PLAN, edits.doc.overlays, WORDS, MAP);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(Timeline, {
      cues: [cue],
      durationSec: DURATION,
      fps: 30,
      playerRef: { current: null } as never,
      selection: null,
      onSelect: () => {},
      edits,
      overlayMarkers: markers,
      overlayWords: ANCHORS,
      onSelectOverlay: () => {},
      onAddOverlayAt,
    }),
    React.createElement(Inspector, {
      selection: null,
      cue: null,
      frame: { width: 1080, height: 1920 },
      allSceneIds: [],
      edits,
      onSelect: () => {},
      resolvedTheme: defaultTheme,
      onVideoPreview: vi.fn(),
      overlayMarker: markers.find((m) => m.id === selectedId) ?? null,
      onOpenOverlayTray,
    }),
  );
}

describe("the overlay lane and panel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let realRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    realRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return {
        left: 0, top: 0, right: DURATION * PX_PER_SEC, bottom: 40,
        width: DURATION * PX_PER_SEC, height: 40, x: 0, y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    Element.prototype.getBoundingClientRect = realRect;
  });

  const mount = async (props: Parameters<typeof Harness>[0]) => {
    await act(async () => {
      root.render(React.createElement(Harness, props));
    });
  };
  const find = <T extends HTMLElement>(testid: string): T =>
    container.querySelector<T>(`[data-testid="${testid}"]`)!;
  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.click();
    });
  };

  it("draws a chip spanning the overlay's window, thumbnail from the workdir copy", async () => {
    await mount({});
    const chip = find("overlay-chip-gde@1");
    expect(chip.style.left).toBe("20%");
    // 1.5s default of a 5s clip.
    expect(chip.style.width).toBe("30%");
    expect(chip.querySelector("img")!.getAttribute("src")).toBe("/media/library/gde.png");
  });

  it("a drag snaps to a word and writes the match's edit", async () => {
    const docs: OverrideDoc[] = [];
    await mount({ onDocChange: (d) => docs.push(d) });
    const chip = find("overlay-chip-gde@1");
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 100 }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 290 }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 290 }));
    });
    expect(docs.at(-1)!.overlays?.edits).toEqual({ "gde@1": { word: 3 } });
    expect(find("overlay-chip-gde@1").style.left).toBe("60%");
  });

  it("right-click on the lane offers 'Add logo/image here…' at that second", async () => {
    const onAddOverlayAt = vi.fn();
    await mount({ onAddOverlayAt });
    await act(async () => {
      find("overlay-lane").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 350, clientY: 10 }),
      );
    });
    await click(find("context-menu-item-Add logo/image here…"));
    expect(onAddOverlayAt).toHaveBeenCalledWith(3.5);
  });

  it("the panel switches look, resets duration, silences, and asks the tray to swap", async () => {
    const docs: OverrideDoc[] = [];
    const onOpenOverlayTray = vi.fn();
    await mount({
      initial: { edits: { "gde@1": { durationSec: 4 } }, added: [], entries: [] },
      onDocChange: (d) => docs.push(d),
      onOpenOverlayTray,
      selectedId: "gde@1",
    });
    await click(find("overlay-look-card"));
    expect(docs.at(-1)!.overlays?.edits["gde@1"]).toEqual({ durationSec: 4, look: "card" });
    await click(find("overlay-duration-default"));
    expect(docs.at(-1)!.overlays?.edits["gde@1"]).toEqual({ look: "card" });
    await click(find("overlay-sound"));
    expect(docs.at(-1)!.overlays?.edits["gde@1"]).toEqual({ look: "card", sound: null });
    await click(find("overlay-image"));
    expect(onOpenOverlayTray).toHaveBeenCalledWith({ mode: "swap", id: "gde@1" });
  });

  it("delete leaves a ghost chip, and restore brings back an untouched doc", async () => {
    const docs: OverrideDoc[] = [];
    await mount({ onDocChange: (d) => docs.push(d), selectedId: "gde@1" });
    await click(find("overlay-delete"));
    expect(find("overlay-chip-gde@1").getAttribute("data-removed")).toBe("true");
    await click(find("overlay-restore"));
    expect(find("overlay-chip-gde@1").getAttribute("data-removed")).toBeNull();
    expect("overlays" in docs.at(-1)!).toBe(false);
  });
});

describe("the transcript word menu", () => {
  it("offers 'Add logo/image here…' at the word's PLAYER-clock start, and no menu without the prop", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onAddOverlayAt = vi.fn();
    const lines = [{ words: [{ text: "GDE", start: 2, end: 2.4, srcStart: 3 }], start: 2, end: 2.4 }];
    function Panel({ withMenu }: { withMenu: boolean }) {
      const edits = useEdits();
      return React.createElement(TranscriptPanel, {
        baseLines: lines,
        liveLines: lines,
        timingLines: lines,
        workdir: null,
        fps: 30,
        playerRef: { current: null },
        edits,
        onDeleteWords: () => {},
        width: 300,
        // A live re-cut shifting the player clock by 1s: the menu must hand
        // App the PLAYER second, the clock the lane's anchors speak.
        toPlayerSec: (sec: number) => sec + 1,
        ...(withMenu ? { onAddOverlayAt } : {}),
      });
    }
    const rightClick = async () => {
      await act(async () => {
        container
          .querySelector('[data-testid="transcript-word-0"]')!
          .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      });
    };
    await act(async () => {
      root.render(React.createElement(Panel, { withMenu: false }));
    });
    await rightClick();
    expect(container.querySelector('[data-testid="context-menu"]')).toBeNull();
    await act(async () => {
      root.render(React.createElement(Panel, { withMenu: true }));
    });
    await rightClick();
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="context-menu-item-Add logo/image here…"]')!.click();
    });
    expect(onAddOverlayAt).toHaveBeenCalledWith(3);
    act(() => root.unmount());
    container.remove();
  });
});

describe("overlay pops in the preview", () => {
  it("fire through the sfx preview path with no sfx lane at all", async () => {
    const plays: string[] = [];
    vi.stubGlobal(
      "Audio",
      class {
        preload = "";
        volume = 1;
        currentTime = 0;
        constructor(public src: string) {}
        play() {
          plays.push(this.src);
          return Promise.resolve();
        }
      },
    );
    const listeners: Record<string, Array<(e: { detail: { frame: number } }) => void>> = {};
    const emit = (name: string, frame = 0) => {
      for (const cb of listeners[name] ?? []) cb({ detail: { frame } });
    };
    const playerRef = {
      current: {
        getCurrentFrame: () => 0,
        seekTo: () => {},
        isPlaying: () => false,
        addEventListener: (n: string, cb: (e: { detail: { frame: number } }) => void) => {
          (listeners[n] ??= []).push(cb);
        },
        removeEventListener: () => {},
      },
    };
    const sounds = overlayPreview(PLAN, undefined, WORDS, MAP, [
      { id: "pop", whenToUse: "", tags: [], gain: 1, packName: "starter" },
    ]).sounds;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    function Strip() {
      const edits = useEdits();
      return React.createElement(Timeline, {
        cues: [cue],
        durationSec: DURATION,
        fps: 30,
        playerRef: playerRef as never,
        selection: null,
        onSelect: () => {},
        edits,
        overlayMarkers: [],
        overlaySounds: sounds,
      });
    }
    await act(async () => {
      root.render(React.createElement(Strip));
    });
    await act(async () => {
      emit("play");
      emit("frameupdate", 27); // 0.9s: baseline
      emit("frameupdate", 32); // 1.07s: crosses word 1
    });
    expect(plays).toEqual(["/api/sfx/audio?id=pop"]);
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
});
