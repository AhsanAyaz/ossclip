import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Storyboard, TimeMap } from "@ossclip/core/browser";
import {
  coverage,
  coverageOverLimit,
  formatRange,
  isKeptRow,
  planChangesSummary,
  rowWarning,
  selectionSpan,
  spanPreview,
  storyboardRows,
  type DrawnMap,
  type StoryboardRow,
} from "./storyboardModel";

/**
 * The storyboard's plan table (storyboard design §10 "Table view"; plan Task
 * 5; §168): one row per shot of `storyboard.json`, where the author drops,
 * rewords, moves and adds shots and can plan again. Drawing is not part of
 * this phase, so a drawn shot only shows its draft number.
 *
 * Server-owned state, the PublishPanel posture: the table lives in the
 * workdir's `storyboard.json`, not in the overrides doc, so there is no
 * undo, dirty or Save here; every action is one request to
 * `/api/storyboard/edit` or `/api/storyboard/plan` and the table shown is
 * the one the server answered with. Requests run one at a time: the server
 * refuses edits while a plan runs (409), and a second request racing the
 * first could save over it. The server's messages are shown verbatim; they
 * are written for the author to act on.
 *
 * What each row says is computed in storyboardModel.ts, on the clock App
 * hands in (`map`, the live one the player plays), so a cut the author makes
 * in the editor shows here before any render.
 */

interface StoryboardLoad {
  storyboard: Storyboard;
  drawn: DrawnMap;
}

interface LimitChangeView {
  index: number;
  kind: string;
  reason: string;
}

type StoryboardEditBody =
  | { op: "drop"; id: string }
  | { op: "restore"; id: string }
  | { op: "idea"; id: string; idea: string }
  | { op: "span"; id: string; startWord: number; endWord: number }
  | { op: "add"; startWord: number; endWord: number; idea: string };

export interface StoryboardPanelProps {
  /** `/api/transcript`'s words: the index space a shot's `startWord`/`endWord` live in. Null when none loaded. */
  words: readonly { text: string; start: number; end: number }[] | null;
  /** The live clock (App's ruler map), source → output seconds. Null when the spans are unusable. */
  map: TimeMap | null;
  /** The last transcript selection App holds, as source starts; null when none was made. */
  selection: readonly { srcStart: number }[] | null;
  /** Moves the player to an output second on the live clock. Absent = the time is not clickable. */
  onSeek?: (sec: number) => void;
  onClose: () => void;
}

