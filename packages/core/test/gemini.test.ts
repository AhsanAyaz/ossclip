import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { GeminiProvider, toGeminiSchema } from "../src/producer/gemini";
import { BeatSheetSchema, ClipBeatSheetSchema } from "../src/producer/beats";
import { TranscriptRepairSchema } from "../src/producer/repair";
import { repairTranscript } from "../src/producer/repair";
import type { LlmProvider } from "../src/producer/provider";
import type { Transcript } from "../src/schema";

const geminiResponse = (over: Record<string, unknown> = {}) => ({
  ok: true,
  json: async () => ({
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: JSON.stringify({ repairs: [] }) }] },
      },
    ],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
    ...over,
  }),
});

afterEach(() => vi.unstubAllGlobals());

describe("toGeminiSchema (R20 §98)", () => {
  it("the three calls that have actually failed in the field MUST convert", () => {
    // Pinned: transcript repair (the R20 field failure), beat sheet, and the
    // clip-extended beat sheet — the editorial calls a run cannot do without.
    for (const schema of [TranscriptRepairSchema, BeatSheetSchema, ClipBeatSheetSchema]) {
      const converted = toGeminiSchema(z.toJSONSchema(schema));
      expect(converted.type).toBe("object");
      expect(converted.properties).toBeDefined();
    }
  });

  it("flattens literal unions to enums and folds nullable variants", () => {
    const s = z.object({
      kind: z.union([z.literal("a"), z.literal("b"), z.literal("c")]),
      note: z.string().nullable(),
    });
    const converted = toGeminiSchema(z.toJSONSchema(s)) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(converted.properties.kind!.enum).toEqual(["a", "b", "c"]);
    expect(converted.properties.note!.nullable).toBe(true);
  });

  it("refuses open records — the provider falls back to prompt-stated JSON for those", () => {
    const record = z.object({ props: z.record(z.string(), z.unknown()) });
    expect(() => toGeminiSchema(z.toJSONSchema(record))).toThrow();
  });
});

describe("GeminiProvider structured output (R20 §98)", () => {
  const provider = () => new GeminiProvider("test-model", "test-key", "http://gemini.test");

  it("sends responseSchema when the schema converts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiResponse());
    vi.stubGlobal("fetch", fetchMock);
    await provider().complete({
      system: "s",
      user: "u",
      schema: TranscriptRepairSchema,
      schemaName: "transcript_repair",
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.type).toBe("object");
  });

  it("reports MAX_TOKENS as truncation, never as a JSON syntax error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        geminiResponse({
          candidates: [
            {
              finishReason: "MAX_TOKENS",
              content: { parts: [{ text: '{"repairs": [{"startWord": 3, "hea' }] },
            },
          ],
          usageMetadata: { promptTokenCount: 5952, candidatesTokenCount: 100, thoughtsTokenCount: 3893 },
        }),
      ),
    );
    await expect(
      provider().complete({
        system: "s",
        user: "u",
        schema: TranscriptRepairSchema,
        schemaName: "transcript_repair",
        maxTokens: 4000,
      }),
    ).rejects.toThrow(/truncated at maxOutputTokens \(4000, 3893 of it thinking\)/);
  });

  it("names invalid JSON as gemini's, with the finish reason and a head snippet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        geminiResponse({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "```json\n{}" }] } }],
        }),
      ),
    );
    await expect(
      provider().complete({
        system: "s",
        user: "u",
        schema: TranscriptRepairSchema,
        schemaName: "transcript_repair",
      }),
    ).rejects.toThrow(/gemini returned invalid JSON.*STOP/);
  });
});

describe("repair robustness (R20 §98)", () => {
  const transcript: Transcript = {
    language: "en",
    words: Array.from({ length: 800 }, (_, i) => ({
      text: `w${i}`,
      start: i * 0.5,
      end: i * 0.5 + 0.4,
    })),
  };

  it("retries once after a malformed response, and the retry's repairs land", async () => {
    let calls = 0;
    const flaky: LlmProvider = {
      name: "flaky",
      usage: [],
      complete: async <T>(req: { schema: z.ZodType<T> }): Promise<T> => {
        calls++;
        if (calls === 1) throw new Error("gemini returned invalid JSON");
        return req.schema.parse({ repairs: [] });
      },
    };
    const result = await repairTranscript(flaky, transcript);
    expect(calls).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it("still fails soft after two failures — the raw transcript renders", async () => {
    const dead: LlmProvider = {
      name: "dead",
      usage: [],
      complete: async () => {
        throw new Error("gemini output truncated at maxOutputTokens");
      },
    };
    const result = await repairTranscript(dead, transcript);
    expect(result.applied).toEqual([]);
    expect(result.error).toMatch(/truncated/);
    expect(result.transcript).toBe(transcript);
  });

  it("scales the token budget with the transcript instead of the flat 4000", async () => {
    let seen: number | undefined;
    const probe: LlmProvider = {
      name: "probe",
      usage: [],
      complete: async <T>(req: { schema: z.ZodType<T>; maxTokens?: number }): Promise<T> => {
        seen = req.maxTokens;
        return req.schema.parse({ repairs: [] });
      },
    };
    await repairTranscript(probe, transcript);
    // 800 words → 4000 + 8000 = 12000: room for a thinking model's thoughts
    // AND the JSON they precede.
    expect(seen).toBe(12000);
  });
});
