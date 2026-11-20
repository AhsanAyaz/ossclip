import { STORYBOARD_COVERAGE, STORYBOARD_MIN_SHOT_SEC, type Storyboard } from "@ossclip/core/browser";

/**
 * The storyboard panel's pure half (storyboard design §10 "Table view"; plan
 * Task 5; §168): what each row of the plan table shows, the coverage the
 * header states, and how a transcript selection becomes a shot's word span.
 * No DOM and no fetch, so every rule here is tested without a browser; the
 * panel (StoryboardPanel.tsx) only renders these values and sends edits.
 */

/**
 * The longest shot, in seconds: `MAX_SCENE_SEC` in core's assemble.ts and the
 * upper bound `ossclip draw` accepts for a duration (§167). Restated rather
 * than imported because assemble.ts exposes only `sceneStartSeconds` on the
 * browser surface; the row warning is advice, and the limits that enforce the
 * bound run on the server with core's own constant.
 */
export const STORYBOARD_MAX_SHOT_SEC = 15;

/** A row's line is capped so a long shot cannot push its idea off screen. */
const LINE_MAX_CHARS = 140;

/** `GET /api/storyboard`'s `drawn` value: a shot's draft and how many versions finished. */
export type DrawnMap = Record<string, { draft: number | null; versions: number }>;

/**
 * The server's shapes for the shot view and the job (plan B2a Task 4; §169),
 * declared again here rather than imported: the editor never imports from
 * apps/cli (that package is Node, and its draw half evaluates LLM-written
 * code). They mirror apps/cli/src/storyboard/shot-detail.ts and jobs.ts.
 */
export interface ShotDetail {
  versions: {
    n: number;
    ok: boolean;
    error?: string;
    said?: string;
    kitVersion: number;
    /** `/media/storyboard/<id>/v<n>/still-<k>.png`, only files that exist. */
    stills: string[];
    preview: string | null;
  }[];
  draft: number | null;
  notes: { onVersion: number; text: string }[];
  /** The idea the draft was drawn from; null with no draft. */
  drawnIdea: string | null;
}

/** `GET /api/storyboard`'s `detail`: only shots that have a history. */
export type DetailMap = Record<string, ShotDetail>;

export type StoryboardJobKind = "draw" | "redraw" | "preview" | "approve";

export interface StoryboardJobState {
  kind: StoryboardJobKind;
  shots: string[];
  current: string | null;
  done: { id: string; ok: boolean; error?: string }[];
  lines: string[];
  calls: number;
  startedAt: number;
  stopping: boolean;
}

/** `GET /api/storyboard/job`, and `GET /api/storyboard`'s `job`. */
export interface StoryboardJobPair {
  job: StoryboardJobState | null;
  last: StoryboardJobState | null;
}

export type StoryboardRowState = "dropped" | "cut away" | "planned" | "drawing" | "failed" | "drawn" | "in the video";

export interface StoryboardRow {
  id: string;
  /** Output seconds on the clock the panel was given, null for a cut-away row. */
  startSec: number | null;
  endSec: number | null;
  /** The shot's KEPT words joined by spaces: what the viewer hears under the drawing. */
  line: string;
  idea: string;
  why: string;
  priority: 1 | 2 | 3;
  state: StoryboardRowState;
  touched: boolean;
  /**
   * The draft version of a row on screen (`isKeptRow`), else null. Not only
   * "drawn" rows have one: a shot being redrawn, or one in the video, still
   * has the draft the author looks at, and the table's Draw rule reads it.
   */
  draft: number | null;
}

/**
 * One row per shot, in start order.
 *
 * `outputTimeOf` is the editor's LIVE clock (App passes the ruler's map, the
 * one the player plays), not the last render's: a word the author cut in the
 * editor is cut here before any render, so a shot whose words are all cut
 * says so now (§168). It returns null for a word the clock removed; such words
 * are left out of the line and the times.
 *
 * Shots are sorted by `startWord`, not by `startSec`: a cut-away row has no
 * time, and word order is time order for every row that has one.
 *
 * The state, first match wins (design §9: what the storyboard shows is
 * computed from the record, the running job and the cut on every load, never
 * stored; §169):
 *  - "dropped": the author refused the shot; that holds whatever else is true.
 *  - "cut away": no word of the shot survives the cut, so there is nothing to
 *    lay a drawing over, even one already drawn or approved (design §8: the
 *    scene leaves the video and the shot keeps its work).
 *  - "drawing": the running job's current shot, or one of its shots not done
 *    yet. Before "in the video", so a redraw of an approved shot reads as the
 *    work it is.
 *  - "in the video": the shot has an approval (design §8).
 *  - "failed": no draft, and the newest version failed. A failed redraw
 *    beside a draft is not this: the draft is still there to look at.
 *  - "drawn": the shot has a draft the author is looking at (design §9
 *    `draft`). Versions without a draft are not "drawn": nothing is chosen.
 *  - "planned": everything else.
 *
 * `detail` and `job` default to none, the B1 table's inputs.
 */
