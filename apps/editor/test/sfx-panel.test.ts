// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultTheme,
  mapFromKeptSpans,
  type OverrideDoc,
  type SceneCue,
  type Word,
} from "@ossclip/core/browser";
import { Timeline } from "../src/Timeline";
import { Inspector } from "../src/Inspector";
import { useEdits } from "../src/useEdits";
import {
  sfxLaneMarkers,
  sfxWordAnchors,
  type SfxLibrarySound,
  type SfxMarker,
  type SfxPlan,
} from "../src/sfxLane";

// The one-time act() opt-in every mounting suite in this repo repeats.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Five words a second apart in an uncut 5s clip: output time IS source time,
 * so a word index reads straight off the pixel maths below. */
const WORDS: Word[] = [0, 1, 2, 3, 4].map((i) => ({
  text: `w${i}`,
  start: i,
  end: i + 0.5,
}));
const DURATION = 5;
const PX_PER_SEC = 100;
const ANCHORS = sfxWordAnchors(WORDS, mapFromKeptSpans([{ srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 }]));

const LIBRARY: SfxLibrarySound[] = [
  { id: "ding", whenToUse: "a point lands", tags: [], gain: 1, packName: "ossclip-starter" },
  { id: "vine-boom", whenToUse: "comedic beat", tags: ["meme"], gain: 0.8, packName: "my-pack" },
];

const cue: SceneCue = {
  id: "scene-0",
  kind: "graphic",
  layout: "lower-third",
  component: "TitleCard",
  props: { title: "SHIP IT" },
  startSec: 0,
  endSec: DURATION,
};

/**
 * The Timeline with a real reducer behind its lane — App's own wiring: the
 * markers are re-derived from the LIVE doc on every render, so a drag's write
 * is observable as the diamond moving as well as in `onDocChange`.
 */
function LaneHarness({
  plan,
  initialSfx,
  onDocChange,
  onSelectSfx = () => {},
  sfxSelected = null,
  playerRef = { current: null },
}: {
  plan: SfxPlan | null;
  initialSfx?: OverrideDoc["sfx"];
  onDocChange?: (doc: OverrideDoc) => void;
  onSelectSfx?: (key: string | null) => void;
  sfxSelected?: string | null;
  /** Loosely typed on purpose (Timeline.test.ts' rule): the preview tests hand
   * in a tiny event-emitting stub, not a whole Remotion player. Every other
   * test here takes the null default, which is the pre-preview wiring. */
  playerRef?: { current: unknown };
}) {
  const edits = useEdits();
  React.useEffect(() => {
    if (initialSfx) {
      edits.load({ theme: {}, scenes: {}, captions: {}, splits: [], cuts: [], sfx: initialSfx });
    }
    // Mount-once load, App.tsx's `loadProduction` shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    onDocChange?.(edits.doc);
  });
  return React.createElement(Timeline, {
    cues: [cue],
    ghosts: [],
    durationSec: DURATION,
    fps: 30,
    playerRef: playerRef as never,
    selection: null,
    onSelect: () => {},
    edits,
    sfxMarkers: plan === null ? null : sfxLaneMarkers(plan, edits.doc.sfx, ANCHORS),
    sfxWords: ANCHORS,
    sfxSelected,
    onSelectSfx,
  });
}

