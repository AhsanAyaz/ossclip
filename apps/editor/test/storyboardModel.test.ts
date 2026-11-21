import { describe, expect, it } from "vitest";
import type { Storyboard, StoryboardShot } from "@ossclip/core/browser";
import {
  approveBlock,
  coverage,
  coverageOverLimit,
  draftIsStale,
  formatRange,
  jobLine,
  jobResultLine,
  jobStartedReplay,
  jobWatchStep,
  planChangesSummary,
  rowWarning,
  selectionSpan,
  spanPreview,
  storyboardBusyTitle,
  storyboardButtonState,
  storyboardRows,
  wordIndexAtSourceTime,
  type ShotDetail,
  type StoryboardJobState,
  type StoryboardRow,
} from "../src/storyboardModel";

/** Ten words, one per second of source; word i runs i .. i+0.8. */
const words = Array.from({ length: 10 }, (_, i) => ({ text: `w${i}`, start: i, end: i + 0.8 }));

/** The identity clock with words 4 and 5 cut. */
const cut = new Set([4, 5]);
const timeOf = (i: number) => (cut.has(i) ? null : { start: words[i]!.start, end: words[i]!.end });

const shot = (over: Partial<StoryboardShot> & { id: string; startWord: number; endWord: number }): StoryboardShot => ({
  idea: `idea ${over.id}`,
  why: `why ${over.id}`,
  priority: 2,
  assets: [],
  kept: true,
  origin: "planner",
  touched: false,
  ...over,
});

const board = (shots: StoryboardShot[]): Storyboard => ({ version: 1, nextShot: shots.length + 1, shots });

const row = (over: Partial<StoryboardRow>): StoryboardRow => ({
  id: "s1",
  startSec: 0,
  endSec: 5,
  line: "",
  idea: "x",
  why: "",
  priority: 1,
  state: "planned",
  touched: false,
  draft: null,
  ...over,
});

describe("storyboardRows", () => {
  it("sorts rows by start whatever order the file holds them in", () => {
    const rows = storyboardRows(
      board([shot({ id: "s2", startWord: 6, endWord: 7 }), shot({ id: "s1", startWord: 0, endWord: 1 })]),
      words,
      timeOf,
      {},
    );
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"]);
  });

  it("joins the shot's kept words into its line and times it from the first to the last kept word", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 3, endWord: 6 })]), words, timeOf, {});
    expect(r!.line).toBe("w3 w6");
    expect(r!.startSec).toBe(3);
    expect(r!.endSec).toBeCloseTo(6.8);
    expect(r!.state).toBe("planned");
  });

  it("caps a long line at 140 characters with an ellipsis", () => {
    const long = Array.from({ length: 60 }, (_, i) => ({ text: `word${i}`, start: i, end: i + 0.5 }));
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 0, endWord: 59 })]), long, (i) => long[i]!, {});
    expect(r!.line).toHaveLength(140);
    expect(r!.line.endsWith("…")).toBe(true);
    expect(r!.line.startsWith("word0 word1 ")).toBe(true);
  });

  it("marks a shot whose words are all cut as cut away, with no times and no line", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 4, endWord: 5 })]), words, timeOf, {});
    expect(r!.state).toBe("cut away");
    expect(r!.startSec).toBeNull();
    expect(r!.endSec).toBeNull();
    expect(r!.line).toBe("");
  });

  it("marks a dropped shot as dropped, even when it has a draft or its words are cut", () => {
    const rows = storyboardRows(
      board([
        shot({ id: "s1", startWord: 0, endWord: 1, kept: false }),
        shot({ id: "s2", startWord: 4, endWord: 5, kept: false }),
      ]),
      words,
      timeOf,
      { s1: { draft: 2, versions: 2 } },
    );
    expect(rows.map((r) => r.state)).toEqual(["dropped", "dropped"]);
    expect(rows[0]!.draft).toBeNull();
  });

  it("marks a shot with a draft as drawn and carries the draft number", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 0, endWord: 1 })]), words, timeOf, {
      s1: { draft: 3, versions: 3 },
    });
    expect(r!.state).toBe("drawn");
    expect(r!.draft).toBe(3);
  });

  it("does not call a shot with versions but no draft drawn", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 0, endWord: 1 })]), words, timeOf, {
      s1: { draft: null, versions: 1 },
    });
    expect(r!.state).toBe("planned");
  });

  it("calls a drawn shot whose words were all cut cut away: nothing is left to draw over", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 4, endWord: 5 })]), words, timeOf, {
      s1: { draft: 1, versions: 1 },
    });
    expect(r!.state).toBe("cut away");
  });

  it("ignores indices past the end of the words instead of throwing", () => {
    const [r] = storyboardRows(board([shot({ id: "s1", startWord: 8, endWord: 20 })]), words, timeOf, {});
    expect(r!.line).toBe("w8 w9");
  });
});

