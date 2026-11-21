import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Storyboard, TimeMap } from "@ossclip/core/browser";
import {
  coverage,
  coverageOverLimit,
  draftIsStale,
  formatRange,
  isKeptRow,
  jobLine,
  jobResultLine,
  planChangesSummary,
  rowWarning,
  selectionSpan,
  spanPreview,
  storyboardRows,
  type DetailMap,
  type DrawnMap,
  type StoryboardJobPair,
  type StoryboardJobState,
  type StoryboardRow,
} from "./storyboardModel";
import { StoryboardShotView } from "./StoryboardShotView";
import {
  PRIORITY_BADGE,
  STATE_COLOR,
  WARN,
  actionBtn,
  backdrop,
  badge,
  closeBtn,
  errorText,
  footNote,
  formBox,
  formButtons,
  formLabel,
  header,
  ideaArea,
  ideaBtn,
  lineText,
  off,
  panel,
  primaryBtn,
  rowBox,
  rowHead,
  rowLabel,
  stateText,
  subtitle,
  timeBtn,
  timeText,
  title,
  toolBtn,
  toolbar,
  whyText,
} from "./storyboardStyles";

/**
 * The storyboard's plan table (storyboard design §10 "Table view"; plan Task
 * 5; §168): one row per shot of `storyboard.json`, where the author drops,
 * rewords, moves and adds shots and can plan again.
 *
 * B2a (plan Task 5; §169) adds drawing: "Draw" per row and "Draw all", the
 * running job's line with Cancel, the last job's result, and the shot view
 * (StoryboardShotView.tsx), opened from a row's state, where the author
 * previews, notes, redraws and approves. A job runs on the server and is
 * followed by polling `GET /api/storyboard/job` once a second, only while
 * one runs; when it ends the table is read again, because a job writes the
 * shot's history (and an approve or a plan, `storyboard.json`), not this
 * page. Plan again is such a job (§169), so it outlives a closed panel.
 *
 * Server-owned state, the PublishPanel posture: the table lives in the
 * workdir's `storyboard.json`, not in the overrides doc, so there is no
 * undo, dirty or Save here; every edit is one request to
 * `/api/storyboard/edit` and the table shown is the one the server answered
 * with, or read again after a job. Requests run one at a time: the server
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
  detail: DetailMap;
  job: StoryboardJobPair;
}

/** `GET /api/storyboard`, read: the table, or the message to show instead of it. */
async function fetchStoryboard(): Promise<{ ok: true; load: StoryboardLoad } | { ok: false; error: string }> {
  const res = await fetch("/api/storyboard");
  const body = (await res.json()) as {
    storyboard?: Storyboard | null;
    drawn?: DrawnMap;
    detail?: DetailMap;
    job?: StoryboardJobPair;
    error?: string;
  };
  if (!res.ok) return { ok: false, error: body.error ?? `GET /api/storyboard failed: ${res.status}` };
  if (!body.storyboard) {
    return { ok: false, error: "This project has no storyboard.json. Plan one with `ossclip produce <video> --storyboard`." };
  }
  return {
    ok: true,
    load: {
      storyboard: body.storyboard,
      drawn: body.drawn ?? {},
      detail: body.detail ?? {},
      job: body.job ?? { job: null, last: null },
    },
  };
}

type StoryboardEditBody =
  | { op: "drop"; id: string }
  | { op: "restore"; id: string }
  | { op: "idea"; id: string; idea: string }
  | { op: "span"; id: string; startWord: number; endWord: number }
  | { op: "add"; startWord: number; endWord: number; idea: string }
  | { op: "unapprove"; id: string };

