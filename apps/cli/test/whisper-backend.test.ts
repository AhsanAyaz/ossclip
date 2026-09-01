import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_WHISPER_MODEL,
  WHISPER_API_KEY_ENV,
  remoteWhisperHost,
  resolveWhisperBackend,
} from "../src/whisper-backend";

/**
 * Which engine transcribes (2026-09-01 weak-CPU field report). Pure over
 * (flag, config, env), so the whole matrix runs without a config file, a
 * poked process.env or a network — publishConfigured's suite, one backend
 * over.
 */
describe("resolveWhisperBackend", () => {
  it("nothing configured → local, the default that never changes under anyone", () => {
    expect(resolveWhisperBackend(undefined, {}, {})).toEqual({
      ok: true,
      backend: { kind: "local" },
    });
  });

  it("a configured URL is the whole switch — no flag needed", () => {
    expect(
      resolveWhisperBackend(undefined, { whisperUrl: "https://api.groq.com/openai/v1" }, {}),
    ).toEqual({
      ok: true,
      backend: {
        kind: "remote",
        baseUrl: "https://api.groq.com/openai/v1",
        model: DEFAULT_REMOTE_WHISPER_MODEL,
      },
    });
  });

  it("--whisper-backend local beats a configured URL — the escape hatch must be un-overridable", () => {
    const r = resolveWhisperBackend(
      "local",
      { whisperUrl: "https://api.groq.com/openai/v1" },
      { [WHISPER_API_KEY_ENV]: "gsk_x" },
    );
    expect(r).toEqual({ ok: true, backend: { kind: "local" } });
  });

  it("--whisper-backend remote with nothing configured errors, naming BOTH spellings", () => {
    const r = resolveWhisperBackend("remote", {}, {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a failure");
    expect(r.message).toContain("OSSCLIP_WHISPER_URL");
    expect(r.message).toContain("whisperUrl");
    // The fix is only actionable with the shape of the value named.
    expect(r.message).toContain("https://api.groq.com/openai/v1");
  });

  it("the API key is optional — a keyless self-hosted server is a supported install", () => {
    const keyless = resolveWhisperBackend(undefined, { whisperUrl: "http://box.local:8000/v1" }, {});
    expect(keyless).toEqual({
      ok: true,
      backend: {
        kind: "remote",
        baseUrl: "http://box.local:8000/v1",
        model: DEFAULT_REMOTE_WHISPER_MODEL,
      },
    });
    // Absent, not "": the provider sends no Authorization header at all.
    if (!keyless.ok || keyless.backend.kind !== "remote") throw new Error("expected remote");
    expect("apiKey" in keyless.backend).toBe(false);
  });

  it("the key comes from the environment only, trimmed", () => {
    const r = resolveWhisperBackend(
      undefined,
      { whisperUrl: "https://api.groq.com/openai/v1" },
      { [WHISPER_API_KEY_ENV]: "  gsk_secret  " },
    );
    expect(r).toMatchObject({ ok: true, backend: { apiKey: "gsk_secret" } });
    // A blank key reads as no key, not as an empty Bearer token.
    expect(
      resolveWhisperBackend(
        undefined,
        { whisperUrl: "https://api.groq.com/openai/v1" },
        { [WHISPER_API_KEY_ENV]: "   " },
      ),
    ).toEqual({
      ok: true,
      backend: {
        kind: "remote",
        baseUrl: "https://api.groq.com/openai/v1",
        model: DEFAULT_REMOTE_WHISPER_MODEL,
      },
    });
  });

  it("a configured model beats the Groq default; a blank one does not", () => {
    expect(
      resolveWhisperBackend(
        undefined,
        { whisperUrl: "http://box.local:8000/v1", whisperRemoteModel: " Systran/faster-whisper-large-v3 " },
        {},
      ),
    ).toMatchObject({ backend: { model: "Systran/faster-whisper-large-v3" } });
    expect(
      resolveWhisperBackend(
        undefined,
        { whisperUrl: "http://box.local:8000/v1", whisperRemoteModel: "  " },
        {},
      ),
    ).toMatchObject({ backend: { model: DEFAULT_REMOTE_WHISPER_MODEL } });
  });

  it("a whitespace-only URL is NOT configured (typeof + trim, never truthiness)", () => {
    // A hand-edited config.json with `"whisperUrl": "  "` must transcribe
    // locally, not POST to a blank host.
    expect(resolveWhisperBackend(undefined, { whisperUrl: "   " }, {})).toEqual({
      ok: true,
      backend: { kind: "local" },
    });
    // …and an explicit --whisper-backend remote over that same config is the
    // error, not a silent local run.
    expect(resolveWhisperBackend("remote", { whisperUrl: "   " }, {}).ok).toBe(false);
  });

  it("a URL is trimmed before it is used", () => {
    expect(
      resolveWhisperBackend(undefined, { whisperUrl: " https://api.groq.com/openai/v1\n" }, {}),
    ).toMatchObject({ backend: { baseUrl: "https://api.groq.com/openai/v1" } });
  });
});

describe("remoteWhisperHost", () => {
  it("is the host, for a one-line stage label", () => {
    expect(remoteWhisperHost("https://api.groq.com/openai/v1")).toBe("api.groq.com");
    expect(remoteWhisperHost("http://box.local:8000/v1")).toBe("box.local:8000");
  });

  it("falls back to the raw string rather than throwing on a bad URL", () => {
    // The value is user-typed config: the stage line must never be the thing
    // that fails — the POST that follows reports it with real context.
    expect(remoteWhisperHost("not a url")).toBe("not a url");
  });
});
