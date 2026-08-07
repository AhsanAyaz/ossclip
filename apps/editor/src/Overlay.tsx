import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import { SPLIT_MIN_PIECE_SEC, type SceneCue } from "@ossclip/core/browser";
import { clampGraphicRect, layoutSlots, safeAreaFor } from "@ossclip/renderer/composition";
import { findEditableFrom, findVideoFrom, rectOf } from "./hitTest";
import { guideSnap, THRESHOLD_FRAC, type Guide } from "./guides";
import type { GraphicRect, useEdits } from "./useEdits";

export interface Selection {
  sceneId: string;
  elementId: string | null;
}

/** A live, uncommitted framing tweak (PLAN 2026-07-30 Task B): applied onto
 * the matching cue at the END of App's live memo so the Player previews the
 * drag/slider in real time, cleared when the real patch lands. */
export interface VideoPreview {
  sceneId: string;
  patch: { scale?: number; dx?: number; dy?: number };
}

/** A live, uncommitted graphic-box transform (R11 Task 2) — same lifecycle
 * as VideoPreview: applied at the end of App's live memo, cleared on commit. */
export interface GraphicPreview {
  sceneId: string;
  rect: GraphicRect;
}

/** Which part of the box a handle drags. Compass points resize; "move" is
 * the titlebar-style grip along the top edge. Exported for `guides.ts`
 * (`guideSnap` reuses these exact semantics — see `applyBoxHandle` below). */
export type BoxHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";

/** One resize/move step, in frame fractions. */
function applyBoxHandle(start: GraphicRect, handle: BoxHandle, fdx: number, fdy: number): GraphicRect {
  const r = { ...start };
  if (handle === "move") {
    r.x += fdx;
    r.y += fdy;
    return r;
  }
  if (handle.includes("w")) {
    r.x += fdx;
    r.w -= fdx;
  }
  if (handle.includes("e")) r.w += fdx;
  if (handle.includes("n")) {
    r.y += fdy;
    r.h -= fdy;
  }
  if (handle.includes("s")) r.h += fdy;
  return r;
}

/**
 * The Player's transport strip (seek bar + buttons) keeps pointer events even
 * while faded to invisible, and its DOM carries no stable class or role to
 * hit-test against — so the bottom strip of the stage is reserved for it and
 * never starts a video grab. Matches what the Player already does with
 * presses there: its own seek bar owns them.
 */
const PLAYER_CONTROLS_STRIP_PX = 64;

interface OverlayProps {
  /** The DOM node the Player mounted into — the coordinate space to hit-test. */
  stageRef: React.RefObject<HTMLDivElement>;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  edits: ReturnType<typeof useEdits>;
  /**
   * Same handler the Save button uses (wraps `edits.save()` and routes
   * failures to the error banner) — so a failed keyboard save is just as
   * visible as a failed button click.
   */
  onSave: () => void;
  /**
   * The composition's native pixel size (`render-props.json`'s
   * `settings.width/height`). The `<Player>` is displayed at a fixed CSS
   * width (currently 380px in `App.tsx`) and scaled down from this native
   * size — mouse deltas arrive in PAGE pixels, but a dragged element's
   * `dx`/`dy` renders in COMPOSITION pixels, so drags must be rescaled by
   * `settings.width / stageRect.width` before they're dispatched.
   */
  settings: { width: number; height: number; fps: number };
  /** The LIVE cue list in time order — sibling selection (⌥+arrows), scene
   * jumps (⌘+arrows) and the playhead split (⌘B) all resolve against it. */
  cues: readonly SceneCue[];
  /** Toggle the keybinds reference (R16 §63) — bound to "?". */
  onToggleHelp: () => void;
  /**
   * The Player itself, for `getScale()` — the AUTHORITATIVE page-px-per-
   * composition-px factor. The stage div's rect is not it: the Player
   * letterboxes its canvas inside whatever box the layout hands it (a
   * height-capped viewport shrinks the canvas below the stage's 380px), and
   * a scale derived from the wrong box misplaces every drag by the
   * letterbox ratio (PLAN Task 1 — measured at exactly ×0.9 in the e2e).
   */
  playerRef: React.RefObject<PlayerRef>;
  /** J/K/L transport dispatch — the reducer and its side effects live in App. */
  onTransport: (key: "J" | "K" | "L") => void;
  /** Live framing preview — owned by App, applied at the end of its live memo. */
  onVideoPreview: (preview: VideoPreview | null) => void;
  /** Live graphic-box preview (R11 Task 2) — same ownership as above. */
  onGraphicPreview: (preview: GraphicPreview | null) => void;
  /** The currently-selected scene's LIVE (override-applied) cue, so a
   * double-click retype on an array-backed element (a FlowDiagram node, a
   * ChatMock message, …) can rewrite that element's entry in place instead
   * of writing a bogus top-level prop nothing reads. */
  cue: SceneCue | null;
}

const HANDLE = 9;

/** Drag commits round to a tenth of a composition px (§48): a rescaled page
 * delta is a long float, and nobody nudges finer than 0.1px — the stored doc
 * and the number fields should read like a person set them. */
const round1 = (v: number): number => Math.round(v * 10) / 10;
/** Rect fractions round to 4 decimals — 0.1px of frame at 1080 wide. */
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Box transform handle chrome (R11 Task 2). */
const boxHandleBase: React.CSSProperties = {
  position: "absolute",
  width: 10,
  height: 10,
  background: "#5b8cff",
  border: "1px solid #0B0B0E",
  borderRadius: 2,
  pointerEvents: "auto",
  zIndex: 6,
};

const HANDLE_POS: Record<Exclude<BoxHandle, "move">, React.CSSProperties> = {
  nw: { left: 0, top: 0, transform: "translate(-50%,-50%)", cursor: "nwse-resize" },
  n: { left: "50%", top: 0, transform: "translate(-50%,-50%)", cursor: "ns-resize" },
  ne: { right: 0, top: 0, transform: "translate(50%,-50%)", cursor: "nesw-resize" },
  e: { right: 0, top: "50%", transform: "translate(50%,-50%)", cursor: "ew-resize" },
  se: { right: 0, bottom: 0, transform: "translate(50%,50%)", cursor: "nwse-resize" },
  s: { left: "50%", bottom: 0, transform: "translate(-50%,50%)", cursor: "ns-resize" },
  sw: { left: 0, bottom: 0, transform: "translate(-50%,50%)", cursor: "nesw-resize" },
  w: { left: 0, top: "50%", transform: "translate(-50%,-50%)", cursor: "ew-resize" },
};

/** Element resize handles (R12 §47) — the element's yellow, so they read as
 * belonging to the dashed element box rather than the blue scene box. */
const elHandleBase: React.CSSProperties = {
  ...boxHandleBase,
  background: "#ffe14d",
};

/** The move grips (R21 §107): the box's whole dashed BOUNDARY drags — a
 * strip along each edge, inset clear of the corner handles. Only the edges:
 * the body must stay click-through or element selection inside the box
 * breaks. The midpoint resize handles sit a zIndex above and win where
 * they overlap. */
