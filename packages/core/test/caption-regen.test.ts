import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import {
  CaptionRegenSchema,
  buildCaptionRegenPrompt,
  generateCaptionRegen,
  stripDashes,
} from "../src/producer/caption-regen";
import { YOUTUBE_TRANSCRIPT_CHAR_CAP } from "../src/producer/youtube";
import type { LlmProvider } from "../src/producer/provider";
import type { LlmUsage } from "../src/producer/usage";

const args = {
  network: "linkedin",
  currentCaption: "50 teams applied. Here's what happened next.",
  instruction: "the 50 teams figure was an example, not a real number",
  transcriptText: "imagine fifty teams applied to your hackathon tomorrow",
  charCap: 1500,
};

describe("buildCaptionRegenPrompt", () => {
  it("carries the network, cap, current caption, instruction and transcript", () => {
    const { system, user } = buildCaptionRegenPrompt(args);
    expect(user).toContain("Network: linkedin (character cap: 1500)");
    expect(user).toContain(args.currentCaption);
    expect(user).toContain(args.instruction);
    expect(user).toContain(args.transcriptText);
    // The rule the feature exists for: an example in the video must never
    // publish as a fact.
    expect(system).toContain("EXAMPLE");
    expect(system).toContain("supported by the transcript");
  });

  it("caps the transcript at YOUTUBE_TRANSCRIPT_CHAR_CAP and says so", () => {
    const long = "word ".repeat(20_000); // 100k chars, well past the 60k cap
    const { user } = buildCaptionRegenPrompt({ ...args, transcriptText: long });
    expect(user).toContain("[transcript truncated — the video continues]");
    // The transcript portion is the slice, not the whole 100k.
    const transcriptPart = user.slice(user.indexOf("Transcript:\n"));
    expect(transcriptPart.length).toBeLessThan(YOUTUBE_TRANSCRIPT_CHAR_CAP + 200);
  });

  it("leaves a transcript under the cap alone — no truncation note on a full read", () => {
    const { user } = buildCaptionRegenPrompt(args);
    expect(user).not.toContain("[transcript truncated");
  });

  it("bans dashes and names the platform practice — the author's voice rules", () => {
    const { system, user } = buildCaptionRegenPrompt(args);
    expect(system).toContain("NEVER use an em-dash");
    expect(system).toContain("ellipsis");
    expect(user).toContain("Platform practice: LinkedIn:");
  });

  it("says nothing about practice for a network without one", () => {
    const { user } = buildCaptionRegenPrompt({ ...args, network: "mastodon" });
    expect(user).not.toContain("Platform practice:");
  });
});

describe("stripDashes", () => {
  it("replaces a mid-sentence em/en dash with the author's ellipsis pause", () => {
    expect(stripDashes("built it — shipped it")).toBe("built it... shipped it");
    expect(stripDashes("built it – shipped it")).toBe("built it... shipped it");
  });

  it("leaves dash-free text byte-identical", () => {
    const text = "plain text... with hyphens like re-encode left alone";
    expect(stripDashes(text)).toBe(text);
  });
});

/** MockProvider's shape, sized to this one call: records usage, answers the
 * schema — so the generate path runs the exact provider seam produce uses. */
class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly usage: LlmUsage[] = [];
  lastReq: { system: string; user: string; schemaName: string; tier?: string } | undefined;
  constructor(private readonly caption: string) {}
  async complete<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
    tier?: "editorial" | "mechanical";
  }): Promise<T> {
    this.lastReq = req;
    this.usage.push({
      provider: this.name,
      schemaName: req.schemaName,
      inputTokens: 10,
      outputTokens: 5,
      exact: true,
      billed: false,
    });
    return req.schema.parse({ caption: this.caption });
  }
}

describe("generateCaptionRegen", () => {
  it("calls the editorial tier with the caption_regen schema and returns the caption", async () => {
    const provider = new FakeProvider("Fixed caption, example clearly labeled.");
    const result = await generateCaptionRegen(provider, args);
    expect(result).toBe("Fixed caption, example clearly labeled.");
    expect(provider.lastReq?.schemaName).toBe("caption_regen");
    expect(provider.lastReq?.tier).toBe("editorial");
    expect(provider.lastReq?.user).toContain(args.instruction);
    expect(provider.usage).toHaveLength(1);
  });

  it("word-boundary truncates a caption the model over-wrote — the belt-and-braces cap", async () => {
    const provider = new FakeProvider("alpha bravo charlie delta echo");
    const result = await generateCaptionRegen(provider, { ...args, charCap: 14 });
    // 14 chars slices mid-"charlie"; the partial word drops.
    expect(result).toBe("alpha bravo");
  });
});

describe("CaptionRegenSchema", () => {
  it("refuses a shape without a caption string — parsed, never coerced", () => {
    expect(CaptionRegenSchema.safeParse({ caption: 42 }).success).toBe(false);
    expect(CaptionRegenSchema.safeParse({}).success).toBe(false);
    expect(CaptionRegenSchema.safeParse({ caption: "ok" }).success).toBe(true);
  });
});