/** A shot's detail: versions `[n, ok]` in order, the draft, and the idea the draft was drawn from. */
const detailOf = (versions: [number, boolean][], draft: number | null, drawnIdea: string | null = null): ShotDetail => ({
  versions: versions.map(([n, ok]) => ({
    n,
    ok,
    ...(ok ? {} : { error: `v${n} failed its checks` }),
    kitVersion: 1,
    stills: ok ? [1, 2, 3].map((k) => `/media/storyboard/s1/v${n}/still-${k}.png`) : [],
    preview: null,
  })),
  draft,
  notes: [],
  drawnIdea,
});

const job = (over: Partial<StoryboardJobState>): StoryboardJobState => ({
  kind: "draw",
  shots: ["s1"],
  current: null,
  done: [],
  lines: [],
  calls: 0,
  startedAt: 1000,
  stopping: false,
  ...over,
});

const approval = { version: 1, durationSec: 3.5, clipKey: "k", clip: "storyboard/s1/approved.mov", src: "clips/x.webm" };

describe("storyboardRows: the B2a states, first match wins (§169)", () => {
  const one = (
    over: Partial<StoryboardShot>,
    drawn: Record<string, { draft: number | null; versions: number }>,
    detail: Record<string, ShotDetail>,
    j: StoryboardJobState | null,
  ) => storyboardRows(board([shot({ id: "s1", startWord: 0, endWord: 1, ...over })]), words, timeOf, drawn, detail, j)[0]!;
  const running = job({ shots: ["s1"], current: "s1" });

  it("dropped beats a running job and an approval", () => {
    expect(one({ kept: false, approval }, { s1: { draft: 1, versions: 1 } }, {}, running).state).toBe("dropped");
  });

  it("cut away beats a running job, and an approved shot whose words are all cut reads cut away", () => {
    const r = storyboardRows(
      board([shot({ id: "s1", startWord: 4, endWord: 5, approval })]),
      words,
      timeOf,
      { s1: { draft: 1, versions: 1 } },
      { s1: detailOf([[1, true]], 1) },
      running,
    )[0]!;
    expect(r.state).toBe("cut away");
  });

  it("drawing: the job's current shot, and a shot of the job not done yet, even when approved", () => {
    expect(one({ approval }, { s1: { draft: 1, versions: 1 } }, {}, running).state).toBe("drawing");
    const queued = job({ shots: ["s0", "s1"], current: "s0" });
    expect(one({}, {}, {}, queued).state).toBe("drawing");
    // Done already: no longer drawing, whatever the job does next.
    const past = job({ shots: ["s1", "s2"], current: "s2", done: [{ id: "s1", ok: true }] });
    expect(one({}, { s1: { draft: 1, versions: 1 } }, {}, past).state).toBe("drawn");
  });

  it("in the video: an approved shot, carrying its draft", () => {
    const r = one({ approval }, { s1: { draft: 2, versions: 2 } }, { s1: detailOf([[1, true], [2, true]], 2) }, null);
    expect(r.state).toBe("in the video");
    expect(r.draft).toBe(2);
  });

  it("failed: no draft and the newest version failed", () => {
    const r = one({}, { s1: { draft: null, versions: 1 } }, { s1: detailOf([[1, false]], null) }, null);
    expect(r.state).toBe("failed");
  });

  it("a failed redraw beside a draft is still drawn: the draft is what the author looks at", () => {
    const r = one({}, { s1: { draft: 1, versions: 2 } }, { s1: detailOf([[1, true], [2, false]], 1) }, null);
    expect(r.state).toBe("drawn");
  });

  it("drawn: a draft, no job and no approval", () => {
    const r = one({}, { s1: { draft: 1, versions: 1 } }, { s1: detailOf([[1, true]], 1) }, null);
    expect(r.state).toBe("drawn");
    expect(r.draft).toBe(1);
  });

  it("planned: nothing drawn, and a job about other shots does not change that", () => {
    expect(one({}, {}, {}, null).state).toBe("planned");
    // A job that is about other shots does not touch this one.
    expect(one({}, {}, {}, job({ shots: ["s9"], current: "s9" })).state).toBe("planned");
    // A plan's unit is named "plan"; a shot of that id is not being drawn (§169).
    const r = storyboardRows(board([shot({ id: "plan", startWord: 0, endWord: 1 })]), words, timeOf, {}, {}, job({ kind: "plan", shots: ["plan"], current: "plan" }))[0]!;
    expect(r.state).toBe("planned");
  });
});

