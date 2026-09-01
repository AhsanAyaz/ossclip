import type { Transcript, Word } from "../schema";

/**
 * The seam between ossclip and any transcription backend (2026-09-01, the
 * weak-CPU field report: whisper is the dominant cost on an i3 2nd gen, and a
 * free remote tier makes it disappear). Two implementations today —
 * whisper.cpp on the box (`whisper-cli.ts`) and any OpenAI-compatible
 * `/v1/audio/transcriptions` server (`openai-compatible.ts`).
 *
 * The local path deliberately keeps calling `runWhisper` directly rather than
 * going through this interface: produce.ts and the edit server inject
 * `runWhisper` itself as a test seam, and forcing that through a provider
 * object would churn every stub for no behavior change.
 */
export interface TranscribeRequest {
  /** Resolved language code; "auto" is handled per provider (whisper.cpp
   *  takes it literally, the HTTP API wants the field OMITTED). */
  language?: string;
  /** `whisperPromptFor()` output — the user dictionary as decoder bias. */
  prompt?: string;
  /** whisper-cli's TRANSLATE task; the OpenAI-compatible provider rejects it
   *  (a different endpoint AND a different default model upstream). */
  translate?: boolean;
}

export interface TranscribeProvider {
  name: string;
  transcribe(audioPath: string, req: TranscribeRequest): Promise<Transcript>;
}

/** [BLANK_AUDIO], (buzzing), [MUSIC] … — noise markers, not speech. Shared:
 *  remote servers emit the same bracketed markers whisper.cpp does. */
export const NOISE_TOKEN = /^[[(].*[\])]$/;

/**
 * Run length at which a stack of zero-length words at ONE instant stops being
 * a rounding artifact and becomes a repetition-loop hallucination. Real speech
 * never emits 8 tokens at a single instant; the field case emitted 118.
 */
export const REPETITION_BURST_MIN = 8;

/**
 * Drop whisper repetition-loop bursts (field case 2026-08-18): an Urdu take
 * re-decoded a whole phrase as 118 CONSECUTIVE tokens all stamped
 * `from === to === 31040` — zero length, at one instant. The stamp repair
 * below then fans such a burst out into 118 fabricated 50ms words marching
 * forward from 31.04s, so the phrase ships TWICE in the captions (31.04s and
 * 33.54s) and a fifth of the transcript carries the tell-tale exactly-0.05s
 * duration. `-mc 0` in whisperArgs is the decoder-side mitigation for the same
 * failure; it did not prevent this occurrence, and it can never repair an
 * already-cached transcript.json — hence a parse-side guard too.
 *
 * A burst is a MAXIMAL run of consecutive zero-length/inverted words sharing
 * one `start`. Equality is exact, not epsilon: these stamps are integer
 * milliseconds divided by 1000, so members of one burst are the same double
 * bit-for-bit, and a tolerance would only start swallowing real neighbors.
 * Runs shorter than REPETITION_BURST_MIN fall through untouched — a lone
 * zero-length stamp is a rounding artifact, not a hallucination. The drop is
 * silent by design: this function is pure and total, and there is no logging
 * channel in the parse path to warn on.
 */
export function dropRepetitionBursts(words: readonly Word[]): Word[] {
  const out: Word[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (w.end > w.start) {
      out.push(w);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < words.length && words[j]!.end <= words[j]!.start && words[j]!.start === w.start) j++;
    if (j - i < REPETITION_BURST_MIN) for (let k = i; k < j; k++) out.push(words[k]!);
    i = j;
  }
  return out;
}

/**
 * The word-stamp hygiene EVERY backend's output goes through, extracted from
 * the tail of `parseWhisperJson` so the remote provider cannot drift from it
 * (2026-09-01). Burst drop runs BEFORE the repair, never after: the repair
 * rewrites every burst member into a distinct monotone stamp, so once it has
 * run the shared timestamp — the only evidence a burst existed — is gone.
 *
 * Copies before mutating, so a caller's array survives the call unchanged;
 * `parseWhisperJson` builds its words fresh, so this is byte-identical to the
 * in-place loop it replaces.
 */
export function normalizeWords(words: readonly Word[]): Word[] {
  const kept = dropRepetitionBursts(words).map((w) => ({ ...w }));
  // Whisper occasionally emits zero-length or inverted stamps; repair minimally.
  for (let i = 0; i < kept.length; i++) {
    const w = kept[i]!;
    if (w.end <= w.start) w.end = w.start + 0.05;
    const next = kept[i + 1];
    if (next && next.start < w.end) next.start = w.end;
  }
  return kept;
}
