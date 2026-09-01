import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  RemoteTranscribeHttpError,
  createOpenAiCompatibleProvider,
  openaiTranscriptionsUrl,
} from "../src/transcribe";

/**
 * The remote transcription backend, driven entirely through the `fetchImpl`
 * seam (publish-postiz.test.ts's pattern): no network in CI, and the wire
 * shape — which is the entire contract with Groq/speaches — is asserted
 * field by field.
 */

let audioPath: string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "ossclip-remote-asr-"));
  audioPath = join(dir, "audio-upload.ogg");
  await writeFile(audioPath, "not really opus");
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A verbose_json body with word timestamps, the shape Groq answers with. */
function verbose(words: Array<{ word: string; start: number; end: number }>, language = "english") {
  return { task: "transcribe", language, duration: 3.2, text: "…", words };
}

/** Runs a transcription against a capturing fetch and returns both. */
async function capture(
  body: unknown,
  opts: { language?: string; prompt?: string; apiKey?: string; status?: number } = {},
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const provider = createOpenAiCompatibleProvider({
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(opts.status ?? 200, body);
    },
  });
  const transcript = await provider.transcribe(audioPath, {
    ...(opts.language !== undefined ? { language: opts.language } : {}),
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
  });
  return { transcript, calls };
}

const form = (init: RequestInit | undefined): FormData => init!.body as FormData;

describe("openaiTranscriptionsUrl", () => {
  it("appends /audio/transcriptions to the OpenAI-compatible base", () => {
    expect(openaiTranscriptionsUrl("https://api.groq.com/openai/v1")).toBe(
      "https://api.groq.com/openai/v1/audio/transcriptions",
    );
  });

  it("strips trailing slashes first", () => {
    expect(openaiTranscriptionsUrl("http://localhost:8000/v1///")).toBe(
      "http://localhost:8000/v1/audio/transcriptions",
    );
  });

  it("is idempotent on a URL that already names the endpoint", () => {
    // Someone who pastes the full endpoint out of the API docs must not end
    // up posting to /v1/audio/transcriptions/audio/transcriptions.
    const full = "https://api.groq.com/openai/v1/audio/transcriptions";
    expect(openaiTranscriptionsUrl(full)).toBe(full);
    expect(openaiTranscriptionsUrl(`${full}/`)).toBe(full);
  });
});

describe("createOpenAiCompatibleProvider — request shape", () => {
  const body = verbose([{ word: " Hello", start: 0, end: 0.4 }]);

  it("POSTs multipart to the normalized endpoint", async () => {
    const { calls } = await capture(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(calls[0]!.init!.method).toBe("POST");
    expect(calls[0]!.init!.body).toBeInstanceOf(FormData);
  });

  it("sends the model, verbose_json and the bracketed word-granularity field", async () => {
    // `timestamp_granularities[]` is the literal wire spelling OpenAI and Groq
    // accept for the array parameter — without it the answer carries segments
    // only, and everything downstream is word-stamp driven.
    const { calls } = await capture(body);
    const f = form(calls[0]!.init);
    expect(f.get("model")).toBe("whisper-large-v3-turbo");
    expect(f.get("response_format")).toBe("verbose_json");
    expect(f.get("timestamp_granularities[]")).toBe("word");
    expect((f.get("file") as File).name).toBe("audio-upload.ogg");
  });

  it("sends Bearer auth only when a key is configured — self-hosted servers are keyless", async () => {
    const withKey = await capture(body, { apiKey: "gsk_test" });
    expect(new Headers(withKey.calls[0]!.init!.headers).get("authorization")).toBe("Bearer gsk_test");
    const keyless = await capture(body);
    expect(new Headers(keyless.calls[0]!.init!.headers).get("authorization")).toBeNull();
  });

  it("omits `language` when unset AND when it is whisper.cpp's \"auto\"", async () => {
    // "auto" is whisper-cli vocabulary, not an ISO code: the HTTP API rejects
    // it, and an ABSENT field is exactly how you ask for auto-detection.
    expect(form((await capture(body)).calls[0]!.init).get("language")).toBeNull();
    expect(form((await capture(body, { language: "auto" })).calls[0]!.init).get("language")).toBeNull();
  });

  it("sends a real language code through", async () => {
    expect(form((await capture(body, { language: "ur" })).calls[0]!.init).get("language")).toBe("ur");
  });

  it("omits `prompt` unless the run has a dictionary", async () => {
    expect(form((await capture(body)).calls[0]!.init).get("prompt")).toBeNull();
    expect(form((await capture(body, { prompt: "Vocabulary: JSON." })).calls[0]!.init).get("prompt")).toBe(
      "Vocabulary: JSON.",
    );
  });

  it("refuses translate — a different endpoint and a different model upstream", async () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: "https://api.groq.com/openai/v1",
      model: "m",
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    });
    await expect(provider.transcribe(audioPath, { translate: true })).rejects.toThrow(
      /--whisper-backend local/,
    );
  });
});

