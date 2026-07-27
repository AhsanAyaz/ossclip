import { run } from "./exec";
import type { Analysis, Span, Transcript } from "./schema";

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

export interface LevelStats {
  /** Noise floor — 10th percentile of per-window RMS, dBFS. */
  floorDb: number;
  /** Speech level — 90th percentile of per-window RMS, dBFS. */
  speechDb: number;
  /** Silence threshold derived from the two, dBFS. */
  thresholdDb: number;
  /** Per-window RMS in dBFS, in order. */
  windowsDb: number[];
  /** Window length, seconds. */
  windowSec: number;
}

/** Window length used for level measurement, seconds. */
const WINDOW_SEC = 0.1;

/**
 * Typical level of a dB series — the MEDIAN window, not an energy average.
 * Energy averaging is peak-dominated: one speech window straddling the edge of
 * a 3 s silence drags its measured level from −51 dB to −26 dB and the region
 * stops looking like dead air. The median ignores that single window.
 */
export function typicalLevelDb(windowsDb: readonly number[]): number {
  if (windowsDb.length === 0) return Number.NEGATIVE_INFINITY;
  const sorted = [...windowsDb].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

/** Typical level of [start, end) from a per-window dB series. */
export function regionLevelDb(
  windowsDb: readonly number[],
  windowSec: number,
  start: number,
  end: number,
): number {
  const lo = Math.max(0, Math.floor(start / windowSec));
  const hi = Math.min(windowsDb.length, Math.ceil(end / windowSec));
  return typicalLevelDb(windowsDb.slice(lo, hi));
}

/** Widest and narrowest silence thresholds we'll ever derive, dBFS. */
const THRESHOLD_FLOOR = -40;
const THRESHOLD_CEIL = -20;
/**
 * How far below the speech level the threshold sits.
 *
 * Anchored to speech, NOT to the noise floor: a "silent" room is only quiet on
 * average. Measured room tone in real footage averaged −49 dB but peaked at
 * −28 dB, and silencedetect needs a *continuous* run below the threshold — so
 * anything under about −27 dB broke a 3 s pause into 0.4 s fragments and the
 * pause was never cut. The mean tells you nothing; the peaks decide.
 */
const SPEECH_DROP = 12;
/** Never put the threshold within this much of the measured noise floor… */
const FLOOR_HEADROOM = 6;
/** …nor this close to the speech level, or speech itself reads as silence. */
const SPEECH_HEADROOM = 8;

export function deriveThreshold(floorDb: number, speechDb: number): number {
  const bounded = Math.min(Math.max(speechDb - SPEECH_DROP, THRESHOLD_FLOOR), THRESHOLD_CEIL);
  const lo = floorDb + FLOOR_HEADROOM;
  const hi = speechDb - SPEECH_HEADROOM;
  // Material with no dynamic range at all (near-silent or clipped throughout)
  // leaves no valid window — the midpoint is the least-wrong answer.
  if (lo > hi) return (floorDb + speechDb) / 2;
  return Math.min(Math.max(bounded, lo), hi);
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
}

/**
 * Measure the take's own noise floor and speech level, so the silence
 * threshold tracks the recording instead of a hardcoded dB value. A hot
 * lav mic and a quiet room condenser have floors 25 dB apart; one fixed
 * threshold silently no-ops on the loud one.
 */
export async function measureLevels(opts: { ffmpegPath: string }, audioPath: string): Promise<LevelStats> {
  // 1600 samples @ 16 kHz (the ASR wav rate) = 100 ms windows.
  const { stdout, stderr } = await run(
    opts.ffmpegPath,
    [
      "-hide_banner", "-nostats", "-i", audioPath,
      "-af",
      "asetnsamples=n=1600,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f", "null", "-",
    ],
    { allowNonZero: true },
  );
  const values: number[] = [];
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-?inf)/);
    if (!m) continue;
    const v = Number(m[1]);
    if (Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) {
    // No usable measurement — fall back to the old fixed threshold.
    return { floorDb: -60, speechDb: -20, thresholdDb: -35, windowsDb: [], windowSec: WINDOW_SEC };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const floorDb = percentile(sorted, 0.1);
  const speechDb = percentile(sorted, 0.9);
  return {
    floorDb,
    speechDb,
    thresholdDb: deriveThreshold(floorDb, speechDb),
    windowsDb: values,
    windowSec: WINDOW_SEC,
  };
}

