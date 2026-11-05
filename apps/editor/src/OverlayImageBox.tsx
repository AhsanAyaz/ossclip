import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import type { OverlayRect } from "@ossclip/core/browser";
import { guideSnap, THRESHOLD_FRAC, type Guide, type SafeArea } from "./guides";
import {
  canvasBoxFor,
  fracToPage,
  moveOverlayRect,
  pageToFrac,
  resizeOverlayRect,
  type CanvasBox,
  type OverlayCorner,
} from "./overlayBox";

/** A live, uncommitted overlay box — `GraphicPreview`'s lifecycle: App lays
 * it over the matching cue so the Player previews the drag, cleared on commit. */
export interface OverlayRectPreview {
  id: string;
  rect: OverlayRect;
}

export interface OverlayImageBoxHandle {
  /** Start a move drag on `id` from a press that already happened — the
   * stage's hit-test found the picture under the pointer (Overlay.tsx), so
   * one press both selects and grabs, the way a graphic element behaves. */
  beginMove: (id: string, clientX: number, clientY: number) => void;
}

interface Props {
  stageRef: React.RefObject<HTMLDivElement>;
  playerRef: React.RefObject<PlayerRef>;
  settings: { width: number; height: number };
  safeArea: SafeArea;
  selectedId: string | null;
  onPreview: (preview: OverlayRectPreview | null) => void;
  onCommit: (id: string, rect: OverlayRect) => void;
}

const HANDLE = 9;
const ACCENT = "#ffe14d";

const CORNER_POS: Record<OverlayCorner, React.CSSProperties> = {
  nw: { left: -HANDLE / 2, top: -HANDLE / 2, cursor: "nwse-resize" },
  ne: { right: -HANDLE / 2, top: -HANDLE / 2, cursor: "nesw-resize" },
  se: { right: -HANDLE / 2, bottom: -HANDLE / 2, cursor: "nwse-resize" },
  sw: { left: -HANDLE / 2, bottom: -HANDLE / 2, cursor: "nesw-resize" },
};

const overlaySelector = (id: string): string => `[data-edit-overlay="${CSS.escape(id)}"]`;

/**
 * The selection box for a library overlay on the stage (overlay-transform):
 * drag the body to move, a corner to resize with the picture's aspect kept.
 * The same gestures a graphic box has, minus edge handles (see
 * `resizeOverlayRect`). Measured off the rendered `data-edit-overlay`
 * element every frame, so it hides itself whenever the playhead is outside
 * the overlay's window — there is nothing on screen to move then.
 *
 * Kept out of Overlay.tsx on purpose: that layer is scene/element selection
 * with a dozen interacting gestures, and an overlay is neither. Its one
 * hook there is the hit-test that hands a press on the picture to
 * `beginMove`.
 */
