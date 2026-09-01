import { readFile } from "node:fs/promises";
import { run } from "../exec";
import type { Transcript, Word } from "../schema";
import { NOISE_TOKEN, normalizeWords } from "./provider";

/** Shape of whisper.cpp's `-oj` JSON output (the fields we consume). */
export interface WhisperJson {
  result?: { language?: string };
  transcription: Array<{
    offsets: { from: number; to: number }; // milliseconds
    text: string;
  }>;
}

/**
 * How many bytes at the END of `bytes` form the start of a multi-byte UTF-8
 * character whose continuation bytes are missing (§130: whisper.cpp `-ml 1`
 * splits byte-level BPE tokens mid-character, so a segment's text can end on
 * a bare lead byte — the field file ended one segment `0x20 0xD9` and started
 * the next `0xB9 …`, the two halves of ٹ). 0 when the tail is complete.
 */
function utf8DanglingTailLen(bytes: Buffer): number {
  let i = bytes.length - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && (bytes[i]! & 0xc0) === 0x80) {
    i--;
    cont++;
  }
  // All continuation bytes: a HEAD fragment, someone else's tail — not ours.
  if (i < 0) return 0;
  const lead = bytes[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  // ASCII (or a stray byte no neighbor could complete) — nothing dangling.
  if (need === 1) return 0;
  return cont < need - 1 ? bytes.length - i : 0;
}

/**
 * Repair segments whose text was split MID-CHARACTER by byte-level BPE
 * (§130). Operates in byte space: `text` values here are latin1-decoded, one
 * code point per original byte, because the fix must see the real bytes —
 * reading the file as utf8 first would already have destroyed them (Node
 * substitutes U+FFFD, and the two halves of the character are gone for good).
 * A segment ending on an incomplete sequence merges with a following segment
 * that begins with continuation bytes, spanning both segments' offsets; the
 * loop re-checks the merged tail so a 3–4 byte character split across three
 * segments still heals. Only that exact shape merges — a dangling tail whose
 * neighbor does NOT continue it is unrecoverable and left to decode to
 * U+FFFD, which parseWhisperJson then folds into a neighboring word.
 */
function repairSplitSegments(json: WhisperJson): WhisperJson {
  const out: WhisperJson["transcription"] = [];
  for (const seg of json.transcription ?? []) {
    const prev = out[out.length - 1];
    const bytes = Buffer.from(seg.text, "latin1");
    if (
      prev &&
      bytes.length > 0 &&
      (bytes[0]! & 0xc0) === 0x80 &&
      utf8DanglingTailLen(Buffer.from(prev.text, "latin1")) > 0
    ) {
      prev.text += seg.text;
      prev.offsets = {
        from: Math.min(prev.offsets.from, seg.offsets.from),
        to: Math.max(prev.offsets.to, seg.offsets.to),
      };
    } else {
      out.push({ ...seg, offsets: { ...seg.offsets } });
    }
  }
  return {
    ...json,
    transcription: out.map((s) => ({
      ...s,
      text: Buffer.from(s.text, "latin1").toString("utf8"),
    })),
  };
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Parse whisper.cpp's `-oj` output from its raw BYTES. The file is not
 * guaranteed to be valid UTF-8 (§130): with `-ml 1` a multi-byte character
 * can be split across two segments' text fields at the byte level, and a
 * plain `readFile(path, "utf8")` silently replaces both halves with U+FFFD —
 * which is exactly the `��اپک` that shipped into the Urdu field captions
 * (Urdu field test 2026-08-05). Valid files take the strict-decode path and
 * behave byte-identically to before; invalid ones round-trip through latin1
 * (byte-transparent, and UTF-8 continuation bytes are ≥0x80 so JSON's ASCII
 * structure is untouched) so the split can be healed with the bytes intact.
 */
export function parseWhisperOutput(raw: Buffer): Transcript {
  let text: string | null = null;
  try {
    text = STRICT_UTF8.decode(raw);
  } catch {
    // Invalid UTF-8: the token-split shape. Fall through to byte repair —
    // but only for DECODE failures; JSON syntax errors below still throw.
  }
  if (text !== null) return parseWhisperJson(JSON.parse(text) as WhisperJson);
  return parseWhisperJson(repairSplitSegments(JSON.parse(raw.toString("latin1")) as WhisperJson));
}

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
    // A word already CLOSED by Arabic-script sentence punctuation refuses
    // continuations (field case 2026-08-18): whisper emits `۔` and the next
    // sentence's first token with no leading whitespace, and the plain
    // whitespace rule fused them into one unsplittable word ("ہوں۔اس").
    // Deliberately NOT the Latin `.`/`!`/`?` — whisper tokenizes decimals
    // ("3", ".", "5") and abbreviations as bare continuations too, and
    // splitting those would shred "3.5" into two words. ۔ (U+06D4) and
    // ؟ (U+061F) have no such second job.
    const startsWord = /^\s/.test(raw) || words.length === 0;
    const start = seg.offsets.from / 1000;
    const end = seg.offsets.to / 1000;
    const last = words[words.length - 1];
    if (!startsWord && last && !/[۔؟]$/.test(last.text)) {
      last.text += text;
      last.end = Math.max(last.end, end);
    } else {
      words.push({ text, start, end });
    }
  }
  // U+FFFD is never displayable speech — it is a byte the split repair could
  // not heal (§130: the field file also holds a lone lead byte whose
  // continuation whisper never emitted at all, mid-word between "ی" and "ج"),
  // and shipping it paints a literal � caption. Strip it from mixed words; a
  // word left EMPTY by the strip folds its time span into a neighbor instead
  // of vanishing — the span still belongs to speech.
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]!;
    if (!w.text.includes("�")) continue;
    const cleaned = w.text.replaceAll("�", "");
    if (cleaned) {
      w.text = cleaned;
      continue;
    }
    const prev = words[i - 1];
    const next = words[i + 1];
    if (prev) prev.end = Math.max(prev.end, w.end);
    else if (next) next.start = Math.min(next.start, w.start);
    words.splice(i, 1);
  }
  // Burst drop + stamp repair now live in `normalizeWords` (provider.ts,
  // 2026-09-01): the remote backend needs exactly the same two passes in
  // exactly the same order, and duplicating them is how the two paths would
  // drift. Behavior here is unchanged — the parser matrix pins it.
  return { language: json.result?.language ?? "en", words: normalizeWords(words) };
}