describe("draftIsStale", () => {
  it("is true when the draft was drawn from another idea (design §10 'Draw again')", () => {
    expect(draftIsStale({ idea: "new idea" }, detailOf([[1, true]], 1, "old idea"))).toBe(true);
  });

  it("is false for a draft of the shot's own idea, no draft, or no history", () => {
    expect(draftIsStale({ idea: "same" }, detailOf([[1, true]], 1, "same"))).toBe(false);
    expect(draftIsStale({ idea: "x" }, detailOf([[1, false]], null, null))).toBe(false);
    expect(draftIsStale({ idea: "x" }, null)).toBe(false);
  });
});

describe("jobLine", () => {
  it("names the shot, its place in the job and the calls so far", () => {
    expect(jobLine(job({ shots: ["s1", "s3", "s4", "s5", "s6"], current: "s3", calls: 4 }))).toBe(
      "Drawing s3 (2 of 5) · 4 calls",
    );
    expect(jobLine(job({ kind: "redraw", shots: ["s2"], current: "s2", calls: 1 }))).toBe("Redrawing s2 (1 of 1) · 1 call");
  });

  it("says the job is stopping after the shot it is on", () => {
    expect(jobLine(job({ shots: ["s1", "s3"], current: "s3", stopping: true }))).toBe("Stopping after s3…");
  });

  it("a plan says what it is and the calls, never a shot or a place: it is one call (§169)", () => {
    const plan = job({ kind: "plan", shots: ["plan"], current: "plan", calls: 1 });
    expect(jobLine(plan)).toBe("Planning again (one LLM call) · 1 call");
    // After the call, while the usage is appended, the line does not change.
    expect(jobLine({ ...plan, current: null, done: [{ id: "plan", ok: true }] })).toBe("Planning again (one LLM call) · 1 call");
    expect(jobLine({ ...plan, calls: 0 })).toBe("Planning again (one LLM call) · 0 calls");
  });

  it("is null with no job", () => {
    expect(jobLine(null)).toBeNull();
  });
});