export interface StoryboardPanelProps {
  /**
   * App's `edits.dirty`. Approve is refused while it is true: the sync run
   * after an approval replays the SAVED overrides.json, and the reload when
   * it ends puts that doc over the unsaved one (Review Focus 4).
   */
  dirty: boolean;
  /**
   * The server started the sync run of the video (an approve that ended ok,
   * or a drop, restore or unapprove of an approved shot). App hands it to
   * its render poll (`beginRenderPoll`), which shows the run and reloads the
   * production when it ends: produce, not this page, writes the clip scene.
   */
  onReplayStarted: () => void;
  /**
   * The server accepted a job (a 202). App follows it from there
   * (`useStoryboardJobWatch`): this panel can close while the job runs, and
   * the hand-off of an approve's sync run to the render poll must not close
   * with it (§169).
   */
  onJobStarted: () => void;
  /** `/api/transcript`'s words: the index space a shot's `startWord`/`endWord` live in. Null when none loaded. */
  words: readonly { text: string; start: number; end: number }[] | null;
  /** The live clock (App's ruler map), source → output seconds. Null when the spans are unusable. */
  map: TimeMap | null;
  /** The last transcript selection App holds, as source starts; null when none was made. */
  selection: readonly { srcStart: number }[] | null;
  /**
   * Forget App's remembered selection (2026-11-21). App keeps the last one
   * across the transcript's click-away so the table can use it, which also
   * means nothing in the table could drop it. Absent = no Clear button.
   */
  onClearSelection?: () => void;
  /** Moves the player to an output second on the live clock. Absent = the time is not clickable. */
  onSeek?: (sec: number) => void;
  onClose: () => void;
}

