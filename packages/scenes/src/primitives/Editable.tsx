import React from "react";
import { editStyle, type ElementEdits } from "../editable";

/**
 * An element the editor can select: the id and the edit nudge on this box,
 * the motion on what it wraps, so the two transforms never overwrite each
 * other. Takes `editId` as a prop on purpose: the edit-id audit
 * (edit-ids-resolve.test.ts) reads a dynamic id from the call site's
 * ``editId={`mock-${i}`}``, so a call site must keep that inline form.
 * Shared by BugCard and PhoneDemo (§161).
 */
export const Editable: React.FC<{
  editId: string;
  edits?: ElementEdits;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ editId, edits, style, children }) => (
  <div data-edit-id={editId} style={{ ...style, ...editStyle(edits, editId) }}>
    {children}
  </div>
);
