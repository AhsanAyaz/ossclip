import type React from "react";
import type { StoryboardRowState } from "./storyboardModel";

/**
 * The storyboard modal's styles, shared by the plan table
 * (StoryboardPanel.tsx) and the shot view (StoryboardShotView.tsx; plan B2a
 * Task 5, §169). Moved here out of the panel unchanged, so the shot view
 * reuses the table's vocabulary instead of a second one, and neither file
 * imports the other's module for its constants (a cycle between the two
 * would leave one reading the other's constants before they exist).
 */

// The editor's warning yellow (CleanupPanel's `declinedNote`, the dirty dot).
export const WARN = "#FFE14D";

export const STATE_COLOR: Record<StoryboardRowState, string> = {
  planned: "#8B8B9E",
  drawn: "#5FBF77",
  dropped: "#8B8B9E",
  "cut away": WARN,
  // Colours the editor already uses (§169): the blue of a top-bar button
  // that is on, the red of an error line, and the modal's primary green for
  // the one state the author worked toward.
  drawing: "#5b8cff",
  failed: "#FF5C5C",
  "in the video": "#00E5A3",
};

export const PRIORITY_BADGE: Record<1 | 2 | 3, React.CSSProperties> = {
  1: { background: "#5b8cff", color: "#0b0b0f" },
  2: { background: "#2A2A33", color: "#C9C9D4" },
  3: { background: "transparent", color: "#8B8B9E", border: "1px solid #2A2A33" },
};

// Modal chrome matches CleanupPanel's (itself ThumbnailPanel's and
// RenderModal's): the editor's one dialog vocabulary. Wider, because a row
// carries a line, an idea and its actions side by side.
export const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 40,
  background: "rgba(5,5,8,0.75)",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

export const panel: React.CSSProperties = {
  width: 720,
  maxWidth: "92vw",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "#12121A",
  border: "1px solid #3A3A48",
  borderRadius: 10,
  padding: "24px 28px",
  boxShadow: "0 20px 40px rgba(0,0,0,0.6)",
  fontFamily:
    "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

export const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

export const title: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: "#EDEDF2",
  letterSpacing: "-0.01em",
};

export const closeBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#8B8B9E",
  fontSize: 16,
  cursor: "pointer",
  padding: "4px 8px",
  borderRadius: 4,
};

export const subtitle: React.CSSProperties = {
  fontSize: 13,
  color: "#8B8B9E",
  marginTop: 6,
  lineHeight: 1.4,
};

export const toolbar: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 14,
  marginBottom: 8,
};

// CleanupPanel's `restoreBtn`: the modal palette's secondary button.
export const toolBtn: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#C9C9D4",
  background: "#1A1A21",
  border: "1px solid #2A2A33",
  borderRadius: 6,
  padding: "5px 10px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const actionBtn: React.CSSProperties = { ...toolBtn, padding: "3px 8px", fontSize: 11 };

/** A disabled button reads as one: PublishPanel's `chipOverCapStyle` dimming. */
export const off = (style: React.CSSProperties, isDisabled: boolean): React.CSSProperties =>
  isDisabled ? { ...style, opacity: 0.45, cursor: "not-allowed" } : style;

// PublishPanel's `confirmBtn`, sized to sit beside a secondary button.
export const primaryBtn: React.CSSProperties = {
  background: "#00E5A3",
  border: "none",
  borderRadius: 6,
  color: "#051A13",
  padding: "5px 14px",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const formBox: React.CSSProperties = {
  border: "1px solid #2C2C38",
  borderRadius: 6,
  background: "#09090D",
  padding: "10px 14px",
  marginTop: 10,
};

export const formLabel: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#C9C9D4",
  marginBottom: 6,
};

export const formButtons: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 8,
};

export const rowBox: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  background: "#09090D",
  marginBottom: 8,
};

export const rowHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

export const rowLabel: React.CSSProperties = {
  fontSize: 13,
  color: "#EDEDF2",
  lineHeight: 1.4,
};

export const monoFont = "ui-monospace, 'SF Mono', Consolas, monospace";

export const timeText: React.CSSProperties = {
  fontSize: 12,
  color: "#C9C9D4",
  fontFamily: monoFont,
  whiteSpace: "nowrap",
};

export const timeBtn: React.CSSProperties = {
  ...timeText,
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  textDecoration: "underline dotted",
};

export const badge: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  borderRadius: 999,
  minWidth: 16,
  height: 16,
  lineHeight: "16px",
  textAlign: "center",
  boxSizing: "border-box",
  flexShrink: 0,
};

export const stateText: React.CSSProperties = {
  fontSize: 11,
  color: "#8B8B9E",
  whiteSpace: "nowrap",
};

export const lineText: React.CSSProperties = {
  fontSize: 12,
  color: "#8B8B9E",
  marginTop: 6,
  lineHeight: 1.4,
  fontStyle: "italic",
};

export const ideaBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  padding: 0,
  marginTop: 6,
  fontSize: 13,
  color: "#EDEDF2",
  lineHeight: 1.4,
  cursor: "text",
  fontFamily: "inherit",
  whiteSpace: "pre-wrap",
};

// PublishPanel's `captionArea`: the modal palette's multi-line field.
export const ideaArea: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: 6,
  background: "#121218",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  padding: "8px 12px",
  color: "#EDEDF2",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  resize: "vertical",
};

export const whyText: React.CSSProperties = {
  fontSize: 11,
  color: "#8B8B9E",
  marginTop: 4,
  lineHeight: 1.4,
};

export const footNote: React.CSSProperties = {
  fontSize: 12,
  color: "#8B8B9E",
  lineHeight: 1.4,
};

// PublishPanel's `errorText`: server messages verbatim, line breaks kept.
export const errorText: React.CSSProperties = {
  marginTop: 8,
  color: "#FF5C5C",
  fontSize: 13,
  fontFamily: monoFont,
  whiteSpace: "pre-wrap",
};
