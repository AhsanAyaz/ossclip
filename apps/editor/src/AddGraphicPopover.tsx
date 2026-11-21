import React, { useEffect, useLayoutEffect, useState } from "react";
import {
  ADDED_OFFERED,
  SCENE_REGISTRY,
  addFormFields,
  addFormProps,
  type AddFormField,
  type AddedOffered,
} from "@ossclip/core/browser";
import { MenuItem, floatingMenu, menuLabel, toolbarButton } from "./selectionMenuChrome";

/**
 * Step 1's list (editor-added-graphics §5): a plain name and one line on what
 * each type shows. Written for the author, not the planner — `whenToUse` in
 * the registry is LLM-facing and says how to fill the props. Keyed by
 * `AddedOffered`, so a type joining the menu without copy fails the
 * typecheck. Each line stays under 60 characters so the list never wraps in
 * the popover's width.
 */
export const ADD_TYPE_COPY: Record<AddedOffered, { name: string; line: string }> = {
  TitleCard: { name: "Title card", line: "One big line of text" },
  StatCard: { name: "Stat", line: "A number with a short label" },
  RuleCard: { name: "Rule", line: "A short heading over the rule it introduces" },
  StrikethroughReveal: { name: "Struck lines", line: "Up to four short lines that can be crossed out" },
  BulletList: { name: "Bullet list", line: "Two to five short points" },
  FlowDiagram: { name: "Flow", line: "Two to five steps joined in a chain" },
  ChatMock: { name: "Chat", line: "Chat bubbles from a user and an agent" },
  CardRow: { name: "Card row", line: "Two to four named cards side by side" },
  CtaCard: { name: "Call to action", line: "Asks viewers to comment, subscribe or open a link" },
  BugCard: { name: "Numbered problem", line: "A numbered problem with a short headline" },
  PhoneDemo: { name: "Phone captions", line: "Caption words shown on a phone screen" },
};

/** One form per type, built on first use. `addFormFields` walks the props
 * schema through `z.toJSONSchema` on every call, and the form re-reads its
 * fields on every keystroke. */
const FIELDS = new Map<AddedOffered, AddFormField[]>();
export function addFormFieldsFor(component: AddedOffered): AddFormField[] {
  let fields = FIELDS.get(component);
  if (fields === undefined) {
    fields = addFormFields(component);
    FIELDS.set(component, fields);
  }
  return fields;
}

/**
 * The form's starting values (§5 "Prefill"): the FIRST text field holds the
 * selected words when they fit its cap — G2, the author types the main text
 * in the same step and never sees a placeholder. Too long and it starts
 * empty rather than cut: a title clipped mid-word is a worse start than a
 * blank one. Lists start with no rows; a choice or a number starts unset, so
 * the author picks it rather than inheriting a guess.
 */
export function initialAddValues(component: AddedOffered, selectedText: string): Record<string, unknown> {
  let prefilled = false;
  const values: Record<string, unknown> = {};
  for (const f of addFormFieldsFor(component)) {
    switch (f.kind) {
      case "text":
        values[f.key] = !prefilled && selectedText.length <= f.max ? selectedText : "";
        prefilled = true;
        break;
      case "list":
      case "messages":
        values[f.key] = [];
        break;
      case "choice":
      case "number":
        values[f.key] = undefined;
        break;
    }
  }
  return values;
}

/**
 * Why Add is off, or null when it may be pressed. The RAW registry schema,
 * not `resolveSceneProps`: that merges the registry's `defaultProps` first,
 * so an empty TitleCard would pass as "TITLE" — and the conversion that
 * renders the entry parses it raw and would skip it (§2 step 2). The Add
 * gate and the conversion must say the same thing.
 */
