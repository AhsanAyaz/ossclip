import { describe, expect, it } from "vitest";
import {
  CAPTION_CAPS,
  DEFAULT_CAPTION_CAP,
  captionCap,
  captionForProvider,
  deriveCaption,
  truncateAtWordBoundary,
} from "../src/publish/captions";
import type { YoutubePack } from "../src/producer/youtube";

const basePack: YoutubePack = {
  titles: ["How agents actually work", "Agents in 8 minutes", "Stop guessing at agents"],
  description: "body",
  hashtags: ["#agents", "llm"],
  tags: ["agents"],
};

describe("truncateAtWordBoundary", () => {
  it("returns short text untouched", () => {
    expect(truncateAtWordBoundary("hello world", 280)).toBe("hello world");
  });

  it("drops the partial word, never slices mid-word", () => {
    // Cap lands inside "world" — the whole word goes, not its head.
    expect(truncateAtWordBoundary("hello world", 8)).toBe("hello");
  });

  it("hard-slices a single word longer than the cap (no space to back up to)", () => {
    expect(truncateAtWordBoundary("a".repeat(300), 10)).toBe("a".repeat(10));
  });
});

describe("deriveCaption", () => {
  it("is first title + #-normalized hashtags", () => {
    // "llm" arrives bare — the derive normalizes it the way the markdown
    // formatter already does, so a pack author never has to care.
    expect(deriveCaption(basePack, "instagram")).toBe(
      "How agents actually work\n\n#agents #llm",
    );
  });

  it("respects the x 280-char cap", () => {
    const long: YoutubePack = { ...basePack, titles: ["word ".repeat(100).trim()] };
    const caption = deriveCaption(long, "x");
    expect(caption.length).toBeLessThanOrEqual(280);
    expect(caption.endsWith("word")).toBe(true);
  });
});

describe("captionCap", () => {
  it("x is 280, unknown providers get the default", () => {
    expect(CAPTION_CAPS.x).toBe(280);
    expect(captionCap("x")).toBe(280);
    expect(captionCap("mastodon")).toBe(DEFAULT_CAPTION_CAP);
  });
});

describe("captionForProvider", () => {
  it("the pack's own platform caption wins over the derived fallback", () => {
    const pack: YoutubePack = {
      ...basePack,
      platformCaptions: { tiktok: "authored tiktok caption" },
    };
    expect(captionForProvider(pack, "tiktok")).toBe("authored tiktok caption");
  });

  it("linkedin maps to the v2 linkedinPost field", () => {
    const pack: YoutubePack = { ...basePack, linkedinPost: "authored linkedin post" };
    expect(captionForProvider(pack, "linkedin")).toBe("authored linkedin post");
  });

  it("a pre-v3 pack (no platformCaptions) falls back to derive", () => {
    expect(captionForProvider(basePack, "facebook")).toBe(deriveCaption(basePack, "facebook"));
  });

  it("an authored caption over the cap is capped — an approved pack is user data, validated not trusted", () => {
    const pack: YoutubePack = {
      ...basePack,
      platformCaptions: { x: undefined },
      linkedinPost: undefined,
    };
    // Route an over-cap authored caption through: x cap is 280.
    const over: YoutubePack = {
      ...basePack,
      platformCaptions: { x: "word ".repeat(80).trim().slice(0, 280) },
    };
    expect(captionForProvider(over, "x").length).toBeLessThanOrEqual(280);
    expect(captionForProvider(pack, "x").length).toBeLessThanOrEqual(280);
  });
});