export function storyboardRows(
  sb: Storyboard,
  words: readonly { text: string }[],
  outputTimeOf: (i: number) => { start: number; end: number } | null,
  drawn: DrawnMap,
  detail: DetailMap = {},
  job: StoryboardJobState | null = null,
): StoryboardRow[] {
  const shots = [...sb.shots].sort((a, b) => a.startWord - b.startWord);
  return shots.map((s) => {
    const kept: string[] = [];
    let startSec: number | null = null;
    let endSec: number | null = null;
    for (let i = s.startWord; i <= s.endWord && i < words.length; i++) {
      const t = outputTimeOf(i);
      if (t === null) continue;
      kept.push(words[i]!.text);
      if (startSec === null) startSec = t.start;
      endSec = t.end;
    }
    const joined = kept.join(" ");
    const line = joined.length > LINE_MAX_CHARS ? `${joined.slice(0, LINE_MAX_CHARS - 1)}…` : joined;
    const draft = drawn[s.id]?.draft ?? null;
    const inJob = job !== null && (job.current === s.id || (job.shots.includes(s.id) && !job.done.some((d) => d.id === s.id)));
    const versions = detail[s.id]?.versions ?? [];
    const newest = versions.reduce<ShotDetail["versions"][number] | null>((a, v) => (a === null || v.n > a.n ? v : a), null);
    const state: StoryboardRowState = !s.kept
      ? "dropped"
      : startSec === null
        ? "cut away"
        : inJob
          ? "drawing"
          : s.approval !== undefined
            ? "in the video"
            : draft === null && newest !== null && !newest.ok
              ? "failed"
              : draft !== null
                ? "drawn"
                : "planned";
    const row: StoryboardRow = {
      id: s.id,
      startSec,
      endSec,
      line,
      idea: s.idea,
      why: s.why,
      priority: s.priority,
      state,
      touched: s.touched,
      draft: null,
    };
    return { ...row, draft: isKeptRow(row) ? draft : null };
  });
}

/** A row that will be on screen: neither dropped nor cut away. */
export function isKeptRow(row: StoryboardRow): boolean {
  return row.state !== "dropped" && row.state !== "cut away";
}

/**
 * True when the shot has a draft drawn from another idea than the shot's
 * own: the author reworded the shot after it was drawn, and design §10 says
 * that does not redraw it; the panel marks it and offers "Draw again".
 */
export function draftIsStale(shot: { idea: string }, detail: ShotDetail | null): boolean {
  return detail !== null && detail.draft !== null && detail.drawnIdea !== null && detail.drawnIdea !== shot.idea;
}

const JOB_VERB: Record<StoryboardJobKind, string> = {
  draw: "Drawing",
  redraw: "Redrawing",
  preview: "Previewing",
  approve: "Approving",
};

/**
 * The running job's line (design §10 "Progress and cost": which shot runs,
 * and the calls used so far), or null when no job runs. A stopping job says
 * only that: Cancel ends it after the shot it is on, and a count that keeps
 * moving would read as Cancel not having worked. `current` is null for the
 * moment between the last shot and the job's end (the usage append).
 */
export function jobLine(job: StoryboardJobState | null): string | null {
  if (job === null) return null;
  if (job.stopping) return job.current !== null ? `Stopping after ${job.current}…` : "Stopping…";
  const calls = `${job.calls} call${job.calls === 1 ? "" : "s"}`;
  const at = job.current !== null ? job.shots.indexOf(job.current) + 1 : job.done.length;
  return `${JOB_VERB[job.kind]}${job.current !== null ? ` ${job.current}` : ""} (${at} of ${job.shots.length}) · ${calls}`;
}

/** The server's error for a shot Cancel interrupted (runDraw's `stopped`, edit.ts). */
const STOPPED_ERROR = "stopped before it finished";

const JOB_DONE: Record<StoryboardJobKind, string> = {
  draw: "drawn",
  redraw: "redrawn",
  preview: "preview ready",
  approve: "approved",
};

/**
 * One line for a finished job: "5 drawn" / "4 drawn, 1 failed: s2: <error>".
 *
 * A shot Cancel interrupted, and one the job never started because of it,
 * is "stopped", not "failed": the author asked for it, and a failure would
 * send them looking for a fault that is not there (§169). Each failure is
 * named with its first line, the job log's rule, so one long checker
 * message cannot push the others off the line.
 */
