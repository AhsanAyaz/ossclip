/**
 * The editor's storyboard jobs (storyboard design §10 "Progress and cost";
 * plan B2a Task 4; §169): draw, redraw, preview and approve, one job at a
 * time, over one or more shots in order.
 *
 * Pure state and the batch loop, no HTTP and no draw: the endpoints in
 * edit.ts pass the per-shot work in as `each`, so the rules that matter
 * (one job at a time, a failing shot never stops the batch, Stop ends it
 * between shots) are tested without a server, a browser or an LLM.
 *
 * In memory on purpose: design §9 says work in progress is not a stored
 * state. A server that restarts mid-job starts with no job; what the
 * interrupted draw left (a version without a result) is discarded by the
 * next `loadShot` (Review Focus 2).
 */

export type StoryboardJobKind = "draw" | "redraw" | "preview" | "approve";

export interface StoryboardJobState {
  kind: StoryboardJobKind;
  /** All shots of the job, in order. */
  shots: string[];
  /** The shot being worked on; null once the job has ended. */
  current: string | null;
  done: { id: string; ok: boolean; error?: string }[];
  /** Progress lines, the newest last, capped at `JOB_LINES_MAX`. */
  lines: string[];
  /** LLM calls so far in this job (design §10: "shows the calls used so far"). */
  calls: number;
  startedAt: number;
  stopping: boolean;
}

/** The `/api/render` log tail's reason: enough to read what happened, never a growing heap. */
export const JOB_LINES_MAX = 200;

export interface JobContext {
  /** True once the author pressed Cancel; the draw asks it before every call. */
  shouldStop(): boolean;
  log(line: string): void;
  addCalls(n: number): void;
}

export interface JobRunner {
  state(): { job: StoryboardJobState | null; last: StoryboardJobState | null };
  /**
   * Throws JobBusyError, synchronously, when a job is running, so an
   * endpoint can answer 409 with no await between its check and the start.
   * `each` runs per shot, in order; a throw or an `ok: false` for one shot
   * is recorded and the next shot still runs (design G8; Review Focus 3).
   * After `stop()`, no further shot is started. Resolves when the job ends.
   *
   * `finish` runs after the last shot and BEFORE the job reads as ended:
   * the server appends the job's usage there, so a panel that sees the job
   * end sees its spend in usage.json, and the next job's append cannot
   * overlap this one's. A throw from it is logged on the job, not raised.
   */
  start(
    kind: StoryboardJobKind,
    shots: string[],
    each: (id: string, ctx: JobContext) => Promise<{ ok: boolean; error?: string }>,
    finish?: () => Promise<void>,
  ): Promise<void>;
  /** False when nothing runs. */
  stop(): boolean;
}

export class JobBusyError extends Error {
  constructor(message = "a storyboard job is running") {
    super(message);
    this.name = "JobBusyError";
  }
}

const copy = (s: StoryboardJobState | null): StoryboardJobState | null =>
  s === null ? null : { ...s, shots: [...s.shots], done: s.done.map((d) => ({ ...d })), lines: [...s.lines] };

export function createJobRunner(now: () => number): JobRunner {
  let job: StoryboardJobState | null = null;
  let last: StoryboardJobState | null = null;

  return {
    // Copies: the endpoint serialises them, and a caller holding one must
    // not be able to change the running job.
    state: () => ({ job: copy(job), last: copy(last) }),

    start(kind, shots, each, finish) {
      if (job !== null) throw new JobBusyError();
      const state: StoryboardJobState = {
        kind,
        shots: [...shots],
        current: null,
        done: [],
        lines: [],
        calls: 0,
        startedAt: now(),
        stopping: false,
      };
      job = state;
      const log = (line: string): void => {
        state.lines.push(line);
        if (state.lines.length > JOB_LINES_MAX) state.lines.splice(0, state.lines.length - JOB_LINES_MAX);
      };
      const ctx: JobContext = {
        shouldStop: () => state.stopping,
        log,
        addCalls: (n) => {
          state.calls += n;
        },
      };
      return (async () => {
        try {
          for (const [i, id] of state.shots.entries()) {
            if (state.stopping) break;
            state.current = id;
            log(`▸ ${id} (${i + 1} of ${state.shots.length})`);
            let result: { ok: boolean; error?: string };
            try {
              result = await each(id, ctx);
            } catch (err) {
              // One shot's fault is that shot's result, never the batch's
              // (G8): the next shot is a separate drawing.
              result = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            state.done.push({ id, ok: result.ok, ...(result.ok || result.error === undefined ? {} : { error: result.error }) });
            if (!result.ok && result.error !== undefined) log(`✗ ${id}: ${result.error.split("\n")[0]}`);
          }
          state.current = null;
          if (finish) {
            try {
              await finish();
            } catch (err) {
              log(`✗ ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } finally {
          state.current = null;
          last = state;
          job = null;
        }
      })();
    },

    stop() {
      if (job === null) return false;
      job.stopping = true;
      return true;
    },
  };
}
