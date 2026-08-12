import type { Transcript, Word } from "./schema";
import { mapFromKeptSpans, type KeptSpan, type TimeMap } from "./timemap";

/**
 * Caption *timing* lives in OUTPUT time: `start`/`end` are what the renderer
 * draws against and they know nothing about cuts. `srcStart` is the deliberate
 * exception (§137) — it is SOURCE time, carried so a re-cut cannot move it.
 * Never read it as an output instant.
 */
export interface CaptionWord {
  text: string;
  start: number;
  end: number;
  /**
   * The word's start in SOURCE seconds (§137). `start`/`end` above are OUTPUT
   * times and a re-cut moves them; this does not, which is what lets a caption
   * edit survive one. The field the edit layer keys on — see
   * `captionKeyFor` in overrides.ts.
   */
  srcStart: number;
}

export interface CaptionLine {
  words: CaptionWord[];
  start: number;
  end: number;
}

/**
 * Fill in `srcStart` for caption lines read back from a `render-props.json`
 * written before the field existed (§137).
 *
 * The type promises `srcStart` on every word, but the on-disk format predates
 * it and there is no schema at that boundary — the editor loads render props
 * as an unvalidated cast — so lines that TYPECHECK as `CaptionLine` can still
 * arrive with the field missing. Without this, every legacy word would key on
 * the same absent value and a retype would anchor to the wrong word: the exact
 * failure the source anchor exists to prevent, arriving silently instead of as
 * a crash.
 *
 * It is recoverable because the same file still carries `spans`: a word's
 * source start is just its output start projected back through the map those
 * spans describe. Pure — the caller owns reading the file.
 */
export function backfillSrcStart(
  lines: readonly CaptionLine[],
  spans: readonly KeptSpan[],
): CaptionLine[] {
  /** The shape a legacy file actually holds, versus the one the type promises. */
  type LegacyWord = Omit<CaptionWord, "srcStart"> & { srcStart?: number };
  const legacy = (line: CaptionLine) => line.words as readonly LegacyWord[];
  // Nothing to recover from a file already written with the field — and an
  // existing `srcStart` is never recomputed, because the map that produced it
  // may not be the one in `spans`.
  if (lines.every((l) => legacy(l).every((w) => w.srcStart !== undefined))) return [...lines];
  const map = mapFromKeptSpans(spans);
  return lines.map((line) => ({
    ...line,
    words: legacy(line).map((w) =>
      w.srcStart === undefined ? { ...w, srcStart: map.toSource(w.start) } : (w as CaptionWord),
    ),
  }));
}

/**
 * Per-LINE direction from the text itself — the first-strong-character
 * heuristic (Unicode UAX #9 rules P2/P3), not the transcript's language
 * code. The Urdu field transcript (2026-08-05) code-switches: lines opening
 * with a Latin loanword ("Fulfillment …") exist alongside pure Urdu lines,
 * and first-strong is the standard resolution for exactly that — the line
 * lays out the way its own leading text reads. Digits and punctuation are
 * bidi-weak/neutral and skipped, so "2026 میں …" still resolves RTL.
 */
const STRONG_RTL = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const STRONG_LTR = /\p{L}/u; // checked AFTER the RTL scripts, which are also \p{L}

export function lineDirection(text: string): "rtl" | "ltr" {
  for (const ch of text) {
    if (STRONG_RTL.test(ch)) return "rtl";
    if (STRONG_LTR.test(ch)) return "ltr";
  }
  return "ltr";
}

export interface CaptionOptions {
  maxWordsPerLine?: number;
  maxLineDuration?: number;
  /** A speech gap longer than this starts a fresh line. */
  maxGap?: number;
  /** How long a line lingers after its last word (clamped to the next line). */
  hold?: number;
  /**
   * Output times a line must not span — scene-cue starts/ends. The caption
   * anchor is resolved once per line from the layout at its start, so a line
   * crossing a layout boundary would sit in the WRONG layout's band and can
   * land on a card or the face (FINDINGS §6b). Lines flush at boundaries and
   * their hold never extends past one.
   */
  breakpoints?: number[];
}

export function buildCaptionLines(
  transcript: Transcript,
  map: TimeMap,
  opts: CaptionOptions = {},
): CaptionLine[] {
  const maxWords = opts.maxWordsPerLine ?? 3;
  const maxDur = opts.maxLineDuration ?? 1.2;
  const maxGap = opts.maxGap ?? 0.6;
  const hold = opts.hold ?? 0.35;
  const breakpoints = [...(opts.breakpoints ?? [])].sort((a, b) => a - b);

  const mapped: CaptionWord[] = [];
  for (const w of transcript.words) {
    const m = map.mapWord(w as Word);
    // `w.start` is source time, `m.start` output — both are needed, and only
    // the source one is stable across a re-cut (§137).
    if (m) mapped.push({ text: w.text, start: m.start, end: m.end, srcStart: w.start });
  }

  const lines: CaptionLine[] = [];
  let current: CaptionWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    lines.push({
      words: current,
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
    });
    current = [];
  };

  for (const w of mapped) {
    const lineStart = current[0]?.start ?? w.start;
    const prevEnd = current[current.length - 1]?.end;
    const crossesBoundary =
      current.length > 0 && breakpoints.some((b) => b > lineStart + 1e-6 && b <= w.start + 1e-6);
    if (
      current.length >= maxWords ||
      w.end - lineStart > maxDur ||
      (prevEnd !== undefined && w.start - prevEnd > maxGap) ||
      crossesBoundary
    ) {
      flush();
    }
    current.push(w);
  }
  flush();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    const lastWordEnd = line.words[line.words.length - 1]!.end;
    const boundary = breakpoints.find((b) => b > line.start + 1e-6);
    let end = line.end + hold;
    if (next) end = Math.min(end, next.start);
    if (boundary !== undefined) end = Math.min(end, boundary);
    // A single word physically spanning a boundary stays readable to its end.
    line.end = Math.min(Math.max(end, lastWordEnd), map.outputDuration);
  }
  return lines;
}