export function addFormIssue(component: AddedOffered, values: Record<string, unknown>): string | null {
  const parsed = SCENE_REGISTRY[component].propsSchema.safeParse(addFormProps(component, values));
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (issue === undefined) return "invalid";
  return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

/**
 * The add-graphic popover (editor-added-graphics §5), in the selection bar's
 * place and on its anchor, the range editor's arrangement. Three faces: the
 * overlap refusal (when App's check refused, and then no type list at all),
 * the type list, and the short form for the picked type.
 *
 * `menuRef` is the panel's shared anchored-surface ref — the panel's layout
 * effect measures whatever surface holds it, so the popover gets the bar's
 * flip-above-near-the-bottom placement. `onLayout` tells the panel this
 * surface changed height (a step, a list row) so it re-measures; it fires
 * only on those changes, never per keystroke.
 *
 * Escape closes it and keeps the selection, the timing popover's contract:
 * the key stops here, so neither the panel's clear-selection branch nor
 * Overlay's window-level deselect sees it.
 */
export const AddGraphicPopover: React.FC<{
  menuRef: React.MutableRefObject<HTMLDivElement | null>;
  top: number;
  left: number;
  /** The selected words, as the panel shows them. */
  text: string;
  refusal: string | null;
  notes: readonly string[];
  onAdd: (component: AddedOffered, props: Record<string, unknown>) => void;
  onClose: () => void;
  onLayout: () => void;
}> = ({ menuRef, top, left, text, refusal, notes, onAdd, onClose, onLayout }) => {
  const [component, setComponent] = useState<AddedOffered | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const fields = component === null ? [] : addFormFieldsFor(component);
  const rows = fields.map((f) => (Array.isArray(values[f.key]) ? (values[f.key] as unknown[]).length : 0)).join(",");
  useLayoutEffect(() => {
    onLayout();
    // Height changes only: the step, the refusal, a list's row count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component, refusal, rows]);
  // Focus lands inside at open: the Graphic… button that had it unmounts with
  // the bar, and a focus left on <body> would send Escape nowhere near here.
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (c: AddedOffered): void => {
    setComponent(c);
    setValues(initialAddValues(c, text));
  };
  const issue = component === null ? null : addFormIssue(component, values);
  const noteRows = notes.map((n) => (
    <div key={n} data-testid="add-graphic-note" style={noteText}>
      {n}
    </div>
  ));

  return (
    <div
      data-testid="transcript-add-graphic-popover"
      ref={menuRef}
      role="dialog"
      aria-label="Add a graphic"
      tabIndex={-1}
      // Chrome, pinned LTR like the bar; the quoted words and the fields carry
      // their own `dir="auto"`, so an Urdu selection still reads right to left.
      dir="ltr"
      style={{
        ...floatingMenu,
        top,
        left,
        flexDirection: "column",
        alignItems: "stretch",
        gap: 6,
        // Room for the longest type line (49 characters) on one row.
        width: 320,
        padding: "8px 8px",
        outline: "none",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div data-testid="add-graphic-words" dir="auto" style={wordsQuote}>
        “{text}”
      </div>
      {refusal !== null ? (
        <>
          <div data-testid="add-graphic-refusal" style={refusalText}>
            {refusal}
          </div>
          <div style={buttonRow}>
            <button data-testid="add-graphic-cancel" style={toolbarButton} onClick={onClose} title="Close (Esc)">
              Close
            </button>
          </div>
        </>
      ) : component === null ? (
        <>
          {noteRows}
          <div style={typeList}>
            {ADDED_OFFERED.map((c) => (
              <MenuItem key={c} data-testid={`add-graphic-type-${c}`} onClick={() => pick(c)} style={typeRow}>
                <span style={typeName}>{ADD_TYPE_COPY[c].name}</span>
                <span style={typeLine}>{ADD_TYPE_COPY[c].line}</span>
              </MenuItem>
            ))}
          </div>
          <div style={buttonRow}>
            <button data-testid="add-graphic-cancel" style={toolbarButton} onClick={onClose} title="Close (Esc)">
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <span style={typeName}>{ADD_TYPE_COPY[component].name}</span>
          {fields.map((f, i) => (
            <AddField
              key={f.key}
              field={f}
              value={values[f.key]}
              autoFocus={i === 0}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
            />
          ))}
          {noteRows}
          <div style={buttonRow}>
            <button
              data-testid="add-graphic-add"
              style={{ ...toolbarButton, ...(issue !== null ? disabledButton : {}) }}
              disabled={issue !== null}
              // The schema's own first complaint, so a disabled Add says what
              // is missing instead of just refusing.
              title={issue ?? "Add this graphic over the selected words"}
              onClick={() => {
                if (issue === null) onAdd(component, addFormProps(component, values));
              }}
            >
              Add
            </button>
            <button data-testid="add-graphic-back" style={toolbarButton} onClick={() => setComponent(null)}>
              Back
            </button>
            <button data-testid="add-graphic-cancel" style={toolbarButton} onClick={onClose} title="Close (Esc)">
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
};

/** One field of the form. Values stay in the shapes `addFormProps` takes —
 * strings, string lists, `{from, text}` messages, a number — and nothing is
 * trimmed or clamped here: the Add gate judges what the author typed. */
const AddField: React.FC<{
  field: AddFormField;
  value: unknown;
  autoFocus: boolean;
  onChange: (value: unknown) => void;
}> = ({ field: f, value, autoFocus, onChange }) => {
  const id = `add-graphic-field-${f.key}`;
  switch (f.kind) {
    case "text": {
      const text = typeof value === "string" ? value : "";
      return (
        <label style={fieldLabel}>
          <span style={labelRow}>
            {f.label}
            <span style={text.length > f.max ? overCount : count}>
              {text.length}/{f.max}
            </span>
          </span>
          <input
            data-testid={id}
            autoFocus={autoFocus}
            dir="auto"
            style={fieldInput}
            value={text}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
    }
    case "choice":
      return (
        <label style={fieldLabel}>
          {f.label}
          <select
            data-testid={id}
            autoFocus={autoFocus}
            style={fieldInput}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          >
            <option value="">Choose…</option>
            {f.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      );
    case "number":
      return (
        <label style={fieldLabel}>
          <span style={labelRow}>
            {f.label}
            <span style={count}>
              {f.min} to {f.max}
            </span>
          </span>
          <input
            data-testid={id}
            autoFocus={autoFocus}
            type="number"
            min={f.min}
            max={f.max}
            step={1}
            style={fieldInput}
            value={typeof value === "number" && Number.isFinite(value) ? String(value) : ""}
            // Empty is unset, not 0; anything else goes to the schema as typed.
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          />
        </label>
      );
    case "list": {
      const items = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div style={fieldLabel}>
          <span style={labelRow}>
            {f.label}
            <span style={count}>
              {f.min} to {f.max}
            </span>
          </span>
          {items.map((item, i) => (
            <span key={i} style={listRow}>
              <input
                data-testid={`${id}-${i}`}
                dir="auto"
                style={{ ...fieldInput, flex: 1 }}
                value={item}
                onChange={(e) => onChange(items.map((v, j) => (j === i ? e.target.value : v)))}
              />
              <button
                data-testid={`add-graphic-remove-${f.key}-${i}`}
                aria-label="Remove"
                style={toolbarButton}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </span>
          ))}
          <button
            data-testid={`add-graphic-add-item-${f.key}`}
            autoFocus={autoFocus}
            style={{ ...toolbarButton, alignSelf: "flex-start", ...(items.length >= f.max ? disabledButton : {}) }}
            disabled={items.length >= f.max}
            onClick={() => onChange([...items, ""])}
          >
            Add item
          </button>
        </div>
      );
    }
    case "messages": {
      const messages = Array.isArray(value) ? (value as { from: string; text: string }[]) : [];
      const patch = (i: number, next: Partial<{ from: string; text: string }>): void =>
        onChange(messages.map((m, j) => (j === i ? { ...m, ...next } : m)));
      return (
        <div style={fieldLabel}>
          <span style={labelRow}>
            Messages
            <span style={count}>
              {f.min} to {f.max}
            </span>
          </span>
          {messages.map((m, i) => (
            <span key={i} style={listRow}>
              <select
                data-testid={`${id}-${i}-from`}
                style={fieldInput}
                value={m.from}
                onChange={(e) => patch(i, { from: e.target.value })}
              >
                {f.from.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <input
                data-testid={`${id}-${i}`}
                dir="auto"
                style={{ ...fieldInput, flex: 1 }}
                value={m.text}
                onChange={(e) => patch(i, { text: e.target.value })}
              />
              <button
                data-testid={`add-graphic-remove-${f.key}-${i}`}
                aria-label="Remove"
                style={toolbarButton}
                onClick={() => onChange(messages.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </span>
          ))}
          <button
            data-testid={`add-graphic-add-item-${f.key}`}
            autoFocus={autoFocus}
            style={{ ...toolbarButton, alignSelf: "flex-start", ...(messages.length >= f.max ? disabledButton : {}) }}
            disabled={messages.length >= f.max}
            // A new bubble answers the last one — the senders alternate, and
            // the author changes it in the row's own menu when they do not.
            onClick={() => onChange([...messages, { from: f.from[messages.length % f.from.length]!, text: "" }])}
          >
            Add message
          </button>
        </div>
      );
    }
  }
};

/** The selection, quoted — what the graphic will sit over. One line, cut
 * with an ellipsis: a paragraph-long selection must not push the list away. */
const wordsQuote: React.CSSProperties = {
  ...menuLabel,
  paddingInline: 2,
  color: "#C9C9D1",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const refusalText: React.CSSProperties = {
  fontSize: 12,
  color: "#EDEDF2",
  lineHeight: 1.4,
  padding: "2px 2px",
};

const noteText: React.CSSProperties = {
  fontSize: 11,
  color: "#9A9AA3",
  lineHeight: 1.4,
  padding: "0 2px",
};

const typeList: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  maxHeight: 280,
  overflowY: "auto",
};

/** A type row: the bar's chip, stacked as name over line. */
const typeRow: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 1,
  width: "100%",
  padding: "5px 8px",
};

const typeName: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#EDEDF2" };

const typeLine: React.CSSProperties = { fontSize: 11, fontWeight: 400, color: "#9A9AA3" };

const fieldLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  fontSize: 11,
  color: "#9A9AA3",
};

const labelRow: React.CSSProperties = { display: "flex", justifyContent: "space-between" };

const count: React.CSSProperties = { color: "#6E6E78" };

/** Over the cap: the count says so before the disabled Add does. */
const overCount: React.CSSProperties = { color: "#FF8A7A" };

/** The range editor's box, in the neutral border — a form of several fields
 * all in the editing yellow read as one shouting block. */
const fieldInput: React.CSSProperties = {
  fontFamily: "'Inter', 'Noto Nastaliq Urdu', 'Geeza Pro', 'Noto Naskh Arabic', system-ui, sans-serif",
  fontSize: 13,
  background: "#0F0F14",
  border: "1px solid #45454F",
  borderRadius: 4,
  color: "#fff",
  padding: "4px 6px",
};

const listRow: React.CSSProperties = { display: "flex", gap: 4, alignItems: "center" };

const buttonRow: React.CSSProperties = { display: "flex", gap: 6 };

const disabledButton: React.CSSProperties = { opacity: 0.5, cursor: "default" };
