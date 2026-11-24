/**
 * The plan limits (storyboard design §2 "Limits"; §168): the one place a
 * planner's reply is made safe before it becomes rows of the table. The
 * prompt states every limit, but a reply is still free text that happens to
 * parse, so its indices may be cut, reversed or past the end, its shots may
 * overlap, and it may plan more than the runtime can carry. This fixes what
 * it can, drops what it cannot, and reports each change by the shot's index
 * in the reply, so the run can say what happened to what the planner said.
 * It never asks the planner again (design §2).
 *
 * The order is fixed, because each step relies on the one before it:
 *
 * 1. assets: names the author does not have are removed;
 * 2. indices: reversed ones swapped, the span clamped to the transcript;
 * 3. cut snap: start and end move inward to kept words (planning shows cut
 *    words, so a reply may anchor on one, plan Review Focus 1);
 * 4. sort by start word;
 * 5. overlap, then minimum, per shot in start order;
 * 6. maximum;
 * 7. coverage.
 *
 * Pure, and it must not throw on any integer input: it is what stands
 * between an LLM's reply and the author's file.
 */
import { STORYBOARD_COVERAGE, STORYBOARD_MIN_SHOT_SEC, type PlannedShot } from "./record";

export interface LimitContext {
  /** Words in the raw transcript; indices are into it. */
  wordCount: number;
  /** Indices of the words the effective cut removes. */
  cut: ReadonlySet<number>;
  /** A kept word's place on the output clock; null for a cut word. */
  outputTimeOf: (wordIndex: number) => { start: number; end: number } | null;
  outputDurationSec: number;
  maxShotSec: number;
  gapSec: number;
  assetNames: readonly string[];
  /**
   * Word spans already taken by shots that stay (on "Plan again", the
   * protected kept shots, plan Task 1 Step 3). A planned shot is moved off
   * them or dropped; they are never changed, and they count toward coverage.
   */
  blocked: readonly { startWord: number; endWord: number }[];
}

export interface LimitChange {
  /** The shot's index in the array passed in, not in the result. */
  index: number;
  kind: "dropped" | "moved" | "trimmed" | "asset-removed";
  reason: string;
}

/**
 * Float slack for comparisons of summed seconds: 14.9 + 0.05 must not land a
 * hair past a 14.95 boundary and move or drop a shot that sits exactly on it.
 */
const EPS = 1e-6;

interface Span {
  startWord: number;
  endWord: number;
  startSec: number;
  endSec: number;
}

interface Live extends Span {
  index: number;
  shot: PlannedShot;
  assets: string[];
}

const secs = (x: number) => `${Number(x.toFixed(2))} s`;