export function jobResultLine(last: StoryboardJobState | null): string | null {
  if (last === null) return null;
  const ok = last.done.filter((d) => d.ok).length;
  const stopped =
    last.done.filter((d) => !d.ok && d.error === STOPPED_ERROR).length + Math.max(0, last.shots.length - last.done.length);
  const failed = last.done.filter((d) => !d.ok && d.error !== STOPPED_ERROR);
  const parts = [`${ok} ${JOB_DONE[last.kind]}`];
  if (stopped > 0) parts.push(`${stopped} stopped`);
  if (failed.length > 0) {
    const named = failed.map((d) => `${d.id}: ${(d.error ?? "failed").split("\n")[0]}`).join("; ");
    parts.push(`${failed.length} failed: ${named}`);
  }
  return parts.join(", ");
}

/**
 * Whether a finished job started the sync run of the video: an approve that
 * ended ok (plan B2a Task 4: the server spawns the recorded command after it
 * saves the approval; an approve it could not follow with that run is
 * `ok: false`). The panel then hands the run to App's render poll, which
 * reloads the production when it ends.
 */
export function jobStartedReplay(last: StoryboardJobState | null): boolean {
  return last !== null && last.kind === "approve" && last.done.length > 0 && last.done.every((d) => d.ok);
}

/**
 * One look at the job by App's watcher (`useStoryboardJobWatch`). `armed`
 * means a job's end is still owed a hand-off: set when the watcher saw a job
 * running, or was told one started. `ended` is true exactly once per job, on
 * the first look that finds no job while armed, so an old `last` read at page
 * load (nothing armed) starts no reload.
 */
export function jobWatchStep(armed: boolean, pair: StoryboardJobPair): { armed: boolean; ended: boolean } {
  if (pair.job !== null) return { armed: true, ended: false };
  return { armed: false, ended: armed };
}

/**
 * Why Approve is disabled, or null. "Save first" comes first: the sync run
 * after an approval replays the SAVED overrides.json, and when it ends the
 * editor reloads that doc over the unsaved one (Review Focus 4), so an
 * approve with unsaved edits would throw them away.
 */
export function approveBlock(a: { dirty: boolean; draft: number | null; jobRunning: boolean }): string | null {
  if (a.dirty) return "Save first";
  if (a.draft === null) return "no draft";
  if (a.jobRunning) return "a job is running";
  return null;
}

/**
 * The share of the runtime the kept rows cover, 0 to 1. Dropped and cut-away
 * rows are not on screen, so they cover nothing; the header compares this to
 * `STORYBOARD_COVERAGE` because the planner's limit is the same share of the
 * same runtime (Global Constraints: 0.6 of the kept runtime).
 */
export function coverage(rows: StoryboardRow[], outputDurationSec: number): number {
  if (!(outputDurationSec > 0)) return 0;
  let sum = 0;
  for (const r of rows) {
    if (!isKeptRow(r) || r.startSec === null || r.endSec === null) continue;
    sum += Math.max(0, r.endSec - r.startSec);
  }
  return sum / outputDurationSec;
}

/** Whether the header's coverage figure is over the planner's limit. */
export function coverageOverLimit(share: number): boolean {
  return share > STORYBOARD_COVERAGE;
}

