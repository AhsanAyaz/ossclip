# Implementation plan: remote whisper backend (OpenAI-compatible /v1/audio/transcriptions)

Motivation (2026-09-01): field report from a user on an i3 2nd gen — whisper is
the dominant cost on weak CPUs. Groq's free tier (8 h audio/day, perpetual,
word-level timestamps via `verbose_json` + `timestamp_granularities[]=word`,
model `whisper-large-v3-turbo`, 25 MB/file) makes remote transcription free
for any realistic creator volume; self-hosted speaches / whisper.cpp server
works through the same API shape for privacy-minded users. Local whisper-cli
stays the default; remote is opt-in.

All anchors verified against main at planning time.

## Design decisions (pinned)

1. **Module layout** — convert `packages/core/src/transcribe.ts` into
   `transcribe/` (barrel `index.ts`, `whisper-cli.ts` = current file verbatim
   minus extracted `normalizeWords`, `provider.ts`, `openai-compatible.ts`).
   Only importer is `packages/core/src/index.ts:12` (`export * from
   "./transcribe"`); `moduleResolution: "bundler"` resolves the directory, so
   the move is churn-free and `packages/core/test/transcribe.test.ts`'s
   `../src/transcribe` import keeps working.
2. **Selection** — config `whisperUrl` (file) + env `OSSCLIP_WHISPER_URL`; key
   env-only `OSSCLIP_WHISPER_API_KEY` and OPTIONAL (self-hosted servers are
   keyless — differs from publishConfigured where the key is required); remote
   model config `whisperRemoteModel` + env `OSSCLIP_WHISPER_REMOTE_MODEL`,
   default `whisper-large-v3-turbo`. Explicit override flag
   `--whisper-backend <local|remote>` (zod enum) — NOT bare `--whisper`, which
   collides with `OSSCLIP_WHISPER` meaning the binary path (config.ts:295).
   URL present → remote; flag `local` always wins.
