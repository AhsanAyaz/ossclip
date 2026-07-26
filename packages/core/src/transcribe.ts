import { readFile } from "node:fs/promises";
import { run } from "./exec";
import type { Transcript, Word } from "./schema";

/** Shape of whisper.cpp's `-oj` JSON output (the fields we consume). */
export interface WhisperJson {
  result?: { language?: string };
  transcription: Array<{
    offsets: { from: number; to: number }; // milliseconds
    text: string;
  }>;
}

const NOISE_TOKEN = /^[[(].*[\])]$/; // [BLANK_AUDIO], (buzzing), [MUSIC] …

/**
 * Convert whisper.cpp `-ml 1` segments (≈ one token each) into words.
 * Tokens beginning with whitespace start a new word; bare continuations
 * ("'s", "ing") merge into the previous word. Bracketed noise markers drop.
 */
export function parseWhisperJson(json: WhisperJson): Transcript {
  const words: Word[] = [];
  for (const seg of json.transcription ?? []) {
    const raw = seg.text;
    if (!raw || !raw.trim()) continue;
    const text = raw.trim();
    if (NOISE_TOKEN.test(text)) continue;
    const startsWord = /^\s/.test(raw) || words.length === 0;
    const start = seg.offsets.from / 1000;
    const end = seg.offsets.to / 1000;
    const last = words[words.length - 1];
    if (!startsWord && last) {
      last.text += text;
      last.end = Math.max(last.end, end);
    } else {
      words.push({ text, start, end });
    }
  }
  // Whisper occasionally emits zero-length or inverted stamps; repair minimally.
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.end <= w.start) w.end = w.start + 0.05;
    const next = words[i + 1];
    if (next && next.start < w.end) next.start = w.end;
  }
  return { language: json.result?.language ?? "en", words };
}

export interface WhisperOptions {
  whisperPath: string;
  modelPath: string;
  /** Output base path; whisper writes `${outBase}.json`. */
  outBase: string;
}

export async function runWhisper(opts: WhisperOptions, wavPath: string): Promise<Transcript> {
  await run(opts.whisperPath, [
    "-m", opts.modelPath,
    "-f", wavPath,
    "-oj",
    "-of", opts.outBase,
    "-ml", "1",
    "--no-prints",
  ]);
  const json = JSON.parse(await readFile(`${opts.outBase}.json`, "utf8")) as WhisperJson;
  return parseWhisperJson(json);
}