describe("Timeline — the SFX marker lane (Phase 4)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let realRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // jsdom lays nothing out (the Timeline suite's own note): 100px/sec.
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

  const mount = async (props: Parameters<typeof LaneHarness>[0]) => {
    await act(async () => {
      root.render(React.createElement(LaneHarness, props));
    });
  };

  it("draws no lane at all for a production planned without --sfx", async () => {
    await mount({ plan: null });
    expect(container.querySelector('[data-testid="sfx-lane"]')).toBeNull();
  });

  it("draws a diamond per placement at its resolved output time", async () => {
    await mount({
      plan: { level: "normal", placements: [{ soundId: "ding", word: 3 }] },
    });
    const marker = container.querySelector<HTMLElement>('[data-testid="sfx-marker-ding@3"]')!;
    expect(marker).not.toBeNull();
    // Word 3 lands at 3s of 5 — 60% along the lane.
    expect(marker.style.left).toBe("60%");
  });

  it("draws a MUTED placement as a dimmed ghost, from the plan + overrides merge", async () => {
    // render-props' `sfxCues` carry no muted placement at all: the ghost can
    // only come from this merge, which is why the lane draws from it.
    await mount({
      plan: { level: "normal", placements: [{ soundId: "ding", word: 1 }] },
      initialSfx: { edits: { "ding@1": { muted: true } }, added: [] },
    });
    const marker = container.querySelector<HTMLElement>('[data-testid="sfx-marker-ding@1"]')!;
    expect(marker.getAttribute("data-muted")).toBe("true");
    const diamond = marker.firstElementChild as HTMLElement;
    expect(Number(diamond.style.opacity)).toBeLessThan(1);
    expect(diamond.style.background).toBe("transparent");
  });

  it("selects on click without writing anything", async () => {
    const onSelectSfx = vi.fn();
    const docs: OverrideDoc[] = [];
    await mount({
      plan: { level: "normal", placements: [{ soundId: "ding", word: 1 }] },
      onSelectSfx,
      onDocChange: (d) => docs.push(d),
    });
    const marker = container.querySelector<HTMLElement>('[data-testid="sfx-marker-ding@1"]')!;
    await act(async () => {
      marker.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 100 }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 100 }));
    });
    expect(onSelectSfx).toHaveBeenCalledWith("ding@1");
    // A click that wobbles a pixel must never pin the placement to a word.
    expect(docs.at(-1)!.sfx).toBeUndefined();
  });

  const drag = async (marker: HTMLElement, fromX: number, toX: number) => {
    await act(async () => {
      marker.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: fromX }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: toX }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: toX }));
    });
  };

  it("a drag snaps to the nearest WORD and writes it under the plan's key", async () => {
    const docs: OverrideDoc[] = [];
    await mount({
      plan: { level: "normal", placements: [{ soundId: "ding", word: 1 }] },
      onDocChange: (d) => docs.push(d),
    });
    // 100px (word 1) → 380px, which is 3.8s: nearest word is 4, not 3.8s.
    await drag(container.querySelector<HTMLElement>('[data-testid="sfx-marker-ding@1"]')!, 100, 380);
    expect(docs.at(-1)!.sfx).toEqual({ edits: { "ding@1": { word: 4 } }, added: [] });
    // …and the diamond followed: word 4 of a 5s clip is 80% along.
    expect(
      container.querySelector<HTMLElement>('[data-testid="sfx-marker-ding@1"]')!.style.left,
    ).toBe("80%");
  });

  it("a drag back onto the planned word CLEARS the override instead of pinning it", async () => {
    const docs: OverrideDoc[] = [];
    await mount({
      plan: { level: "normal", placements: [{ soundId: "ding", word: 1 }] },
      initialSfx: { edits: { "ding@1": { word: 4 } }, added: [] },
      onDocChange: (d) => docs.push(d),
    });
    await drag(container.querySelector<HTMLElement>('[data-testid="sfx-marker-ding@1"]')!, 400, 105);
    expect(docs.at(-1)!.sfx).toBeUndefined();
  });

  it("dragging an ADDED placement moves its own record, not an edits key", async () => {
    const docs: OverrideDoc[] = [];
    await mount({
      plan: { level: "normal", placements: [] },
      initialSfx: { edits: {}, added: [{ id: "pop-1", soundId: "pop", word: 1 }] },
      onDocChange: (d) => docs.push(d),
    });
    await drag(container.querySelector<HTMLElement>('[data-testid="sfx-marker-pop-1"]')!, 100, 300);
    expect(docs.at(-1)!.sfx).toEqual({
      edits: {},
      added: [{ id: "pop-1", soundId: "pop", word: 3 }],
    });
  });
});

/**
 * A player that emits nothing on its own — the test drives the clock.
 *
 * The TranscriptPanel suite's stub, extended with the transport events the
 * preview gates on: `frameupdate` alone is a scrub, and only `play` makes the
 * samples that follow it playback.
 */
function stubPlayer() {
  const listeners: Record<string, Array<(e: { detail: { frame: number } }) => void>> = {};
  let playing = false;
  const emit = (name: string, frame = 0): void => {
    for (const cb of listeners[name] ?? []) cb({ detail: { frame } });
  };
  return {
    ref: {
      current: {
        getCurrentFrame: () => 0,
        seekTo: () => {},
        isPlaying: () => playing,
        addEventListener: (name: string, cb: (e: { detail: { frame: number } }) => void) => {
          (listeners[name] ??= []).push(cb);
        },
        removeEventListener: (name: string, cb: (e: { detail: { frame: number } }) => void) => {
          listeners[name] = (listeners[name] ?? []).filter((c) => c !== cb);
        },
      },
    },
    play: () => {
      playing = true;
      emit("play");
    },
    pause: () => {
      playing = false;
      emit("pause");
    },
    /** One playhead sample, in SECONDS — the harness runs at 30fps. */
    frameAt: (sec: number) => emit("frameupdate", Math.round(sec * 30)),
  };
}