3. **Upload sidecar: ogg/opus 32 kbps 16 kHz mono** (`-c:a libopus -b:a 32k`).
   The 16 kHz PCM wav is 1.92 MB/min → ~13 min hits Groq's 25 MB cap; opus at
   32 kbps is ~240 KB/min → ~100 min under cap and ASR-transparent for speech.
   FLAC rejected (lossless buys nothing for ASR, only ~25 min under cap).
   Pre-flight size check against `REMOTE_UPLOAD_MAX_BYTES = 24 MiB` (margin so
   a boundary file errors with our message, not theirs). Chunking is OUT of
   scope v1 — over-cap errors name the measured size, the ~100-min ceiling,
   and the fixes (local backend / Groq dev tier's 100 MB).
4. **Response mapping** — loose zod parse of verbose_json; `word→text`, trim,
   drop empties + `NOISE_TOKEN` matches; shared `normalizeWords()` (extracted
   from the tail of `parseWhisperJson`, transcribe.ts:203-212:
   `dropRepetitionBursts` + zero-length/inverted/overlap stamp repair). No
   token merging, no §130 byte repair — those are whisper.cpp `-ml 1`
   artifacts; remote returns whole words with punctuation attached, already
   the local output shape.
5. **Cache key** — optional `backend: string` on `TranscriptKeySchema`
   (produce.ts:296), value `remote:<normalized-base-url>`; absent = local
   (compat with every existing key file). Remote runs put the remote model
   name in the existing `model` field. Without this, a warm workdir serves a
   local transcript to a remote run — the exact hazard `language`/`translate`
   fields were added for.
6. **produce.ts branch C** — pure `resolveWhisperBackend()` picks; whisper
   binary preflight (:2707) and model-file check (:2714-2723) run only on the
   local branch; StageAnimator `"REMOTE ASR"` with host+model in the detail;
   `RemoteTranscribeHttpError` carries per-status hints (postiz mould).
   Timeout 10 min (postiz `DEFAULT_TIMEOUT_MS`). No retries (postiz.ts:25-28
   posture — a retry silently doubles quota burn).
7. **edit.ts span re-transcribe** — span wavs are seconds long: upload wav
   as-is (`audio/wav`), no opus sidecar. New injectable seam
   `transcribeRemote` beside `runWhisper` (edit.ts:491).
8. **Doctor/setup** — remote configured: whisper-cli/model checks pass with
   "not needed — remote transcription configured" detail (LLM-provider
   optional posture, doctor.ts:146-180) plus a new no-network
   `remote transcription` line (URL · model · key presence); line omitted
   entirely when not configured. `planSetup` marks whisper + model steps
   `satisfied` when remote configured.
9. **`--whisper-translate` + remote = hard error** in v1 (`/audio/translations`
   is a different endpoint AND a different default model on Groq — silently
   swapping both behind one flag is a surprise; the flag is rare). Error names
   the fix. Raised before the cache-key check so translate can never cross
   cache with remote.
10. **Language** — resolved language maps to the API `language` field; `"auto"`
    and unset both OMIT the field (servers auto-detect when absent; "auto" is
    not a valid ISO code there). Output language: requested code if resolved,
    else lowercased response language, else schema default "en".

## Step 1 — core: extract normalizeWords, split transcribe/ directory

- `whisper-cli.ts`: current transcribe.ts verbatim except parseWhisperJson's
  tail (dropRepetitionBursts call + stamp-repair loop, :203-212) moves to
  `provider.ts` as shared pure `normalizeWords(words: readonly Word[]): Word[]`.
  Burst-drop MUST run before stamp repair (repair destroys the
  shared-timestamp evidence bursts are detected by). Move
  `dropRepetitionBursts`, `REPETITION_BURST_MIN`, `NOISE_TOKEN` into
  provider.ts so openai-compatible.ts doesn't import from whisper-cli.
  parseWhisperJson behavior stays byte-identical — pinned by the existing
  parser matrix.
- `provider.ts`:

```ts
export interface TranscribeRequest {
  language?: string;      // resolved code; "auto" handled per provider
  prompt?: string;        // whisperPromptFor() output
  translate?: boolean;    // whisper-cli only; openai-compatible rejects upstream
}
export interface TranscribeProvider {
  name: string;
  transcribe(audioPath: string, req: TranscribeRequest): Promise<Transcript>;
}
```

  produce.ts keeps calling `runWhisper` directly for local — do not force the
  local path through the interface (would churn the edit.ts:491 seam + stubs).
- `transcribe/index.ts`: `export * from "./whisper-cli"; export * from
  "./provider"; export * from "./openai-compatible";`

## Step 2 — core: transcribe/openai-compatible.ts (postiz skeleton)

```ts
/** whisperUrl → endpoint: trailing slashes dropped, "/audio/transcriptions"
 * appended unless already written (postizApiBase mould, postiz.ts:181). */
export function openaiTranscriptionsUrl(baseUrl: string): string;

export class RemoteTranscribeHttpError extends Error {
  constructor(readonly url: string, readonly status: number, bodySnippet: string)
}
```

Status hints (PostizHttpError mould, postiz.ts:186-211):
- 401/403 → "the server rejected OSSCLIP_WHISPER_API_KEY (or none was sent — set it in the environment or ~/.ossclip/.env)"
- 404 → "no /audio/transcriptions here — whisperUrl should be the OpenAI-compatible base ending in /v1 (e.g. https://api.groq.com/openai/v1)"
- 413 → "audio too large for this server — free Groq caps uploads at 25MB; use --whisper-backend local or the dev tier"
- 429 → "rate limited (Groq free tier: 8h audio/day)"

Response schema (zod v4, `import { z } from "zod/v4"` matching schema.ts:1;
loose — servers add fields freely):

```ts
const RemoteWordSchema = z.looseObject({ word: z.string(), start: z.number(), end: z.number() });
const VerboseJsonSchema = z.looseObject({ language: z.string().optional(), words: z.array(RemoteWordSchema).optional() });
```

Factory:

```ts
export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;          // optional: self-hosted servers run keyless
  fetchImpl?: typeof fetch; // the postiz test seam
  timeoutMs?: number;       // default 10 * 60 * 1000
}
export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): TranscribeProvider;
```

`transcribe(audioPath, req)`:
1. `req.translate === true` → throw (belt-and-braces; CLI errors earlier).
2. `openAsBlob(audioPath, { type: audioPath.endsWith(".ogg") ? "audio/ogg" : "audio/wav" })` — streamed (postiz.ts:276 rationale).
3. Exact multipart fields: `file` (blob, basename), `model`,
   `response_format = "verbose_json"`, `timestamp_granularities[] = "word"`
   (literal bracketed field name — the wire spelling OpenAI/Groq accept),
   `language` (omitted when undefined or "auto"), `prompt` (omitted when
   undefined).
4. `fetchImpl(url, { method: "POST", headers: apiKey ? { Authorization: `Bearer …` } : {}, body, signal })`
   with AbortController timeout; network failure → "remote transcription
   unreachable at <url>: <msg>"; non-2xx → RemoteTranscribeHttpError with a
   300-char body snippet.
5. Parse with VerboseJsonSchema; `words` absent/empty → error: "the server
   answered without word timestamps — it must support
   response_format=verbose_json with timestamp_granularities[]=word (Groq and
   speaches do; a plain whisper.cpp server may not), or the audio contained no
   speech".
6. Map: `text = w.word.trim()`; drop empty / NOISE_TOKEN matches; clamp
   `start = Math.max(0, w.start)` (a server's -0.01 must not trip WordSchema's
   nonnegative); then `normalizeWords(mapped)`.
7. `TranscriptSchema.parse({ language: req.language && req.language !== "auto" ? req.language : parsed.language?.toLowerCase(), words })`.

No retries.

## Step 3 — core: opus sidecar in ingest.ts (beside extractAudio :80)

```ts
/** Pure: ffmpeg args for the compressed remote-upload sidecar. Opus 32kbps
 * 16kHz mono: ASR-transparent for speech, ~240KB/min — the PCM wav is
 * 1.92MB/min and hits Groq's free-tier 25MB cap at ~13 minutes. */
export function uploadAudioArgs(wavPath: string, outOgg: string): string[] {
  return ["-y", "-i", wavPath, "-vn", "-c:a", "libopus", "-b:a", "32k", "-ar", "16000", "-ac", "1", outOgg];
}
export async function encodeUploadAudio(tools: IngestTools, wav: string, outOgg: string): Promise<void>;
/** 24MiB: Groq free tier caps at 25 — margin so a boundary file errors here
 * with our message instead of theirs. */
export const REMOTE_UPLOAD_MAX_BYTES = 24 * 1024 * 1024;
```

## Step 4 — config.ts (BOTH interface :11 AND resolveConfig :288 — the postizUrl lesson :279-287)

- `whisperUrl?: string` — base URL of an OpenAI-compatible transcription
  server ending in /v1 (Groq: https://api.groq.com/openai/v1). Non-secret
  (postizUrl posture); the key is env-only.
- `whisperRemoteModel?: string` — model name sent remotely; default lives at
  the consumer (resolveWhisperBackend).
- resolveConfig: `whisperUrl: env.OSSCLIP_WHISPER_URL ?? fileCfg.whisperUrl`,
  `whisperRemoteModel: env.OSSCLIP_WHISPER_REMOTE_MODEL ?? fileCfg.whisperRemoteModel`.
  Env spellings on purpose (unlike postizUrl): the Groq quickstart is "export
  two vars and run".

## Step 5 — CLI: apps/cli/src/whisper-backend.ts (publishConfigured mould, publish.ts:104-120)

```ts
export const WHISPER_API_KEY_ENV = "OSSCLIP_WHISPER_API_KEY";
export const DEFAULT_REMOTE_WHISPER_MODEL = "whisper-large-v3-turbo";
export type WhisperBackend =
  | { kind: "local" }
  | { kind: "remote"; baseUrl: string; model: string; apiKey?: string };
export function resolveWhisperBackend(
  flag: "local" | "remote" | undefined,
  cfg: Pick<OssclipConfig, "whisperUrl" | "whisperRemoteModel">,
  env: NodeJS.ProcessEnv,
): { ok: true; backend: WhisperBackend } | { ok: false; message: string };
```

Rules: flag "local" → local always; flag "remote" with no URL → {ok:false}
naming both spellings; URL present (trimmed non-empty string, never coerced) →
remote with model default and optional trimmed key; else local.

Commander: `.option("--whisper-backend <backend>", …)` on produce (:280),
transcribe (:841), analyze (:887); `z.enum(["local","remote"]).optional()`
validation in each action (the --whisper-language posture :657-663); thread as
`whisperBackend?: "local" | "remote"` through ProduceOptions (~:623).

## Step 6 — produce.ts branch C rewiring (:2639-2755)

1. After resolveWhisperLanguage (:2654): resolveWhisperBackend; {ok:false}
   throws.
2. Translate guard BEFORE the key is built: remote + whisperTranslate → throw
   "--whisper-translate needs the local backend (the OpenAI-compatible API
   translates on a different endpoint and model) — use --whisper-backend
   local, or drop the flag."
3. requestedKey (:2667): remote → `model: backend.model`,
   `backend: `remote:${openaiTranscriptionsUrl(backend.baseUrl)}`` (normalized
   so /v1 and /v1/ key identically); spread-omitted when local so local key
   files stay byte-identical (the translate posture :2670-2672).
4. transcriptCacheReusable (:326): add
   `(effective.backend ?? "") === (requested.backend ?? "")`.
   TranscriptKeySchema: `backend: z.string().optional()` + hazard comment.
5. Whisper-run block branches: local unchanged (:2707-2750). Remote: no
   preflight/model check; inside phases.time("transcribe", …) —
   encodeUploadAudio → `audio-upload.ogg`; size check vs
   REMOTE_UPLOAD_MAX_BYTES (error names MB, ~100-min ceiling, fixes);
   StageAnimator("REMOTE ASR", `Transcribing via ${host} (${model})...`,
   "whisper"); non-TTY `▸ transcribing remotely (${host}, ${model})…`;
   provider.transcribe(ogg, { language: requestedKey.language, prompt:
   whisperPromptFor(dictionary) }); write transcriptKeyPath as :2753.

## Step 7 — edit.ts /api/retranscribe-range

- Compute backend at the handler (~:963): `resolveWhisperBackend(undefined,
  cfg, process.env)` — keep retranscribeSettings (:225) untouched for the
  local shape. Remote: skip whisper/model config+existence checks (ffmpeg
  still required for extractAudioSpan / sliceAudio).
- Handler (:992-1008): remote calls `(opts.transcribeRemote ??
  createOpenAiCompatibleProvider(…).transcribe)(tmpWav, { language, prompt })`
  — span wav uploaded as-is. New seam in the opts bag (:490-491):
  `transcribeRemote?: (wavPath: string, req: TranscribeRequest) =>
  Promise<Transcript>` with the runWhisper-seam rationale comment. Failures
  stay `200 {ok:false, error}` (:1027-1029 posture) — the hint text is the
  sentence the panel shows.

## Step 8 — doctor + setup

- doctor.ts runDoctor (:57): compute backend from cfg + p.env (env already in
  DoctorProbes :37). whisper-cli (:109-127) and model (:133-147) checks: when
  remote configured and local probe fails → ok:true with "<path> not found —
  not needed: remote transcription configured"; when local probe passes,
  unchanged. New check after the model line: name "remote transcription",
  ok:true, no network call, detail
  "<url> · model <model> · <key set | no API key (fine for self-hosted; Groq
  needs OSSCLIP_WHISPER_API_KEY)>". Omit the line when not configured.