describe("storyboardBusyTitle", () => {
  it("offers Cancel for a job that can be stopped", () => {
    expect(storyboardBusyTitle(job({ shots: ["s1"], current: "s1", calls: 1 }))).toBe(
      "Drawing s1 (1 of 1) · 1 call. Open to follow it or cancel",
    );
  });

  it("never offers Cancel for a plan: the server refuses it (§169)", () => {
    expect(storyboardBusyTitle(job({ kind: "plan", shots: ["plan"], current: "plan", calls: 1 }))).toBe(
      "Planning again (one LLM call) · 1 call. Open to follow it",
    );
  });
});

describe("jobResultLine", () => {
  it("counts an all-ok job", () => {
    const done = ["s1", "s2", "s3", "s4", "s5"].map((id) => ({ id, ok: true }));
    expect(jobResultLine(job({ shots: done.map((d) => d.id), done }))).toBe("5 drawn");
  });

  it("names a failed shot and its error", () => {
    const done = [
      { id: "s1", ok: true },
      { id: "s2", ok: false, error: "the code did not type-check" },
      { id: "s3", ok: true },
      { id: "s4", ok: true },
      { id: "s5", ok: true },
    ];
    expect(jobResultLine(job({ shots: done.map((d) => d.id), done }))).toBe("4 drawn, 1 failed: s2: the code did not type-check");
  });

  it("counts a shot the stop interrupted, and one it never started, as stopped, not failed", () => {
    const done = [
      { id: "s1", ok: true },
      { id: "s2", ok: true },
      { id: "s3", ok: true },
      { id: "s4", ok: false, error: "stopped before it finished" },
    ];
    expect(jobResultLine(job({ shots: ["s1", "s2", "s3", "s4"], done, stopping: true }))).toBe("3 drawn, 1 stopped");
    expect(jobResultLine(job({ shots: ["s1", "s2", "s3"], done: [{ id: "s1", ok: true }], stopping: true }))).toBe(
      "1 drawn, 2 stopped",
    );
  });

  it("says what the other kinds of job did", () => {
    const ok = [{ id: "s1", ok: true }];
    expect(jobResultLine(job({ kind: "redraw", done: ok }))).toBe("1 redrawn");
    expect(jobResultLine(job({ kind: "preview", done: ok }))).toBe("1 preview ready");
    expect(jobResultLine(job({ kind: "approve", done: ok }))).toBe("1 approved");
  });

  it("a plan reads planned again, or failed with the error's first line (§169)", () => {
    const plan = (done: { id: string; ok: boolean; error?: string }[]) => job({ kind: "plan", shots: ["plan"], done });
    expect(jobResultLine(plan([{ id: "plan", ok: true }]))).toBe("Planned again");
    expect(jobResultLine(plan([{ id: "plan", ok: false, error: "quota exceeded\nretry later" }]))).toBe(
      "Plan again failed: quota exceeded",
    );
  });

  it("is null with no finished job", () => {
    expect(jobResultLine(null)).toBeNull();
  });
});

describe("jobStartedReplay", () => {
  it("is true for an approve job that ended ok: the server started the sync run", () => {
    expect(jobStartedReplay(job({ kind: "approve", done: [{ id: "s1", ok: true }] }))).toBe(true);
  });

  it("is false for a failed or stopped approve, any other kind, and no job", () => {
    expect(jobStartedReplay(job({ kind: "approve", done: [{ id: "s1", ok: false, error: "x" }] }))).toBe(false);
    expect(jobStartedReplay(job({ kind: "approve", done: [] }))).toBe(false);
    expect(jobStartedReplay(job({ kind: "draw", done: [{ id: "s1", ok: true }] }))).toBe(false);
    // A plan writes storyboard.json, not the video.
    expect(jobStartedReplay(job({ kind: "plan", shots: ["plan"], done: [{ id: "plan", ok: true }] }))).toBe(false);
    expect(jobStartedReplay(null)).toBe(false);
  });
});