/** `m:ss.s`, rounded to tenths first so 59.96 s reads 1:00.0, not 0:60.0. */
function formatSec(sec: number): string {
  const tenths = Math.round(Math.max(0, sec) * 10);
  const m = Math.floor(tenths / 600);
  const s = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

/** A row's time range, for example `0:12.4 – 0:18.0`. */
export function formatRange(startSec: number, endSec: number): string {
  return `${formatSec(startSec)} – ${formatSec(endSec)}`;
}

/**
 * A short warning for a kept row the drawing step would refuse: `ossclip
 * draw` takes 2 to 15 seconds (§167). The planner's limits keep its own rows
 * inside that, but the author's cuts and span edits can move a row out of it
 * afterwards, and the row is where the author can fix it. Null when the row is
 * fine or not on screen.
 */
export function rowWarning(row: StoryboardRow): string | null {
  if (!isKeptRow(row) || row.startSec === null || row.endSec === null) return null;
  const len = row.endSec - row.startSec;
  if (len < STORYBOARD_MIN_SHOT_SEC) return `shorter than ${STORYBOARD_MIN_SHOT_SEC} s after your cuts`;
  if (len > STORYBOARD_MAX_SHOT_SEC) return `longer than ${STORYBOARD_MAX_SHOT_SEC} s`;
  return null;
}

/**
 * The transcript index of the word that starts at `srcStart` (source
 * seconds), or null.
 *
 * Exact within 1 ms, never nearest: a caption word's `srcStart` is the
 * `start` of the transcript word it was built from (`buildCaptionLines`,
 * §137), so a real word matches to float noise. A word that matches nothing
 * (a word minted by a caption range rewrite, whose `srcStart` is
 * interpolated, or a legacy caption whose anchor was back-filled from a
 * clamped output time) has no transcript index, and guessing the nearest one
 * would put the shot on words the author did not select. The first match
 * wins; `lastWordIndexAtSourceTime` is the other end's rule.
 */
export function wordIndexAtSourceTime(words: readonly { start: number }[], srcStart: number): number | null {
  if (!Number.isFinite(srcStart)) return null;
  for (let i = 0; i < words.length; i++) {
    if (Math.abs(words[i]!.start - srcStart) <= 0.001) return i;
  }
  return null;
}

/** The last match: two transcript words can share a start (a zero-length stamp). */
function lastWordIndexAtSourceTime(words: readonly { start: number }[], srcStart: number): number | null {
  if (!Number.isFinite(srcStart)) return null;
  for (let i = words.length - 1; i >= 0; i--) {
    if (Math.abs(words[i]!.start - srcStart) <= 0.001) return i;
  }
  return null;
}

/**
 * A transcript selection as a shot's word span, or null when any selected
 * word has no transcript index.
 *
 * The selection arrives as the transcript panel's caption words, which are
 * positional in the panel and known outside it only by `srcStart` (source
 * seconds); a shot is anchored to transcript indices (design §2). Every word
 * must match, not just the two ends: a selection holding a word the
 * transcript does not have is a selection over rewritten captions, and the
 * author should see the refusal rather than a span that silently includes
 * words they cannot see. The span runs from the smallest index to the
 * largest, so the selection's order does not matter.
 */
export function selectionSpan(
  words: readonly { start: number }[],
  selected: readonly { srcStart: number }[],
): { startWord: number; endWord: number } | null {
  if (selected.length === 0) return null;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const s of selected) {
    const first = wordIndexAtSourceTime(words, s.srcStart);
    if (first === null) return null;
    const last = lastWordIndexAtSourceTime(words, s.srcStart)!;
    lo = Math.min(lo, first);
    hi = Math.max(hi, last);
  }
  return { startWord: lo, endWord: hi };
}

/**
 * The words of a span as the panel names the selection: the first and last
 * three words around an ellipsis, so the author can see what "Add shot from
 * selection" will use after the transcript's own highlight is gone (opening
 * the modal is a click outside the transcript, which clears it).
 */
export function spanPreview(words: readonly { text: string }[], span: { startWord: number; endWord: number }): string {
  const texts = words.slice(span.startWord, span.endWord + 1).map((w) => w.text);
  if (texts.length <= 6) return texts.join(" ");
  return `${texts.slice(0, 3).join(" ")} … ${texts.slice(-3).join(" ")}`;
}

/** The sentence under a successful "Plan again" saying what the limits did. */
export function planChangesSummary(changes: readonly { index: number; kind: string; reason: string }[]): string {
  if (changes.length === 0) return "No planner shot was changed by the limits.";
  if (changes.length === 1) return "1 planner shot was changed by the limits.";
  return `${changes.length} planner shots were changed by the limits.`;
}

/** What the top bar does with the storyboard: no button, a button, or a button marked broken. */
export type StoryboardButtonState = { kind: "hidden" } | { kind: "shown" } | { kind: "error"; message: string };

/**
 * The top-bar button's state from `GET /api/storyboard`'s status and body.
 *
 * Shown only when the project has a storyboard: a project produced without
 * `--storyboard` has no table, and a button that opens an empty panel would
 * invite the author into a feature they never ran. A 500 is a
 * `storyboard.json` that fails its schema (Review Focus 4): the button stays,
 * marked, because the file exists and the panel is where the author reads
 * which line is wrong. Anything else (409 with no project, a failed request)
 * is no button.
 */
export function storyboardButtonState(status: number, body: unknown): StoryboardButtonState {
  const b = (typeof body === "object" && body !== null ? body : {}) as { storyboard?: unknown; error?: unknown };
  if (status === 500) {
    return { kind: "error", message: typeof b.error === "string" ? b.error : "storyboard.json could not be read" };
  }
  if (status === 200 && typeof b.storyboard === "object" && b.storyboard !== null) return { kind: "shown" };
  return { kind: "hidden" };
}
