import { z } from "zod/v4";
import type { LlmProvider } from "./provider";
import { estimateTokens, type LlmUsage } from "./usage";

export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Gemini via the generateContent REST API in JSON mode. The schema is stated
 * in the prompt and enforced client-side with zod — simpler and more portable
 * than responseSchema (which supports only a subset of JSON Schema).
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
    const schemaText = JSON.stringify(z.toJSONSchema(req.schema));
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
        maxOutputTokens: req.maxTokens ?? 16000,
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
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
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
    if (!text) throw new Error("gemini returned no text candidate");
    return req.schema.parse(JSON.parse(text));
  }
}