/** Every `new Audio(src)` the preview makes, with its play calls — the
 * `sfx-preview` button's own stub idiom, kept as a list because the preview
 * pools one element per sound. */
function stubAudio() {
  const created: Array<{ src: string; plays: number; volume: number; currentTimes: number[] }> = [];
  vi.stubGlobal(
    "Audio",
    class {
      preload = "";
      volume = 1;
      #rec: (typeof created)[number];
      constructor(src: string) {
        this.#rec = { src, plays: 0, volume: 1, currentTimes: [] };
        created.push(this.#rec);
      }
      set currentTime(v: number) {
        this.#rec.currentTimes.push(v);
      }
      play() {
        this.#rec.plays += 1;
        this.#rec.volume = this.volume;
        return Promise.resolve();
      }
    },
  );
  return created;
}

describe("Timeline — SFX play with the preview (Phase 4 follow-up)", () => {
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
    vi.unstubAllGlobals();
  });

  const mount = async (props: Parameters<typeof LaneHarness>[0]) => {
    await act(async () => {
      root.render(React.createElement(LaneHarness, props));
    });
  };

  /** Word 1 at 1s, a second placement at 3s — the lane the tests play across. */
  const PLAN: SfxPlan = {
    level: "normal",
    placements: [
      { soundId: "ding", word: 1 },
      { soundId: "vine-boom", word: 3, gain: 2 },
    ],
  };

  it("plays a sound when playback crosses its marker, through the preview route", async () => {
    const audio = stubAudio();
    const player = stubPlayer();
    await mount({ plan: PLAN, playerRef: player.ref });
    // One element per DISTINCT sound, preloaded from the id — never a path.
    expect(audio.map((a) => a.src)).toEqual([
      "/api/sfx/audio?id=ding",
      "/api/sfx/audio?id=vine-boom",
    ]);
    await act(async () => {
      player.play();
      player.frameAt(0.9); // seeds the baseline; fires nothing
      player.frameAt(1.05); // crosses word 1
    });
    expect(audio[0]!.plays).toBe(1);
    expect(audio[0]!.currentTimes).toEqual([0]); // restarted, not resumed
    expect(audio[1]!.plays).toBe(0);
    // …and the second placement fires on its own crossing, at the element's
    // ceiling: gain 2 is legal in the doc and previews at 1.
    await act(async () => {
      player.frameAt(2.95);
      player.frameAt(3.05);
    });
    expect(audio[1]!.plays).toBe(1);
    expect(audio[1]!.volume).toBe(1);
  });

  it("fires nothing while the player is merely SCRUBBED — a seek is not playback", async () => {
    const audio = stubAudio();
    const player = stubPlayer();
    await mount({ plan: PLAN, playerRef: player.ref });
    await act(async () => {
      player.frameAt(0.9);
      player.frameAt(1.05);
    });
    expect(audio[0]!.plays).toBe(0);
  });

  it("the toggle gates it: OFF plays nothing, and back ON plays again", async () => {
    const audio = stubAudio();
    const player = stubPlayer();
    await mount({ plan: PLAN, playerRef: player.ref });
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="sfx-preview-toggle"]',
    )!;
    // Default ON — the sounds are the point of the lane.
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      player.play();
      player.frameAt(0.9);
      player.frameAt(1.05);
    });
    expect(audio[0]!.plays).toBe(0);
    await act(async () => {
      toggle.click();
    });
    await act(async () => {
      player.frameAt(2.95);
      player.frameAt(3.05);
    });
    expect(audio[1]!.plays).toBe(1);
  });

  it("previews a MUTED placement silently and an edited one at its NEW word", async () => {
    // The lane's own derivation feeds the preview, so an edit made this
    // session is heard where the user put it — with no render in between.
    const audio = stubAudio();
    const player = stubPlayer();
    await mount({
      plan: PLAN,
      initialSfx: {
        edits: { "ding@1": { word: 4 }, "vine-boom@3": { muted: true } },
        added: [],
      },
      playerRef: player.ref,
    });
    await act(async () => {
      player.play();
      player.frameAt(0.9);
      player.frameAt(1.05); // the PLANNED position — now empty
      player.frameAt(2.95);
      player.frameAt(3.05); // the muted placement's position
    });
    expect(audio.find((a) => a.src.endsWith("ding"))!.plays).toBe(0);
    expect(audio.every((a) => a.plays === 0)).toBe(true);
    await act(async () => {
      player.frameAt(3.95);
      player.frameAt(4.05); // word 4, where the drag put it
    });
    expect(audio.find((a) => a.src.endsWith("ding"))!.plays).toBe(1);
  });

  it("offers no toggle at all on a production planned without --sfx", async () => {
    const player = stubPlayer();
    await mount({ plan: null, playerRef: player.ref });
    expect(container.querySelector('[data-testid="sfx-preview-toggle"]')).toBeNull();
  });
});