describe("approveBlock", () => {
  it("asks for a save first while the document is dirty (Review Focus 4)", () => {
    expect(approveBlock({ dirty: true, draft: 1, jobRunning: false })).toBe("Save first");
  });

  it("refuses with no draft", () => {
    expect(approveBlock({ dirty: false, draft: null, jobRunning: false })).toBe("no draft");
  });

  it("refuses while a job runs", () => {
    expect(approveBlock({ dirty: false, draft: 1, jobRunning: true })).toBe("a job is running");
  });

  it("is null when Approve can run", () => {
    expect(approveBlock({ dirty: false, draft: 1, jobRunning: false })).toBeNull();
  });
});

describe("coverage", () => {
  it("adds the kept rows' lengths over the runtime and ignores dropped and cut-away rows", () => {
    const rows = [
      row({ id: "a", startSec: 0, endSec: 5 }),
      row({ id: "b", startSec: 10, endSec: 15, state: "drawn", draft: 1 }),
      row({ id: "c", startSec: 20, endSec: 30, state: "dropped" }),
      row({ id: "d", startSec: null, endSec: null, state: "cut away" }),
    ];
    expect(coverage(rows, 40)).toBeCloseTo(10 / 40);
  });

  it("counts drawing, failed and in-the-video rows: each is still a shot on screen (§169)", () => {
    const rows = [
      row({ id: "a", startSec: 0, endSec: 2, state: "drawing" }),
      row({ id: "b", startSec: 10, endSec: 12, state: "failed" }),
      row({ id: "c", startSec: 20, endSec: 22, state: "in the video", draft: 1 }),
    ];
    expect(coverage(rows, 40)).toBeCloseTo(6 / 40);
  });

  it("is 0 on a zero runtime rather than infinity", () => {
    expect(coverage([row({})], 0)).toBe(0);
  });

  it("is over the limit only past 60%", () => {
    expect(coverageOverLimit(0.6)).toBe(false);
    expect(coverageOverLimit(0.61)).toBe(true);
  });
});

describe("formatRange", () => {
  it("prints minutes, zero-padded seconds and tenths", () => {
    expect(formatRange(12.4, 18)).toBe("0:12.4 – 0:18.0");
    expect(formatRange(5, 65.25)).toBe("0:05.0 – 1:05.3");
  });

  it("rounds to tenths before splitting minutes, so 59.96 s is 1:00.0", () => {
    expect(formatRange(59.96, 125.04)).toBe("1:00.0 – 2:05.0");
  });
});

describe("rowWarning", () => {
  it("warns about a kept row under 2 s on the live cut", () => {
    expect(rowWarning(row({ startSec: 3, endSec: 4.5 }))).toBe("shorter than 2 s after your cuts");
  });

  it("warns about a kept row over 15 s", () => {
    expect(rowWarning(row({ startSec: 0, endSec: 15.5, state: "drawn", draft: 1 }))).toBe("longer than 15 s");
  });

  it("says nothing for a row from 2 to 15 s, inclusive", () => {
    expect(rowWarning(row({ startSec: 0, endSec: 2 }))).toBeNull();
    expect(rowWarning(row({ startSec: 0, endSec: 15 }))).toBeNull();
  });

  it("says nothing for a dropped or cut-away row: it is not on screen", () => {
    expect(rowWarning(row({ startSec: 0, endSec: 1, state: "dropped" }))).toBeNull();
    expect(rowWarning(row({ startSec: null, endSec: null, state: "cut away" }))).toBeNull();
  });
});

describe("wordIndexAtSourceTime", () => {
  it("matches a start within 1 ms", () => {
    expect(wordIndexAtSourceTime(words, 3.0004)).toBe(3);
  });

  it("returns null for a time no word starts at, never the nearest word", () => {
    expect(wordIndexAtSourceTime(words, 3.01)).toBeNull();
    expect(wordIndexAtSourceTime(words, Number.NaN)).toBeNull();
  });
});

