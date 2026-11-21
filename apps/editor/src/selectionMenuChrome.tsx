import React, { useState } from "react";

/**
 * The selection bar's chrome (TranscriptPanel), shared with the add-graphic
 * popover (editor-added-graphics §5) that opens in the bar's place: one
 * surface, one row style, so the family moves together when one of them
 * changes. Moved out of TranscriptPanel.tsx rather than exported from it —
 * the panel renders the popover, and a popover importing its own parent
 * would be an import cycle.
 */

/**
 * The shared surface of every anchored thing: the bar, the delete flyout,
 * the range editor and the timing popover all spread this and override only
 * layout, so one edit moves the whole family together.
 *
 * ABSOLUTE, not fixed (2026-08-18 round 3): the anchor is a positioned parent
 * (the body is `position: relative`), so the bar scrolls with the content.
 * zIndex above the word spans, below the modal backdrops (40) — same ordering
 * argument as App's menu.
 *
 * Lifted off the panel in round 5: at #1A1A21 on the panel's #111116 the bar
 * read as a patch of background with buttons on it, and it sits beside a
 * SATURATED yellow selection band that out-shouts everything. A lighter
 * surface (#262630) with a visible edge (#3A3A47) and a real drop shadow puts
 * it convincingly ABOVE the page without adding a second bright element —
 * the depth does the work the colour must not.
 */
export const floatingMenu: React.CSSProperties = {
  position: "absolute",
  zIndex: 31,
  background: "#262630",
  border: "1px solid #3A3A47",
  borderRadius: 10,
  padding: "4px 6px",
  // Two shadows: a long soft one for the lift off the page, a tight one to
  // seat the edge — a single large blur alone reads as a smudge on a dark UI.
  boxShadow: "0 14px 34px rgba(0,0,0,0.66), 0 2px 6px rgba(0,0,0,0.4)",
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 2,
};

export const menuLabel: React.CSSProperties = {
  fontSize: 11,
  color: "#9A9AA3",
  // LOGICAL, not the physical `0 8px 0 6px` it was: the count sits at the
  // END of the row, and under an rtl base the physical padding put its
  // breathing room on the wrong side of the label.
  paddingInline: "6px 8px",
  whiteSpace: "nowrap",
};

/** App.tsx's menuItem, compacted into a bar chip — nowrap so the row never
 * folds mid-label. Roomier than round 3's `6px 8px`: on the lifted surface
 * the labels sat tight against each other with nothing to separate them, and
 * padding is the separator that costs no ink. */
const menuItem: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#EDEDF2",
  background: "transparent",
  border: "none",
  borderRadius: 6,
  padding: "6px 10px",
  cursor: "pointer",
  textAlign: "left",
  whiteSpace: "nowrap",
};

/** A menu row: full-width ghost button with a hover highlight. Hover via
 * local state rather than a stylesheet class (§138 put the picker rows'
 * states in index.css because inline styles cannot express `:hover`) — these
 * rows are the panel's only hover consumers, and the state keeps the menu
 * self-contained. */
export const MenuItem: React.FC<
  {
    children: React.ReactNode;
  } & Pick<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "onClick" | "disabled" | "title" | "aria-label"
  > & {
      "data-testid": string;
      /** Layered over `menuItem`, under the hover/disabled states. */
      style?: React.CSSProperties;
    }
> = ({ children, style, ...rest }) => {
  const [hover, setHover] = useState(false);
  return (
    <button
      role="menuitem"
      {...rest}
      style={{
        ...menuItem,
        ...style,
        // One step LIGHTER than the surface it sits on (#262630) — the old
        // #23232E was a step DARKER, so hover read as a hole in the bar.
        ...(hover && !rest.disabled ? { background: "#34343F" } : {}),
        ...(rest.disabled ? { opacity: 0.5, cursor: "default" } : {}),
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
    </button>
  );
};

/** The popovers' Apply/Cancel/Play row. Its fill and border are a step
 * LIGHTER than the surface (`floatingMenu`) — at the old #1A1A21/#2A2A33 the
 * buttons matched the popover they sat on and read as flat labels, which on
 * the Apply of a destructive-ish edit is the wrong thing to be invisible. */
export const toolbarButton: React.CSSProperties = {
  fontSize: 11,
  color: "#EDEDF2",
  background: "#34343F",
  border: "1px solid #45454F",
  borderRadius: 6,
  cursor: "pointer",
  padding: "4px 8px",
};
