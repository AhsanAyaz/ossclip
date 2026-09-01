import { basename } from "node:path";
import { z } from "zod/v4";
import { TranscriptSchema, type Transcript, type Word } from "../schema";
import { NOISE_TOKEN, normalizeWords, type TranscribeProvider, type TranscribeRequest } from "./provider";

/**
 * Transcription against any OpenAI-compatible `/v1/audio/transcriptions`
 * server — Groq's free tier (8h audio/day, `whisper-large-v3-turbo`), a
 * self-hosted speaches, or anything else speaking that shape.
 *
 * Why (2026-09-01 field report): on a weak CPU — an i3 2nd gen — whisper is
 * the dominant cost of a produce run, minutes of decode per minute of video.
 * A remote call makes it seconds. Local whisper-cli stays the DEFAULT; this
 * is opt-in via `whisperUrl` / `OSSCLIP_WHISPER_URL`, and the API key is
 * optional because self-hosted servers run keyless (unlike publish, where the
 * key is required).
 *
 * Error posture is postiz.ts's, for the same reason: a transcription is the
 * user's explicit action, so every non-2xx throws with the status and a body
 * snippet, and there are NO retries — a retry against a metered free tier
 * silently doubles the quota burn for a failure the user is about to see
 * anyway.
 */

/**
 * `whisperUrl` → the endpoint: trailing slashes dropped,
 * `/audio/transcriptions` appended unless the user already wrote it
 * (`postizApiBase`'s mould). The user configures the OpenAI-compatible BASE
 * ("https://api.groq.com/openai/v1"), which is the URL every provider's
 * quickstart prints — but someone who pastes the full endpoint must not end
 * up posting to `/v1/audio/transcriptions/audio/transcriptions`.
 */
export function openaiTranscriptionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/audio/transcriptions") ? trimmed : `${trimmed}/audio/transcriptions`;
}

export class RemoteTranscribeHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    bodySnippet: string,
  ) {
    // Per-status hints, PostizHttpError's mould: the raw status tells a user
    // nothing about which of the two env vars (or which URL spelling) is
    // wrong, and this path is reached by people who just pasted a quickstart.
    const hint =
      status === 401 || status === 403
        ? " — the server rejected OSSCLIP_WHISPER_API_KEY (or none was sent — set it in the environment or ~/.ossclip/.env)"
        : status === 404
          ? " — no /audio/transcriptions here — whisperUrl should be the OpenAI-compatible base ending in /v1 (e.g. https://api.groq.com/openai/v1)"
          : status === 413
            ? " — audio too large for this server — free Groq caps uploads at 25MB; use --whisper-backend local or the dev tier"
            : status === 429
              ? " — rate limited (Groq free tier: 8h audio/day)"
              : "";
    super(`remote transcription POST ${url} failed: ${status}${hint}${bodySnippet ? `\n${bodySnippet}` : ""}`);
    this.name = "RemoteTranscribeHttpError";
  }
}

/**
 * `verbose_json` as we consume it. LOOSE on purpose: servers add fields
 * freely (Groq sends `task`, `duration`, `segments`, `x_groq`), and a strict
 * object would turn a perfectly good transcription into a parse error the
 * next time one of them ships a field.
 */
const RemoteWordSchema = z.looseObject({
  word: z.string(),
  start: z.number(),
  end: z.number(),
});
const VerboseJsonSchema = z.looseObject({
  language: z.string().optional(),
  words: z.array(RemoteWordSchema).optional(),
});

