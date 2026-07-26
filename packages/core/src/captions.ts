import type { Transcript, Word } from "./schema";
import type { TimeMap } from "./timemap";

/** Caption timing lives in OUTPUT time — captions never know about cuts. */
export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionLine {
  words: CaptionWord[];
  start: number;
  end: number;
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
    if (m) mapped.push({ text: w.text, start: m.start, end: m.end });
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