export function enforcePlanLimits(
  shots: PlannedShot[],
  ctx: LimitContext,
): { shots: PlannedShot[]; changes: LimitChange[] } {
  const changes: LimitChange[] = [];
  const note = (index: number, kind: LimitChange["kind"], reason: string) => changes.push({ index, kind, reason });
  const wordCount = Number.isInteger(ctx.wordCount) && ctx.wordCount > 0 ? ctx.wordCount : 0;
  const isKept = (i: number) => i >= 0 && i < wordCount && !ctx.cut.has(i);
  const gap = Number.isFinite(ctx.gapSec) && ctx.gapSec > 0 ? ctx.gapSec : 0;

  /**
   * A span snapped inward to its first and last kept words, with their
   * times, or why it has none. Shared by planned shots and `blocked`, so a
   * blocked range is measured exactly as a shot on the same words would be.
   */
  const snap = (
    s: number,
    e: number,
  ): { ok: true; span: Span } | { ok: false; reason: string; allCut: boolean } => {
    let a = s;
    while (a <= e && !isKept(a)) a++;
    if (a > e) return { ok: false, reason: "all its words are cut", allCut: true };
    let b = e;
    while (!isKept(b)) b--;
    const ta = ctx.outputTimeOf(a);
    const tb = ctx.outputTimeOf(b);
    // A kept word always has a place on the output clock; when the caller's
    // clock disagrees, a guessed time would put the shot somewhere nobody
    // chose, so the shot goes and the report says why.
    if (ta === null || tb === null) {
      return { ok: false, reason: `kept word ${ta === null ? a : b} has no output time`, allCut: false };
    }
    return { ok: true, span: { startWord: a, endWord: b, startSec: ta.start, endSec: tb.end } };
  };

  // Steps 1 to 3, shot by shot in reply order.
  const live: Live[] = [];
  shots.forEach((shot, index) => {
    const assets: string[] = [];
    for (const name of shot.assets) {
      if (ctx.assetNames.includes(name)) assets.push(name);
      else note(index, "asset-removed", `asset "${name}" is not one of the author's assets`);
    }

    let s = shot.startWord;
    let e = shot.endWord;
    if (!Number.isInteger(s) || !Number.isInteger(e)) {
      note(index, "dropped", "its word indices are not whole numbers");
      return;
    }
    if (s > e) {
      note(index, "moved", `start and end were reversed (${s} and ${e}); swapped`);
      [s, e] = [e, s];
    }
    if (e < 0 || s >= wordCount) {
      note(index, "dropped", `words ${s} to ${e} are outside the transcript (${wordCount} words)`);
      return;
    }
    if (s < 0) {
      note(index, "moved", `start ${s} was before the first word; moved to word 0`);
      s = 0;
    }
    if (e >= wordCount) {
      note(index, "trimmed", `end ${e} was past the last word; trimmed to word ${wordCount - 1}`);
      e = wordCount - 1;
    }

    const snapped = snap(s, e);
    if (!snapped.ok) {
      note(index, "dropped", snapped.allCut ? `all its words are cut (${s} to ${e})` : snapped.reason);
      return;
    }
    const span = snapped.span;
    if (span.startWord !== s) note(index, "moved", `start word ${s} is cut; moved to the next kept word ${span.startWord}`);
    if (span.endWord !== e) note(index, "trimmed", `end word ${e} is cut; trimmed back to kept word ${span.endWord}`);
    live.push({ ...span, index, shot, assets });
  });

  // The blocked ranges on the same clock. One the cut has wholly removed is
  // not on screen, so it neither blocks nor counts toward coverage.
  const blocked: (Span & { label: string })[] = [];
  for (const r of ctx.blocked) {
    let s = Math.min(r.startWord, r.endWord);
    let e = Math.max(r.startWord, r.endWord);
    if (!Number.isInteger(s) || !Number.isInteger(e) || e < 0 || s >= wordCount) continue;
    s = Math.max(0, s);
    e = Math.min(wordCount - 1, e);
    const snapped = snap(s, e);
    if (snapped.ok) blocked.push({ ...snapped.span, label: `a kept shot on words ${r.startWord} to ${r.endWord}` });
  }

  // Step 4. Ties keep reply order, so the planner's first word wins a start.
  live.sort((x, y) => x.startWord - y.startWord || x.index - y.index);

  /** The first kept word after `from`, up to `last`, heard at or after `atSec`. */
  const firstKeptFrom = (from: number, last: number, atSec: number): number | null => {
    for (let w = from + 1; w <= last; w++) {
      if (!isKept(w)) continue;
      const t = ctx.outputTimeOf(w);
      if (t !== null && t.start >= atSec - EPS) return w;
    }
    return null;
  };

  // Step 5. Two spans conflict when they come closer than the gap scenes
  // keep between them (SCENE_GAP_SEC in assembly), from either side: a shot
  // that runs into a blocked range is in its way as much as one that starts
  // inside it. A conflict moves the shot's start past the other span's end
  // plus the gap; only the start moves, the end is the planner's (or the
  // snap's). The minimum is checked right after a shot is placed, so a shot
  // too short to draw never pushes the next one off its words.
  const placed: (Live & { label: string })[] = [];
  for (const w of live) {
    let dropped = false;
    for (;;) {
      const hit = [...blocked, ...placed].find((o) => w.startSec < o.endSec + gap - EPS && o.startSec < w.endSec + gap - EPS);
      if (hit === undefined) break;
      const to = firstKeptFrom(w.startWord, w.endWord, hit.endSec + gap);
      if (to === null) {
        note(w.index, "dropped", `overlapped ${hit.label}; nothing of it is left after it`);
        dropped = true;
        break;
      }
      note(w.index, "moved", `overlapped ${hit.label}; moved to start at word ${to}`);
      w.startWord = to;
      w.startSec = ctx.outputTimeOf(to)!.start;
    }
    if (dropped) continue;
    const len = w.endSec - w.startSec;
    if (len < STORYBOARD_MIN_SHOT_SEC - EPS) {
      note(w.index, "dropped", `${secs(len)} is under the ${STORYBOARD_MIN_SHOT_SEC} s minimum a shot can be drawn at`);
      continue;
    }
    placed.push({ ...w, label: `the shot planned at index ${w.index} (words ${w.startWord} to ${w.endWord})` });
  }

  // Step 6. Trimmed at the end, to a kept word, so the shot still starts on
  // the line its picture belongs to. A trim can leave a shot whose next kept
  // word is far away under the minimum; it is dropped then, since a row that
  // cannot be drawn is the thing the minimum exists to keep out.
  const sized: typeof placed = [];
  for (const w of placed) {
    const len = w.endSec - w.startSec;
    if (len <= ctx.maxShotSec + EPS) {
      sized.push(w);
      continue;
    }
    let to: number | null = null;
    for (let k = w.endWord; k >= w.startWord; k--) {
      if (!isKept(k)) continue;
      const t = ctx.outputTimeOf(k);
      if (t !== null && t.end - w.startSec <= ctx.maxShotSec + EPS) {
        to = k;
        break;
      }
    }
    if (to === null) {
      note(w.index, "dropped", `its first word alone is over the ${secs(ctx.maxShotSec)} maximum`);
      continue;
    }
    w.endWord = to;
    w.endSec = ctx.outputTimeOf(to)!.end;
    note(w.index, "trimmed", `${secs(len)} is over the ${secs(ctx.maxShotSec)} maximum; trimmed to end at word ${to}`);
    const trimmed = w.endSec - w.startSec;
    if (trimmed < STORYBOARD_MIN_SHOT_SEC - EPS) {
      note(w.index, "dropped", `trimmed to ${secs(trimmed)}, under the ${STORYBOARD_MIN_SHOT_SEC} s minimum a shot can be drawn at`);
      continue;
    }
    sized.push(w);
  }

  // Step 7. The blocked ranges are shots already on screen, so they count;
  // they are never the ones dropped, so when they alone are over the limit
  // every planned shot goes. Compared as seconds against the limit rather
  // than as a share, so a zero runtime cannot divide by zero.
  const dur = Number.isFinite(ctx.outputDurationSec) && ctx.outputDurationSec > 0 ? ctx.outputDurationSec : 0;
  const limit = STORYBOARD_COVERAGE * dur;
  const pct = Math.round(STORYBOARD_COVERAGE * 100);
  let covered = [...blocked, ...sized].reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
  const kept = [...sized];
  while (covered > limit + EPS && kept.length > 0) {
    // Highest priority number first (3 is the least important), then the
    // latest start: the end of a video is where a viewer has least to lose.
    let v = 0;
    for (let k = 1; k < kept.length; k++) {
      const a = kept[k]!;
      const b = kept[v]!;
      if (a.shot.priority > b.shot.priority || (a.shot.priority === b.shot.priority && a.startWord >= b.startWord)) v = k;
    }
    const victim = kept.splice(v, 1)[0]!;
    note(
      victim.index,
      "dropped",
      `shots cover ${secs(covered)} of ${secs(dur)}, over the ${pct}% limit; dropped as priority ${victim.shot.priority}, the lowest left, latest first`,
    );
    covered -= victim.endSec - victim.startSec;
  }

  kept.sort((x, y) => x.startWord - y.startWord || x.index - y.index);
  return {
    shots: kept.map((w) => ({ ...w.shot, startWord: w.startWord, endWord: w.endWord, assets: w.assets })),
    changes,
  };
}
