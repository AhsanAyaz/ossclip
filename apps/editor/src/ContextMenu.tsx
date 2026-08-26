import React, { useEffect } from "react";

/**
 * A minimal right-click menu (cut-review rework, 2026-08-26) — the editor's
 * first, so it stays deliberately small: fixed-position, dark-palette rows,
 * no library. Owned by whoever opens it (the Timeline's marker chips today):
 * the OWNER holds the open/closed state and the items; this component only
 * paints and closes. Closes on Escape, any mousedown outside, scroll, or a
 * second contextmenu elsewhere — every gesture that means "not this menu".
 */

export interface ContextMenuItem {
  label: string;
  onPick: () => void;
}

export interface ContextMenuProps {
  /** Viewport coordinates of the opening right-click. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture + stopPropagation: Escape here closes the MENU, and must
        // not also clear the app's selection underneath (the panel rule).
        e.stopPropagation();
        onClose();
      }
    };
    const close = () => onClose();
    window.addEventListener("keydown", onKeyDown, true);
    // Mousedown, not click: the menu's own rows stopPropagation below, so
    // any press that reaches window is outside the menu by construction.
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("contextmenu", close);
    };
  }, [onClose]);

  // Clamp into the viewport so a chip near the right edge doesn't open a
  // half-off-screen menu; 180px matches the menu's min-width below.
  const left = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1280) - 200);

  return (
    <div
      data-testid="context-menu"
      role="menu"
      style={{ ...menu, left, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          data-testid={`context-menu-item-${item.label}`}
          style={row}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            item.onPick();
            onClose();
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "#22222c";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
};

const menu: React.CSSProperties = {
  position: "fixed",
  zIndex: 80,
  minWidth: 180,
  background: "#16161d",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  padding: 4,
  boxShadow: "0 10px 32px rgba(0,0,0,0.55)",
};

const row: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  borderRadius: 4,
  padding: "7px 10px",
  color: "#EDEDF2",
  fontSize: 12,
  fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace",
  cursor: "pointer",
  whiteSpace: "nowrap",
};
