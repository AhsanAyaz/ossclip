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
    if (
      current.length >= maxWords ||
      w.end - lineStart > maxDur ||
      (prevEnd !== undefined && w.start - prevEnd > maxGap)
    ) {
      flush();
    }
    current.push(w);
  }
  flush();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    const extended = line.end + hold;
    line.end = next ? Math.min(extended, next.start) : Math.min(extended, map.outputDuration);
  }
  return lines;
}
