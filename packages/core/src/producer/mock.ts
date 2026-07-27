import type { z } from "zod/v4";
import type { LlmProvider } from "./provider";
import { estimateTokens, type LlmUsage } from "./usage";
import { BeatSheetSchema } from "./beats";

/**
 * Deterministic offline producer: segments the transcript into fixed-size
 * moments and cycles through a few scene kinds. Exists so the whole
 * produce path is exercisable with zero network (PHASE1 §4 "offline path is
 * first-class") — and so tests can run the exact code path `--produce` runs.
 */
export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly usage: LlmUsage[] = [];

  async complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
  }): Promise<T> {
    const result =
      req.schemaName === "beat_sheet"
        ? this.beatSheet(req.user, req.schema)
        : req.schemaName === "transcript_repair"
          ? // A deterministic no-op: the offline path must exercise the repair
            // call without inventing corrections a real provider would justify.
            req.schema.parse({ repairs: [] })
          : this.sceneProps(req.user, req.schema, req.schemaName);
    // Estimated, and costing exactly nothing — but recorded, because the
    // offline path is first-class and "how big are the prompts this pipeline
    // sends" is worth answering without spending anything to find out.
    this.usage.push({
      provider: this.name,
      schemaName: req.schemaName,
      inputTokens: estimateTokens(`${req.system}\n${req.user}`),
      outputTokens: estimateTokens(JSON.stringify(result)),
      reportedCostUsd: 0,
      exact: false,
      billed: false,
      ms: 0,
    });
    return result;
  }

  private beatSheet<T>(user: string, schema: z.ZodType<T>): T {
    const wordCount = (user.match(/\[\d+\]/g) ?? []).length;
    const kinds = ["TitleCard", "none", "StatCard", "none", "FlowDiagram", "none", "RuleCard"] as const;
    const per = Math.max(3, Math.ceil(wordCount / 6));
    const moments = [];
    for (let start = 0, k = 0; start < wordCount; start += per, k++) {
      moments.push({
        startWord: start,
        endWord: Math.min(start + per - 1, wordCount - 1),
        purpose: `beat ${k + 1}`,
        onScreenCopy: `BEAT ${k + 1}`,
        sceneKind: kinds[k % kinds.length]!,
      });
      if (moments.length >= 8) break;
    }
    const sheet = BeatSheetSchema.parse({ hook: "MOCK HOOK", moments });
    return schema.parse(sheet);
  }

  private sceneProps<T>(_user: string, schema: z.ZodType<T>, schemaName: string): T {
    const canned: Record<string, unknown> = {
      TitleCard_props: { eyebrow: "MOCK", title: "THE RAW TAKE", emphasis: "861%", sub: "becomes a clean edit" },
      StatCard_props: { label: "FILLERS REMOVED", value: "+100%", caption: "MORE SIGNAL. LESS UM.", inverted: true },
      RuleCard_props: { kicker: "PRODUCER RULE", text: "SHOW, THEN TELL", struck: "NOT: WALLS OF TEXT" },
      StrikethroughReveal_props: { lines: [{ text: "MORE WORDS", struck: true }, { text: "MORE SIGNAL", struck: false }] },
      FlowDiagram_props: { nodes: ["RAW TAKE", "CUT", "PRODUCED"], emphasizeLast: true },
      TerminalMock_props: {
        windows: [
          { title: "ossclip-01", lines: ["$ ossclip produce raw.mp4", "▸ transcribing…", "▸ cutting…"] },
          { title: "ossclip-02", lines: ["▸ rendering…", "✓ done"] },
        ],
        fanOut: "OUTPUT ×1",
      },
      ChatMock_props: { messages: [{ from: "user", text: "can it cut my ums?" }, { from: "agent", text: "already did." }] },
      ScreenshotFrame_props: { label: "REVIEW STATUS: TODAY", kenBurns: true },
    };
    const props = canned[schemaName];
    if (!props) throw new Error(`mock provider: unknown schema ${schemaName}`);
    return schema.parse(props);
  }
}