const MOVE_EDGES: Record<"top" | "bottom" | "left" | "right", React.CSSProperties> = {
  top: { top: 0, left: 14, right: 14, height: 10 },
  bottom: { bottom: 0, left: 14, right: 14, height: 10 },
  left: { left: 0, top: 14, bottom: 14, width: 10 },
  right: { right: 0, top: 14, bottom: 14, width: 10 },
};
const moveEdgeBase: React.CSSProperties = {
  position: "absolute",
  cursor: "move",
  pointerEvents: "auto",
  zIndex: 5,
};

/**
 * Ids the scene library hands out for elements that live INSIDE an array
 * prop rather than as their own top-level prop key (`packages/scenes`'
 * `line-N`/`node-N`/`message-N`/`window-N`). A plain `patchProps(sceneId, {
 * [elementId]: text })` — which works for `TitleCard`/`StatCard`/`RuleCard`/
 * `ScreenshotFrame`, where `data-edit-id` names an actual top-level prop —
 * writes into one of these ids as a prop key nothing ever reads, silently
 * losing the retype.
 */
const DYNAMIC_ID = /^(line|node|message|window|item)-(\d+)$/;

/**
 * Map a `line-N`/`node-N`/`message-N` id back to the array field it actually
 * lives in and return the prop PATCH that rewrites just that entry —
 * `null` if the id doesn't decompose this way, the cue has no matching
 * array, or the index is out of range. `window-N` (a `TerminalMock` window:
 * a title PLUS several lines) edits as one multiline blob — newline per
 * rendered terminal line, the title left untouched — because its lines
 * carry no ids of their own, so refusing the window here left TerminalMock
 * the only component with untouchable text (field report 2026-08-07).
 */
export function buildArrayPatch(
  elementId: string,
  props: Record<string, unknown>,
  text: string,
): Record<string, unknown> | null {
  const m = DYNAMIC_ID.exec(elementId);
  if (!m) return null;
  const kind = m[1] as "line" | "node" | "message" | "item" | "window";
  const idx = Number(m[2]);
  // ChatMock's CTA mode (props.keyword set) renders exactly ONE synthetic
  // bubble showing the keyword and ignores `props.messages` entirely
  // (FINDINGS §28b, `chatBubbles` in packages/scenes/src/fit.ts) — patching
  // `messages[0]` here would silently no-op the retype. The rendered text is
  // `"${keyword.toUpperCase()}"` (quote-wrapped, uppercased), so map it back
  // to a plain keyword instead of writing the decorated form into the prop.
  // The seed for an in-place edit (as opposed to a full retype) is the LIVE
  // decorated `textContent` (see the double-click handler below), so an edit
  // that only tweaks a letter or two — rather than replacing the whole
  // string — still carries the quotes and uppercasing through to here.
  // Lowercasing unconditionally (in addition to stripping the quotes) is the
  // simplest rule that closes that off: the keyword is uppercased again at
  // render time regardless, and it's matched case-insensitively against the
  // caption track, so no information is lost either way.
  if (kind === "message" && idx === 0 && typeof props.keyword === "string" && props.keyword) {
    const mapped = text.trim().replace(/^"(.*)"$/, "$1").toLowerCase();
    return mapped ? { keyword: mapped } : null;
  }
  const field =
    kind === "line"
      ? "lines"
      : kind === "node"
        ? "nodes"
        : kind === "item"
          ? "items"
          : kind === "window"
            ? "windows"
            : "messages";
  const arr = props[field];
  if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return null;
  const next = arr.slice();
  const item = next[idx];
  if (kind === "node" || kind === "item") {
    // FlowDiagram's `nodes` and BulletList's `items` are plain string[] —
    // the whole entry IS the text.
    next[idx] = text;
  } else if (kind === "window") {
    // A TerminalMock window's text is its `lines` array, and those lines
    // carry no per-line edit ids (only the window div is tagged), so the
    // panel edits the whole window as a newline-joined blob (field report
    // 2026-08-07). Split preserves empty lines — a blank terminal line is a
    // thing the author may want — and never touches `title`.
    if (typeof item !== "object" || item === null) return null;
    // TerminalMockProps' bounds (max 6 lines of max 40 chars) are enforced
    // HERE, at commit, because the override merge never re-validates props:
    // an out-of-schema override renders silently today and a component
    // swap-away-and-back would drop it. Silent truncation, not rejection,
    // because this is live typing — a keystroke stream has no single moment
    // to fail loudly at, unlike a parsed flag (the zod house rule's home).
    const lines = text
      .split("\n")
      .slice(0, 6)
      .map((l) => l.slice(0, 40));
    next[idx] = { ...(item as Record<string, unknown>), lines };
  } else {
    if (typeof item !== "object" || item === null) return null;
    next[idx] = { ...(item as Record<string, unknown>), text };
  }
  return { [field]: next };
}

/**
 * The current text an element id names — `buildArrayPatch`'s read direction
 * (R12 §49). Top-level string props read directly; the array-backed
 * `line-N`/`node-N`/`message-N` ids read out of their arrays; a CTA-mode
 * `message-0` reads the keyword (which is what a patch there writes); a
 * `window-N` (a TerminalMock window) reads its `lines` newline-joined —
 * the shape the window arm of `buildArrayPatch` writes back (field report
 * 2026-08-07). Null means "no text control".
 */
export function elementTextOf(
  elementId: string,
  props: Record<string, unknown>,
): string | null {
  const m = DYNAMIC_ID.exec(elementId);
  if (!m) {
    const v = props[elementId];
    return typeof v === "string" ? v : null;
  }
  const kind = m[1] as "line" | "node" | "message" | "item" | "window";
  const idx = Number(m[2]);
  if (kind === "message" && idx === 0 && typeof props.keyword === "string" && props.keyword) {
    return props.keyword;
  }
  const field =
    kind === "line"
      ? "lines"
      : kind === "node"
        ? "nodes"
        : kind === "item"
          ? "items"
          : kind === "window"
            ? "windows"
            : "messages";
  const arr = props[field];
  if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return null;
  const item = arr[idx];
  if (kind === "node" || kind === "item") return typeof item === "string" ? item : null;
  if (kind === "window") {
    const lines = (item as Record<string, unknown> | null)?.lines;
    return Array.isArray(lines) && lines.every((l) => typeof l === "string")
      ? lines.join("\n")
      : null;
  }
  const text = (item as Record<string, unknown> | null)?.text;
  return typeof text === "string" ? text : null;
}

/**
 * Blur an INPUT/TEXTAREA before a click elsewhere is handled (PLAN
 * 2026-08-04 Task 2, bug 6): the Inspector's own text fields — the
 * `element-text` input, every `NumberField`, `ThemeField` — already write
 * their edit on every `onChange`, not on blur (verified by reading them:
 * none gates its `onCommit`/`patch*` call behind a blur handler), so
 * dropping focus here only clears the STALE FOCUS, never the last-typed
 * value — a click away from a field commits what was typed, it does not
 * discard it. Without this, `document.activeElement` stays on the field and
 * Overlay's global keydown guard (`isTypingContext`) keeps routing every
 * keystroke into it instead of the shortcut the click was reaching for —
 * exactly bug 6 as filed (clicking the timeline doesn't blur the field).
 * Deliberately narrower than `isTypingContext` below (no SELECT, no
 * contentEditable): a dropdown or a range slider has no free-typed value a
 * click could discard, so there is nothing here for them to lose.
 */