export const StoryboardPanel: React.FC<StoryboardPanelProps> = ({ words, map, selection, onSeek, onClose }) => {
  const [load, setLoad] = useState<StoryboardLoad | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "edit" | "plan">(null);
  // The ref is the gate, the state is the display: two clicks inside one
  // frame both see the state's old value, and the second would be a second
  // request (the `planBusy` double-click rule, server side).
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The idea being edited in place. Mirrored in a ref because the save is
   * reached from two events, Enter and blur, and blur also fires when Enter's
   * own save closes the field: the ref says whether a save is already on its
   * way, and whether the edit was cancelled, without waiting for a render.
   */
  const [editing, setEditingState] = useState<{ id: string; draft: string; error: string | null } | null>(null);
  const editRef = useRef<{ id: string; draft: string; saving: boolean } | null>(null);
  const [adding, setAdding] = useState<{ draft: string; error: string | null } | null>(null);
  const [confirmPlan, setConfirmPlan] = useState(false);
  const [planResult, setPlanResult] = useState<{ usage: string | null; changes: LimitChangeView[] } | null>(null);

  const setEditing = (next: { id: string; draft: string; error: string | null } | null): void => {
    // A fresh ref object per change: `commitIdea` holds the one it started
    // with and compares by identity to learn the field moved on mid-request.
    editRef.current = next === null ? null : { id: next.id, draft: next.draft, saving: false };
    setEditingState(next);
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/storyboard");
        const body = (await res.json()) as {
          storyboard?: Storyboard | null;
          drawn?: DrawnMap;
          error?: string;
        };
        if (!live) return;
        if (!res.ok) {
          setLoadError(body.error ?? `GET /api/storyboard failed: ${res.status}`);
          return;
        }
        if (!body.storyboard) {
          setLoadError("This project has no storyboard.json. Plan one with `ossclip produce <video> --storyboard`.");
          return;
        }
        setLoad({ storyboard: body.storyboard, drawn: body.drawn ?? {} });
      } catch (err) {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Escape backs out of the innermost thing open: a field being edited, the
  // add form, the plan confirm, and only then the panel. Capture phase, the
  // other panels' rule, so the app's shortcuts under the modal never see it;
  // that also means the field's own handler never does, so the cancel is here.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (editRef.current !== null) setEditing(null);
      else if (adding !== null) setAdding(null);
      else if (confirmPlan) setConfirmPlan(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, adding, confirmPlan]);

  const outputTimeOf = useCallback(
    (i: number) => {
      const w = words?.[i];
      return w !== undefined && map !== null ? map.mapWord(w) : null;
    },
    [words, map],
  );
  const rows = useMemo<StoryboardRow[]>(
    () => (load === null || words === null ? [] : storyboardRows(load.storyboard, words, outputTimeOf, load.drawn)),
    [load, words, outputTimeOf],
  );
  const keptRows = rows.filter(isKeptRow);
  const share = coverage(rows, map?.outputDuration ?? 0);
  const span = useMemo(
    () => (words === null || selection === null ? null : selectionSpan(words, selection)),
    [words, selection],
  );
  /** Why the selection actions are disabled, or null when they are not. */
  const selectionBlocked =
    selection === null || selection.length === 0
      ? "Select words in the transcript first (open it with the Transcript button)"
      : span === null
        ? "The selected words do not line up with the transcript's words (a rewritten caption run?): select them again"
        : null;

  /** One edit, one request. Returns the server's error, or null when it was saved. */
  const sendEdit = async (edit: StoryboardEditBody): Promise<string | null> => {
    if (busyRef.current) return "another storyboard request is still running";
    busyRef.current = true;
    setBusy("edit");
    try {
      const res = await fetch("/api/storyboard/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(edit),
      });
      const body = (await res.json()) as { ok?: boolean; storyboard?: Storyboard; error?: string };
      if (!res.ok || body.ok !== true || !body.storyboard) return body.error ?? `edit failed: ${res.status}`;
      const next = body.storyboard;
      setLoad((prev) => (prev === null ? prev : { ...prev, storyboard: next }));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  /** Drop, restore and span: their errors go to the panel's one error line. */
  const rowAction = async (edit: StoryboardEditBody): Promise<void> => {
    setError(null);
    const err = await sendEdit(edit);
    if (err !== null) setError(err);
  };

  const startIdeaEdit = (row: StoryboardRow): void => {
    if (busyRef.current) return;
    setError(null);
    setEditing({ id: row.id, draft: row.idea, error: null });
  };

  const commitIdea = async (): Promise<void> => {
    const cur = editRef.current;
    if (cur === null || cur.saving) return;
    const shot = load?.storyboard.shots.find((s) => s.id === cur.id);
    // Unchanged text sends nothing: an edit marks the shot touched, and a
    // touched shot survives "Plan again" (design §2), so a click in and out
    // of the field must not make the shot the author's.
    if (shot === undefined || cur.draft.trim() === shot.idea) {
      setEditing(null);
      return;
    }
    cur.saving = true;
    const err = await sendEdit({ op: "idea", id: cur.id, idea: cur.draft });
    // Cancelled, or another field opened, while the request ran.
    if (editRef.current !== cur) return;
    cur.saving = false;
    if (err === null) setEditing(null);
    // A refused idea (empty, too long) keeps the field open with the text
    // the author typed, so the fix is an edit, not a retype.
    else setEditing({ id: cur.id, draft: cur.draft, error: err });
  };

  const commitAdd = async (): Promise<void> => {
    if (adding === null || span === null) return;
    const draft = adding.draft;
    const err = await sendEdit({ op: "add", startWord: span.startWord, endWord: span.endWord, idea: draft });
    if (err === null) setAdding(null);
    else setAdding({ draft, error: err });
  };

  const runPlanAgain = async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("plan");
    setConfirmPlan(false);
    setError(null);
    setPlanResult(null);
    try {
      const res = await fetch("/api/storyboard/plan", { method: "POST" });
      const body = (await res.json()) as {
        ok?: boolean;
        storyboard?: Storyboard;
        changes?: LimitChangeView[];
        usage?: string;
        error?: string;
      };
      if (!res.ok || body.ok !== true || !body.storyboard) {
        setError(body.error ?? `Plan again failed: ${res.status}`);
        return;
      }
      const next = body.storyboard;
      // `drawn` is kept: the plan keeps every drawn shot with its id, and a
      // new shot has an id no folder of drawings has ever had.
      setLoad((prev) => (prev === null ? prev : { ...prev, storyboard: next }));
      setPlanResult({ usage: body.usage ?? null, changes: body.changes ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const disabled = busy !== null;
  const ideaKeyDown =
    (submit: () => void) =>
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      // Enter saves and Shift+Enter is a newline, the chat-box convention
      // the transcript's range editor uses. Escape is the window handler's.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    };

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div
        data-testid="storyboard-modal"
        role="dialog"
        aria-label="Storyboard"
        style={panel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={header}>
          <div style={title}>Storyboard</div>
          <button style={closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {loadError !== null ? (
          <div data-testid="storyboard-error" style={errorText}>
            {loadError}
          </div>
        ) : load === null ? (
          <div style={subtitle}>Loading…</div>
        ) : words === null || map === null ? (
          // The rows are word indices into the transcript, timed on the
          // clock: without both there is no line, no time and no state to
          // show, and every row would wrongly read "cut away".
          <div data-testid="storyboard-no-transcript" style={{ ...subtitle, marginTop: 12 }}>
            The editor could not load this project&apos;s transcript and timing, so the table cannot show
            its shots. Re-run `ossclip produce` to rebuild them.
          </div>
        ) : (
          <>
            <div
              data-testid="storyboard-summary"
              style={{ ...subtitle, ...(coverageOverLimit(share) ? { color: WARN } : {}) }}
              title={
                coverageOverLimit(share)
                  ? "Over 60%: the speaker is hidden for most of the video. Drop some shots."
                  : "The share of the video the kept shots cover; the planner keeps it at 60% or less."
              }
            >
              {keptRows.length} shot{keptRows.length === 1 ? "" : "s"} · covers {Math.round(share * 100)}% of the
              video
            </div>

            <div style={toolbar}>
              <button
                type="button"
                data-testid="storyboard-add"
                style={off(toolBtn, disabled || selectionBlocked !== null || adding !== null)}
                disabled={disabled || selectionBlocked !== null || adding !== null}
                title={selectionBlocked ?? "Add a shot on the words selected in the transcript"}
                onClick={() => {
                  setError(null);
                  setAdding({ draft: "", error: null });
                }}
              >
                Add shot from selection
              </button>
              <button
                type="button"
                data-testid="storyboard-plan-again"
                style={off(toolBtn, disabled || confirmPlan)}
                disabled={disabled || confirmPlan}
                title="Plan the shots again from the transcript. Shots you reworded, added or drew are kept."
                onClick={() => {
                  setError(null);
                  setPlanResult(null);
                  setConfirmPlan(true);
                }}
              >
                {busy === "plan" ? "Planning again… (one LLM call)" : "Plan again (one LLM call)"}
              </button>
            </div>

            <div data-testid="storyboard-selection" style={footNote}>
              {span !== null
                ? `Selected in the transcript: “${spanPreview(words, span)}” (words ${span.startWord}–${span.endWord})`
                : selectionBlocked}
            </div>

            {adding !== null && span !== null ? (
              <div style={formBox}>
                <div style={formLabel}>Idea for the new shot</div>
                <textarea
                  data-testid="storyboard-add-idea"
                  aria-label="Idea for the new shot"
                  style={ideaArea}
                  rows={2}
                  autoFocus
                  value={adding.draft}
                  placeholder="What is on screen, and how it moves"
                  onChange={(e) => setAdding({ draft: e.target.value, error: null })}
                  onKeyDown={ideaKeyDown(() => void commitAdd())}
                />
                {adding.error !== null ? (
                  <div data-testid="storyboard-add-error" style={errorText}>
                    {adding.error}
                  </div>
                ) : null}
                <div style={formButtons}>
                  <button
                    type="button"
                    data-testid="storyboard-add-confirm"
                    style={off(primaryBtn, disabled || adding.draft.trim().length === 0)}
                    disabled={disabled || adding.draft.trim().length === 0}
                    title={adding.draft.trim().length === 0 ? "Type the idea first" : undefined}
                    onClick={() => void commitAdd()}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    data-testid="storyboard-add-cancel"
                    style={off(toolBtn, disabled)}
                    disabled={disabled}
                    onClick={() => setAdding(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {confirmPlan ? (
              // In the panel rather than `window.confirm`: the dialog would
              // block the page and could not say which shots are kept.
              <div data-testid="storyboard-plan-confirm-box" style={formBox}>
                <div style={rowLabel}>
                  This replaces every shot you have not touched. Reworded, added and drawn shots are kept.
                </div>
                <div style={formButtons}>
                  <button
                    type="button"
                    data-testid="storyboard-plan-confirm"
                    style={off(primaryBtn, disabled)}
                    disabled={disabled}
                    onClick={() => void runPlanAgain()}
                  >
                    Plan again
                  </button>
                  <button
                    type="button"
                    data-testid="storyboard-plan-cancel"
                    style={toolBtn}
                    onClick={() => setConfirmPlan(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {planResult !== null ? (
              <div data-testid="storyboard-plan-result" style={{ ...footNote, marginTop: 10 }}>
                {planResult.usage !== null ? <div>{planResult.usage}</div> : null}
                <div>{planChangesSummary(planResult.changes)}</div>
                {planResult.changes.length > 0 ? (
                  <details>
                    <summary style={{ cursor: "pointer" }}>What the limits changed</summary>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                      {planResult.changes.map((c, i) => (
                        <li key={i}>
                          {c.kind}: {c.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : null}

            {error !== null ? (
              <div data-testid="storyboard-error" style={errorText}>
                {error}
              </div>
            ) : null}

            <div style={{ marginTop: 16 }}>
              {rows.length === 0 ? (
                <div data-testid="storyboard-empty" style={subtitle}>
                  The storyboard has no shots. Add one from a transcript selection, or plan again.
                </div>
              ) : null}
              {rows.map((row) => {
                const warning = rowWarning(row);
                const isEditing = editing !== null && editing.id === row.id;
                const editable = isKeptRow(row);
                return (
                  <div
                    key={row.id}
                    data-testid={`storyboard-row-${row.id}`}
                    style={{ ...rowBox, ...(row.state === "dropped" ? { opacity: 0.5 } : {}) }}
                  >
                    <div style={rowHead}>
                      {row.startSec !== null && row.endSec !== null ? (
                        onSeek !== undefined ? (
                          <button
                            type="button"
                            data-testid={`storyboard-time-${row.id}`}
                            style={timeBtn}
                            title="Move the player to the start of this shot"
                            onClick={() => onSeek(row.startSec!)}
                          >
                            {formatRange(row.startSec, row.endSec)}
                          </button>
                        ) : (
                          <span style={timeText}>{formatRange(row.startSec, row.endSec)}</span>
                        )
                      ) : (
                        <span style={timeText}>no time</span>
                      )}
                      <span
                        style={{ ...badge, ...PRIORITY_BADGE[row.priority] }}
                        title={`Priority ${row.priority}: 1 is the most important; the limits drop 3 first`}
                        aria-label={`priority ${row.priority}`}
                      >
                        {row.priority}
                      </span>
                      <span data-testid={`storyboard-state-${row.id}`} style={{ ...stateText, color: STATE_COLOR[row.state] }}>
                        {row.state === "drawn" ? `drawn (v${row.draft})` : row.state}
                      </span>
                      {row.touched && row.state !== "dropped" ? (
                        <span style={stateText} title="You changed this shot, so Plan again keeps it">
                          · edited
                        </span>
                      ) : null}
                      {warning !== null ? (
                        <span data-testid={`storyboard-warning-${row.id}`} style={{ ...stateText, color: WARN }}>
                          · {warning}
                        </span>
                      ) : null}
                      <span style={{ flex: 1 }} />
                      {row.state === "dropped" ? (
                        <button
                          type="button"
                          data-testid={`storyboard-restore-${row.id}`}
                          style={off(actionBtn, disabled)}
                          disabled={disabled}
                          onClick={() => void rowAction({ op: "restore", id: row.id })}
                        >
                          Restore
                        </button>
                      ) : (
                        <>
                          {row.state !== "cut away" ? (
                            <button
                              type="button"
                              data-testid={`storyboard-use-selection-${row.id}`}
                              style={off(actionBtn, disabled || span === null)}
                              disabled={disabled || span === null}
                              title={selectionBlocked ?? "Move this shot onto the words selected in the transcript"}
                              onClick={() => {
                                if (span !== null) {
                                  void rowAction({ op: "span", id: row.id, startWord: span.startWord, endWord: span.endWord });
                                }
                              }}
                            >
                              Use selection
                            </button>
                          ) : null}
                          <button
                            type="button"
                            data-testid={`storyboard-drop-${row.id}`}
                            style={off(actionBtn, disabled)}
                            disabled={disabled}
                            onClick={() => void rowAction({ op: "drop", id: row.id })}
                          >
                            Drop
                          </button>
                        </>
                      )}
                    </div>
                    {row.state === "cut away" ? (
                      <div style={lineText}>The words under this shot were cut from the video.</div>
                    ) : row.line.length > 0 ? (
                      <div style={lineText}>“{row.line}”</div>
                    ) : null}
                    {isEditing ? (
                      <>
                        <textarea
                          data-testid={`storyboard-idea-input-${row.id}`}
                          aria-label={`Idea for shot ${row.id}`}
                          style={ideaArea}
                          rows={3}
                          autoFocus
                          readOnly={busy === "edit"}
                          value={editing.draft}
                          onChange={(e) => setEditing({ id: row.id, draft: e.target.value, error: null })}
                          onKeyDown={ideaKeyDown(() => void commitIdea())}
                          onBlur={() => void commitIdea()}
                        />
                        {editing.error !== null ? (
                          <div data-testid={`storyboard-idea-error-${row.id}`} style={errorText}>
                            {editing.error}
                          </div>
                        ) : null}
                      </>
                    ) : editable ? (
                      <button
                        type="button"
                        data-testid={`storyboard-idea-${row.id}`}
                        style={ideaBtn}
                        disabled={disabled}
                        title="Click to reword. Enter saves, Shift+Enter is a new line, Escape cancels."
                        onClick={() => startIdeaEdit(row)}
                      >
                        {row.idea}
                      </button>
                    ) : (
                      <div data-testid={`storyboard-idea-${row.id}`} style={{ ...ideaBtn, cursor: "default" }}>
                        {row.idea}
                      </div>
                    )}
                    {row.why.length > 0 ? <div style={whyText}>{row.why}</div> : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// The editor's warning yellow (CleanupPanel's `declinedNote`, the dirty dot).
const WARN = "#FFE14D";

const STATE_COLOR: Record<StoryboardRow["state"], string> = {
  planned: "#8B8B9E",
  drawn: "#5FBF77",
  dropped: "#8B8B9E",
  "cut away": WARN,
};

const PRIORITY_BADGE: Record<1 | 2 | 3, React.CSSProperties> = {
  1: { background: "#5b8cff", color: "#0b0b0f" },
  2: { background: "#2A2A33", color: "#C9C9D4" },
  3: { background: "transparent", color: "#8B8B9E", border: "1px solid #2A2A33" },
};

// Modal chrome matches CleanupPanel's (itself ThumbnailPanel's and
// RenderModal's): the editor's one dialog vocabulary. Wider, because a row
// carries a line, an idea and its actions side by side.
const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 40,
  background: "rgba(5,5,8,0.75)",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const panel: React.CSSProperties = {
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

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const title: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  color: "#EDEDF2",
  letterSpacing: "-0.01em",
};

const closeBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#8B8B9E",
  fontSize: 16,
  cursor: "pointer",
  padding: "4px 8px",
  borderRadius: 4,
};

const subtitle: React.CSSProperties = {
  fontSize: 13,
  color: "#8B8B9E",
  marginTop: 6,
  lineHeight: 1.4,
};

const toolbar: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 14,
  marginBottom: 8,
};

// CleanupPanel's `restoreBtn`: the modal palette's secondary button.
const toolBtn: React.CSSProperties = {
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

const actionBtn: React.CSSProperties = { ...toolBtn, padding: "3px 8px", fontSize: 11 };

/** A disabled button reads as one: PublishPanel's `chipOverCapStyle` dimming. */
const off = (style: React.CSSProperties, isDisabled: boolean): React.CSSProperties =>
  isDisabled ? { ...style, opacity: 0.45, cursor: "not-allowed" } : style;

// PublishPanel's `confirmBtn`, sized to sit beside a secondary button.
const primaryBtn: React.CSSProperties = {
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

const formBox: React.CSSProperties = {
  border: "1px solid #2C2C38",
  borderRadius: 6,
  background: "#09090D",
  padding: "10px 14px",
  marginTop: 10,
};

const formLabel: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#C9C9D4",
  marginBottom: 6,
};

const formButtons: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 8,
};

const rowBox: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #2C2C38",
  borderRadius: 6,
  background: "#09090D",
  marginBottom: 8,
};

const rowHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const rowLabel: React.CSSProperties = {
  fontSize: 13,
  color: "#EDEDF2",
  lineHeight: 1.4,
};

const monoFont = "ui-monospace, 'SF Mono', Consolas, monospace";

const timeText: React.CSSProperties = {
  fontSize: 12,
  color: "#C9C9D4",
  fontFamily: monoFont,
  whiteSpace: "nowrap",
};

const timeBtn: React.CSSProperties = {
  ...timeText,
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  textDecoration: "underline dotted",
};

const badge: React.CSSProperties = {
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

const stateText: React.CSSProperties = {
  fontSize: 11,
  color: "#8B8B9E",
  whiteSpace: "nowrap",
};

const lineText: React.CSSProperties = {
  fontSize: 12,
  color: "#8B8B9E",
  marginTop: 6,
  lineHeight: 1.4,
  fontStyle: "italic",
};

const ideaBtn: React.CSSProperties = {
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
const ideaArea: React.CSSProperties = {
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

const whyText: React.CSSProperties = {
  fontSize: 11,
  color: "#8B8B9E",
  marginTop: 4,
  lineHeight: 1.4,
};

const footNote: React.CSSProperties = {
  fontSize: 12,
  color: "#8B8B9E",
  lineHeight: 1.4,
};

// PublishPanel's `errorText`: server messages verbatim, line breaks kept.
const errorText: React.CSSProperties = {
  marginTop: 8,
  color: "#FF5C5C",
  fontSize: 13,
  fontFamily: monoFont,
  whiteSpace: "pre-wrap",
};
