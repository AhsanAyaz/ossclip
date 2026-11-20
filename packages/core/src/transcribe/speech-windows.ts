import type { Word } from "../schema";
import type { TakeWindow } from "./take-transcripts";

/**
 * Silence-compressed decoding (FINDINGS §159).
 *
 * One whisper pass over a long recording smears word timestamps across the
 * silence between takes: on a 13-minute field recording (796 s, 473 s of it
 * silence) 31% of the words had their midpoint inside measured silence, and
 * speech that physically ended at 46.70 s was stamped "designer" at 51.29 s.
 * Every cut proposed from those times was off by seconds.
 *
 * The TIMES come from a second decode with the long silences removed before
 * whisper hears the audio, mapped back to the original clock; the TEXT still
 * comes from today's decode (decodeTakes in produce.ts joins the two). With
 * the silence gone there is nothing to smear into — 0.4% left — but with the
 * pauses gone whisper also stops punctuating (488 words in unpunctuated
 * stretches), and splice gaps of zeros or a style prompt did not bring it
 * back (§159). The first attempt — decoding silence-bounded windows and
 * stitching them — still carried 300 s of in-window silence to smear into
 * (9.6% left), dropped 8 real words stamped past a window's end, and doubled
 * the wall time. Pure halves here, the ffmpeg/whisper spawns in produce.ts
 * (the openCommand/openInBrowser split).
 */

export interface SilenceSpan {
  start: number;
  end: number;
}

/**
 * Fixed, not the per-file threshold measureLevels derives: the derived one is
 * tuned for CUTTABLE dead air and runs stricter on noisy rooms, where it would
 * find no silence at all and leave the file decoding whole. -35 dB / 0.35 s
 * is the detector the §159 measurement was taken with.
 */
export function silenceDetectArgs(wav: string): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-i", wav,
    "-af", "silencedetect=n=-35dB:d=0.35",
    "-f", "null",
    "-",
  ];
}

/**
 * ffmpeg's silencedetect lines, paired. A trailing `silence_start` with no
 * end is silence running to EOF (ffmpeg never prints the end), so it closes
 * at `durationSec`. The first start can read slightly negative (-0.00175):
 * clamped to 0, as detectSilences does.
 */
export function parseSilences(stderr: string, durationSec: number): SilenceSpan[] {
  const out: SilenceSpan[] = [];
  let pending: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) pending = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e && pending !== null) {
      out.push({ start: pending, end: Number(e[1]) });
      pending = null;
    }
  }
  if (pending !== null && pending < durationSec) out.push({ start: pending, end: durationSec });
  return out;
}

/** Speech runs over the audio: the gaps between silences. */
export function speechRuns(silences: readonly SilenceSpan[], durationSec: number): TakeWindow[] {
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  const runs: TakeWindow[] = [];
  let at = 0;
  for (const s of sorted) {
    if (s.end <= at || s.start >= durationSec) continue;
    if (s.start > at) runs.push({ startSec: at, endSec: s.start });
    at = Math.max(at, s.end);
  }
  if (at < durationSec) runs.push({ startSec: at, endSec: durationSec });
  return runs;
}

/**
 * The silences inside one take, on that take's clock. Detection runs once
 * over the whole concat; each take is then planned on its own, so a take's
 * compressed decode is what its per-take slice would have heard.
 */
export function silencesInWindow(silences: readonly SilenceSpan[], window: TakeWindow): SilenceSpan[] {
  const out: SilenceSpan[] = [];
  for (const s of silences) {
    const start = Math.max(s.start, window.startSec);
    const end = Math.min(s.end, window.endSec);
    if (end > start) out.push({ start: start - window.startSec, end: end - window.startSec });
  }
  return out;
}

/** One stretch of kept audio: `[srcStart, srcEnd)` of the source lands at `dstStart`. */
export interface CompressionSegment {
  srcStart: number;
  srcEnd: number;
  dstStart: number;
}

/**
 * The selection works on whole 10 ms frames (160 samples at extractAudio's
 * 16 kHz): compressArgs repacks the audio into frames of exactly that size
 * and aselect keeps or drops each frame by its start time. A boundary off
 * this grid would keep one frame more or less than the plan says, and the
 * error would accumulate into every later word's remapped time.
 */
const GRID_PER_SEC = 100;
const SAMPLES_PER_FRAME = 160;
// Integer grid units without float noise: 2.15 * 100 is 215.00000000000003.
const gridFloor = (s: number): number => Math.floor(s * GRID_PER_SEC + 1e-6);
const gridCeil = (s: number): number => Math.ceil(s * GRID_PER_SEC - 1e-6);

/**
 * The segments the compressed wav is made of. Each speech run is padded by
 * `padSec` so a soft onset or trailing consonant the -35 dB detector heard as
 * silence still reaches whisper; runs whose pads would overlap become one
 * segment (the sub-0.3 s gap between them stays in — it is a breath, not the
 * silence that smears). Pads never reach past the audio's start or end.
 */