export interface OpenAiCompatibleOptions {
  /** OpenAI-compatible base, e.g. "https://api.groq.com/openai/v1". */
  baseUrl: string;
  model: string;
  /** Optional: self-hosted servers (speaches, whisper.cpp server) run keyless. */
  apiKey?: string;
  /** The postiz test seam — the whole HTTP surface is testable without a network. */
  fetchImpl?: typeof fetch;
  /** Per-request cap; an hour of audio takes a while to upload and decode. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const BODY_SNIPPET_CHARS = 300;

export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): TranscribeProvider {
  const url = openaiTranscriptionsUrl(opts.baseUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "openai-compatible",
    async transcribe(audioPath: string, req: TranscribeRequest): Promise<Transcript> {
      // Belt and braces — the CLI refuses this combination earlier, with the
      // fix named. `/audio/translations` is a different endpoint AND a
      // different default model upstream, so silently swapping both behind
      // `--whisper-translate` would be a surprise, not a convenience.
      if (req.translate === true) {
        throw new Error(
          "--whisper-translate needs the local backend (the OpenAI-compatible API translates on a different endpoint and model) — use --whisper-backend local, or drop the flag.",
        );
      }
      const { openAsBlob } = await import("node:fs");
      // Streams the file into multipart form-data instead of holding it in
      // memory (postiz.ts's rationale): the upload sidecar is small, but a
      // span wav or an uncompressed hour is not.
      const blob = await openAsBlob(audioPath, {
        type: audioPath.endsWith(".ogg") ? "audio/ogg" : "audio/wav",
      });
      const form = new FormData();
      form.append("file", blob, basename(audioPath));
      form.append("model", opts.model);
      form.append("response_format", "verbose_json");
      // The literal bracketed field name is the wire spelling OpenAI and Groq
      // accept — it is an array parameter in a multipart body, not a typo.
      form.append("timestamp_granularities[]", "word");
      // "auto" is whisper.cpp's vocabulary, not an ISO code: sending it makes
      // the server reject the request, while OMITTING the field is exactly
      // what asks for auto-detection.
      if (req.language !== undefined && req.language !== "auto") form.append("language", req.language);
      if (req.prompt !== undefined) form.append("prompt", req.prompt);

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
          body: form,
          signal: ac.signal,
        });
      } catch (err) {
        throw new Error(
          `remote transcription unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      if (!res.ok) throw new RemoteTranscribeHttpError(url, res.status, text.slice(0, BODY_SNIPPET_CHARS));
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(
          `remote transcription answered non-JSON from ${url}: ${text.slice(0, BODY_SNIPPET_CHARS)}`,
        );
      }
      const parsed = VerboseJsonSchema.parse(json);
      if (!parsed.words || parsed.words.length === 0) {
        // Two causes, both worth naming: a server that transcribed fine but
        // has no word-timestamp support (a plain whisper.cpp server), and
        // near-silent audio, which Groq's turbo model answers wordlessly.
        // Everything downstream (cuts, captions, zoom) is word-stamp driven,
        // so a text-only answer is unusable, not a degraded success.
        throw new Error(
          `the server answered without word timestamps — it must support response_format=verbose_json with timestamp_granularities[]=word (Groq and speaches do; a plain whisper.cpp server may not), or the audio contained no speech (${url})`,
        );
      }
      // No token merging and no §130 byte repair here: those heal whisper.cpp
      // `-ml 1` artifacts (one BPE token per segment, split mid-character).
      // The HTTP API returns whole words with punctuation attached — already
      // the shape parseWhisperJson works to produce.
      const words: Word[] = [];
      for (const w of parsed.words) {
        const wordText = w.word.trim();
        if (!wordText || NOISE_TOKEN.test(wordText)) continue;
        words.push({
          text: wordText,
          // Clamped: a server answering -0.01 for the first word would trip
          // WordSchema's nonnegative and fail the whole run over a rounding
          // artifact at the very start of the audio.
          start: Math.max(0, w.start),
          end: w.end,
        });
      }
      return TranscriptSchema.parse({
        // The requested code wins — it is what the cache key and the caption
        // pipeline were told the audio is. Otherwise the server's own answer,
        // lowercased. NOTE: some servers answer with a full NAME ("english")
        // rather than a code; no code-sensitive consumer exists today
        // (captions' RTL check is a Unicode heuristic), so no name→code table.
        language:
          req.language !== undefined && req.language !== "auto"
            ? req.language
            : parsed.language?.toLowerCase(),
        words: normalizeWords(words),
      });
    },
  };
}
