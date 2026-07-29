import { z } from "zod/v4";
import type { Segment, Transcript } from "./schema";
import { LEAD_KEEP, TAIL_KEEP } from "./cutlist";
import type { ClipHighlight, Moment } from "./producer/beats";

/**
 * `--clip` highlight selection (R19 §93): choose ONE window of a long take
 * and produce only it. Everything here is deliberately pure and runs BEFORE
 * analyze/cut/captions/scenes — the transcript is sliced to the window and
 * the existing pipeline runs unchanged on the slice (§93.1). Nothing in this
 * module (or because of it) touches captions or the time map; if that ever
 * seems necessary, selection has been put in the wrong place.
 */

/** The resolved clip window. Word indices are in the index space of the
 * transcript selection ran against (the repaired, PRE-slice transcript);
 * seconds are source time and remain meaningful after slicing. */
export const ClipWindowSchema = z.object({
  startWord: z.number().int().nonnegative(),
  endWord: z.number().int().nonnegative(),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  /** The producer's one-line account of why THIS window (§93h). */
  reason: z.string(),
});
export type ClipWindow = z.infer<typeof ClipWindowSchema>;

/** §93e: a window shorter than half the ask is a selection failure, not a clip. */
export const CLIP_MIN_FRACTION = 0.5;
/** Author decision (plan 2026-08-03): sentence snapping within ±20% of target. */
export const CLIP_SNAP_TOLERANCE = 0.2;

/** Word that closes a sentence — ASR punctuation rides on the word text. */
const SENTENCE_END = /[.!?…]["'")\]»]*$/u;

const isSentenceEnd = (t: Transcript, i: number): boolean =>
  SENTENCE_END.test(t.words[i]?.text ?? "");
const isSentenceStart = (t: Transcript, i: number): boolean =>
  i === 0 || isSentenceEnd(t, i - 1);

const durSec = (t: Transcript, start: number, end: number): number =>
  t.words[end]!.end - t.words[start]!.start;

export interface ResolvedClip {
  window: ClipWindow;
  /** What resolution changed about the model's raw pick — for the console. */
  notes: string[];
}

/**
 * Validate and snap the model's highlight (§93e + the snapping decision).
 * The indices are untrusted LLM output: clamped, order-checked, snapped to
 * sentence boundaries within ±20% of the target, trimmed if over-long, and
 * REFUSED (thrown, with the reason) when what remains is under half the
 * target — never a silent fallback to the full take, which would quietly
 * "clip" a 20-minute video to 20 minutes.
 */
