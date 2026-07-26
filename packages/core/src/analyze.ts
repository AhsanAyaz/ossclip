import { run } from "./exec.js";
import type { Analysis, Span, Transcript } from "./schema.js";

/**
 * Standalone interjections only. Deliberately excludes "like"/"you know"/"ah"/"oh":
 * without an LLM adjudicating, false positives feel far worse than fillers.
 */
const FILLER_WORDS = new Set(["um", "uh", "uhm", "erm", "er", "hmm", "hm", "mmm", "mm", "mhm", "uh-huh"]);

export function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}-]+$/gu, "");
}

export interface SilenceDetectOptions {
  ffmpegPath: string;
  noiseDb?: number;
  minDuration?: number;
}

/** Acoustic silences via ffmpeg silencedetect (parsed from stderr). */
export async function detectSilences(opts: SilenceDetectOptions, audioPath: string): Promise<Span[]> {
  const noise = opts.noiseDb ?? -35;
  const minDur = opts.minDuration ?? 0.35;
  const { stderr } = await run(
    opts.ffmpegPath,
    ["-i", audioPath, "-af", `silencedetect=noise=${noise}dB:d=${minDur}`, "-f", "null", "-"],
    { allowNonZero: true },
  );
  const silences: Span[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (startMatch) pendingStart = Math.max(0, Number(startMatch[1]));
    const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (endMatch && pendingStart !== null) {
      silences.push({ start: pendingStart, end: Number(endMatch[1]) });
      pendingStart = null;
    }
  }
  if (pendingStart !== null) silences.push({ start: pendingStart, end: Number.POSITIVE_INFINITY });
  return silences;
}

function intersect(a: Span, b: Span): Span | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

/**
 * Fuse transcript + acoustics. A pause is only "agreed" (safe to tighten) when
 * a transcript gap and an acoustic silence overlap — either signal alone
 * misfires (whisper hallucinates gaps; silencedetect misses breathy noise).
 */
export function analyze(transcript: Transcript, silences: Span[], duration: number): Analysis {
  const words = transcript.words;
  const gaps: Span[] = [];
  if (words.length > 0) {
    const first = words[0]!;
    const last = words[words.length - 1]!;
    if (first.start > 0) gaps.push({ start: 0, end: first.start });
    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i]!;
      const b = words[i + 1]!;
      if (b.start > a.end) gaps.push({ start: a.end, end: b.start });
    }
    if (duration > last.end) gaps.push({ start: last.end, end: duration });
  } else {
    gaps.push({ start: 0, end: duration });
  }

  const bounded = silences.map((s) => ({ start: s.start, end: Math.min(s.end, duration) }));
  const agreedPauses: Span[] = [];
  for (const gap of gaps) {
    for (const sil of bounded) {
      const overlap = intersect(gap, sil);
      if (overlap && overlap.end - overlap.start >= 0.1) agreedPauses.push(overlap);
    }
  }
  agreedPauses.sort((a, b) => a.start - b.start);

  const fillers = words.flatMap((w, wordIndex) => {
    const norm = normalizeToken(w.text);
    return FILLER_WORDS.has(norm) ? [{ wordIndex, text: w.text, start: w.start, end: w.end }] : [];
  });

  return { silences: bounded, gaps, agreedPauses, fillers };
}
