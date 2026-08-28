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

  it("threads is 500 — its own hard limit, not the generic default", () => {
    // 2026-08-28, found by connecting a real Threads account: the provider
    // had no entry, so it inherited DEFAULT_CAPTION_CAP (1500) and an
    // authored caption between 500 and 1500 chars would be sent over the
    // platform's limit — rejected or silently cut by Threads, either way
    // not what the pack said.
    expect(captionCap("threads")).toBe(500);
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

  it("linkedin-page reads linkedinPost too — a company page is still LinkedIn", () => {
    // The 2026-08-27 live E2E's third catch: Postiz reports a company page as
    // the `linkedin-page` provider, which fell through every arm here and got
    // the title-plus-hashtags floor while the personal feed got the authored
    // post. Same network, same idiom, same 1500-char cap — one pack field
    // serves both, and a page publishing a 94-char stub next to the personal
    // account's 983-char post is nobody's intent.
    const pack: YoutubePack = { ...basePack, linkedinPost: "authored linkedin post" };
    expect(captionForProvider(pack, "linkedin-page")).toBe("authored linkedin post");
    expect(captionCap("linkedin-page")).toBe(1500);
  });

  it("youtube's caption IS the pack's description — the field written for exactly that box", () => {
    // 2026-08-28, found by connecting a real YouTube channel: the title
    // mapped (`buildPublishPosts` sets it from `titles[0]`) but the caption
    // fell through every arm to the title-plus-hashtags floor, so a pack
    // carrying a full YouTube description published 94 characters of it.
    // `description` is the one pack field whose whole purpose is this box.
    const pack: YoutubePack = { ...basePack, description: "The full YouTube description." };
    expect(captionForProvider(pack, "youtube")).toBe("The full YouTube description.");
    expect(captionCap("youtube")).toBe(5000);
  });

  it("an empty description still falls back to derive rather than publishing nothing", () => {
    const pack: YoutubePack = { ...basePack, description: "   " };
    expect(captionForProvider(pack, "youtube")).toBe(deriveCaption(pack, "youtube"));
  });

  it("threads borrows the INSTAGRAM caption, trimmed to its own 500-char limit", () => {
    // Threads has no field of its own in the pack, and the pack is the only
    // author (this module never invents copy — the module docstring's rule).
    // Instagram is the closest idiom the pack actually writes: same company,
    // same audience, same short-video framing. The 500 cap still applies, so
    // a long Instagram caption arrives trimmed at a word boundary rather
    // than rejected by Threads.
    const pack: YoutubePack = {
      ...basePack,
      platformCaptions: { instagram: "authored instagram caption" },
    };
    expect(captionForProvider(pack, "threads")).toBe("authored instagram caption");
    const long: YoutubePack = {
      ...basePack,
      platformCaptions: { instagram: "word ".repeat(200).trim() },
    };
    const trimmed = captionForProvider(long, "threads");
    expect(trimmed.length).toBeLessThanOrEqual(500);
    expect(trimmed.endsWith("word")).toBe(true);
  });

  it("threads with no instagram caption still derives rather than publishing nothing", () => {
    expect(captionForProvider(basePack, "threads")).toBe(deriveCaption(basePack, "threads"));
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