/** The Inspector with a real reducer behind it — Inspector.test.ts' Harness,
 * narrowed to the props the SFX panel reads. */
function PanelHarness({
  marker,
  initialSfx,
  onDocChange,
  wordAtPlayhead = () => 2,
  sfxEnabled = true,
}: {
  marker: SfxMarker | null;
  initialSfx?: OverrideDoc["sfx"];
  onDocChange?: (doc: OverrideDoc) => void;
  wordAtPlayhead?: () => number | null;
  sfxEnabled?: boolean;
}) {
  const edits = useEdits();
  React.useEffect(() => {
    if (initialSfx) {
      edits.load({ theme: {}, scenes: {}, captions: {}, splits: [], cuts: [], sfx: initialSfx });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    onDocChange?.(edits.doc);
  });
  return React.createElement(Inspector, {
    selection: null,
    cue: null,
    frame: { width: 1080, height: 1920 },
    allSceneIds: [],
    edits,
    onSelect: () => {},
    resolvedTheme: defaultTheme,
    onVideoPreview: vi.fn(),
    sfxMarker: marker,
    sfxLibrary: LIBRARY,
    sfxEnabled,
    sfxWordAtPlayhead: wordAtPlayhead,
  });
}

const plannedMarker: SfxMarker = {
  key: "ding@2",
  kind: "planned",
  soundId: "ding",
  word: 2,
  gain: 1,
  muted: false,
  atSec: 2,
  planned: { soundId: "ding", word: 2 },
};

describe("Inspector — the selected sound effect (Phase 4)", () => {
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
    vi.unstubAllGlobals();
  });

  const mount = async (props: Parameters<typeof PanelHarness>[0]) => {
    await act(async () => {
      root.render(React.createElement(PanelHarness, props));
    });
  };

  const find = <T extends HTMLElement>(testid: string): T =>
    container.querySelector<T>(`[data-testid="${testid}"]`)!;

  it("offers every INSTALLED sound, level-agnostic — a user choice outranks the model's gate", async () => {
    await mount({ marker: plannedMarker });
    const select = find<HTMLSelectElement>("sfx-sound");
    // The meme-tagged sound is offered on a `normal` production: the level
    // gate prices the MODEL's plan, not the user's swap (Phase 3 doctrine).
    expect([...select.options].map((o) => o.value)).toEqual(["ding", "vine-boom"]);
    expect(select.value).toBe("ding");
  });

  it("keeps a sound the library no longer has selectable rather than blank", async () => {
    await mount({ marker: { ...plannedMarker, soundId: "gone", key: "gone@2" } });
    const select = find<HTMLSelectElement>("sfx-sound");
    expect(select.value).toBe("gone");
    expect(select.options[0]!.textContent).toContain("not in the library");
  });

  it("swapping the sound writes soundId under the PLAN's key", async () => {
    const docs: OverrideDoc[] = [];
    await mount({ marker: plannedMarker, onDocChange: (d) => docs.push(d) });
    const select = find<HTMLSelectElement>("sfx-sound");
    await act(async () => {
      select.value = "vine-boom";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(docs.at(-1)!.sfx).toEqual({ edits: { "ding@2": { soundId: "vine-boom" } }, added: [] });
  });

  it("the gain slider writes a placement gain, coalesced into one undo step", async () => {
    const docs: OverrideDoc[] = [];
    await mount({ marker: plannedMarker, onDocChange: (d) => docs.push(d) });
    const slider = find<HTMLInputElement>("sfx-gain-slider");
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("2");
    await act(async () => {
      // Through the NATIVE setter, then `input` — cover-panel.test.ts's
      // `setInputValue` rule: React reads a controlled input's value through
      // that descriptor, so a plain assignment never lands.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "1.5");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(docs.at(-1)!.sfx).toEqual({ edits: { "ding@2": { gain: 1.5 } }, added: [] });
  });

  it("deleting a PLANNED placement mutes it — the plan is rewritten every run", async () => {
    const docs: OverrideDoc[] = [];
    await mount({ marker: plannedMarker, onDocChange: (d) => docs.push(d) });
    // The planned placement's delete IS the mute button — there is no
    // separate `sfx-delete` on this branch.
    expect(container.querySelector('[data-testid="sfx-delete"]')).toBeNull();
    await act(async () => {
      find("sfx-mute").click();
    });
    expect(docs.at(-1)!.sfx).toEqual({ edits: { "ding@2": { muted: true } }, added: [] });
  });

  it("a muted placement offers Restore, which deletes the key", async () => {
    const docs: OverrideDoc[] = [];
    await mount({
      marker: { ...plannedMarker, muted: true },
      initialSfx: { edits: { "ding@2": { muted: true } }, added: [] },
      onDocChange: (d) => docs.push(d),
    });
    expect(container.querySelector('[data-testid="sfx-mute"]')).toBeNull();
    await act(async () => {
      find("sfx-restore").click();
    });
    expect(docs.at(-1)!.sfx).toBeUndefined();
  });

  it("deleting an ADDED placement splices it out — no ghost to restore", async () => {
    const docs: OverrideDoc[] = [];
    await mount({
      marker: {
        key: "pop-1",
        kind: "added",
        soundId: "pop",
        word: 1,
        gain: 1,
        muted: false,
        atSec: 1,
      },
      initialSfx: { edits: {}, added: [{ id: "pop-1", soundId: "pop", word: 1 }] },
      onDocChange: (d) => docs.push(d),
    });
    expect(container.querySelector('[data-testid="sfx-mute"]')).toBeNull();
    await act(async () => {
      find("sfx-delete").click();
    });
    expect(docs.at(-1)!.sfx).toBeUndefined();
  });

  it("the preview button plays the audio ROUTE for the selected sound", async () => {
    const play = vi.fn();
    const created: string[] = [];
    vi.stubGlobal(
      "Audio",
      class {
        constructor(src: string) {
          created.push(src);
        }
        play = play;
      },
    );
    await mount({ marker: { ...plannedMarker, soundId: "vine-boom" } });
    await act(async () => {
      find("sfx-preview").click();
    });
    // The id, never a path: the server resolves the file from its own library.
    expect(created).toEqual(["/api/sfx/audio?id=vine-boom"]);
    expect(play).toHaveBeenCalled();
  });
});

describe("Inspector — adding a sound (Phase 4)", () => {
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

  const mount = async (props: Parameters<typeof PanelHarness>[0]) => {
    await act(async () => {
      root.render(React.createElement(PanelHarness, props));
    });
  };

  it("offers the palette on the no-selection panel when the production HAS a plan", async () => {
    await mount({ marker: null });
    expect(container.querySelector('[data-testid="sfx-add-section"]')).not.toBeNull();
  });

  it("offers NO palette on a production planned without --sfx", async () => {
    // produce only applies the override layer when a plan exists, so an add
    // here would promise an effect no render plays.
    await mount({ marker: null, sfxEnabled: false });
    expect(container.querySelector('[data-testid="sfx-add-section"]')).toBeNull();
  });

  it("adds at the playhead's WORD, with a minted id", async () => {
    const docs: OverrideDoc[] = [];
    await mount({ marker: null, wordAtPlayhead: () => 3, onDocChange: (d) => docs.push(d) });
    const select = container.querySelector<HTMLSelectElement>('[data-testid="sfx-add-sound"]')!;
    await act(async () => {
      select.value = "vine-boom";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="sfx-add"]')!.click();
    });
    expect(docs.at(-1)!.sfx).toEqual({
      edits: {},
      added: [{ id: "vine-boom-3", soundId: "vine-boom", word: 3 }],
    });
  });

  it("refuses out loud when no word sits under the playhead", async () => {
    const docs: OverrideDoc[] = [];
    await mount({ marker: null, wordAtPlayhead: () => null, onDocChange: (d) => docs.push(d) });
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="sfx-add"]')!.click();
    });
    // Nothing written — a placement is anchored to a word, never to a guess.
    expect(docs.at(-1)!.sfx).toBeUndefined();
    expect(container.querySelector('[data-testid="sfx-add-refused"]')).not.toBeNull();
  });
});