- setup/plan.ts planSetup (:67): remote configured → whisper (:114-146) and
  model (:148-173) steps `{ status: "satisfied", detail: "remote transcription
  configured (<url>) — local whisper not needed" }` unless the local
  binary/model already exist (setup never uninstalls). setup.ts unchanged.

## Step 9 — README

Section "Remote transcription (weak-CPU machines)": local stays default; two
config keys + two env vars; 24 MB / ~100-min v1 cap; self-hosted note
(speaches / whisper.cpp server, keyless); --whisper-backend local escape
hatch; translate limitation; libopus note (bundled static ffmpeg has it; a
minimal custom build may not). Groq quickstart:

```
# 1. Get a free key at console.groq.com
export OSSCLIP_WHISPER_URL=https://api.groq.com/openai/v1
export OSSCLIP_WHISPER_API_KEY=gsk_...
ossclip produce myvideo.mp4
```

## Tests

- packages/core/test/transcribe.test.ts — existing suite passes UNCHANGED
  (pins the extraction). Add normalizeWords direct cases: zero-length +0.05,
  inverted repaired, overlap clamped, burst ≥8 dropped, burst-before-repair
  ordering.
- packages/core/test/openai-compatible.test.ts (new, fetchImpl pattern):
  URL normalizer (…/v1 → …/v1/audio/transcriptions, trailing slash, full URL
  idempotent); request shape via captured fetchImpl (method/URL; Bearer iff
  apiKey; fields model / response_format / timestamp_granularities[];
  language omitted for undefined AND "auto", present for "ur"; prompt
  omitted/present); mapping happy path; noise dropped; empty word dropped;
  zero-length repaired (proves normalizeWords ran); unknown keys ignored;
  missing words → hint error; non-JSON → error; 401/404/413/429 → each hint
  substring; timeout/abort path; language out (requested wins → lowercased
  response → "en").