describe("selectionSpan", () => {
  it("maps a selection to its first and last transcript index", () => {
    expect(selectionSpan(words, [{ srcStart: 2 }, { srcStart: 3 }, { srcStart: 4 }])).toEqual({
      startWord: 2,
      endWord: 4,
    });
  });

  it("does not depend on the selection's order", () => {
    expect(selectionSpan(words, [{ srcStart: 7 }, { srcStart: 5 }])).toEqual({ startWord: 5, endWord: 7 });
  });

  it("returns null when any selected word cannot be matched, the middle one included", () => {
    expect(selectionSpan(words, [{ srcStart: 2 }, { srcStart: 2.5 }, { srcStart: 3 }])).toBeNull();
    expect(selectionSpan(words, [{ srcStart: 99 }])).toBeNull();
  });

  it("returns null for an empty selection", () => {
    expect(selectionSpan(words, [])).toBeNull();
  });

  it("takes the last of two words sharing a start for the end of the span", () => {
    const twin = [
      { start: 0, end: 0.5 },
      { start: 1, end: 1 },
      { start: 1, end: 1.4 },
    ];
    expect(selectionSpan(twin, [{ srcStart: 0 }, { srcStart: 1 }])).toEqual({ startWord: 0, endWord: 2 });
  });
});

describe("spanPreview", () => {
  it("shows a short span whole", () => {
    expect(spanPreview(words, { startWord: 1, endWord: 3 })).toBe("w1 w2 w3");
  });

  it("shows the first and last three words of a long span", () => {
    expect(spanPreview(words, { startWord: 0, endWord: 9 })).toBe("w0 w1 w2 … w7 w8 w9");
  });
});

describe("planChangesSummary", () => {
  it("counts the limit changes", () => {
    const c = { index: 0, kind: "moved", reason: "r" };
    expect(planChangesSummary([])).toBe("No planner shot was changed by the limits.");
    expect(planChangesSummary([c])).toBe("1 planner shot was changed by the limits.");
    expect(planChangesSummary([c, c, c])).toBe("3 planner shots were changed by the limits.");
  });
});

describe("storyboardButtonState", () => {
  const sb = board([shot({ id: "s1", startWord: 0, endWord: 1 })]);

  it("shows the button when the project has a storyboard", () => {
    expect(storyboardButtonState(200, { storyboard: sb, drawn: {} })).toEqual({ kind: "shown" });
  });

  it("hides it when there is no storyboard file", () => {
    expect(storyboardButtonState(200, { storyboard: null, drawn: {} })).toEqual({ kind: "hidden" });
  });

  it("hides it with no project open (409) or a body it cannot read", () => {
    expect(storyboardButtonState(409, { error: "no workdir open" })).toEqual({ kind: "hidden" });
    expect(storyboardButtonState(200, null)).toEqual({ kind: "hidden" });
  });

  it("keeps it, marked, when storyboard.json is broken (500), with the server's message", () => {
    expect(storyboardButtonState(500, { error: "storyboard.json: shots.0.idea: too long" })).toEqual({
      kind: "error",
      message: "storyboard.json: shots.0.idea: too long",
    });
  });
});

describe("jobWatchStep: App's watcher reports a job's end once (§169)", () => {
  const running = { job: job({ kind: "approve" }), last: null };
  const ended = { job: null, last: job({ kind: "approve", done: [{ id: "s1", ok: true }] }) };

  it("arms on a running job and reports the end on the first look after it", () => {
    const a = jobWatchStep(false, running);
    expect(a).toEqual({ armed: true, ended: false });
    const b = jobWatchStep(a.armed, ended);
    expect(b).toEqual({ armed: false, ended: true });
    expect(jobWatchStep(b.armed, ended)).toEqual({ armed: false, ended: false });
  });

  it("reports the end of a job it was told started, even when it never saw it running", () => {
    expect(jobWatchStep(true, ended)).toEqual({ armed: false, ended: true });
  });

  it("an old finished job read at page load is not an end: nothing was being followed", () => {
    expect(jobWatchStep(false, ended)).toEqual({ armed: false, ended: false });
  });
});