export function blurTypingElement(): void {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    active.blur();
  }
}

/**
 * A transparent layer above the `<Player>` that turns clicks into a
 * selection, drags into `patchElement` nudges, and a double-click into
 * inline text editing. It never blocks the player's own controls: only the
 * box and its edit input accept pointer events, everything else passes
 * clicks straight through to `elementFromPoint`.
 */
export const Overlay: React.FC<OverlayProps> = ({
  stageRef,
  selection,
  onSelect,
  edits,
  onSave,
  settings,
  playerRef,
  onTransport,
  onVideoPreview,
  onGraphicPreview,
  cue,
  cues,
  onToggleHelp,
}) => {
  const [rect, setRect] = useState<DOMRect | null>(null);
  /** An in-progress drag-to-pan on the video slot (PLAN Task B). `base` is
   * the override's dx/dy at mousedown, so the drag ADDS to it. */
  const videoDragRef = useRef<{
    sceneId: string;
    x: number;
    y: number;
    dx: number;
    dy: number;
    baseDx: number;
    baseDy: number;
  } | null>(null);
  const videoRafRef = useRef(0);
  /** An in-progress drag of the PiP bubble itself (R21 §107): in the
   * pip-bubble layout the video IS the bubble, and the thing under the
   * cursor should move — plain drag repositions the bubble (`cue.pip`, the
   * R14 §52 override); ⌥-drag keeps the framing pan. */
  const pipDragRef = useRef<{
    sceneId: string;
    x: number;
    y: number;
    base: { x: number; y: number };
    slot: { w: number; h: number };
  } | null>(null);
  const pipRafRef = useRef(0);
  /** An in-progress transform of the graphic box (R11 Task 2). `start` is
   * the box in frame fractions at mousedown, measured off the DOM. */
  const rectDragRef = useRef<{
    sceneId: string;
    handle: BoxHandle;
    x: number;
    y: number;
    dx: number;
    dy: number;
    start: GraphicRect;
  } | null>(null);
  const rectRafRef = useRef(0);
  /** The altKey state as of the LAST mousemove of the current rect drag, not
   * the mouseup that commits it — the two events are independent, so without
   * this a user who presses/releases Alt after their last move (no
   * intervening mousemove) commits under a different Alt state than the
   * preview last showed, and the box visibly jumps on release. Reset to null
   * at drag start; null falls back to the mouseup event's own altKey, which
   * only matters if the drag commits with zero mousemoves in between (it
   * can't today — the commit is gated on `dx !== 0 || dy !== 0` below — but
   * the fallback keeps this correct even if that gate ever loosens). */
  const rectMoveAltKeyRef = useRef<boolean | null>(null);
  /** State (not just the ref) so the safe-area guide re-renders during it. */
  const [rectDragging, setRectDragging] = useState(false);
  /** The centre/safe-area guides `guideSnap` currently has active (Overlay
   * guides) — state, not a ref, so the yellow lines re-render live during
   * the drag; cleared on mouseup and whenever a drag holds Alt. */
  const [guides, setGuides] = useState<Guide[]>([]);
  /** An in-progress corner-resize of an ELEMENT (R12 §47): radial from the
   * element's centre, committed as ONE uniform-scale patch on mouseup. */
  const elResizeRef = useRef<{
    sceneId: string;
    elementId: string;
    cx: number;
    cy: number;
    startDist: number;
    prior: number;
    factor: number;
  } | null>(null);
  /** Mirrors the ref's factor so the box outline previews the resize live. */
  const [elResizeFactor, setElResizeFactor] = useState<number | null>(null);
  /** An in-progress caption word retype (PLAN Task 7, scope (a)). */
  const [captionEdit, setCaptionEdit] = useState<{
    index: number;
    was: string;
    draft: string;
    rect: DOMRect;
  } | null>(null);
  const dragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const [dragOffset, setDragOffset] = useState({ dx: 0, dy: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  // The mouseup handler needs the CURRENT selection, but it's attached in an
  // effect whose closure only refreshes after a render commits — a fast
  // mousedown-drag-mouseup sequence can otherwise finish before React ever
  // re-runs the effect, reading a stale (often null) `selection`. Mirroring
  // it into a ref, updated synchronously alongside the state, sidesteps that.
  const selectionRef = useRef(selection);
  const select = useCallback(
    (next: Selection | null) => {
      selectionRef.current = next;
      onSelect(next);
    },
    [onSelect],
  );
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  /**
   * The hit layer itself — plus, it turns out, several of Remotion's own
   * internal wrapper divs (Sequence/AbsoluteFill nodes that keep
   * `pointer-events: auto` regardless of an ancestor's `none`) — sit on top
   * of the tagged scene leaves. A single toggle only sees through ONE layer,
   * so this walks `elementFromPoint` down through however many stacked
   * layers there are, disabling each just long enough to see what's under
   * it, until it lands on a tagged element (or gives up), then restores
   * everything it touched.
   */
  const elementBelow = (clientX: number, clientY: number): Element | null => {
    // Restore each element's PREVIOUS inline value, never "": several targets
    // (caption words, the scene slots) carry a React inline pointer-events,
    // and clearing it leaves them unhittable until React happens to re-render
    // them — which is how the first click of a double-click used to make the
    // caption word invisible to the second.
    const touched: Array<{ el: HTMLElement; prev: string }> = [];
    let result: Element | null = null;
    for (let i = 0; i < 25; i++) {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el || el === document.documentElement || el === document.body) {
        result = el;
        break;
      }
      result = el;
      if (
        el.hasAttribute("data-edit-id") ||
        el.hasAttribute("data-edit-scene") ||
        el.hasAttribute("data-caption-word") ||
        // Inside the video slot (any descendant — the deepest hit is usually
        // the <video> itself): stop, `findVideoFrom` walks up to the tag.
        el.closest("[data-edit-video]") !== null ||
        // A real control (the Player's buttons, the rate chip): the press is
        // its — stop the descent so it can never be mistaken for the video
        // slot underneath it.
        ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)
      ) {
        break;
      }
      if (!(el instanceof HTMLElement)) break;
      touched.push({ el, prev: el.style.pointerEvents });
      el.style.pointerEvents = "none";
    }
    touched.forEach(({ el, prev }) => {
      el.style.pointerEvents = prev;
    });
    return result;
  };

  /**
   * The canvas's page-px box. The Player letterboxes its canvas centred
   * inside its container, so the origin is the container centre minus half
   * the scaled composition; `getScale()` is the authoritative size factor
   * (the same reasoning as `pageToComposition` below).
   */
  const canvasBox = useCallback(() => {
    const stage = stageRef.current;
    const scale = playerRef.current?.getScale();
    const host =
      stage?.querySelector(".__remotion-player")?.getBoundingClientRect() ??
      stage?.getBoundingClientRect();
    if (!host || !scale || scale <= 0) return null;
    const w = settings.width * scale;
    const h = settings.height * scale;
    return { left: host.left + (host.width - w) / 2, top: host.top + (host.height - h) / 2, w, h };
  }, [stageRef, playerRef, settings]);

  // Re-measure whenever the selection changes or the frame advances — the
  // Player re-renders on every frame, so the box must track it live. Gated on
  // `selection` so the rAF loop doesn't spin every frame with nothing to
  // measure.
  useEffect(() => {
    if (!selection) {
      setRect(null);
      return;
    }
    let raf: number;
    const tick = () => {
      const stage = stageRef.current;
      if (stage) {
        const r = selection.elementId
          ? rectOf(stage, selection.sceneId, selection.elementId)
          : stage.querySelector<HTMLElement>(`[data-edit-scene="${selection.sceneId}"]`)
              ?.getBoundingClientRect() ?? null;
        setRect(r);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stageRef, selection]);

  // The SELECTIVE swallow (PLAN Task 2). The Player treats any press on its
  // surface as click-to-toggle-playback, wired to `pointerdown` on its outer
  // div. The overlay's hit layer is deliberately `pointer-events: none` (so
  // the transport bar keeps working — the previous fix), which means every
  // press reaches the Player, including presses on editable elements: click
  // a label, the video plays. The rule wanted is selective, and the split
  // is: a press that lands on an editable ELEMENT (or the selection box over
  // one) belongs to the editor — stop it before the Player's React root sees
  // it; a press anywhere else (video background, transport controls) is the
  // Player's, untouched.
  //
  // Capture phase on `window`, because the Player's handler is a React
  // `onPointerDown` — stopping propagation during capture keeps the event
  // from ever reaching React's root listener. Only `stopPropagation`, never
  // `preventDefault`: per the pointer-events spec, cancelling `pointerdown`
  // suppresses the compatibility mouse events, and the selection/drag logic
  // below runs on exactly those.
  useEffect(() => {
    const onPointerDownCapture = (e: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      if (!stage.contains(e.target as Node)) return;
      // An Alt-press or a middle-button press is a VIEW gesture (§55b —
      // pan the magnified preview), never an edit. Leaving it alone here
      // keeps the split unambiguous: plain drag edits, Alt-drag moves the
      // camera, and neither can be mistaken for the other.
      if (e.altKey || e.button !== 0) return;
      const editorOwnsIt =
        (selectionRef.current?.elementId && boxRef.current?.contains(e.target as Node)) ||
        findEditableFrom(elementBelow(e.clientX, e.clientY)) !== null;
      if (editorOwnsIt) e.stopPropagation();
    };
    window.addEventListener("pointerdown", onPointerDownCapture, true);
    return () => window.removeEventListener("pointerdown", onPointerDownCapture, true);
  }, [stageRef]);

  // The hit layer itself is `pointer-events: none` (see the returned JSX)
  // so it never blocks the Player's own controls: a click on play/pause or
  // the scrub bar lands on the Player's real DOM, not on this overlay, and
  // therefore never bubbles through a handler attached to the overlay's own
  // node. So selection is driven by a `window`-level `mousedown` listener
  // instead, which inspects `e.target`/coordinates but never calls
  // `preventDefault`/`stopPropagation` on the mouse events — the native
  // click underneath still fires normally for everything the capture
  // listener above chose not to swallow.
  useEffect(() => {
    const onWindowMouseDown = (e: MouseEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      // Ignore clicks outside the stage entirely (topbar, sidebar, etc.) —
      // this listener is global precisely so pass-through works, but it must
      // not react to unrelated clicks.
      if (!stage.contains(e.target as Node)) return;
      // A mousedown that lands INSIDE the currently-focused field is the
      // field being USED — placing the cursor, drag-selecting text in the
      // caption editor — not a click away from it. The caption editor
      // commits-and-closes on blur, so blurring here killed the edit box the
      // double-click had just opened (field report 2026-08-07). Return
      // outright rather than merely skipping the blur: the hit-test below
      // would otherwise re-resolve whatever sits UNDER the editor and change
      // the selection mid-edit. (`contains` includes the node itself.)
      const active = document.activeElement;
      if (
        (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
        active.contains(e.target as Node)
      ) {
        return;
      }
      // Player-area mousedown (bug 6, PLAN 2026-08-04 Task 2): a click on the
      // stage — selecting a scene, dragging an element — should never leave
      // a stale Inspector field eating the keystrokes that follow. See
      // `blurTypingElement`'s own comment for why this only drops focus,
      // never a value.
      blurTypingElement();
      // View gestures (§55b): Alt-drag and middle-drag pan the magnified
      // preview — App owns them. They must not select, deselect, or arm any
      // edit drag here.
      if (e.altKey || e.button !== 0) return;
      // A mousedown that landed on the selection box itself continues
      // manipulating the CURRENT selection — but only when that selection is
      // an actual ELEMENT. An element's box exactly overlays that one
      // element, so any click inside it really is "drag this again". A
      // SCENE-level selection's box (`elementId: null`) instead covers the
      // entire slot — every element inside the scene visually sits under it
      // — so treating any click there as "continue the scene drag" would
      // silently swallow clicks meant for elements inside the scene (the
      // scene selection isn't draggable at all: `mouseup` bails out on
      // `!sel?.elementId`). Falling through to the `elementBelow` hit-test
      // below re-resolves what's actually under the cursor instead —
      // `elementBelow` already walks through arbitrary pointer-events:auto
      // layers (including this very box) to find the real tagged leaf.
      // A press on an ELEMENT corner handle (R12 §47) resizes rather than
      // moves — checked before the box-body branch below, which would read
      // any press inside the box as the start of a move drag.
      const elHandle =
        e.target instanceof Element ? e.target.closest<HTMLElement>("[data-el-handle]") : null;
      const elSel = selectionRef.current;
      if (elHandle && elSel?.elementId) {
        const r = rectOf(stage, elSel.sceneId, elSel.elementId);
        if (r) {
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const startDist = Math.hypot(e.clientX - cx, e.clientY - cy);
          if (startDist > 2) {
            const prior = edits.doc.scenes[elSel.sceneId]?.elements[elSel.elementId]?.scale ?? 1;
            elResizeRef.current = {
              sceneId: elSel.sceneId,
              elementId: elSel.elementId,
              cx,
              cy,
              startDist,
              prior,
              factor: 1,
            };
            setElResizeFactor(1);
          }
        }
        return;
      }
      if (selectionRef.current?.elementId && boxRef.current?.contains(e.target as Node)) {
        dragRef.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
        setDragOffset({ dx: 0, dy: 0 });
        return;
      }
      // A press on a BOX HANDLE (R11 Task 2) transforms the graphic slot.
      // Checked on the raw topmost target, before the hit walk — the walk
      // would disable the handle and drill straight past it. The handles
      // only render for a scene-level selection of a graphic cue, so the
      // guard here is just "is one under the pointer".
      const handleEl =
        e.target instanceof Element ? e.target.closest<HTMLElement>("[data-box-handle]") : null;
      const handleSel = selectionRef.current;
      if (handleEl && handleSel && !handleSel.elementId) {
        const node = stage.querySelector<HTMLElement>(
          `[data-edit-scene="${handleSel.sceneId}"]`,
        );
        const canvas = canvasBox();
        if (node && canvas) {
          const r = node.getBoundingClientRect();
          rectMoveAltKeyRef.current = null;
          rectDragRef.current = {
            sceneId: handleSel.sceneId,
            handle: handleEl.dataset.boxHandle as BoxHandle,
            x: e.clientX,
            y: e.clientY,
            dx: 0,
            dy: 0,
            start: {
              x: (r.left - canvas.left) / canvas.w,
              y: (r.top - canvas.top) / canvas.h,
              w: r.width / canvas.w,
              h: r.height / canvas.h,
            },
          };
          setRectDragging(true);
        }
        return;
      }
      const el = elementBelow(e.clientX, e.clientY);
      const hit = findEditableFrom(el);
      if (!hit) {
        // Missed every tagged leaf — still select the scene itself if the
        // click landed inside one, so the Inspector can offer scene-level
        // controls instead of going straight back to the theme panel.
        const scene = el?.closest<HTMLElement>("[data-edit-scene]");
        if (scene) {
          select({ sceneId: scene.dataset.editScene!, elementId: null });
          return;
        }
        // No element, no scene box — the picture itself. Grab it (PLAN Task
        // B): select the active cue and arm a drag-to-pan of its framing.
        // The bottom strip stays the Player's (its transport lives there).
        const videoSceneId = findVideoFrom(el);
        const stageBottom = stage.getBoundingClientRect().bottom;
        if (videoSceneId && e.clientY < stageBottom - PLAYER_CONTROLS_STRIP_PX) {
          select({ sceneId: videoSceneId, elementId: null });
          // The pip bubble (R21 §107): in this layout the picture IS the
          // bubble, and dragging the thing under the cursor should move IT.
          // Plain drag repositions the bubble; ⌥-drag keeps the framing pan
          // (⌥ already means "pan" on this stage — the view hint says so).
          const pipCue = cues.find((c) => c.id === videoSceneId);
          if (pipCue?.layout === "pip-bubble" && !e.altKey) {
            const slot = layoutSlots("pip-bubble", undefined, [], settings).video.rect;
            pipDragRef.current = {
              sceneId: videoSceneId,
              x: e.clientX,
              y: e.clientY,
              base: { x: pipCue.pip?.x ?? slot.x, y: pipCue.pip?.y ?? slot.y },
              slot: { w: slot.w, h: slot.h },
            };
            return;
          }
          const prior = edits.doc.scenes[videoSceneId]?.video;
          videoDragRef.current = {
            sceneId: videoSceneId,
            x: e.clientX,
            y: e.clientY,
            dx: 0,
            dy: 0,
            baseDx: prior?.dx ?? 0,
            baseDy: prior?.dy ?? 0,
          };
          return;
        }
        // Blank stage area or a Player control: clear the selection, same as
        // before this listener moved to `window`.
        select(null);
        return;
      }
      select({ sceneId: hit.sceneId, elementId: hit.elementId });
      dragRef.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
      setDragOffset({ dx: 0, dy: 0 });
    };
    window.addEventListener("mousedown", onWindowMouseDown);
    return () => window.removeEventListener("mousedown", onWindowMouseDown);
  }, [stageRef, select, edits, canvasBox, cues, settings]);

  useEffect(() => {
    // Page px → composition px. The factor comes from the Player's own
    // `getScale()` — the stage div's rect is subtly wrong: the Player
    // letterboxes its canvas inside the box the layout hands it, so a
    // height-capped viewport leaves the stage wider than the canvas and
    // every drag lands short by that ratio. One factor for both axes —
    // the Player scales uniformly.
    const pageToComposition = (): number => {
      const playerScale = playerRef.current?.getScale();
      const stageRect = stageRef.current?.getBoundingClientRect();
      return playerScale && playerScale > 0
        ? 1 / playerScale
        : stageRect && stageRect.width > 0
          ? settings.width / stageRect.width
          : 1;
    };
    const onMove = (e: MouseEvent) => {
      // Cursor affordance (PLAN Task B2.5): grab over the bare picture,
      // grabbing mid-pan. Cheap — the topmost target plus a closest() —
      // never the style-juggling hit walk, which is for presses only.
      const stage = stageRef.current;
      if (stage) {
        if (rectDragRef.current || elResizeRef.current) {
          // A handle drag: the handle's own cursor is right; leave it be.
        } else if (pipDragRef.current) {
          stage.style.cursor = "move";
        } else if (videoDragRef.current) {
          stage.style.cursor = "grabbing";
        } else {
          const t = e.target instanceof Element ? e.target : null;
          const overVideo =
            t !== null &&
            stage.contains(t) &&
            !t.closest(
              "button, input, select, textarea, [data-edit-id], [data-edit-scene], [data-caption-word]",
            ) &&
            e.clientY < stage.getBoundingClientRect().bottom - PLAYER_CONTROLS_STRIP_PX;
          // Over a pip bubble the affordance is MOVE (a plain drag will
          // reposition it — R21 §107); elsewhere the picture pans, so grab.
          const overPip =
            overVideo &&
            (() => {
              const id = findVideoFrom(t);
              return id !== null && cues.find((c) => c.id === id)?.layout === "pip-bubble";
            })();
          stage.style.cursor = overVideo ? (overPip ? "move" : "grab") : "";
        }
      }
      const elResize = elResizeRef.current;
      if (elResize) {
        // Radial: the factor is the ratio of the pointer's distance from the
        // element's centre — dragging a corner outward grows it, inward
        // shrinks. Clamped so the committed scale stays inside the schema.
        const d = Math.hypot(e.clientX - elResize.cx, e.clientY - elResize.cy);
        const raw = d / elResize.startDist;
        elResize.factor = Math.min(4 / elResize.prior, Math.max(0.05 / elResize.prior, raw));
        setElResizeFactor(elResize.factor);
        return;
      }
      const rectDrag = rectDragRef.current;
      if (rectDrag) {
        rectDrag.dx = e.clientX - rectDrag.x;
        rectDrag.dy = e.clientY - rectDrag.y;
        rectMoveAltKeyRef.current = e.altKey;
        if (!rectRafRef.current) {
          rectRafRef.current = requestAnimationFrame(() => {
            rectRafRef.current = 0;
            const drag = rectDragRef.current;
            const canvas = canvasBox();
            if (!drag || !canvas) return;
            // Page px → frame FRACTIONS (the rect's own unit). Like the
            // video pan there is NO compensateEdits division — the slot
            // lives outside the fit-scaled wrapper.
            const next = clampGraphicRect(
              applyBoxHandle(drag.start, drag.handle, drag.dx / canvas.w, drag.dy / canvas.h),
              settings,
            );
            // Overlay guides (spec): snap onto centre lines / safe-area
            // edges, AFTER applyBoxHandle + the clamp, before the preview
            // renders. Alt is the escape hatch (same convention as the
            // timeline's snapping) — checked here, at the call site, off the
            // captured mousemove event, so `guideSnap` itself never reads
            // modifier state and a held Alt reproduces the pre-guide drag
            // byte-for-byte.
            if (e.altKey) {
              setGuides([]);
              onGraphicPreview({ sceneId: drag.sceneId, rect: next });
            } else {
              const snapped = guideSnap(next, drag.handle, safeAreaFor(settings), THRESHOLD_FRAC);
              setGuides(snapped.guides);
              onGraphicPreview({ sceneId: drag.sceneId, rect: snapped.rect });
            }
          });
        }
        return;
      }
      const pipDrag = pipDragRef.current;
      if (pipDrag) {
        // Live commits under ONE coalesce key (the pip sliders' contract):
        // one drag, one undo step. rAF-throttled like every stage drag.
        if (!pipRafRef.current) {
          pipRafRef.current = requestAnimationFrame(() => {
            pipRafRef.current = 0;
            const drag = pipDragRef.current;
            const canvas = canvasBox();
            if (!drag || !canvas) return;
            const fx = (e.clientX - drag.x) / canvas.w;
            const fy = (e.clientY - drag.y) / canvas.h;
            edits.patchPip(
              drag.sceneId,
              {
                x: round4(Math.min(Math.max(drag.base.x + fx, 0), 1 - drag.slot.w)),
                y: round4(Math.min(Math.max(drag.base.y + fy, 0), 1 - drag.slot.h)),
              },
              `pip:${drag.sceneId}:drag`,
            );
          });
        }
        return;
      }
      const videoDrag = videoDragRef.current;
      if (videoDrag) {
        videoDrag.dx = e.clientX - videoDrag.x;
        videoDrag.dy = e.clientY - videoDrag.y;
        // rAF-throttled: the preview re-renders the whole Player frame, and
        // mousemove outruns paint.
        if (!videoRafRef.current) {
          videoRafRef.current = requestAnimationFrame(() => {
            videoRafRef.current = 0;
            const drag = videoDragRef.current;
            if (!drag) return;
            const scale = pageToComposition();
            // NO compensateEdits division, deliberately — the asymmetry with
            // element drags is real: a graphic's stored nudges render inside
            // a wrapper that `fitScale` scales, so they're counter-divided;
            // the video slot has no scaled wrapper (`cue.video.dx/dy` apply
            // via a plain translate), so dividing here would land every pan
            // short by the fit factor. Do not "fix" this into that bug.
            onVideoPreview({
              sceneId: drag.sceneId,
              patch: {
                dx: drag.baseDx + drag.dx * scale,
                dy: drag.baseDy + drag.dy * scale,
              },
            });
          });
        }
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      drag.dx = e.clientX - drag.x;
      drag.dy = e.clientY - drag.y;
      setDragOffset({ dx: drag.dx, dy: drag.dy });
    };
    const onUp = (e: MouseEvent) => {
      const elResize = elResizeRef.current;
      if (elResize) {
        elResizeRef.current = null;
        setElResizeFactor(null);
        if (Math.abs(elResize.factor - 1) > 1e-3) {
          // ONE patch per gesture — one undo step, rounded per §48.
          edits.patchElement(elResize.sceneId, elResize.elementId, {
            scale: Math.round(elResize.prior * elResize.factor * 1000) / 1000,
          });
        }
        return;
      }
      const rectDrag = rectDragRef.current;
      if (rectDrag) {
        rectDragRef.current = null;
        setRectDragging(false);
        setGuides([]);
        if (rectRafRef.current) {
          cancelAnimationFrame(rectRafRef.current);
          rectRafRef.current = 0;
        }
        if (rectDrag.dx !== 0 || rectDrag.dy !== 0) {
          const canvas = canvasBox();
          if (canvas) {
            // ONE patch per gesture — one undo step, like every other drag.
            let final = clampGraphicRect(
              applyBoxHandle(
                rectDrag.start,
                rectDrag.handle,
                rectDrag.dx / canvas.w,
                rectDrag.dy / canvas.h,
              ),
              settings,
            );
            // Same guide snap as the live preview, same Alt escape hatch —
            // the committed rect must match whatever the last preview frame
            // showed, or the box would visibly jump on release. Read from
            // the LAST MOUSEMOVE's Alt state, not this mouseup's own: they
            // are independent events, and a press/release of Alt with no
            // move in between would otherwise commit under a different Alt
            // state than what the preview last drew.
            if (!(rectMoveAltKeyRef.current ?? e.altKey)) {
              final = guideSnap(final, rectDrag.handle, safeAreaFor(settings), THRESHOLD_FRAC).rect;
            }
            edits.patchGraphicRect(rectDrag.sceneId, {
              x: round4(final.x),
              y: round4(final.y),
              w: round4(final.w),
              h: round4(final.h),
            });
          }
        }
        rectMoveAltKeyRef.current = null;
        onGraphicPreview(null);
        return;
      }
      const pipDrag = pipDragRef.current;
      if (pipDrag) {
        // The moves already landed, coalesced under one key — nothing to
        // commit here beyond letting go.
        pipDragRef.current = null;
        if (pipRafRef.current) {
          cancelAnimationFrame(pipRafRef.current);
          pipRafRef.current = 0;
        }
        return;
      }
      const videoDrag = videoDragRef.current;
      if (videoDrag) {
        videoDragRef.current = null;
        if (videoRafRef.current) {
          cancelAnimationFrame(videoRafRef.current);
          videoRafRef.current = 0;
        }
        if (videoDrag.dx !== 0 || videoDrag.dy !== 0) {
          const scale = pageToComposition();
          // ONE patch per gesture — one undo step (PLAN Task B2.4).
          edits.patchVideo(videoDrag.sceneId, {
            dx: round1(videoDrag.baseDx + videoDrag.dx * scale),
            dy: round1(videoDrag.baseDy + videoDrag.dy * scale),
          });
        }
        onVideoPreview(null);
        return;
      }
      const drag = dragRef.current;
      const sel = selectionRef.current;
      if (!drag || !sel?.elementId) {
        dragRef.current = null;
        return;
      }
      if (drag.dx !== 0 || drag.dy !== 0) {
        // Same page-px → composition-px rescale as the video pan above; the
        // difference is `compensateEdits` DOWNSTREAM (SceneLayer divides the
        // stored value by the fit scale, because element nudges render
        // inside the scaled wrapper).
        const scale = pageToComposition();
        const scene = edits.doc.scenes[sel.sceneId];
        const prior = scene?.elements[sel.elementId];
        edits.patchElement(sel.sceneId, sel.elementId, {
          dx: round1((prior?.dx ?? 0) + drag.dx * scale),
          dy: round1((prior?.dy ?? 0) + drag.dy * scale),
        });
      }
      dragRef.current = null;
      setDragOffset({ dx: 0, dy: 0 });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [edits, stageRef, settings, playerRef, onVideoPreview, onGraphicPreview, canvasBox, cues]);

  // Element INLINE editing is gone (R12 §49, the author's call): the
  // floating input painted over the element while the un-edited render was
  // still visible behind it, so you judged a mixture of old pixels and new
  // value. Text edits live in the Inspector's panel now — which also covers
  // the array-backed line-N/node-N/message-N ids via buildArrayPatch, so
  // nothing the double-click could reach was lost. Caption words keep THEIR
  // double-click below: that flow edits a different document (the caption
  // stream), positions beside the word rather than over a graphic, and §49
  // explicitly left it as its own decision.

  // Double-click on a caption word opens an in-place retype (PLAN Task 7,
  // scope (a): 1:1 text swap, timing untouched). Window-level because the
  // caption spans live inside the Player's DOM, not the overlay's. Resolved
  // through the `elementBelow` WALK, not a bare elementFromPoint (R15 §57):
  // the Player's transport strip keeps pointer events even while faded out,
  // and in a short preview (landscape at the old fixed width) it covered the
  // exact band captions sit in — the bare hit returned the transport's div
  // and the retype never opened. The walk drills through pointer-eating
  // layers but STOPS at real controls (buttons, inputs), so a double-click
  // on the transport's own buttons stays the Player's (§57b).
  useEffect(() => {
    const onDoubleClick = (e: MouseEvent) => {
      const stage = stageRef.current;
      if (!stage || !stage.contains(e.target as Node)) return;
      const word = elementBelow(e.clientX, e.clientY)?.closest<HTMLElement>(
        "[data-caption-word]",
      );
      if (!word) return;
      e.preventDefault();
      const index = Number(word.dataset.captionWord);
      // The RAW text, not textContent — the rendered word may be CTA-decorated
      // ("AGENTS"), and the stale-guard must match the stored truth.
      const was = word.dataset.captionText ?? "";
      if (!Number.isFinite(index) || !was) return;
      setCaptionEdit({ index, was, draft: was, rect: word.getBoundingClientRect() });
    };
    window.addEventListener("dblclick", onDoubleClick);
    return () => window.removeEventListener("dblclick", onDoubleClick);
  }, [stageRef]);

  useEffect(() => {
    /** A keystroke belongs to a field, not the transport. */
    const isTypingContext = (): boolean => {
      const active = document.activeElement;
      return (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      );
    };
    /**
     * Only TEXT ENTRY holds onto playback keys (R16 §70). A slider you just
     * scrubbed, a select, a checkbox — none of them "wants" a space, but
     * they kept focus and swallowed it, so play/pause went dead until you
     * clicked away. Those controls now YIELD: the key blurs them and drives
     * the transport. A text field keeps every key — a space there is a
     * space. (Plain arrows still respect ALL inputs: arrows on a focused
     * slider adjust the slider, which is what sliders are for.)
     */
    const isTextEntry = (): boolean => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) return true;
      if (active instanceof HTMLElement && active.isContentEditable) return true;
      return (
        active instanceof HTMLInputElement &&
        !["range", "checkbox", "radio", "button"].includes(active.type)
      );
    };
    const yieldFocus = (): void => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !isTextEntry()) active.blur();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (captionEdit !== null) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        // A focused field first (R21 §102): Escape LEAVES the field, keeping
        // the selection — without this, focus stayed trapped in the input and
        // every shortcut below read as "broken" until a click elsewhere.
        if (isTypingContext()) {
          (document.activeElement as HTMLElement | null)?.blur();
          return;
        }
        select(null);
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        // ⌘⇧Z redoes (R17 §80) — the convention everywhere; ⌘Y below is the
        // Windows-habit alias.
        if (e.shiftKey) edits.redo();
        else edits.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        edits.redo();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // Route through the same handler the Save button uses, so a failed
        // keyboard save surfaces in the error banner instead of vanishing
        // into an unhandled promise rejection.
        onSave();
      } else if (e.key === " " && !mod) {
        // SPACE toggles playback globally (PLAN Task 5) — with two guards.
        // TEXT ENTRY wins: a space in an inline edit (the early return
        // above) or an inspector text field must insert a space. Everything
        // else — a slider, a select — yields (§70): blur, then toggle.
        if (isTextEntry()) return;
        // And the Player's own space handling wins: with focus on a button
        // inside the stage (its play button — the Player focuses it for
        // exactly this), the native button activation already toggles, and
        // firing here too would toggle twice for a net no-op.
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          active.tagName === "BUTTON" &&
          stageRef.current?.contains(active)
        ) {
          return;
        }
        yieldFocus();
        e.preventDefault();
        playerRef.current?.toggle();
      } else if (!mod && ["j", "k", "l"].includes(e.key.toLowerCase())) {
        // J/K/L transport (PLAN Task 2), same yield rule as SPACE (§70). The
        // ladder itself lives in transport.ts; App owns the side effects.
        if (isTextEntry()) return;
        yieldFocus();
        e.preventDefault();
        onTransport(e.key.toUpperCase() as "J" | "K" | "L");
      } else if (!mod && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        // Plain arrows step ONE FRAME (R16 §71), selection or no selection —
        // ⌥+arrows select scenes and ⌘+arrows jump scene starts; the bare
        // key is the fine-grained playhead nudge every editor has. Sliders
        // keep their arrows: adjusting a focused range input is what arrows
        // are FOR there, so the full typing guard applies here.
        if (isTypingContext()) return;
        e.preventDefault();
        const player = playerRef.current;
        if (!player) return;
        player.seekTo(Math.max(0, player.getCurrentFrame() + (e.key === "ArrowRight" ? 1 : -1)));
      } else if (mod && e.key.toLowerCase() === "b") {
        // Split the scene under the playhead (R16 §61) — the editor's ⌘B.
        // Stored as an absolute output time in the override doc, applied
        // after the plain fill, so scenes and takes split alike and undo
        // takes it back like any other edit.
        if (isTextEntry()) return;
        e.preventDefault();
        const player = playerRef.current;
        if (!player) return;
        const t = player.getCurrentFrame() / settings.fps;
        const target = cues.find(
          (c) => t >= c.startSec + SPLIT_MIN_PIECE_SEC && t <= c.endSec - SPLIT_MIN_PIECE_SEC,
        );
        // Too close to an edge (or on no cue at all): refuse rather than
        // mint an unusably thin half.
        if (!target) return;
        edits.addSplit(Math.round(t * 1000) / 1000);
      } else if (!mod && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        // ⌥+arrows move the SELECTION to the neighbouring scene (R16 §62) —
        // the playhead stays put; this is "select", not "navigate". With
        // NOTHING selected it starts the walk (R21 §102): → selects the
        // first scene, ← the last, instead of doing nothing.
        if (isTextEntry()) return;
        const sel = selectionRef.current;
        const next = sel
          ? (() => {
              const idx = cues.findIndex((c) => c.id === sel.sceneId);
              return idx === -1 ? undefined : cues[idx + (e.key === "ArrowRight" ? 1 : -1)];
            })()
          : cues[e.key === "ArrowRight" ? 0 : cues.length - 1];
        if (!next) return;
        e.preventDefault();
        select({ sceneId: next.id, elementId: null });
      } else if (mod && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        // ⌘+arrows move the PLAYHEAD to the neighbouring scene's start (R16
        // §62) — as asked: the beginning of the previous / next scene — AND
        // select it (§72): the cursor is there, the scene is selected, and
        // play starts from exactly that point. preventDefault also keeps
        // the browser's ⌘← history-back away.
        if (isTextEntry()) return;
        e.preventDefault();
        const player = playerRef.current;
        if (!player) return;
        const t = player.getCurrentFrame() / settings.fps;
        const idx = cues.findIndex((c) => t >= c.startSec && t < c.endSec);
        const target = cues[(idx === -1 ? 0 : idx) + (e.key === "ArrowRight" ? 1 : -1)];
        if (!target) return;
        player.seekTo(Math.round(target.startSec * settings.fps));
        select({ sceneId: target.id, elementId: null });
      } else if (!mod && !e.altKey && e.key === "?") {
        // The keybinds reference (R16 §63).
        if (isTypingContext()) return;
        e.preventDefault();
        onToggleHelp();
      } else if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
        // Soft-delete the selected GRAPHIC scene (PLAN Task C6). Scene-level
        // selection only: with an element selected, Backspace is far more
        // likely aimed at text than at the whole scene. Takes can't be
        // deleted (their window is derived — there is nothing to remove),
        // and a ghost is already deleted. Selection is kept so the
        // Inspector's Restore is one keystroke away from an accidental hit.
        if (isTypingContext()) return;
        const sel = selectionRef.current;
        if (!sel || sel.elementId !== null) return;
        if (!cue || cue.kind === "plain" || cue.id !== sel.sceneId) return;
        if (edits.doc.scenes[sel.sceneId]?.hidden === true) return;
        e.preventDefault();
        edits.hideScene(sel.sceneId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [select, edits, captionEdit, onSave, playerRef, stageRef, onTransport, cue, cues, settings, onToggleHelp]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        // The whole point of this fix: `none` here means this layer is
        // invisible to hit-testing everywhere except its own explicitly
        // `auto` descendants (the box, below, and the edit input) — so a
        // click that misses both lands on whatever is actually underneath
        // (the Player's controls, or a scene element), not on this div. The
        // `window` mousedown listener above still runs for every click and
        // does the selection/hit-test bookkeeping, but never blocks the
        // native click from also reaching its real target.
        pointerEvents: "none",
      }}
    >
      {dragOffset.dx !== 0 || dragOffset.dy !== 0 || rectDragging ? (
        // The platform chrome insets, shown ONLY while a drag is in progress
        // (PLAN Task 4): an element dragged under the invisible safe area
        // looks like it simply vanished. Drawn from the exported SAFE_AREA —
        // never a hardcoded copy, or the guide drifts from the geometry it
        // claims to show. Non-interactive so it cannot swallow the drag it
        // is annotating.
        <div
          data-testid="safe-area-guide"
          style={{
            position: "absolute",
            // The frame's OWN insets (R15): landscape has no platform chrome,
            // and drawing the portrait rails on it would annotate a
            // constraint the geometry no longer enforces.
            left: `${safeAreaFor(settings).left * 100}%`,
            top: `${safeAreaFor(settings).top * 100}%`,
            right: `${safeAreaFor(settings).right * 100}%`,
            bottom: `${safeAreaFor(settings).bottom * 100}%`,
            border: "1px dashed rgba(255, 225, 77, 0.45)",
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.18)",
            pointerEvents: "none",
          }}
        />
      ) : null}
      {/* Overlay guides (spec: "Overlay guides") — a 1px accent-yellow line
          spanning the frame for each axis `guideSnap` currently has active.
          Percentage-positioned against THIS div, same coordinate convention
          as the safe-area guide above (both are frame fractions). Only
          rendered while there's something to show. */}
      {guides.map((g) => (
        <div
          key={g.axis}
          data-testid={`guide-${g.axis}`}
          style={{
            position: "absolute",
            pointerEvents: "none",
            background: "#FFE14D",
            ...(g.axis === "x"
              ? { left: `${g.at * 100}%`, top: 0, bottom: 0, width: 1 }
              : { top: `${g.at * 100}%`, left: 0, right: 0, height: 1 }),
          }}
        />
      ))}
      {rect && selection ? (
        <div
          ref={boxRef}
          data-testid="overlay-box"
          style={{
            position: "fixed",
            pointerEvents: "auto",
            // A corner resize previews on the OUTLINE, centre-anchored (R12
            // §47) — the element itself re-renders once the patch commits,
            // same contract as the move drag.
            left:
              rect.left +
              dragOffset.dx -
              HANDLE / 2 +
              (rect.width * (1 - (elResizeFactor ?? 1))) / 2,
            top:
              rect.top +
              dragOffset.dy -
              HANDLE / 2 +
              (rect.height * (1 - (elResizeFactor ?? 1))) / 2,
            width: rect.width * (elResizeFactor ?? 1) + HANDLE,
            height: rect.height * (elResizeFactor ?? 1) + HANDLE,
            border: selection.elementId ? "2px dashed #ffe14d" : "2px dashed #5b8cff",
            borderRadius: 4,
            boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
            cursor: selection.elementId ? "grab" : "default",
          }}
        >
          {selection.elementId ? (
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                marginBottom: 4,
                fontSize: 10,
                fontFamily: "ui-monospace, 'SF Mono', monospace",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "#0B0B0E",
                background: "#ffe14d",
                padding: "2px 6px",
                borderRadius: 3,
                whiteSpace: "nowrap",
              }}
            >
              {selection.elementId}
            </div>
          ) : null}
          {/* Element corner handles (R12 §47): position was already direct
              manipulation (drag to move) while size was numbers-only — the
              half-state the findings flagged. Radial drag = uniform scale. */}
          {selection.elementId
            ? (["nw", "ne", "se", "sw"] as const).map((h) => (
                <div
                  key={h}
                  data-el-handle={h}
                  data-testid={`el-handle-${h}`}
                  style={{ ...elHandleBase, ...HANDLE_POS[h] }}
                />
              ))
            : null}
          {/* Transform handles (R11 Task 2): scene-level selection of a cue
              that actually DRAWS a graphic — the box is measured off its
              `data-edit-scene` node, which SceneLayer only renders when the
              layout has a slot, so full-bleed cues and plain takes (which
              draw no graphic) never grow handles the feature can't honour.
              The box BODY stays click-through (the hit walk sees through
              it), or element selection inside the box breaks — so moving is
              a titlebar-style strip along the top edge, not the whole body. */}
          {!selection.elementId && cue && cue.kind !== "plain" ? (
            <>
              {(["top", "bottom", "left", "right"] as const).map((side) => (
                <div
                  key={side}
                  data-box-handle="move"
                  data-testid={side === "top" ? "box-handle-move" : `box-handle-move-${side}`}
                  style={{ ...moveEdgeBase, ...MOVE_EDGES[side] }}
                />
              ))}
              {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((h) => (
                <div
                  key={h}
                  data-box-handle={h}
                  data-testid={`box-handle-${h}`}
                  style={{ ...boxHandleBase, ...HANDLE_POS[h] }}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      {captionEdit ? (
        <input
          autoFocus
          data-testid="caption-edit"
          value={captionEdit.draft}
          onChange={(e) => setCaptionEdit({ ...captionEdit, draft: e.target.value })}
          onBlur={() => {
            const trimmed = captionEdit.draft.trim();
            // Commit on anything non-empty (retyping the original back CLEARS
            // the override — the reducer's rule); empty is a cancel, because a
            // caption word cannot be deleted here: 1:1 is the contract that
            // keeps timings and scene anchors intact.
            if (trimmed) edits.patchCaption(captionEdit.index, trimmed, captionEdit.was);
            setCaptionEdit(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setCaptionEdit(null);
          }}
          style={{
            position: "fixed",
            pointerEvents: "auto",
            left: captionEdit.rect.left - 4,
            top: captionEdit.rect.top - 4,
            width: Math.max(captionEdit.rect.width + 40, 90),
            height: captionEdit.rect.height + 8,
            fontSize: Math.max(13, Math.min(captionEdit.rect.height * 0.7, 28)),
            fontFamily: "'Inter', system-ui, sans-serif",
            fontWeight: 800,
            border: "2px solid #FFE14D",
            borderRadius: 4,
            padding: "0 4px",
            background: "#0B0B0E",
            color: "#fff",
            outline: "none",
            zIndex: 11,
          }}
        />
      ) : null}
    </div>
  );
};