- packages/core ingest tests — uploadAudioArgs exact-array pin.
- packages/core/test/config.test.ts — whisperUrl/whisperRemoteModel
  env-beats-file-beats-absent rows.
- apps/cli/test/whisper-backend.test.ts (new) — matrix: no config → local;
  URL → remote; flag local beats URL; flag remote without URL → {ok:false}
  naming both spellings; key optional; model default vs configured;
  whitespace URL treated absent.
- apps/cli/test/transcript-cache-key.test.ts — local key ↔ remote request no
  reuse; remote ↔ same URL+model reuse; different URL no reuse; keyless cache
  ↔ remote no reuse; existing rows untouched.
- apps/cli produce-argv/flag-forwarding tests — --whisper-backend parses,
  rejects "groq", forwards on all three commands.
- apps/cli/test/edit-server.test.ts — remote config via loadCfg seam:
  retranscribe calls transcribeRemote stub (not runWhisper), succeeds with no
  model file on disk; remote HTTP failure → 200 {ok:false} with hint sentence.
- apps/cli/test/doctor.test.ts — remote cfg: missing binary/model still
  ok:true with "not needed" detail; remote line present with key/no-key;
  unconfigured → line absent, local checks fail as today.
- apps/cli/test/setup.test.ts — remote configured: whisper+model steps
  satisfied with remote detail; local binary present + remote → reported found.

