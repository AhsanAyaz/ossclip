import type { Analysis, CleanupLevel, RemovalReason, Segment, Transcript } from "./schema";

interface LevelPolicy {
  /** Only tighten agreed pauses longer than this (seconds). */
  pauseMin: number;
  /** Resulting gap length after tightening. */
  tightenTo: number;
  removeFillers: boolean;
  /**
   * Run-up kept before the first word and after the last (R27 §127).
   *
   * Level-dependent, because "how hard should I cut" plainly covers the ends
   * too, and a fixed 0.25/0.35 was the one thing `--cleanup aggressive` could
   * not tighten. On a short that LOOPS, a third of a second of the speaker
   * sitting there after the last word is a visible dead beat every time the
   * video repeats — the reason this surfaced on a real render.
   */
  leadKeep: number;
  tailKeep: number;
}

const POLICIES: Record<Exclude<CleanupLevel, "exact">, LevelPolicy> = {
  light: { pauseMin: 1.2, tightenTo: 0.3, removeFillers: false, leadKeep: 0.35, tailKeep: 0.45 },
  standard: { pauseMin: 0.7, tightenTo: 0.22, removeFillers: true, leadKeep: 0.25, tailKeep: 0.35 },
  aggressive: { pauseMin: 0.5, tightenTo: 0.18, removeFillers: true, leadKeep: 0.12, tailKeep: 0.15 },
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
   * function of its arguments.
   */
  bloops?: readonly { startWord: number; endWord: number; startSec: number; endSec: number }[];
  /**
   * Spans `findRetakeGroups` (R27 §127) elected to cut — the deterministic
   * "keep only the last complete take" detector for the flub the speaker did
   * NOT mark. Also a `reason: "retake"` cut, and also passed in rather than
   * detected here, for the same purity reason as `bloops`: `buildCutlist`
   * still has no judgement of its own about what a bad take looks like, it
   * just folds whichever spans two independent detectors handed it into the
   * one partition.
   */
  retakes?: readonly { startWord: number; endWord: number; startSec: number; endSec: number }[];
}