export function resolveClipWindow(
  transcript: Transcript,
  highlight: ClipHighlight | undefined,
  targetSec: number,
): ResolvedClip {
  const words = transcript.words;
  if (words.length === 0) throw new Error("--clip: transcript has no words to select from");
  if (!highlight) {
    throw new Error(
      "--clip: the producer returned no highlight window — cannot select a clip. " +
        "Re-run, or try a different --llm/--llm-model.",
    );
  }
  const notes: string[] = [];
  const maxIndex = words.length - 1;
  if (highlight.startWord > maxIndex) {
    throw new Error(
      `--clip: highlight starts at word ${highlight.startWord}, beyond the transcript (${maxIndex})`,
    );
  }
  let start = highlight.startWord;
  let end = Math.min(highlight.endWord, maxIndex);
  if (end !== highlight.endWord) notes.push(`endWord clamped ${highlight.endWord} → ${end}`);
  if (end <= start) {
    throw new Error(`--clip: highlight window is empty or inverted (words ${start}–${end})`);
  }

  const tol = CLIP_SNAP_TOLERANCE * targetSec;
  const cap = targetSec * (1 + CLIP_SNAP_TOLERANCE);

  // Snap the START to the nearest sentence start within tolerance — a clip
  // that opens mid-sentence reads as broken regardless of the pick's quality.
  {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i <= maxIndex; i++) {
      if (!isSentenceStart(transcript, i)) continue;
      const dist = Math.abs(words[i]!.start - words[start]!.start);
      if (dist <= tol && dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    }
    if (best !== -1 && best !== start) {
      notes.push(`start snapped to sentence boundary: word ${start} → ${best}`);
      start = best;
    }
  }
  if (end <= start) end = Math.min(start + 1, maxIndex);

  // The END: snap to a sentence end. An over-long window is trimmed to the
  // sentence end nearest the target (the hook lives at the start — always
  // trim the tail); an in-tolerance one snaps to the nearest boundary.
  const sentenceEnds: number[] = [];
  for (let i = start; i <= maxIndex; i++) if (isSentenceEnd(transcript, i)) sentenceEnds.push(i);
  if (durSec(transcript, start, end) > cap) {
    let best = -1;
    let bestDist = Infinity;
    for (const e of sentenceEnds) {
      if (e <= start || e > end) continue;
      const d = durSec(transcript, start, e);
      if (d > cap) continue;
      const dist = Math.abs(d - targetSec);
      if (dist < bestDist) {
        best = e;
        bestDist = dist;
      }
    }
    if (best === -1) {
      // No sentence boundary under the cap — trim at a word boundary instead.
      let e = end;
      while (e > start && durSec(transcript, start, e) > cap) e--;
      best = Math.max(e, start + 1);
    }
    notes.push(
      `window trimmed ${durSec(transcript, start, end).toFixed(1)}s → ` +
        `${durSec(transcript, start, best).toFixed(1)}s (target ${targetSec}s +${(
          CLIP_SNAP_TOLERANCE * 100
        ).toFixed(0)}%)`,
    );
    end = best;
  } else if (!isSentenceEnd(transcript, end)) {
    let best = -1;
    let bestDist = Infinity;
    for (const e of sentenceEnds) {
      if (e <= start) continue;
      const dist = Math.abs(words[e]!.end - words[end]!.end);
      if (dist <= tol && dist < bestDist) {
        best = e;
        bestDist = dist;
      }
    }
    if (best !== -1 && best !== end) {
      notes.push(`end snapped to sentence boundary: word ${end} → ${best}`);
      end = best;
    }
  }

  const dur = durSec(transcript, start, end);
  if (dur < CLIP_MIN_FRACTION * targetSec) {
    throw new Error(
      `--clip: the selected window is ${dur.toFixed(1)}s — under half the ${targetSec}s target. ` +
        `Refusing to produce it (the take may not contain ${targetSec}s of connected material; ` +
        `try a shorter --clip, or run without it).`,
    );
  }

  return {
    window: {
      startWord: start,
      endWord: end,
      startSec: words[start]!.start,
      endSec: words[end]!.end,
      reason: highlight.reason,
    },
    notes,
  };
}

/**
 * A pinned window from `command.json` (§93g): "start:end" word indices.
 * The editor's Render replays the recorded argv, and replay must reproduce
 * the SAME window with zero LLM calls — so the pin is authoritative and is
 * validated but never re-snapped (it was snapped when first resolved).
 */
export function parseClipWindowPin(transcript: Transcript, pin: string): ClipWindow {
  const m = /^(\d+):(\d+)$/.exec(pin);
  if (!m) throw new Error(`--clip-window: expected "startWord:endWord", got "${pin}"`);
  const startWord = Number.parseInt(m[1]!, 10);
  const endWord = Number.parseInt(m[2]!, 10);
  const maxIndex = transcript.words.length - 1;
  if (maxIndex < 0) throw new Error("--clip-window: transcript has no words");
  if (startWord > maxIndex || endWord > maxIndex || endWord <= startWord) {
    throw new Error(
      `--clip-window ${pin} does not fit this transcript (${maxIndex + 1} words) — ` +
        `was it recorded against different footage?`,
    );
  }
  return {
    startWord,
    endWord,
    startSec: transcript.words[startWord]!.start,
    endSec: transcript.words[endWord]!.end,
    reason: "pinned window (command.json replay)",
  };
}

