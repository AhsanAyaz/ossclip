import { z } from "zod/v4";
import type { LlmProvider } from "./provider";
import { estimateTokens, type LlmUsage } from "./usage";

export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Convert a zod-derived JSON Schema into Gemini's `responseSchema` dialect
 * (R20 §98). The API takes an OpenAPI-style subset — no $refs, no `const`,
 * no `additionalProperties` — so this converts what it can and THROWS on
 * what it cannot; the caller falls back to prompt-stated JSON mode for that
 * call rather than sending a schema the API would reject. The critical
 * schemas (transcript repair, beat sheet, clip beat sheet) are pinned
 * convertible by unit test — those are the calls whose malformed output has
 * actually cost a run (the R20 repair failure).
 */
export function toGeminiSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null) {
    throw new Error("not a schema object");
  }
  const s = schema as Record<string, unknown>;
  if (s.$ref !== undefined) throw new Error("$ref unsupported by responseSchema");
  if (s.additionalProperties !== undefined && s.additionalProperties !== false) {
    throw new Error("open records unsupported by responseSchema");
  }

  // z.literal → {const}: Gemini has no `const`, but a one-value enum is the
  // same constraint.
  if (s.const !== undefined) {
    return { type: typeof s.const === "number" ? "number" : "string", enum: [String(s.const)] };
  }

  // .nullable() → anyOf [T, {type:"null"}]: fold into `nullable`.
  const variants = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) {
    const nonNull = variants.filter(
      (v) => !(typeof v === "object" && v !== null && (v as { type?: string }).type === "null"),
    );
    const hadNull = nonNull.length !== variants.length;
    if (nonNull.length === 1) {
      return { ...toGeminiSchema(nonNull[0]), ...(hadNull ? { nullable: true } : {}) };
    }
    // A union of string literals flattens to one enum; anything else stays
    // an anyOf, which the API accepts for genuine unions.
    const enums = nonNull.map((v) => {
      const c = toGeminiSchema(v);
      return c.type === "string" && Array.isArray(c.enum) ? (c.enum as string[]) : null;
    });
    if (enums.every((e) => e !== null)) {
      return { type: "string", enum: enums.flatMap((e) => e!), ...(hadNull ? { nullable: true } : {}) };
    }
    return { anyOf: nonNull.map(toGeminiSchema), ...(hadNull ? { nullable: true } : {}) };
  }

  const out: Record<string, unknown> = {};
  if (typeof s.type === "string") out.type = s.type;
  if (typeof s.description === "string") out.description = s.description;
  if (typeof s.format === "string" && ["enum", "date-time"].includes(s.format)) out.format = s.format;
  if (Array.isArray(s.enum)) out.enum = s.enum;
  if (typeof s.minimum === "number") out.minimum = s.minimum;
  if (typeof s.maximum === "number") out.maximum = s.maximum;
  if (s.items !== undefined) out.items = toGeminiSchema(s.items);
  if (typeof s.properties === "object" && s.properties !== null) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        toGeminiSchema(v),
      ]),
    );
    if (Array.isArray(s.required)) out.required = s.required;
  }
  if (out.type === undefined && out.properties === undefined && out.enum === undefined) {
    throw new Error("schema fragment with no representable shape");
  }
  return out;
}

/**
 * Gemini via the generateContent REST API. JSON output is constrained BOTH
 * ways (R20 §98, from the field failure where a repair response came back
 * as an unterminated string): `responseSchema` makes the decoder emit only
 * schema-valid JSON when the schema converts to the API's subset, and the
 * schema stays stated in the prompt — which is also the whole story for the
 * calls whose schema does not convert. zod remains the authority on the way
 * out either way. A MAX_TOKENS finish is reported as the truncation it is,
 * not as a JSON syntax error at some position.
 * Auth: GEMINI_API_KEY env (PHASE1 §4) or constructor arg.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  readonly usage: LlmUsage[] = [];

  constructor(
    private model: string = DEFAULT_GEMINI_MODEL,
    private apiKey: string | undefined = process.env.GEMINI_API_KEY,
    private baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  ) {}

  async complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
    maxTokens?: number;
  }): Promise<T> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not set");
    const jsonSchema = z.toJSONSchema(req.schema);
    const schemaText = JSON.stringify(jsonSchema);
    let responseSchema: Record<string, unknown> | null = null;
    try {
      responseSchema = toGeminiSchema(jsonSchema);
    } catch {
      // Not convertible (records, refs) — prompt-stated JSON mode carries it.
    }
    const maxOutputTokens = req.maxTokens ?? 16000;
    const body = {
      system_instruction: { parts: [{ text: req.system }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `${req.user}\n\n` +
                `Respond with ONLY a JSON object valid against this JSON Schema ` +
                `("${req.schemaName}"):\n${schemaText}`,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        ...(responseSchema ? { responseSchema } : {}),
        maxOutputTokens,
      },
    };
    const started = Date.now();
    const res = await fetch(
      `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    if (!res.ok) {
      throw new Error(`gemini request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
        // Thinking tokens are billed as output but reported apart from it.
        thoughtsTokenCount?: number;
      };
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
    const meta = data.usageMetadata;
    // Recorded before the failure checks — a truncated response still
    // consumed tokens, and a run that fell over is exactly when the cost of
    // getting there matters (same rule the Anthropic provider follows).
    this.usage.push({
      provider: this.name,
      model: this.model,
      schemaName: req.schemaName,
      inputTokens: meta?.promptTokenCount ?? estimateTokens(`${req.system}${req.user}`),
      outputTokens:
        meta?.candidatesTokenCount === undefined
          ? estimateTokens(text ?? "")
          : meta.candidatesTokenCount + (meta.thoughtsTokenCount ?? 0),
      cachedInputTokens: meta?.cachedContentTokenCount,
      exact: meta?.promptTokenCount !== undefined,
      billed: true,
      ms: Date.now() - started,
    });
    const finish = data.candidates?.[0]?.finishReason;
    if (finish === "MAX_TOKENS") {
      // On a thinking model the thought tokens draw from the same budget, so
      // the visible JSON can be cut off long before maxOutputTokens reads
      // "spent" — say so instead of failing as a syntax error mid-string.
      throw new Error(
        `gemini output truncated at maxOutputTokens (${maxOutputTokens}` +
          `${meta?.thoughtsTokenCount ? `, ${meta.thoughtsTokenCount} of it thinking` : ""}) — ` +
          "the call needs a bigger budget",
      );
    }
    if (!text) throw new Error(`gemini returned no text candidate (finishReason ${finish ?? "?"})`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `gemini returned invalid JSON (finishReason ${finish ?? "?"}): ` +
          `${err instanceof Error ? err.message : String(err)} — head: ${text.slice(0, 120)}`,
      );
    }
    return req.schema.parse(parsed);
  }
}