export function buildCutlist({
  transcript,
  analysis,
  duration,
  level,
  bloops,
  retakes,
}: BuildCutlistArgs): Segment[] {
  const keepAll: Segment[] = [{ srcIn: 0, srcOut: duration, kind: "keep" }];
  // `exact` means exact: it is the escape hatch for "touch nothing", and a
  // blooper or retake cut is still a cut. --blooper-marker or
  // --collapse-retakes with --cleanup exact is a contradiction, and the flag
  // the user typed second does not get to win.
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

  // Same injection, same reason, lower confidence (R27 §127): a marker is the
  // speaker asserting "this attempt is bad" — confidence 1. A retake group is
  // this codebase inferring it from token similarity and the hallucination
  // guard, so it earns 0.9, not 1 — the report and any future confidence-
  // gated behavior can tell a supplied fact from an inferred one.
  for (const r of retakes ?? []) {
    removals.push({
      start: r.startSec,
      end: r.endSec,
      reason: "retake",
      confidence: 0.9,
      source: "acoustic",
    });
  }

  for (const pause of analysis.cuttable) {
    // Lead and tail are decided by the SILENCE's position in the file, not by
    // comparing it to a word stamp (R27 §127). Whisper's `-ml 1` stamps stretch
    // to fill gaps: on a real take the first word was stamped 0.00–0.53 over
    // silence that plainly starts at 0.00, so `pause.end <= first.start` was
    // false and the opening dead air fell through to the interior rule — where
    // it was under `pauseMin` and survived. The tail failed the same way, by a
    // 0.07s overlap, leaving the speaker on screen looking down after the last
    // word. Dead air touching either end of the file IS lead/tail, whatever the
    // recognizer claims about where words begin.
    const isLead = pause.start <= 1e-6;
    const isTail = pause.end >= duration - 1e-6;
    if (isLead) {
      // Keep LEAD_KEEP of run-up before speech starts (hook starts fast).
      // Measured back from the END of the silence — where speech actually
      // begins — rather than from a word stamp that may cover the silence.
      const speechStarts = first !== undefined ? Math.max(pause.end, first.start) : pause.end;
      const end = Math.min(pause.end, speechStarts - policy.leadKeep);
      if (end - pause.start >= MIN_REMOVAL) {
        removals.push({ start: pause.start, end, reason: "silence", confidence: 0.95, source: "acoustic" });
      }
    } else if (isTail) {
      // Same, mirrored: the take ends when the speech does, so keep TAIL_KEEP
      // past the last word and drop everything after — including the pause the
      // recognizer's final stamp bled into.
      const speechEnds = last !== undefined ? Math.min(pause.start, last.end) : pause.start;
      const start = Math.max(pause.start, speechEnds + policy.tailKeep);
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
  //
  // Fillers are excluded here ONLY when `policy.removeFillers` says they're
  // actually being removed (fix wave final review, findings §124's
  // follow-up): this same `protectedWords` list also feeds
  // `hasProtectedWordInside` below, which Task 6 widened to fold a wordless
  // keep-gap up to `policy.pauseMin` (1.2s at light). Excluding fillers
  // unconditionally meant a lone "um" sitting in a gap between two silence
  // removals read as "wordless" even at `light`, where `removeFillers` is
  // false and the filler was never scheduled for removal at all — so the
  // fold silently ate it, cutting a word `light`'s own contract promises to
  // keep. The transcript-boundary loop right below is unaffected: it only
  // ever runs for `source === "transcript"` removals, which only exist when
  // `policy.removeFillers` created them (the `if (policy.removeFillers)`
  // block above) — so at `light`, that loop already sees zero such removals
  // and this widened list changes nothing for it, verified by reading rather
  // than assumed.
  const protectedWords = words.filter((_, i) => !policy.removeFillers || !fillerIndices.has(i));
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

  // Merge removals that overlap, or whose in-between keep is a wordless
  // sliver — folded in regardless of length, not just when it's already
  // under MIN_KEEP. A 0.37s wordless gap between two `silence` removals
  // shipped in a real cleanup run because the old condition ANDed the
  // wordless check to the length check, so `hasProtectedWordInside` was only
  // ever asked once the gap was already short — a wordless gap that cleared
  // MIN_KEEP was never asked at all (findings §124). MIN_KEEP's own comment
  // already says wordless fragments fold; this makes the code do it.
  //
  // The fold is capped at `policy.pauseMin`, not left unbounded — folds any
  // wordless gap UP TO pauseMin, refuses anything past it. The cap isn't
  // about protecting short gaps; it's about what a gap LONGER than pauseMin
  // sitting between two removals implies. The interior-pause branch above
  // already generates its own removal for every genuinely silent stretch
  // longer than pauseMin (`pauseDur <= policy.pauseMin` is the only case it
  // skips) — so if a wordless-per-transcript gap that long survives here
  // as bare space between two OTHER removals, the acoustic detector looked
  // at it and did NOT call it silence. That's a live-audio signal the
  // transcript can't see (a breath, laughter, room action, b-roll audio)
  // being kept safe from a rule that only knows "the transcript found no
  // words." A gap AT OR UNDER pauseMin, by contrast, is exactly the field
  // bug's shape (0.37s, standard's 0.7s pauseMin): debris left over once
  // both its neighbors are already cut, not a stretch the detector had any
  // chance to flag on its own. `Math.max` with MIN_KEEP is defensive, not
  // load-bearing: every current pauseMin already exceeds MIN_KEEP.
  const merged: Removal[] = [];
  for (const r of removals) {
    if (r.end - r.start < 0.05) continue;
    const prev = merged[merged.length - 1];
    const gap = prev ? r.start - prev.end : Number.POSITIVE_INFINITY;
    const overlapping = prev !== undefined && gap <= 1e-6;
    const wordless = prev !== undefined && !hasProtectedWordInside(prev.end, r.start);
    const foldableGap = wordless && gap <= Math.max(MIN_KEEP, policy.pauseMin);
    if (prev && (overlapping || foldableGap)) {
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