export function compressionPlan(
  runs: readonly TakeWindow[],
  durationSec: number,
  opts: { padSec?: number } = {},
): CompressionSegment[] {
  const padSec = opts.padSec ?? 0.15;
  const endUnits = durationSec * GRID_PER_SEC;
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of [...runs].sort((a, b) => a.startSec - b.startSec)) {
    const start = Math.max(0, gridFloor(r.startSec - padSec));
    const end = Math.min(endUnits, gridCeil(r.endSec + padSec));
    if (end <= start) continue;
    const last = merged[merged.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  const out: CompressionSegment[] = [];
  let dst = 0;
  for (const m of merged) {
    const srcEnd = m.end === endUnits ? durationSec : m.end / GRID_PER_SEC;
    out.push({ srcStart: m.start / GRID_PER_SEC, srcEnd, dstStart: dst / GRID_PER_SEC });
    dst += m.end - m.start;
  }
  return out;
}

/** Seconds as ffmpeg reads them, without float noise. */
const secArg = (s: number): string => String(Number(s.toFixed(6)));

/**
 * Past this the selection goes to a filter script. Measured on the §159
 * recording, 159 segments make a 4.3 kB inline `-af` that ffmpeg 6.1 runs in
 * 1.4 s, sample-exact; a 1500-segment, 40 kB script ran just as exact. The
 * ceiling is the OS, not ffmpeg — Windows caps a whole command line at
 * 32 767 characters — so an hour of stop-start speech must not ride in argv.
 */
const INLINE_FILTER_MAX_CHARS = 8000;

/**
 * ffmpeg args writing exactly `plan`'s segments, in order, as 16 kHz mono
 * PCM. `asetnsamples` makes every frame 10 ms (`p=0`: no padded final
 * frame), each `between` window sits half a frame inside the segment so a
 * frame starting on a boundary is never ambiguous, and `asetpts` re-stamps
 * the kept frames contiguously. A long selection is returned as `script`,
 * for the caller to write before spawning.
 */
export function compressArgs(
  src: string,
  out: string,
  plan: readonly CompressionSegment[],
): { args: string[]; script?: { path: string; text: string } } {
  const half = 1 / GRID_PER_SEC / 2;
  const select = plan
    .map((s) => `between(t,${secArg(s.srcStart - half)},${secArg(s.srcEnd - half)})`)
    .join("+");
  const filter = `asetnsamples=n=${SAMPLES_PER_FRAME}:p=0,aselect='${select}',asetpts=N/SR/TB`;
  const tail = ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out];
  if (filter.length <= INLINE_FILTER_MAX_CHARS) {
    return { args: ["-y", "-hide_banner", "-i", src, "-af", filter, ...tail] };
  }
  const path = `${out}.filter`;
  return {
    args: ["-y", "-hide_banner", "-i", src, "-filter_script:a", path, ...tail],
    script: { path, text: filter },
  };
}

/**
 * Where compressed time `t` lands: the segment it belongs to and its time on
 * the original clock. Segments are contiguous on the compressed clock, so
 * that is the last one starting at or before `t`; past the last: its end.
 */
function locate(t: number, plan: readonly CompressionSegment[]): { k: number; src: number } {
  let k = 0;
  for (let i = 0; i < plan.length; i++) {
    if (plan[i]!.dstStart <= t) k = i;
    else break;
  }
  const s = plan[k]!;
  return { k, src: Math.min(s.srcStart + Math.max(0, t - s.dstStart), s.srcEnd) };
}

/** A compressed-clock time on the original clock. */
export function remapTime(t: number, plan: readonly CompressionSegment[]): number {
  if (plan.length === 0) return t;
  return locate(t, plan).src;
}

const MIN_WORD_SEC = 0.02;

/**
 * Words on the original clock. The end is clamped to the segment holding the
 * START: a spoken word cannot span a removed silence of 0.35 s or more, and
 * whisper stretching a word over the splice would otherwise rebuild the
 * multi-second words this exists to remove. No word is ever dropped — the
 * windowed attempt lost 8 real ones that way (§159).
 */
export function remapWords<W extends Word>(words: readonly W[], plan: readonly CompressionSegment[]): W[] {
  if (plan.length === 0) return words.map((w) => ({ ...w }));
  return words.map((w) => {
    const at = locate(w.start, plan);
    const seg = plan[at.k]!;
    // A word pinned to a segment's end (whisper stamped it on the splice, or
    // past the last segment) takes its minimum length INSIDE the segment:
    // pushed past srcEnd it would sit in the removed silence (§159).
    const start = Math.max(seg.srcStart, Math.min(at.src, seg.srcEnd - MIN_WORD_SEC));
    const end = Math.max(Math.min(remapTime(w.end, plan), seg.srcEnd), start + MIN_WORD_SEC);
    return { ...w, start, end };
  });
}

/**
 * Whether removing silence is worth a different decode. Dense clips and
 * shorts (under 10% or under 3 s removable) decode exactly as before §159,
 * with today's arguments, so their transcripts are unchanged.
 */
export function shouldCompress(silences: readonly SilenceSpan[], durationSec: number): boolean {
  const kept = compressionPlan(speechRuns(silences, durationSec), durationSec).reduce(
    (s, seg) => s + (seg.srcEnd - seg.srcStart),
    0,
  );
  const removable = durationSec - kept;
  return removable >= 0.1 * durationSec && removable >= 3;
}

/**
 * One plan per take (a single file is one take), each on its take's clock;
 * null decodes that take exactly as today.
 */
export function takeCompressionPlans(
  silences: readonly SilenceSpan[],
  takes: readonly TakeWindow[],
): Array<CompressionSegment[] | null> {
  return takes.map((take) => {
    const local = silencesInWindow(silences, take);
    const d = take.endSec - take.startSec;
    if (!shouldCompress(local, d)) return null;
    // A take that is silence end to end has nothing to keep, and an empty
    // selection is an ffmpeg error, not an empty wav: decode it as today.
    const plan = compressionPlan(speechRuns(local, d), d);
    return plan.length > 0 ? plan : null;
  });
}

/**
 * The one log line a two-pass transcription prints. It names both passes:
 * the run decodes the whole recording for the text AND the speech for the
 * times (§159), and a line claiming only the second would hide half the wait.
 */
export function compressionLine(speechSec: number, durationSec: number): string {
  return (
    `▸ transcribing ${durationSec.toFixed(0)} s recording, then timing ` +
    `${speechSec.toFixed(0)} s of speech with silences removed`
  );
}
