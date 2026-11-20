import { srtFromCaptionLines, type SrtLine } from "./export-premiere-project";

/**
 * The clip kit's `captions.srt` (design kit-captions-layer.md, Part 1):
 * the project's caption lines as a subtitle file Resolve imports into a
 * subtitle track. Pure — `ossclip kit` owns the file.
 *
 * Times are the lines' own output seconds, which are seconds from the start
 * of the kit's timeline: the timeline is the cut, so output time and
 * timeline time are the same clock.
 */

export interface KitCaptionsSrt {
  /** The file's text, or null when no line survives (no file is written). */
  text: string | null;
  /** Entries written. */
  lines: number;
  /** Lines left out: no word with any text, or an end not after the start. */
  skipped: number;
}

/**
 * One entry per caption line that has a word with text and a positive
 * length, numbered from 1 with no gaps.
 *
 * - A word's whitespace collapses to single spaces and a blank word drops
 *   out, so the words are joined by single spaces; a newline inside a word
 *   would otherwise end the SRT entry where it stands.
 * - A line of no words would be an entry with an empty text row, which ends
 *   the entry at once in most SRT readers; a zero- or negative-length line
 *   is not a subtitle Resolve can place. Both are counted, so the report says
 *   how many lines the file does not carry.
 * - Windows line endings throughout (the design's choice): SRT came from a
 *   Windows tool, Resolve here runs on Windows, and `\r\n` is the form every
 *   reader accepts. Through `srtFromCaptionLines`' `eol`, so the time format
 *   is the premiere-project export's own and is never written twice.
 */
export function kitCaptionsSrt(lines: readonly SrtLine[]): KitCaptionsSrt {
  const kept: SrtLine[] = [];
  let skipped = 0;
  for (const line of lines) {
    const words = line.words
      .map((w) => ({ text: w.text.replace(/\s+/g, " ").trim() }))
      .filter((w) => w.text !== "");
    if (words.length === 0 || !(line.end > line.start)) {
      skipped++;
      continue;
    }
    kept.push({ words, start: line.start, end: line.end });
  }
  return {
    text: kept.length === 0 ? null : srtFromCaptionLines(kept, { eol: "\r\n" }),
    lines: kept.length,
    skipped,
  };
}
