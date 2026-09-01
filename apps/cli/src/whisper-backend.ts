import type { OssclipConfig } from "@ossclip/core";

/**
 * Which transcription backend a run uses — local whisper.cpp (the default,
 * forever) or an OpenAI-compatible `/v1/audio/transcriptions` server.
 *
 * Why (2026-09-01 field report): on a weak CPU — an i3 2nd gen — whisper is
 * the dominant cost of a produce run, and Groq's free tier makes it seconds.
 * Remote is OPT-IN: presence of a URL is the switch, so nobody's existing
 * install changes behavior by upgrading.
 *
 * `publishConfigured`'s mould (publish.ts), with one deliberate difference:
 * the API key is OPTIONAL. Self-hosted servers (speaches, whisper.cpp
 * server) run keyless, so requiring a key the way publish does would lock
 * out the privacy-minded half of the audience.
 *
 * Pure over (flag, config, env) so the whole matrix is testable without a
 * config file or a poked process.env.
 */

/** Env-only, like every other secret (env.ts's rule): keys never live in config.json. */
export const WHISPER_API_KEY_ENV = "OSSCLIP_WHISPER_API_KEY";

/**
 * Groq's word-timestamped turbo model — the one the quickstart in the README
 * points at. The default lives HERE rather than in config.ts's DEFAULTS
 * because it is only meaningful once a remote URL exists, and a self-hosted
 * box (whose model names look like "Systran/faster-whisper-large-v3") sets
 * `whisperRemoteModel` anyway.
 */
export const DEFAULT_REMOTE_WHISPER_MODEL = "whisper-large-v3-turbo";

export type WhisperBackend =
  | { kind: "local" }
  | { kind: "remote"; baseUrl: string; model: string; apiKey?: string };

export type WhisperBackendResult =
  | { ok: true; backend: WhisperBackend }
  | { ok: false; message: string };

/**
 * `--whisper-backend` (already zod-parsed by program.ts) beats the config,
 * and "local" ALWAYS wins — it is the escape hatch a user reaches for when
 * the remote server is down or the audio must not leave the machine, so it
 * can never be overridden by a URL sitting in config.json.
 *
 * A typed `--whisper-backend remote` with nothing configured is an ERROR
 * naming both spellings, not a silent fall back to local: the user asked for
 * remote precisely because local is what they are trying to avoid.
 */
export function resolveWhisperBackend(
  flag: "local" | "remote" | undefined,
  cfg: Pick<OssclipConfig, "whisperUrl" | "whisperRemoteModel">,
  env: NodeJS.ProcessEnv,
): WhisperBackendResult {
  if (flag === "local") return { ok: true, backend: { kind: "local" } };
  // typeof + trim, never truthiness: `whisperUrl: "  "` in a hand-edited
  // config.json must read as "not configured", not as a URL we then POST to.
  const url = typeof cfg.whisperUrl === "string" ? cfg.whisperUrl.trim() : "";
  if (url.length === 0) {
    if (flag === "remote") {
      return {
        ok: false,
        message:
          "--whisper-backend remote needs a transcription server: set OSSCLIP_WHISPER_URL in the " +
          'environment (or ~/.ossclip/.env), or "whisperUrl" in ~/.ossclip/config.json — the ' +
          "OpenAI-compatible base ending in /v1, e.g. https://api.groq.com/openai/v1.",
      };
    }
    return { ok: true, backend: { kind: "local" } };
  }
  const model =
    typeof cfg.whisperRemoteModel === "string" && cfg.whisperRemoteModel.trim().length > 0
      ? cfg.whisperRemoteModel.trim()
      : DEFAULT_REMOTE_WHISPER_MODEL;
  const key = env[WHISPER_API_KEY_ENV]?.trim() ?? "";
  return {
    ok: true,
    backend: {
      kind: "remote",
      baseUrl: url,
      model,
      // Omitted rather than "" when unset, so the provider sends NO
      // Authorization header at all — a keyless self-hosted server is a
      // supported configuration, not a missing key.
      ...(key.length > 0 ? { apiKey: key } : {}),
    },
  };
}

/**
 * The host for a one-line stage/status label. Falls back to the raw string
 * when `new URL` refuses it: the value is user-typed config, and a stage line
 * must never be the thing that throws — the POST that follows will report a
 * bad URL with far better context.
 */
export function remoteWhisperHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
