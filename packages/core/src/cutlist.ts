import type { Analysis, CleanupLevel, RemovalReason, Segment, Transcript } from "./schema";

interface LevelPolicy {
  /** Only tighten agreed pauses longer than this (seconds). */
  pauseMin: number;
  /** Resulting gap length after tightening. */
  tightenTo: number;
  removeFillers: boolean;
}

const POLICIES: Record<Exclude<CleanupLevel, "exact">, LevelPolicy> = {
  light: { pauseMin: 1.2, tightenTo: 0.3, removeFillers: false },
  standard: { pauseMin: 0.7, tightenTo: 0.22, removeFillers: true },
  aggressive: { pauseMin: 0.5, tightenTo: 0.18, removeFillers: true },
};

/** Dead air kept before the first word / after the last word. Exported for
 * the clip bound (R19 §93), so a clip boundary breathes like a take boundary. */
export const LEAD_KEEP = 0.25;
export const TAIL_KEEP = 0.35;
/** Removals shorter than this aren't worth a visible cut. */
const MIN_REMOVAL = 0.15;
/** Padding kept between a filler cut and its neighbor words. */
const FILLER_NEIGHBOR_PAD = 0.02;
/**
 * Minimum audio kept at each end of a silence-derived cut, so a word's release
 * and the next word's attack survive a slightly over-eager detector. Pause
 * tightening usually reserves more than this; these are floors, not additions.
 */
const SILENCE_PAD_IN = 0.06;
const SILENCE_PAD_OUT = 0.1;
/** Kept fragments shorter than this (holding no word) are folded into the cut. */
const MIN_KEEP = 0.25;

interface Removal {
  start: number;
  end: number;
  reason: RemovalReason;
  confidence: number;
  /**
   * Acoustic removals sit inside verified silence, so their boundaries may land
   * inside a (stretched) word stamp; transcript-derived ones must not.
   */
  source: "acoustic" | "transcript";
}

export interface BuildCutlistArgs {
  transcript: Transcript;
  analysis: Analysis;
  duration: number;
  level: CleanupLevel;
  /**
   * Spans the speaker marked as bloopers out loud (R27 §122), from
   * `findBloopSpans`. Passed in rather than detected here so this stays a pure
   * function of its arguments — and so `--blooper-marker` is the only thing
   * that can put a `retake` cut in the timeline.
   */
  bloops?: readonly { startWord: number; endWord: number; startSec: number; endSec: number }[];
}