export const StoryboardPanel: React.FC<StoryboardPanelProps> = ({
  dirty,
  onReplayStarted,
  onJobStarted,
  words,
  map,
  selection,
  onClearSelection,
  onSeek,
  onClose,
}) => {
  const [load, setLoad] = useState<StoryboardLoad | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "edit" | "job">(null);
  /** The shot the shot view shows; null is the table. */
  const [shotView, setShotView] = useState<string | null>(null);
  // Read through a ref by the job poll, whose interval outlives renders.
  const onReplayRef = useRef(onReplayStarted);
  onReplayRef.current = onReplayStarted;
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
        const got = await fetchStoryboard();
        if (!live) return;
        if (got.ok) setLoad(got.load);
        else setLoadError(got.error);
      } catch (err) {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /**
   * A job has ended: read the table again (the job wrote the shot's history,
   * and an approve wrote `storyboard.json`). The job pair is set first, so
   * the poll stops even when the read fails. The sync run an approve starts
   * is App's to follow (`onJobStarted`), not this panel's: it can be closed.
   */
  const jobEnded = useCallback(async (pair: StoryboardJobPair): Promise<void> => {
    setLoad((prev) => (prev === null ? prev : { ...prev, job: { job: null, last: pair.last } }));
    try {
      const got = await fetchStoryboard();
      if (got.ok) setLoad(got.load);
      else setError(got.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /** The job's state now; the poll below takes over while it runs. */
  const refreshJob = useCallback(async (): Promise<void> => {
    const res = await fetch("/api/storyboard/job");
    if (!res.ok) return;
    const pair = (await res.json()) as StoryboardJobPair;
    // A job that ended before this first look (a skipped draw is quick)
    // never reaches the poll, so its end is handled here.
    if (pair.job === null) await jobEnded(pair);
    else setLoad((prev) => (prev === null ? prev : { ...prev, job: pair }));
  }, [jobEnded]);

  const jobRunning = load !== null && load.job.job !== null;

  // Once a second, only while a job runs (design §10 "Progress and cost").
  // One request at a time: a tick that finds the last one still out skips.
  useEffect(() => {
    if (!jobRunning) return;
    let live = true;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const res = await fetch("/api/storyboard/job");
          if (!res.ok || !live) return;
          const pair = (await res.json()) as StoryboardJobPair;
          if (!live) return;
          if (pair.job === null) {
            live = false;
            window.clearInterval(timer);
            await jobEnded(pair);
          } else {
            setLoad((prev) => (prev === null ? prev : { ...prev, job: pair }));
          }
        } catch {
          // The next tick asks again.
        } finally {
          inFlight = false;
        }
      })();
    }, 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [jobRunning, jobEnded]);

  // Escape backs out of the innermost thing open: the shot view, a field
  // being edited, the add form, the plan confirm, and only then the panel.
  // Capture phase, the other panels' rule, so the app's shortcuts under the
  // modal never see it; that also means the field's own handler never does,
  // so the cancel is here. The shot view first: the table's forms are
  // hidden behind it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (shotView !== null) setShotView(null);
      else if (editRef.current !== null) setEditing(null);
      else if (adding !== null) setAdding(null);
      else if (confirmPlan) setConfirmPlan(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, adding, confirmPlan, shotView]);

  const outputTimeOf = useCallback(
    (i: number) => {
      const w = words?.[i];
      return w !== undefined && map !== null ? map.mapWord(w) : null;
    },
    [words, map],
  );
  const rows = useMemo<StoryboardRow[]>(
    () =>
      load === null || words === null
        ? []
        : storyboardRows(load.storyboard, words, outputTimeOf, load.drawn, load.detail, load.job.job),
    [load, words, outputTimeOf],
  );
  const keptRows = rows.filter(isKeptRow);
  /** Whether a row's draft was drawn from an older idea (design §10 "Draw again"). */
  const staleOf = (row: StoryboardRow): boolean => {
    const shot = load?.storyboard.shots.find((s) => s.id === row.id);
    return shot !== undefined && draftIsStale(shot, load?.detail[row.id] ?? null);
  };
  /** A kept row the table offers to draw: no draft yet, or a draft of an older idea. */
  const drawable = (row: StoryboardRow): boolean =>
    isKeptRow(row) && row.state !== "drawing" && (row.draft === null || staleOf(row));
  // "Draw all" is the rows with no draft only: a stale draft is the author's
  // to replace one shot at a time, and each draw spends LLM calls (AG3).
  const drawAllIds = keptRows.filter((r) => r.state !== "drawing" && r.draft === null).map((r) => r.id);
  // Not the running job's: Approve renders the draft's stills again under the
  // same names DURING the job, and a URL keyed to it would cache the old
  // ones. The finished job's stamp changes the URL once the job has ended.
  const cacheKey = load?.job.last?.startedAt ?? 0;
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
      const body = (await res.json()) as { ok?: boolean; storyboard?: Storyboard; replay?: boolean; error?: string };
      if (!res.ok || body.ok !== true || !body.storyboard) return body.error ?? `edit failed: ${res.status}`;
      const next = body.storyboard;
      setLoad((prev) => (prev === null ? prev : { ...prev, storyboard: next }));
      // A drop, restore or unapprove of an approved shot: the server started
      // the sync run, so the scene leaves or returns (plan B2a Task 4).
      if (body.replay === true) onReplayRef.current();
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
    // A drop, restore or unapprove of an APPROVED shot starts the sync run,
    // and the reload after it puts the saved overrides.json over whatever is
    // unsaved on screen (§169, the rule Approve already has): refuse it the
    // same way, before any request.
    const changesVideo = edit.op === "drop" || edit.op === "restore" || edit.op === "unapprove";
    const target = changesVideo ? load?.storyboard.shots.find((s) => s.id === edit.id) : undefined;
    if (dirty && target?.approval !== undefined) {
      setError("Save first: this changes the video, and the reload would discard your unsaved edits.");
      return;
    }
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

  /**
   * Plan again is a server job (§169), started like the others: App's
   * watcher follows it, so the Storyboard button shows it with the panel
   * closed, and its result is the job's, read again when the panel reopens.
   * The new table arrives through `jobEnded`'s read.
   */
  const runPlanAgain = async (): Promise<void> => {
    setConfirmPlan(false);
    await startJob("/api/storyboard/plan", {});
  };

  /**
   * POST a job's start (draw, note, preview, approve, plan). The answer is a 202,
   * or `{ok:false, error}` (409 busy, 412 a missing input, 400 a refused
   * body) shown in the error line, never thrown: a refusal is an answer.
   * Resolves true when the job started.
   */
  const startJob = async (path: string, payload: unknown): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy("job");
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (res.status !== 202 || body.ok !== true) {
        setError(body.error ?? `${path} failed: ${res.status}`);
        return false;
      }
      onJobStarted();
      await refreshJob();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  /** Cancel is not behind the request gate: it must reach a job whatever else is out. */
  const cancelJob = async (): Promise<void> => {
    try {
      const res = await fetch("/api/storyboard/cancel", { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (res.status !== 202 || body.ok !== true) setError(body.error ?? `Cancel failed: ${res.status}`);
      await refreshJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** "Make draft": a plain 200, no job; the table is read again for the new draft's stills. */
  const makeDraft = async (id: string, version: number): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("edit");
    setError(null);
    try {
      const res = await fetch("/api/storyboard/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, version }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || body.ok !== true) {
        setError(body.error ?? `Make draft failed: ${res.status}`);
        return;
      }
      const got = await fetchStoryboard();
      if (got.ok) setLoad(got.load);
      else setError(got.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const disabled = busy !== null;
  const job: StoryboardJobState | null = load?.job.job ?? null;
  const planRunning = job?.kind === "plan";
  const resultLine = jobRunning ? null : jobResultLine(load?.job.last ?? null);
  // The last job's, not this panel's: a plan that ended while the panel was
  // closed still shows what it changed when the panel opens again (§169).
  const lastJob = load?.job.last ?? null;
  const planResult = !jobRunning && lastJob?.kind === "plan" && lastJob.plan !== undefined ? lastJob.plan : null;
  // Shown in both views: a job started from the shot view is followed there.
  const jobBlock = (
    <>
      {job !== null ? (
        <div data-testid="storyboard-job" style={{ ...formBox, ...rowHead }}>
          <span style={{ ...rowLabel, color: STATE_COLOR.drawing }}>{jobLine(job)}</span>
          <span style={{ flex: 1 }} />
          {/* A plan is one call, which nothing stops midway: the server refuses its Cancel (§169). */}
          {job.kind !== "plan" ? (
            <button
              type="button"
              data-testid="storyboard-job-cancel"
              style={off(actionBtn, job.stopping)}
              disabled={job.stopping}
              title="Stop after the shot that is running; a draw also stops before its next LLM call"
              onClick={() => void cancelJob()}
            >
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
      {resultLine !== null ? (
        <div data-testid="storyboard-job-result" style={{ ...footNote, marginTop: 8 }}>
          Last job: {resultLine}
        </div>
      ) : null}
      {error !== null ? (
        <div data-testid="storyboard-error" style={errorText}>
          {error}
        </div>
      ) : null}
    </>
  );
  const viewedShot = shotView === null ? undefined : load?.storyboard.shots.find((s) => s.id === shotView);
  const viewedRow = shotView === null ? undefined : rows.find((r) => r.id === shotView);

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
        ) : viewedShot !== undefined && viewedRow !== undefined ? (
          <>
            {jobBlock}
            <StoryboardShotView
              // Keyed by shot so the note box starts empty for each shot.
              key={viewedShot.id}
              shot={viewedShot}
              row={viewedRow}
              detail={load.detail[viewedShot.id] ?? null}
              dirty={dirty}
              jobRunning={jobRunning}
              busy={disabled}
              cacheKey={cacheKey}
              onBack={() => {
                setError(null);
                setShotView(null);
              }}
              onPreview={() => void startJob("/api/storyboard/preview", { id: viewedShot.id })}
              onRedraw={(text) => startJob("/api/storyboard/note", { id: viewedShot.id, text })}
              onMakeDraft={(version) => void makeDraft(viewedShot.id, version)}
              onApprove={() => void startJob("/api/storyboard/approve", { id: viewedShot.id })}
              onUnapprove={() => void rowAction({ op: "unapprove", id: viewedShot.id })}
            />
          </>
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
                style={off(toolBtn, disabled || jobRunning || confirmPlan)}
                disabled={disabled || jobRunning || confirmPlan}
                title="Plan the shots again from the transcript. Shots you reworded, added or drew are kept."
                onClick={() => {
                  setError(null);
                  setConfirmPlan(true);
                }}
              >
                {planRunning ? "Planning again… (one LLM call)" : "Plan again (one LLM call)"}
              </button>
              <button
                type="button"
                data-testid="storyboard-draw-all"
                style={off(toolBtn, disabled || jobRunning || drawAllIds.length === 0)}
                disabled={disabled || jobRunning || drawAllIds.length === 0}
                title={
                  drawAllIds.length === 0
                    ? "Every kept shot has a draft"
                    : `Draw the ${drawAllIds.length} kept shot${drawAllIds.length === 1 ? "" : "s"} with no draft, one after another (LLM calls for each)`
                }
                onClick={() => void startJob("/api/storyboard/draw", { ids: drawAllIds })}
              >
                Draw all
              </button>
            </div>

            <div data-testid="storyboard-selection" style={footNote}>
              {span !== null
                ? `Selected in the transcript: “${spanPreview(words, span)}” (words ${span.startWord}–${span.endWord})`
                : selectionBlocked}
              {/* Whenever App holds a selection, misaligned ones included:
                  "select them again" is advice, and Clear is how to stop the
                  line reading a span the author is done with. */}
              {onClearSelection !== undefined && selection !== null && selection.length > 0 ? (
                <button
                  type="button"
                  data-testid="storyboard-selection-clear"
                  style={{ ...actionBtn, marginLeft: 8 }}
                  title="Forget this selection: Add shot and Use selection need a new one"
                  onClick={() => {
                    // The add form is anchored to the span: left open, it
                    // would come back with its stale draft on the NEXT
                    // selection, over words it was not written for.
                    setAdding(null);
                    onClearSelection();
                  }}
                >
                  Clear
                </button>
              ) : null}
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
                    style={off(primaryBtn, disabled || jobRunning)}
                    disabled={disabled || jobRunning}
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

            {jobBlock}

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
                const rowDetail = load.detail[row.id];
                const thumb = rowDetail?.versions.find((v) => v.n === rowDetail.draft)?.stills[0];
                const stale = isKeptRow(row) && staleOf(row);
                // The newest version's error is the one "failed" is about (storyboardRows' rule).
                const failedError =
                  row.state === "failed" ? [...(rowDetail?.versions ?? [])].sort((a, b) => b.n - a.n)[0]?.error : undefined;
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
                      <button
                        type="button"
                        data-testid={`storyboard-open-shot-${row.id}`}
                        style={openShotBtn}
                        title="Open the shot: its stills, versions, notes and Approve"
                        onClick={() => {
                          setError(null);
                          setShotView(row.id);
                        }}
                      >
                        {thumb !== undefined ? (
                          <img src={`${thumb}?v=${cacheKey}`} alt={`Shot ${row.id}, draft still`} style={thumbImg} />
                        ) : null}
                        <span
                          data-testid={`storyboard-state-${row.id}`}
                          style={{ ...stateText, color: STATE_COLOR[row.state] }}
                          {...(failedError !== undefined ? { title: failedError } : {})}
                        >
                          {row.state === "drawn" ? `drawn (v${row.draft})` : row.state}
                        </span>
                      </button>
                      {stale ? (
                        <span
                          data-testid={`storyboard-stale-${row.id}`}
                          style={{ ...stateText, color: WARN }}
                          title="The idea changed after this shot was drawn; Draw again draws the new idea"
                        >
                          · drawn from an older idea
                        </span>
                      ) : null}
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
                          {drawable(row) ? (
                            <button
                              type="button"
                              data-testid={`storyboard-draw-${row.id}`}
                              style={off(actionBtn, disabled || jobRunning)}
                              disabled={disabled || jobRunning}
                              title={
                                stale
                                  ? "Draw this shot again from its new idea; the earlier versions stay (LLM calls)"
                                  : "Draw this shot (LLM calls)"
                              }
                              onClick={() => void startJob("/api/storyboard/draw", { ids: [row.id] })}
                            >
                              {stale ? "Draw again" : "Draw"}
                            </button>
                          ) : null}
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

// A row's state as the shot view's door (§169): the state text keeps its own
// look, with the draft's first still beside it once there is one.
const openShotBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  textDecoration: "underline dotted",
  color: "inherit",
};

const thumbImg: React.CSSProperties = {
  height: 32,
  borderRadius: 3,
  border: "1px solid #2C2C38",
};