/** Acoustic silences via ffmpeg silencedetect (parsed from stderr). */
export async function detectSilences(opts: SilenceDetectOptions, audioPath: string): Promise<Span[]> {
  const noise = opts.noiseDb ?? (await measureLevels(opts, audioPath)).thresholdDb;
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

/** A cuttable region shorter than this isn't worth considering. */
const MIN_CUTTABLE = 0.1;
/**
 * Mean level this far below speech is dead air, whatever the transcript claims.
 * Quiet or off-mic speech still averages nearer the speech level than this.
 */
const DEAD_AIR_DROP = 25;

/** Subtract `blockers` from `span`, returning the surviving pieces. */
export function subtractSpans(span: Span, blockers: readonly Span[]): Span[] {
  let pieces: Span[] = [{ ...span }];
  for (const b of blockers) {
    const next: Span[] = [];
    for (const p of pieces) {
      if (b.end <= p.start || b.start >= p.end) {
        next.push(p);
        continue;
      }
      if (b.start > p.start) next.push({ start: p.start, end: b.start });
      if (b.end < p.end) next.push({ start: b.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

/**
 * Acoustics decide what is cuttable; the transcript only vetoes.
 *
 * The previous rule ("cut only where a transcript gap and a silence agree")
 * cannot fire on real whisper output: with `-ml 1` the word stamps are
 * contiguous — each word's end IS the next word's start — so pauses are
 * absorbed into word durations and the transcript reports no gap to agree
 * with. Measured on a real 68 s take: 164/167 word boundaries contiguous,
 * every detected silence landing *inside* a word, zero agreed pauses, zero
 * cuts.
 *
 * Inverted rule: a region below the silence threshold contains no audible
 * speech by definition, so it is cuttable. The transcript vetoes only the
 * pathological case where a whole non-filler word is claimed to live inside
 * that silence — a real signal conflict, where the safe move is to keep it.
 *
 * That veto is itself overridden when the region's MEAN energy is far below
 * the speech level (`levels` supplied): whisper stamps words over dead air
 * often enough that trusting it there would cancel obvious lead-in trims,
 * while genuinely quiet speech still averages well above room tone.
 */
export function analyze(
  transcript: Transcript,
  silences: Span[],
  duration: number,
  levels?: Pick<LevelStats, "windowsDb" | "windowSec" | "speechDb">,
): Analysis {
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

  const fillers = words.flatMap((w, wordIndex) => {
    const norm = normalizeToken(w.text);
    return FILLER_WORDS.has(norm) ? [{ wordIndex, text: w.text, start: w.start, end: w.end }] : [];
  });
  const fillerIndices = new Set(fillers.map((f) => f.wordIndex));

  const cuttable: Span[] = [];
  for (const sil of bounded) {
    if (sil.end - sil.start < MIN_CUTTABLE) continue;
    // Veto: a non-filler word wholly inside the silence means the two signals
    // disagree about where speech is. Keep that word and cut around it…
    let conflicts = words.filter(
      (w, i) => !fillerIndices.has(i) && w.start >= sil.start && w.end <= sil.end && w.end > w.start,
    );
    // …unless the region is measurably dead air, in which case the transcript
    // is the signal that's wrong.
    if (conflicts.length > 0 && levels && levels.windowsDb.length > 0) {
      const meanDb = regionLevelDb(levels.windowsDb, levels.windowSec, sil.start, sil.end);
      if (meanDb <= levels.speechDb - DEAD_AIR_DROP) conflicts = [];
    }
    for (const piece of subtractSpans(sil, conflicts)) {
      if (piece.end - piece.start >= MIN_CUTTABLE) cuttable.push(piece);
    }
  }
  cuttable.sort((a, b) => a.start - b.start);

  return { silences: bounded, gaps, cuttable, breaths: detectBreaths(levels, duration), fillers };
}

/** A dip must last at least this long to be a breath and not a plosive gap. */
const MIN_BREATH_SEC = 0.12;
/** Dips this quiet are pauses; the silencedetect threshold is stricter still. */
const BREATH_DROP = 10;

/**
 * Sub-silence pauses — where a speaker draws breath between phrases.
 *
 * `silences` cannot serve this purpose: `silencedetect` runs with a 0.35 s
 * minimum (see `detectSilences`), while real inter-phrase breaths are
 * 120–300 ms. On the reference take that floor left 8 silences across 68 s,
 * which is why anything driven off them degenerates to uniform pacing.
 *
 * The 100 ms RMS series is already measured for threshold derivation, so this
 * costs no extra ffmpeg pass: a run of windows sitting `BREATH_DROP` below
 * the take's own speech level is a pause, whatever the transcript claims.
 * These are phrase boundaries the word stamps cannot provide — whisper `-ml 1`
 * emits contiguous stamps, so inter-word gaps do not exist (PHASE0 "Signal
 * fusion", FINDINGS §18).
 */
export function detectBreaths(
  levels: Pick<LevelStats, "windowsDb" | "windowSec" | "speechDb"> | undefined,
  duration: number,
): Span[] {
  if (!levels || levels.windowsDb.length === 0) return [];
  const threshold = levels.speechDb - BREATH_DROP;
  const breaths: Span[] = [];
  let runStart: number | null = null;
  for (let i = 0; i <= levels.windowsDb.length; i++) {
    const quiet = i < levels.windowsDb.length && levels.windowsDb[i]! <= threshold;
    if (quiet && runStart === null) runStart = i;
    if (!quiet && runStart !== null) {
      const start = runStart * levels.windowSec;
      const end = Math.min(i * levels.windowSec, duration);
      if (end - start >= MIN_BREATH_SEC) breaths.push({ start, end });
      runStart = null;
    }
  }
  return breaths;
}