export const OverlayImageBox = React.forwardRef<OverlayImageBoxHandle, Props>(function OverlayImageBox(
  { stageRef, playerRef, settings, safeArea, selectedId, onPreview, onCommit },
  ref,
) {
  const [pageRect, setPageRect] = useState<DOMRect | null>(null);
  const [dragRect, setDragRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const dragRef = useRef<{
    id: string;
    mode: "move" | OverlayCorner;
    x: number;
    y: number;
    start: OverlayRect;
    canvas: CanvasBox;
    last: OverlayRect | null;
  } | null>(null);
  // The callbacks a drag's window listeners call — refs so a re-render
  // mid-drag (every preview is one) never strands a listener on a stale prop.
  const onPreviewRef = useRef(onPreview);
  const onCommitRef = useRef(onCommit);
  onPreviewRef.current = onPreview;
  onCommitRef.current = onCommit;

  const canvasBox = useCallback((): CanvasBox | null => {
    const stage = stageRef.current;
    const scale = playerRef.current?.getScale();
    const host =
      stage?.querySelector(".__remotion-player")?.getBoundingClientRect() ?? stage?.getBoundingClientRect();
    if (!host || !scale) return null;
    return canvasBoxFor(host, scale, settings);
  }, [stageRef, playerRef, settings]);

  // Track the picture while selected (Overlay.tsx's rAF posture: the Player
  // re-renders per frame, and the entrance pop changes the box's size).
  useEffect(() => {
    if (selectedId === null) {
      setPageRect(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      const el = stageRef.current?.querySelector<HTMLElement>(overlaySelector(selectedId));
      setPageRect(el ? el.getBoundingClientRect() : null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stageRef, selectedId]);

  const startDrag = useCallback(
    (id: string, mode: "move" | OverlayCorner, clientX: number, clientY: number) => {
      const el = stageRef.current?.querySelector<HTMLElement>(overlaySelector(id));
      const canvas = canvasBox();
      if (!el || !canvas) return;
      dragRef.current = {
        id,
        mode,
        x: clientX,
        y: clientY,
        start: pageToFrac(el.getBoundingClientRect(), canvas),
        canvas,
        last: null,
      };
      const onMove = (e: MouseEvent) => {
        const d = dragRef.current;
        if (!d) return;
        const fdx = (e.clientX - d.x) / d.canvas.w;
        const fdy = (e.clientY - d.y) / d.canvas.h;
        if (fdx === 0 && fdy === 0) return;
        let next: OverlayRect;
        let shown: Guide[] = [];
        if (d.mode === "move") {
          next = moveOverlayRect(d.start, fdx, fdy);
          // Snapping on a move only, and Alt opts out (the graphic box's
          // rule): a corner snap would have to break the locked aspect.
          if (!e.altKey) {
            const snapped = guideSnap(next, "move", safeArea, THRESHOLD_FRAC);
            next = moveOverlayRect(snapped.rect, 0, 0);
            shown = snapped.guides;
          }
        } else {
          next = resizeOverlayRect(d.start, d.mode, fdx, fdy);
        }
        d.last = next;
        setGuides(shown);
        setDragRect(fracToPage(next, d.canvas));
        onPreviewRef.current({ id: d.id, rect: next });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        const d = dragRef.current;
        dragRef.current = null;
        setGuides([]);
        setDragRect(null);
        // A press with no movement is a click — it selected, it moves nothing.
        if (d?.last) onCommitRef.current(d.id, d.last);
        onPreviewRef.current(null);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [stageRef, canvasBox, safeArea],
  );

  useImperativeHandle(ref, () => ({ beginMove: (id, x, y) => startDrag(id, "move", x, y) }), [startDrag]);

  const shown = dragRect ?? pageRect;
  if (selectedId === null || shown === null) return null;
  const canvas = guides.length > 0 ? canvasBox() : null;
  return (
    <>
      {canvas
        ? guides.map((g) => (
            <div
              key={g.axis}
              data-testid={`overlay-guide-${g.axis}`}
              style={{
                position: "fixed",
                pointerEvents: "none",
                background: ACCENT,
                ...(g.axis === "x"
                  ? { left: canvas.left + g.at * canvas.w, top: canvas.top, height: canvas.h, width: 1 }
                  : { top: canvas.top + g.at * canvas.h, left: canvas.left, width: canvas.w, height: 1 }),
              }}
            />
          ))
        : null}
      <div
        data-overlay-box=""
        data-testid="overlay-image-box"
        onMouseDown={(e) => {
          if (e.button !== 0 || e.altKey) return;
          // preventDefault: no text selection or native image drag mid-gesture.
          e.preventDefault();
          const corner = (e.target as HTMLElement).closest<HTMLElement>("[data-overlay-corner]")?.dataset
            .overlayCorner as OverlayCorner | undefined;
          startDrag(selectedId, corner ?? "move", e.clientX, e.clientY);
        }}
        style={{
          position: "fixed",
          left: shown.left,
          top: shown.top,
          width: shown.width,
          height: shown.height,
          border: `2px dashed ${ACCENT}`,
          borderRadius: 4,
          boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
          boxSizing: "border-box",
          cursor: "grab",
          pointerEvents: "auto",
          zIndex: 5,
        }}
      >
        {(["nw", "ne", "se", "sw"] as const).map((c) => (
          <div
            key={c}
            data-overlay-corner={c}
            data-testid={`overlay-corner-${c}`}
            style={{
              position: "absolute",
              width: HANDLE,
              height: HANDLE,
              background: ACCENT,
              border: "1px solid #0B0B0E",
              borderRadius: 2,
              ...CORNER_POS[c],
            }}
          />
        ))}
      </div>
    </>
  );
});