describe("createOpenAiCompatibleProvider — response mapping", () => {
  it("maps word/start/end into trimmed words", async () => {
    const { transcript } = await capture(
      verbose([
        { word: " Hello", start: 0, end: 0.4 },
        { word: " everyone,", start: 0.4, end: 0.9 },
      ]),
    );
    expect(transcript.words).toEqual([
      { text: "Hello", start: 0, end: 0.4 },
      { text: "everyone,", start: 0.4, end: 0.9 },
    ]);
  });

  it("drops bracketed noise markers and words that trim to nothing", async () => {
    const { transcript } = await capture(
      verbose([
        { word: " Hello", start: 0, end: 0.4 },
        { word: " [BLANK_AUDIO]", start: 0.4, end: 0.9 },
        { word: "   ", start: 0.9, end: 1.0 },
        { word: " done", start: 1.0, end: 1.4 },
      ]),
    );
    expect(transcript.words.map((w) => w.text)).toEqual(["Hello", "done"]);
  });

  it("runs normalizeWords: a zero-length remote stamp gets the 50ms floor", async () => {
    const { transcript } = await capture(verbose([{ word: "hm", start: 2, end: 2 }]));
    expect(transcript.words[0]).toEqual({ text: "hm", start: 2, end: 2.05 });
  });

  it("clamps a negative start — WordSchema is nonnegative and a -0.01 must not fail the run", async () => {
    const { transcript } = await capture(verbose([{ word: "Hi", start: -0.01, end: 0.3 }]));
    expect(transcript.words[0]).toEqual({ text: "Hi", start: 0, end: 0.3 });
  });

  it("ignores unknown fields — servers add them freely", async () => {
    const { transcript } = await capture({
      language: "english",
      x_groq: { id: "req_1" },
      segments: [{ id: 0, text: "Hi" }],
      words: [{ word: "Hi", start: 0, end: 0.3, probability: 0.99 }],
    });
    expect(transcript.words).toEqual([{ text: "Hi", start: 0, end: 0.3 }]);
  });

  it("the requested language wins over the server's answer", async () => {
    const { transcript } = await capture(verbose([{ word: "Hi", start: 0, end: 0.3 }], "english"), {
      language: "ur",
    });
    expect(transcript.language).toBe("ur");
  });

  it("without a request language, the server's own answer comes through lowercased", async () => {
    const { transcript } = await capture(verbose([{ word: "Hi", start: 0, end: 0.3 }], "Urdu"));
    expect(transcript.language).toBe("urdu");
    const auto = await capture(verbose([{ word: "Hi", start: 0, end: 0.3 }], "EN"), {
      language: "auto",
    });
    expect(auto.transcript.language).toBe("en");
  });

  it("falls back to the schema default when the server names no language", async () => {
    const { transcript } = await capture({ words: [{ word: "Hi", start: 0, end: 0.3 }] });
    expect(transcript.language).toBe("en");
  });
});

describe("createOpenAiCompatibleProvider — failures", () => {
  it("a wordless answer names the missing capability AND the silent-audio case", async () => {
    await expect(capture({ language: "english", text: "hello" })).rejects.toThrow(
      /timestamp_granularities\[\]=word/,
    );
    await expect(capture(verbose([]))).rejects.toThrow(/contained no speech/);
  });

  it("a non-JSON answer says so with a snippet, not a bare SyntaxError", async () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: "https://api.groq.com/openai/v1",
      model: "m",
      fetchImpl: async () => new Response("<html>gateway</html>", { status: 200 }),
    });
    await expect(provider.transcribe(audioPath, {})).rejects.toThrow(/answered non-JSON.*gateway/s);
  });

  it.each([
    [401, /OSSCLIP_WHISPER_API_KEY/],
    [403, /OSSCLIP_WHISPER_API_KEY/],
    [404, /base ending in \/v1/],
    [413, /25MB/],
    [429, /8h audio\/day/],
    [500, /failed: 500/],
  ])("a %i answer throws with its hint", async (status, needle) => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: "https://api.groq.com/openai/v1",
      model: "m",
      fetchImpl: async () => new Response("boom", { status }),
    });
    await expect(provider.transcribe(audioPath, {})).rejects.toThrow(needle);
  });

  it("RemoteTranscribeHttpError carries url and status for the caller's hint line", () => {
    const err = new RemoteTranscribeHttpError("https://x/v1/audio/transcriptions", 429, "slow down");
    expect(err.status).toBe(429);
    expect(err.url).toBe("https://x/v1/audio/transcriptions");
    expect(err.message).toContain("slow down");
  });

  it("an unreachable server names the endpoint, not a bare ECONNREFUSED", async () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: "http://localhost:8000/v1",
      model: "m",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(provider.transcribe(audioPath, {})).rejects.toThrow(
      /unreachable at http:\/\/localhost:8000\/v1\/audio\/transcriptions: ECONNREFUSED/,
    );
  });

  it("aborts on the timeout, and the abort surfaces as an unreachable error", async () => {
    // No retry on the way out: a retry against a metered free tier doubles the
    // quota burn for a failure the user is about to see anyway (postiz's
    // posture).
    let calls = 0;
    const provider = createOpenAiCompatibleProvider({
      baseUrl: "https://api.groq.com/openai/v1",
      model: "m",
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          calls += 1;
          init!.signal!.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
        }),
    });
    await expect(provider.transcribe(audioPath, {})).rejects.toThrow(/unreachable at .*aborted/s);
    expect(calls).toBe(1);
  });
});