export function buildCutlist({
  transcript,
  analysis,
  duration,
  level,
  bloops,
}: BuildCutlistArgs): Segment[] {
  const keepAll: Segment[] = [{ srcIn: 0, srcOut: duration, kind: "keep" }];
  // `exact` means exact: it is the escape hatch for "touch nothing", and a
  // blooper cut is still a cut. --blooper-marker with --cleanup exact is a
  // contradiction, and the flag the user typed second does not get to win.
  if (level === "exact") return keepAll;
  const policy = POLICIES[level];
  const words = transcript.words;
  const first = words[0];
  const last = words[words.length - 1];
  const fillerIndices = new Set(analysis.fillers.map((f) => f.wordIndex));

  const removals: Removal[] = [];

  // Marked bloopers, injected BEFORE the sort/merge below so they inherit the
  // whole existing machine: merging with the silence that brackets the flub,
  // MIN_KEEP sliver folding, and the partition emit. Source is "acoustic"
  // because the boundaries are word stamps we chose deliberately — the
  // protected-word pass must not push them back off the words they exist to
  // remove.
  for (const b of bloops ?? []) {
    removals.push({
      start: b.startSec,
      end: b.endSec,
      reason: "retake",
      confidence: 1,
      source: "acoustic",
    });
  }

  for (const pause of analysis.cuttable) {
    const isLead = first !== undefined && pause.end <= first.start + 1e-6;
    const isTail = last !== undefined && pause.start >= last.end - 1e-6;
    if (isLead) {
      // Trim dead air before the first word down to LEAD_KEEP (hook starts fast).
      const end = Math.min(pause.end, (first?.start ?? pause.end) - LEAD_KEEP);
      if (end - pause.start >= MIN_REMOVAL) {
        removals.push({ start: pause.start, end, reason: "silence", confidence: 0.95, source: "acoustic" });
      }
    } else if (isTail) {
      const start = Math.max(pause.start, (last?.end ?? pause.start) + TAIL_KEEP);
      if (pause.end - start >= MIN_REMOVAL) {
        removals.push({ start, end: pause.end, reason: "silence", confidence: 0.95, source: "acoustic" });
      }
    } else {
      const pauseDur = pause.end - pause.start;
      if (pauseDur <= policy.pauseMin) continue;
      // Keep 40% of the residual gap after the previous word (trailing energy),
      // 60% before the next (breath pre-roll) — never less than the safety pads.
      const start = pause.start + Math.max(policy.tightenTo * 0.4, SILENCE_PAD_IN);
      const end = pause.end - Math.max(policy.tightenTo * 0.6, SILENCE_PAD_OUT);
      if (end - start >= MIN_REMOVAL) {
        removals.push({
          start,
          end,
          reason: pauseDur > 1.0 ? "silence" : "pause",
          confidence: 0.9,
          source: "acoustic",
        });
      }
    }
  }

  if (policy.removeFillers) {
    for (const f of analysis.fillers) {
      const prev = words[f.wordIndex - 1];
      const next = words[f.wordIndex + 1];
      let start = f.start - 0.04;
      let end = f.end + 0.04;
      if (prev) start = Math.max(start, prev.end + FILLER_NEIGHBOR_PAD);
      if (next) end = Math.min(end, next.start - FILLER_NEIGHBOR_PAD);
      if (end - start >= 0.05) {
        removals.push({ start, end, reason: "filler", confidence: 0.8, source: "transcript" });
      }
    }
  }

  for (const r of removals) {
    r.start = Math.max(0, r.start);
    r.end = Math.min(duration, r.end);
  }
  removals.sort((a, b) => a.start - b.start);

  // A transcript-derived boundary must never land inside a word we intend to
  // keep. Acoustic boundaries are exempt: whisper's `-ml 1` stamps stretch a
  // word's end all the way to the next word's start, so a pause *always* looks
  // like it is "inside" a word — applying this rule to them cancels every cut.
  const protectedWords = words.filter((_, i) => !fillerIndices.has(i));
  for (const r of removals) {
    if (r.source !== "transcript") continue;
    for (const w of protectedWords) {
      if (r.start > w.start && r.start < w.end) r.start = w.end + FILLER_NEIGHBOR_PAD;
      if (r.end > w.start && r.end < w.end) r.end = w.start - FILLER_NEIGHBOR_PAD;
    }
  }

  const hasProtectedWordInside = (start: number, end: number): boolean =>
    protectedWords.some((w) => {
      const mid = (w.start + w.end) / 2;
      return mid > start && mid < end;
    });

  // Merge removals that overlap, or whose in-between keep is a wordless sliver.
  const merged: Removal[] = [];
  for (const r of removals) {
    if (r.end - r.start < 0.05) continue;
    const prev = merged[merged.length - 1];
    if (prev && (r.start <= prev.end + 1e-6 || (r.start - prev.end < MIN_KEEP && !hasProtectedWordInside(prev.end, r.start)))) {
      const prevDur = prev.end - prev.start;
      const curDur = r.end - r.start;
      prev.end = Math.max(prev.end, r.end);
      if (curDur > prevDur) prev.reason = r.reason;
      prev.confidence = Math.min(prev.confidence, r.confidence);
    } else {
      merged.push({ ...r });
    }
  }

  const final = merged.filter((r) => r.end - r.start >= 0.05);

  // Full partition of [0, duration].
  const segments: Segment[] = [];
  let cursor = 0;
  for (const r of final) {
    if (r.start > cursor) segments.push({ srcIn: cursor, srcOut: r.start, kind: "keep" });
    segments.push({ srcIn: r.start, srcOut: r.end, kind: "remove", reason: r.reason, confidence: r.confidence });
    cursor = r.end;
  }
  if (cursor < duration) segments.push({ srcIn: cursor, srcOut: duration, kind: "keep" });

  // Sanity valve: if analysis went haywire and nearly everything vanished, keep the take.
  const kept = segments.filter((s) => s.kind === "keep").reduce((acc, s) => acc + (s.srcOut - s.srcIn), 0);
  if (kept < Math.min(0.5, duration * 0.05)) return keepAll;

  return segments;
}