/** The transcript, cut down to the window. Source-time stamps are untouched —
 * everything downstream still reasons in source time through the cutlist. */
export function sliceTranscript(transcript: Transcript, window: ClipWindow): Transcript {
  return { ...transcript, words: transcript.words.slice(window.startWord, window.endWord + 1) };
}

/**
 * Re-anchor beat-sheet moments into the sliced index space: moments outside
 * the window drop, partial ones clamp, survivors shift by the window start.
 */
export function sliceMoments(moments: readonly Moment[], window: ClipWindow): Moment[] {
  return moments.flatMap((m) => {
    if (m.endWord < window.startWord || m.startWord > window.endWord) return [];
    return [
      {
        ...m,
        startWord: Math.max(m.startWord, window.startWord) - window.startWord,
        endWord: Math.min(m.endWord, window.endWord) - window.startWord,
      },
    ];
  });
}

/**
 * Slice the RAW transcript by TIME, not by the window's word indices: repairs
 * may merge or split words (`applyRepairs` splices), so raw and repaired
 * index spaces need not line up — but both carry source-time stamps, and the
 * window's seconds are exact. Returns the slice and its offset in the raw
 * index space, for shifting `repairs` alongside.
 */
export function sliceRawTranscript(
  raw: Transcript,
  window: ClipWindow,
): { transcript: Transcript; offset: number } {
  const inWindow = (w: { start: number; end: number }): boolean =>
    w.end > window.startSec && w.start < window.endSec;
  const offset = raw.words.findIndex(inWindow);
  if (offset === -1) return { transcript: { ...raw, words: [] }, offset: 0 };
  const words = raw.words.filter(inWindow);
  return { transcript: { ...raw, words }, offset };
}

/** Keep only repairs that live wholly inside the sliced raw range, shifted
 * into its index space — `production.json` stores raw + repairs as the
 * reproducible pair, and a repair pointing outside the slice breaks that. */
export function sliceRepairs<T extends { startWord: number; endWord: number }>(
  repairs: readonly T[],
  offset: number,
  wordCount: number,
): T[] {
  return repairs
    .filter((r) => r.startWord >= offset && r.endWord < offset + wordCount)
    .map((r) => ({ ...r, startWord: r.startWord - offset, endWord: r.endWord - offset }));
}

/**
 * Bound a cutlist to the window: everything outside becomes a single `clip`
 * removal at each end, everything inside is preserved. The result stays a
 * full partition of [0, duration], so the TimeMap invariant
 * (`outputDuration === Σ kept`) holds by construction. The window is padded
 * by the cutlist's own lead/tail keeps so a clip boundary breathes exactly
 * like a take boundary.
 */
export function boundCutlistToWindow(
  segments: readonly Segment[],
  window: ClipWindow,
  duration: number,
): Segment[] {
  const winIn = Math.max(0, Math.min(window.startSec - LEAD_KEEP, duration));
  const winOut = Math.min(duration, Math.max(window.endSec + TAIL_KEEP, winIn));
  const out: Segment[] = [];
  if (winIn > 0) {
    out.push({ srcIn: 0, srcOut: winIn, kind: "remove", reason: "clip", confidence: 1 });
  }
  for (const s of segments) {
    const srcIn = Math.max(s.srcIn, winIn);
    const srcOut = Math.min(s.srcOut, winOut);
    if (srcOut - srcIn <= 1e-9) continue;
    const prev = out[out.length - 1];
    if (prev && prev.kind === s.kind && prev.reason === s.reason) {
      prev.srcOut = srcOut;
    } else {
      out.push({ ...s, srcIn, srcOut });
    }
  }
  if (winOut < duration) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === "remove" && prev.reason === "clip") {
      prev.srcOut = duration;
    } else {
      out.push({ srcIn: winOut, srcOut: duration, kind: "remove", reason: "clip", confidence: 1 });
    }
  }
  return out;
}

/** m:ss for the console/report — clip windows live in minutes, not seconds. */
export function formatClipTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
