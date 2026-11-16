import type { Transcript, Word } from "../schema";

/**
 * Per-clip transcription for folder input (2026-11-13 field report, "AI And
 * Coding").
 *
 * A folder's takes are independent recordings joined end to end. Decoding the
 * whole concat in one whisper pass lets the decoder carry timing and text
 * across a seam, and an iPhone take whose audio stops mid-word (the AAC track
 * there ends ~0.27s before the video) is exactly where it loses its place:
 * the last sentence of one take ("but their interview strategy is still
 * the…") was stamped 2.5s into the NEXT take as a zero-duration token burst.
 * Every cut, caption and scene anchor downstream inherited the wrong times,
 * so the render dropped words the captions still showed.
 *
 * Decoding each take in its own window makes a seam a hard reset: a take's
 * words can only land inside that take. Pure halves here, the spawn loop in
 * produce.ts (the openCommand/openInBrowser split).
 */

export interface TakeWindow {
  startSec: number;
  endSec: number;
}

/**
 * Each clip's window on the concat timeline. The concat filter makes every
 * segment as long as its longest stream — the video, padding a short audio
 * track with silence — so the manifest's VIDEO durations are the seams.
 */
export function takeWindows(durationsSec: readonly number[]): TakeWindow[] {
  const out: TakeWindow[] = [];
  let at = 0;
  for (const d of durationsSec) {
    out.push({ startSec: at, endSec: at + d });
    at += d;
  }
  return out;
}

/**
 * Join per-clip transcripts onto the concat timeline. A word wholly past its
 * window's end is dropped and an overhanging one clamped: whisper pads a
 * final, cut-off word past the end of the audio it heard, and letting that
 * overhang overlap the next take would rebuild the bug this exists to fix.
 */
export function stitchTakeTranscripts(
  parts: ReadonlyArray<{ window: TakeWindow; transcript: Transcript }>,
): Transcript {
  const words: Word[] = [];
  for (const { window, transcript } of parts) {
    for (const w of transcript.words) {
      const start = w.start + window.startSec;
      if (start >= window.endSec) continue;
      words.push({ ...w, start, end: Math.min(w.end + window.startSec, window.endSec) });
    }
  }
  return { language: parts[0]?.transcript.language ?? "en", words };
}

/** Seconds as ffmpeg reads them, without float noise (10.9 - 5.3 = 5.6000000000000005). */
const secArg = (s: number): string => String(Number(s.toFixed(6)));

/**
 * ffmpeg args cutting one clip's window out of the extracted wav. `-ss`
 * AFTER `-i` decodes up to the seek point instead of jumping to it, which is
 * sample-accurate on PCM — a window that starts early would hand whisper the
 * previous take's tail.
 */
export function sliceWavArgs(src: string, out: string, window: TakeWindow): string[] {
  return [
    "-y",
    "-i", src,
    "-ss", secArg(window.startSec),
    "-t", secArg(window.endSec - window.startSec),
    "-c:a", "pcm_s16le",
    out,
  ];
}