## Verification

1. `pnpm typecheck && pnpm test` (and the editor playwright suite — pnpm test
   excludes it).
2. Mock-fetch integration = the openai-compatible suite (no network in CI).
3. Live recipe (fixture flow injects --transcript which skips branch C — so
   drive `transcribe` WITHOUT it on a fresh workdir):

```
export OSSCLIP_WHISPER_URL=https://api.groq.com/openai/v1
export OSSCLIP_WHISPER_API_KEY=gsk_...
pnpm ossclip transcribe fixtures/fixture.mp4 --workdir /tmp/remote-check
```

   Expect: REMOTE ASR stage line; audio-upload.ogg + transcript.json +
   transcript-key.json (containing "backend": "remote:…") in the workdir;
   word count comparable to fixtures/fixture.transcript.json. Re-run WITHOUT
   the env vars: cache-mismatch → local whisper re-transcribes (proves the
   key both ways). Then the standard verify-ossclip fixture flow (local path
   untouched).
4. `pnpm ossclip doctor` with and without OSSCLIP_WHISPER_URL.

## Risks / open questions

- transcript.language may carry a full name ("english") when no language was
  requested — no code-sensitive consumer exists today (captions RTL is
  Unicode-heuristic, captions.ts:77); name→code table deliberately out of
  scope, noted at the mapping.
- Groq turbo can omit `words` for near-silent audio — the hint error covers
  it ("…or the audio contained no speech").
- libopus: bundled static ffmpeg has it; a user's minimal build may not —
  README sentence + run() surfaces the ffmpeg error.
- verbose_json has no per-word confidence — `conf` stays absent (never read).
- transcribe.ts → transcribe/ move: package ships `files: ["src"]`, barrel
  unchanged, no in-repo deep imports of @ossclip/core/src/transcribe.