export interface WhisperOptions {
  whisperPath: string;
  modelPath: string;
  /** Output base path; whisper writes `${outBase}.json`. */
  outBase: string;
  /**
   * Language code passed as `-l` (e.g. "ur", "de", "auto"). whisper.cpp
   * defaults to English when the flag is absent, which decodes garbage out of
   * a non-English fine-tune (Urdu field test 2026-08-05: ggml-medium-urdu
   * needed `-l ur` to emit Urdu script at all). Left unset, the spawned args
   * stay byte-identical to what English-suffixed models always got.
   */
  language?: string;
  /**
   * Initial decoder prompt (`--prompt`), used to bias recognition toward the
   * user's vocabulary (F4 dictionary, 2026-08-16: "Jason" for JSON). Left
   * unset, the spawned args stay byte-identical to every pre-dictionary run.
   * Known risk (documented in the flag's help): a whisper-cli built before
   * the flag existed rejects it with its own loud error — accepted over
   * silently dropping the user's terms.
   */
  prompt?: string;
  /**
   * whisper's TRANSLATE task (`-tr`): decode non-English speech straight to
   * ENGLISH text (2026-08-29). Orthogonal to `language`, which only says what
   * is being SPOKEN — `-l ur` alone emits Urdu script, correct for Urdu
   * captions and wrong for an English-captioned short. Pass both together:
   * whisper still needs to know the source language to decode it well.
   *
   * Left unset, the spawned args stay byte-identical to every prior run.
   */
  translate?: boolean;
}

/**
 * Pure arg construction, split from the spawn the same way openCommand() is
 * split from openInBrowser(): the `-l` conditional is exactly the kind of
 * branch that must be testable without a whisper binary on the box.
 */
export function whisperArgs(opts: WhisperOptions, wavPath: string): string[] {
  const args = [
    "-m", opts.modelPath,
    "-f", wavPath,
    "-oj",
    "-of", opts.outBase,
    "-ml", "1",
    // No text context across 30s decode windows (field case 2026-08-18): an
    // Urdu take hit whisper's repetition loop — a whole sentence re-decoded
    // as 261 zero-duration tokens — and carrying the previous window's text
    // into the decoder is the known trigger. `-mc 0` is the standard
    // mitigation and leaves `--prompt` (the dictionary bias) untouched.
    // Cached transcript.json files decoded without it are knowingly still
    // reused (transcriptCacheReusable's no-spurious-retranscribe rule);
    // delete a workdir's transcript.json to re-decode with it.
    "-mc", "0",
    "--no-prints",
  ];
  if (opts.language !== undefined) args.push("-l", opts.language);
  // AFTER `-l`: whisper reads the pair as "this language, translated", and
  // keeping the order fixed is what makes the arg list assertable.
  if (opts.translate === true) args.push("-tr");
  if (opts.prompt !== undefined) args.push("--prompt", opts.prompt);
  return args;
}

/**
 * The `--prompt` text for a user dictionary. whisper.cpp treats the prompt as
 * preceding context, so a plain vocabulary list is enough to bias the decoder
 * toward these spellings ("Jason" → "JSON", 2026-08-16 field report). Pure
 * and undefined-for-empty so the no-dictionary invocation stays byte-identical
 * to what every run before the flag got.
 */
export function whisperPromptFor(dictionary: readonly string[]): string | undefined {
  if (dictionary.length === 0) return undefined;
  return `Vocabulary: ${dictionary.join(", ")}.`;
}

export async function runWhisper(opts: WhisperOptions, wavPath: string): Promise<Transcript> {
  await run(opts.whisperPath, whisperArgs(opts, wavPath));
  // Bytes, not "utf8": the utf8 read is where the §130 split characters died.
  return parseWhisperOutput(await readFile(`${opts.outBase}.json`));
}
