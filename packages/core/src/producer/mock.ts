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
      req.schemaName === "beat_sheet" || req.schemaName === "clip_beat_sheet"
        ? this.beatSheet(req.user, req.schema, req.schemaName === "clip_beat_sheet")
        : req.schemaName === "transcript_repair"
          ? // A deterministic no-op: the offline path must exercise the repair
            // call without inventing corrections a real provider would justify.
            req.schema.parse({ repairs: [] })
          : req.schemaName === "sfx_plan"
            ? this.sfxPlan(req.user, req.schema)
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

  private beatSheet<T>(user: string, schema: z.ZodType<T>, clip: boolean): T {
    const wordCount = (user.match(/\[\d+\]/g) ?? []).length;
    // Clip mode (R19 §93): a deterministic highlight — a stretch starting 40%
    // in, sized at ~2.8 words/sec of the requested target. No timestamps here,
    // so `resolveClipWindow` does the real fitting (trim + sentence snap) on
    // the actual word stamps downstream.
    const targetSec = Number.parseFloat(/Target clip length: ~(\d+(?:\.\d+)?)s/.exec(user)?.[1] ?? "60");
    const winStart = clip ? Math.min(Math.floor(wordCount * 0.4), Math.max(0, wordCount - 2)) : 0;
    const winEnd = clip
      ? Math.min(wordCount - 1, winStart + Math.max(3, Math.round(targetSec * 2.8)))
      : wordCount - 1;
    const kinds = ["TitleCard", "none", "StatCard", "none", "FlowDiagram", "none", "RuleCard"] as const;
    const per = Math.max(3, Math.ceil((winEnd - winStart + 1) / 6));
    const moments = [];
    for (let start = winStart, k = 0; start <= winEnd; start += per, k++) {
      moments.push({
        startWord: start,
        endWord: Math.min(start + per - 1, winEnd),
        purpose: `beat ${k + 1}`,
        onScreenCopy: `BEAT ${k + 1}`,
        sceneKind: kinds[k % kinds.length]!,
      });
      if (moments.length >= 8) break;
    }
    const sheet = {
      hook: "MOCK HOOK",
      moments,
      ...(clip
        ? { highlight: { startWord: winStart, endWord: winEnd, reason: "mock: fixed 40%-in window" } }
        : {}),
    };
    return schema.parse(sheet);
  }

  /**
   * A scripted SFX plan (`--sfx`): the budget the prompt states, spread evenly
   * across the take, cycling through the menu the prompt offered.
   *
   * Reads the MENU rather than naming sounds, so the fixture pipeline keeps
   * working when the starter pack changes and so a `--sfx-level` below `meme`
   * can never be handed a meme sound the menu withheld. Evenly spread because
   * the deterministic gate is the point of the offline path: bunched
   * placements would be eaten by the 1.5s spacing pass and the fixture would
   * assert whatever survived rather than what was planned.
   */
  private sfxPlan<T>(user: string, schema: z.ZodType<T>): T {
    // The `- <id>: <whenToUse>` menu lines only — the graphics plan's bullets
    // read `- words [3..7] …`, which has no `<slug>:` head.
    const ids = [...user.matchAll(/^- ([a-z0-9-]+): /gm)].map((m) => m[1]!);
    const wordCount = (user.match(/\[\d+\]/g) ?? []).length;
    const max = Number.parseInt(/Place AT MOST (\d+) sound effects/.exec(user)?.[1] ?? "0", 10);
    const n = Math.min(Number.isFinite(max) ? max : 0, ids.length > 0 ? wordCount : 0);
    const placements = [];
    for (let k = 0; k < n; k++) {
      placements.push({
        soundId: ids[k % ids.length]!,
        // Interior anchors (k+1 of n+1): word 0 is the hook's first syllable,
        // and an effect on it fires before the viewer has heard anything.
        word: Math.min(wordCount - 1, Math.floor(((k + 1) * wordCount) / (n + 1))),
        rationale: `mock: evenly spaced placement ${k + 1} of ${n}`,
      });
    }
    return schema.parse({ placements });
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
