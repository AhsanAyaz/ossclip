import React, { useCallback, useEffect, useRef, useState } from "react";
import { findEditableFrom, rectOf } from "./hitTest";
import type { useEdits } from "./useEdits";

export interface Selection {
  sceneId: string;
  elementId: string | null;
}

interface OverlayProps {
  /** The DOM node the Player mounted into — the coordinate space to hit-test. */
  stageRef: React.RefObject<HTMLDivElement>;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  edits: ReturnType<typeof useEdits>;
}

const HANDLE = 9;

/**
 * A transparent layer above the `<Player>` that turns clicks into a
 * selection, drags into `patchElement` nudges, and a double-click into
 * inline text editing. It never blocks the player's own controls: only the
 * box and its edit input accept pointer events, everything else passes
 * clicks straight through to `elementFromPoint`.
 */
export const Overlay: React.FC<OverlayProps> = ({ stageRef, selection, onSelect, edits }) => {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const [dragOffset, setDragOffset] = useState({ dx: 0, dy: 0 });
  const hitLayerRef = useRef<HTMLDivElement>(null);
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
    const touched: HTMLElement[] = [];
    let result: Element | null = null;
    for (let i = 0; i < 25; i++) {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el || el === document.documentElement || el === document.body) {
        result = el;
        break;
      }
      result = el;
      if (el.hasAttribute("data-edit-id") || el.hasAttribute("data-edit-scene")) break;
      if (!(el instanceof HTMLElement)) break;
      touched.push(el);
      el.style.pointerEvents = "none";
    }
    touched.forEach((el) => {
      el.style.pointerEvents = "";
    });
    return result;
  };

  // Re-measure whenever the selection changes or the frame advances — the
  // Player re-renders on every frame, so the box must track it live.
  useEffect(() => {
    let raf: number;
    const tick = () => {
      const stage = stageRef.current;
      if (stage && selection) {
        const r = selection.elementId
          ? rectOf(stage, selection.sceneId, selection.elementId)
          : stage.querySelector<HTMLElement>(`[data-edit-scene="${selection.sceneId}"]`)
              ?.getBoundingClientRect() ?? null;
        setRect(r);
      } else {
        setRect(null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stageRef, selection]);

  const handleStageMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const stage = stageRef.current;
      if (!stage || editingText !== null) return;
      // A mousedown that landed on the selection box itself continues
      // manipulating the CURRENT selection — resolving via `elementFromPoint`
      // here would just find the box (it explicitly keeps pointer events so
      // it's draggable), not what's under it, and wrongly clear the selection.
      if (selectionRef.current && boxRef.current?.contains(e.target as Node)) {
        dragRef.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
        setDragOffset({ dx: 0, dy: 0 });
        return;
      }
      const el = elementBelow(e.clientX, e.clientY);
      const hit = findEditableFrom(el);
      if (!hit) {
        // Missed every tagged leaf — still select the scene itself if the
        // click landed inside one, so the Inspector can offer scene-level
        // controls instead of going straight back to the theme panel.
        const scene = el?.closest<HTMLElement>("[data-edit-scene]");
        select(scene ? { sceneId: scene.dataset.editScene!, elementId: null } : null);
        return;
      }
      select({ sceneId: hit.sceneId, elementId: hit.elementId });
      dragRef.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
      setDragOffset({ dx: 0, dy: 0 });
    },
    [stageRef, select, editingText],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.dx = e.clientX - drag.x;
      drag.dy = e.clientY - drag.y;
      setDragOffset({ dx: drag.dx, dy: drag.dy });
    };
    const onUp = () => {
      const drag = dragRef.current;
      const sel = selectionRef.current;
      if (!drag || !sel?.elementId) {
        dragRef.current = null;
        return;
      }
      if (drag.dx !== 0 || drag.dy !== 0) {
        const scene = edits.doc.scenes[sel.sceneId];
        const prior = scene?.elements[sel.elementId];
        edits.patchElement(sel.sceneId, sel.elementId, {
          dx: (prior?.dx ?? 0) + drag.dx,
          dy: (prior?.dy ?? 0) + drag.dy,
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
  }, [edits]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!selection?.elementId) return;
      e.preventDefault();
      // Seed from the rendered DOM, not `edits.doc.scenes[...].props` — the
      // override doc only holds the user's DELTA over the producer's props,
      // so an untouched element has no entry there at all and this would
      // start the input blank instead of showing what's actually on screen.
      const stage = stageRef.current;
      const node = stage?.querySelector<HTMLElement>(
        `[data-edit-scene="${selection.sceneId}"] [data-edit-id="${selection.elementId}"]`,
      );
      setEditingText(node?.textContent ?? "");
    },
    [selection, stageRef],
  );

  const commitText = useCallback(() => {
    if (selection?.elementId && editingText !== null) {
      edits.patchProps(selection.sceneId, { [selection.elementId]: editingText });
    }
    setEditingText(null);
  }, [selection, editingText, edits]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (editingText !== null) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        select(null);
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        edits.undo();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void edits.save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [select, edits, editingText]);

  return (
    <div
      ref={hitLayerRef}
      onMouseDown={handleStageMouseDown}
      style={{
        position: "absolute",
        inset: 0,
        cursor: selection?.elementId ? "grab" : "default",
      }}
    >
      {rect && selection ? (
        <div
          ref={boxRef}
          onDoubleClick={handleDoubleClick}
          style={{
            position: "fixed",
            pointerEvents: editingText !== null ? "none" : "auto",
            left: rect.left + dragOffset.dx - HANDLE / 2,
            top: rect.top + dragOffset.dy - HANDLE / 2,
            width: rect.width + HANDLE,
            height: rect.height + HANDLE,
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
        </div>
      ) : null}
      {editingText !== null && rect ? (
        <input
          autoFocus
          value={editingText}
          onChange={(e) => setEditingText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditingText(null);
          }}
          style={{
            position: "fixed",
            left: rect.left,
            top: rect.top,
            width: Math.max(rect.width, 80),
            height: rect.height,
            fontSize: Math.max(14, Math.min(rect.height * 0.6, 32)),
            fontFamily: "'Inter', system-ui, sans-serif",
            fontWeight: 700,
            border: "2px solid #ffe14d",
            borderRadius: 4,
            padding: "0 4px",
            background: "#0B0B0E",
            color: "#fff",
            outline: "none",
            zIndex: 10,
          }}
        />
      ) : null}
    </div>
  );
};
