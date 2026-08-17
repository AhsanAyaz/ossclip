import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import type { Word } from "../src/schema";
import { TimeMap } from "../src/timemap";
import type { LlmProvider } from "../src/producer/provider";
import {
  YOUTUBE_APPROVED_BASENAME,
  YOUTUBE_CHAPTER_MIN_COUNT,
  YOUTUBE_CHAPTER_MIN_GAP_SEC,
  YOUTUBE_PROMPT_VERSION,
  YOUTUBE_TAGS_LIMIT,
  YOUTUBE_TIMESTAMPS_HEADING,
  YOUTUBE_TRANSCRIPT_CHAR_CAP,
  YoutubePackSchema,
  buildYoutubePrompt,
  formatYoutubeMarkdown,
  generateYoutubePack,
  normalizeChapters,
  spliceTimestampsIntoDescription,
  stampedTranscript,
  trimTagsToLimit,
  type YoutubePack,
} from "../src/producer/youtube";

// Deliberately the PRE-v2 shape (no titleAngles, no hook60/linkedin/community):
// this exact shape is what last night's approved packs hold on disk, and the
// approved-file contract means it must parse and render forever.
const pack: YoutubePack = {
  titles: ["How agents actually work", "5 agent mistakes to stop making", "Agents in 8 minutes"],
  description: "The one agent pattern nobody explains.\n\nFull walkthrough.\n\n#agents #llm #devtools",
  hashtags: ["#agents", "llm", "#devtools"],
  tags: ["ai agents", "llm tutorial", "agents explained"],
  chapters: [
    { atSec: 0, title: "Hook" },
    { atSec: 65, title: "The pattern" },
    { atSec: 125, title: "Payoff" },
  ],
};

// The prompt-v2 shape, extras included.
const v2Pack: YoutubePack = {
  ...pack,
  titleAngles: ["browse", "search", "benefit"],
  hook60: "Show the finished dashboard at 0:05, then rewind to how.",
  linkedinPost: "I broke my agent pipeline on purpose.\n\nHere's what it taught me.\n\nLink in comments.",
  communityPost: "New video is live — the agent pattern nobody explains. Go watch!",
};

describe("YoutubePackSchema", () => {
  it("parses a full pack, chapters included", () => {
    expect(YoutubePackSchema.parse(pack)).toEqual(pack);
  });

  it("chapters are optional — a chapterless pack still parses", () => {
    const { chapters: _chapters, ...rest } = pack;
    expect(YoutubePackSchema.parse(rest).chapters).toBeUndefined();
  });

  // The approved-file back-compat pin: every prompt-v2 field is OPTIONAL, so
  // a pack approved before v2 (the `pack` fixture's exact shape) parses with
  // all of them absent — a required field here would brick every
  // youtube-pack-approved.json already on disk.
  it("a pre-v2 pack parses with every v2 field absent", () => {
    const parsed = YoutubePackSchema.parse(pack);
    expect(parsed.titleAngles).toBeUndefined();
    expect(parsed.hook60).toBeUndefined();
    expect(parsed.linkedinPost).toBeUndefined();
    expect(parsed.communityPost).toBeUndefined();
  });

  it("parses the v2 fields when present", () => {
    expect(YoutubePackSchema.parse(v2Pack)).toEqual(v2Pack);
  });

  // Enum, not string: a hallucinated angle label must fail loudly, never
  // render as a made-up bracket tag in the markdown.
  it("refuses an unknown title angle", () => {
    expect(() =>
      YoutubePackSchema.parse({ ...pack, titleAngles: ["browse", "viral", "search"] }),
    ).toThrow();
  });

  // §112 as applied in beats.ts: LLM output is untrusted input, validated
  // where the pipeline can degrade. A title one word over budget must cost a
  // word — never the run.
  it("caps an over-length title instead of refusing the pack", () => {
    const long = `${"agents ".repeat(20)}explained`; // > 100 chars
    const parsed = YoutubePackSchema.parse({ ...pack, titles: [long, "b", "c"] });
    expect(parsed.titles[0]!.length).toBeLessThanOrEqual(100);
  });

  it("fewer than 3 titles is a real refusal — that IS malformed output", () => {
    expect(() => YoutubePackSchema.parse({ ...pack, titles: ["only one"] })).toThrow();
  });
});

describe("YOUTUBE_APPROVED_BASENAME", () => {
  it("is the exact filename the editor writes and produce honors — the two must never drift", () => {
    // The thumbnail approval contract mirrored (THUMBNAIL_APPROVED_BASENAME):
    // both sides import THIS constant, and the panel copy tells users to
    // delete this literal name to regenerate.
    expect(YOUTUBE_APPROVED_BASENAME).toBe("youtube-pack-approved.json");
  });
});

describe("YOUTUBE_PROMPT_VERSION", () => {
  it("is pinned — produce's pack cache key carries it, so bumping it is the ONE regenerate lever", () => {
    // Prompt changes change the answer (the §78 posture). If a prompt edit
    // ships without bumping this, every warm workdir keeps serving packs the
    // old prompt wrote — this pin makes the bump a conscious act.
    expect(YOUTUBE_PROMPT_VERSION).toBe("v2");
  });
});

describe("trimTagsToLimit", () => {
  it("leaves a list exactly at the limit untouched (boundary)", () => {
    // Two tags whose join(", ") is exactly the limit: 249 + 2 + 249 = 500.
    const tags = ["a".repeat(249), "b".repeat(249)];
    expect(tags.join(", ")).toHaveLength(YOUTUBE_TAGS_LIMIT);
    expect(trimTagsToLimit(tags)).toEqual(tags);
  });

  it("drops from the END — relevance order means the last tag is the cheapest", () => {
    const tags = ["a".repeat(249), "b".repeat(249), "c"];
    expect(trimTagsToLimit(tags)).toEqual(tags.slice(0, 2));
  });

  it("a single tag over the limit degrades to no tags, not a crash", () => {
    expect(trimTagsToLimit(["x".repeat(YOUTUBE_TAGS_LIMIT + 1)])).toEqual([]);
  });

  it("an empty list stays empty", () => {
    expect(trimTagsToLimit([])).toEqual([]);
  });
});

describe("stampedTranscript", () => {
  const word = (text: string, start: number, end: number): Word => ({ text, start, end });
  // Two sentences in SOURCE time with a cut between them: "Hello world."
  // at 0-2s, an 8s removed gap, "Second sentence." at 10-12s.
  const words = [
    word("Hello", 0, 1),
    word("world.", 1, 2),
    word("Second", 10, 11),
    word("sentence.", 11, 12),
  ];
  const map = new TimeMap([
    { srcIn: 0, srcOut: 2, kind: "keep" },
    { srcIn: 2, srcOut: 10, kind: "remove" },
    { srcIn: 10, srcOut: 12, kind: "keep" },
  ]);

  it("stamps each sentence with its first word's OUTPUT time, not its source time", () => {
    // Source 10s is output 2s — the whole reason the stamps are trustworthy.
    expect(stampedTranscript(words, map)).toBe("[0:00] Hello world.\n[0:02] Second sentence.");
  });

  it("skips a sentence whose every word was cut — it is not in the video", () => {
    const withCut = [
      word("Hello", 0, 1),
      word("world.", 1, 2),
      word("Gone.", 4, 5), // entirely inside the removed 2..10
      word("Second", 10, 11),
      word("sentence.", 11, 12),
    ];
    expect(stampedTranscript(withCut, map)).toBe(
      "[0:00] Hello world.\n[0:02] Second sentence.",
    );
  });

  it("stamps from the first SURVIVING word when the sentence's opening was cut", () => {
    const partial = [
      word("Um", 3, 4), // cut — inside the removed 2..10
      word("kept.", 10.5, 11.5),
    ];
    // First surviving word starts at source 10.5 → output 2.5 → "0:02".
    expect(stampedTranscript(partial, map)).toBe("[0:02] Um kept.");
  });

  it("a trailing sentence without closing punctuation still stamps", () => {
    expect(stampedTranscript([word("no", 0, 1), word("period", 1, 2)], map)).toBe(
      "[0:00] no period",
    );
  });

  it("caps at maxChars by dropping WHOLE sentences and appending the excerpt note", () => {
    const many: Word[] = [];
    for (let i = 0; i < 40; i++) {
      many.push(word(`sentence-${i}`, i, i + 0.5), word("ends.", i + 0.5, i + 1));
    }
    const fullMap = new TimeMap([{ srcIn: 0, srcOut: 40, kind: "keep" }]);
    const out = stampedTranscript(many, fullMap, { maxChars: 200 });
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain("[transcript truncated — the video continues]");
    // Whole lines only: every non-note line still opens with a stamp.
    for (const line of out.split("\n").slice(0, -1)) expect(line).toMatch(/^\[\d+:\d\d\] /);
  });

  it("no note when everything fits — the default cap is the prompt's cap", () => {
    const out = stampedTranscript(words, map);
    expect(out.length).toBeLessThanOrEqual(YOUTUBE_TRANSCRIPT_CHAR_CAP);
    expect(out).not.toContain("[transcript truncated");
  });
});

describe("normalizeChapters", () => {
  const c = (atSec: number, title: string) => ({ atSec, title });
  const good = [c(0, "Hook"), c(30, "Middle"), c(60, "Payoff")];

  it("a valid list passes through unchanged (idempotence — the cache path re-normalizes)", () => {
    expect(normalizeChapters(good, 90)).toEqual(good);
    expect(normalizeChapters(normalizeChapters(good, 90), 90)).toEqual(good);
  });

  it("sorts an unsorted list ascending — the model's order is untrusted", () => {
    expect(normalizeChapters([good[2]!, good[0]!, good[1]!], 90)).toEqual(good);
  });

  it("a first chapter within the 10s minimum of 0 snaps TO 0, keeping its title", () => {
    expect(normalizeChapters([c(3, "Hook"), c(30, "Middle"), c(60, "Payoff")], 90)).toEqual(good);
  });

  it("a first chapter further out gets a synthetic 0:00 Intro — 0:00 is mandatory", () => {
    expect(normalizeChapters([c(30, "Middle"), c(45, "More"), c(60, "Payoff")], 90)).toEqual([
      c(0, "Intro"),
      c(30, "Middle"),
      c(45, "More"),
      c(60, "Payoff"),
    ]);
  });

  it("of a pair closer than 10s, the LATER one drops (the earlier stamp is the true start)", () => {
    expect(YOUTUBE_CHAPTER_MIN_GAP_SEC).toBe(10);
    expect(normalizeChapters([...good, c(65, "Too close")], 90)).toEqual(good);
  });

  it("chapters at or past the duration drop — a stamp the video never reaches", () => {
    expect(normalizeChapters([...good, c(90, "At end"), c(120, "Past end")], 90)).toEqual(good);
  });

  // Degrade-don't-die: YouTube silently ignores a list under 3 entries, so
  // shipping it would print timestamps that never become chapters — [] is
  // the honest answer.
  it("fewer than 3 surviving chapters degrades to NO chapters", () => {
    expect(YOUTUBE_CHAPTER_MIN_COUNT).toBe(3);
    expect(normalizeChapters([c(0, "Hook"), c(30, "Middle")], 90)).toEqual([]);
    // ...including when the drops above caused the shortfall.
    expect(normalizeChapters([c(0, "Hook"), c(5, "Close"), c(30, "Mid")], 32)).toEqual([]);
  });

  it("an empty list stays empty", () => {
    expect(normalizeChapters([], 90)).toEqual([]);
  });
});

describe("buildYoutubePrompt", () => {
  const base = { transcriptText: "[0:00] hello agents world", durationSec: 62.4 };

  it("includes intent, hook and cover text when given", () => {
    const { user } = buildYoutubePrompt({
      ...base,
      intent: "educational video about agents",
      hook: "MOCK HOOK",
      coverText: "AGENTS IN 60s",
    });
    expect(user).toContain("Intent: educational video about agents");
    expect(user).toContain("Hook (already chosen by the producer): MOCK HOOK");
    expect(user).toContain("Cover headline: AGENTS IN 60s");
    expect(user).toContain("Transcript:\n[0:00] hello agents world");
  });

  it("the runtime line uses the m:ss spelling and states the chapter ceiling", () => {
    expect(buildYoutubePrompt(base).user).toContain(
      "Total runtime: 1:02 — chapters must not exceed it.",
    );
  });

  it("omits the lines a run without --produce cannot supply", () => {
    const { user } = buildYoutubePrompt(base);
    expect(user).not.toContain("Intent:");
    expect(user).not.toContain("Hook");
    expect(user).not.toContain("Cover headline:");
  });

  // The audience steer (2026-08-16): titles/tags for "junior devs" are a
  // different pack than for "engineering managers" — present when supplied
  // (--audience / config `audience`), absent otherwise, the include/omit
  // shape of every optional line above.
  it("includes the audience line when given, omits it otherwise", () => {
    const { user } = buildYoutubePrompt({ ...base, audience: "junior web devs learning AI" });
    expect(user).toContain("Audience: junior web devs learning AI");
    expect(buildYoutubePrompt(base).user).not.toContain("Audience:");
  });

  it("caps the transcript at the cap and says the video continues", () => {
    const { user } = buildYoutubePrompt({
      ...base,
      transcriptText: "x".repeat(YOUTUBE_TRANSCRIPT_CHAR_CAP + 500),
    });
    expect(user).toContain("[transcript truncated — the video continues]");
    // The excerpt itself is exactly the cap, not the cap plus the overflow.
    // (x{10,}: the runtime line's own "exceed" carries a stray x.)
    expect((user.match(/x{10,}/) ?? [""])[0]).toHaveLength(YOUTUBE_TRANSCRIPT_CHAR_CAP);
  });

  it("a transcript at the cap passes through without the truncation note", () => {
    const { user } = buildYoutubePrompt({
      ...base,
      transcriptText: "x".repeat(YOUTUBE_TRANSCRIPT_CHAR_CAP),
    });
    expect(user).not.toContain("[transcript truncated");
  });

  it("the system prompt states the v2 craft rules the schema cannot", () => {
    const { system } = buildYoutubePrompt(base);
    expect(system).toContain("YouTube growth strategist");
    // The three labeled A/B angles for Test & Compare.
    expect(system).toContain("Test & Compare");
    expect(system).toContain('"browse"');
    expect(system).toContain('"search"');
    expect(system).toContain('"benefit"');
    expect(system).toContain("70 characters");
    // The search snippet is the first two lines; hashtags close it.
    expect(system).toContain("FIRST TWO lines");
    // The formatter owns the timestamps — the model writing its own would
    // duplicate (and contradict) the measured ones.
    expect(system).toContain("Do NOT write timestamp");
    // Chapters come from the measured stamps only, never estimates.
    expect(system).toContain("USING ONLY the [m:ss] stamps");
    expect(system).toContain("The first chapter is at 0");
    // The no-lying constraint survives the rewrite.
    expect(system).toContain("never make a claim the video does not deliver");
    // Deliberately ABSENT (see the module comment): competitor analysis — no
    // browsing means it would be hallucination — and a thumbnail prompt —
    // ossclip generates the real thumbnail from the real portrait.
    expect(system).not.toMatch(/competitor/i);
    expect(system).not.toMatch(/thumbnail/i);
  });
});

describe("generateYoutubePack", () => {
  // A stub provider, not the SDK-shaped MockProvider: what's under test is
  // the call shape (schemaName, tier) and the post-parse guards.
  const providerReturning = (result: unknown) => {
    const calls: { schemaName: string; tier?: string }[] = [];
    const provider: LlmProvider = {
      name: "stub",
      usage: [],
      async complete<T>(req: { schema: z.ZodType<T>; schemaName: string; tier?: string }) {
        calls.push({ schemaName: req.schemaName, tier: req.tier });
        return req.schema.parse(result);
      },
    };
    return { provider, calls };
  };

  it("asks the editorial tier for a youtube_pack and trims the tags", async () => {
    const overLimit = ["keep me", "x".repeat(YOUTUBE_TAGS_LIMIT)];
    const { provider, calls } = providerReturning({ ...pack, tags: overLimit });
    const got = await generateYoutubePack(provider, {
      transcriptText: "hello",
      durationSec: 300,
    });
    expect(calls).toEqual([{ schemaName: "youtube_pack", tier: "editorial" }]);
    expect(got.tags).toEqual(["keep me"]);
    expect(got.titles).toEqual(pack.titles);
    // durationSec 300 leaves the fixture's chapters valid — untouched.
    expect(got.chapters).toEqual(pack.chapters);
  });

  it("normalizes chapters against the real duration — an unshippable list degrades to none", async () => {
    // Only the 0:00 chapter fits inside 10s → under the 3 minimum → no
    // chapters at all, and the pack still stands (§112).
    const { provider } = providerReturning(pack);
    const got = await generateYoutubePack(provider, { transcriptText: "hello", durationSec: 10 });
    expect(got.chapters).toBeUndefined();
  });
});

describe("spliceTimestampsIntoDescription", () => {
  const chapters = [
    { atSec: 0, title: "Hook" },
    { atSec: 65, title: "The pattern" },
  ];

  it("lands the block ABOVE a trailing hashtag line — hashtags stay last", () => {
    const out = spliceTimestampsIntoDescription("First line.\n\nBody.\n\n#agents #llm", chapters);
    expect(out).toBe(
      `First line.\n\nBody.\n\n${YOUTUBE_TIMESTAMPS_HEADING}\n0:00 Hook\n1:05 The pattern\n\n#agents #llm`,
    );
  });

  it("appends at the end when the description has no hashtag line", () => {
    const out = spliceTimestampsIntoDescription("Just a body.", chapters);
    expect(out).toBe(`Just a body.\n\n${YOUTUBE_TIMESTAMPS_HEADING}\n0:00 Hook\n1:05 The pattern`);
  });

  it("a line merely CONTAINING a hashtag is body, not the hashtag line", () => {
    const out = spliceTimestampsIntoDescription("Body.\nWe cover #agents here", chapters);
    expect(out.endsWith("1:05 The pattern")).toBe(true);
  });

  it("no chapters → the description passes through untouched (trailing space trimmed)", () => {
    expect(spliceTimestampsIntoDescription("Body.\n\n#tag\n", [])).toBe("Body.\n\n#tag");
  });
});

describe("formatYoutubeMarkdown", () => {
  it("writes every section in paste order, timestamps INSIDE the description", () => {
    const md = formatYoutubeMarkdown(pack);
    const lines = md.split("\n");
    expect(lines[0]).toBe("# YouTube pack");
    expect(lines).toContain("## Title options");
    expect(lines).toContain("1. How agents actually work");
    expect(lines).toContain("3. Agents in 8 minutes");
    expect(lines).toContain("## Description");
    expect(lines).toContain("The one agent pattern nobody explains.");
    // YouTube parses chapters FROM the description — the block sits between
    // the body and the trailing hashtag line, so the section is ONE paste.
    expect(lines).toContain(YOUTUBE_TIMESTAMPS_HEADING);
    expect(lines).toContain("0:00 Hook");
    expect(lines).toContain("1:05 The pattern");
    expect(lines).toContain("2:05 Payoff");
    expect(md.indexOf(YOUTUBE_TIMESTAMPS_HEADING)).toBeLessThan(md.indexOf("#agents #llm #devtools"));
    // Embedded means embedded — the old separate section is gone.
    expect(md).not.toContain("## Chapters");
    expect(lines).toContain("## Hashtags");
    // One paste-ready line, # supplied exactly once whether or not the model
    // already spelled it.
    expect(lines).toContain("#agents #llm #devtools");
    expect(lines).toContain("## Tags (comma-separated)");
    expect(lines).toContain("ai agents, llm tutorial, agents explained");
  });

  // The pre-v2 approved-pack pin: no angles → unlabeled titles, no v2
  // sections — the file renders as it did the night it was approved.
  it("a pre-v2 pack renders without angle labels or the optional sections", () => {
    const md = formatYoutubeMarkdown(pack);
    expect(md).toContain("1. How agents actually work");
    expect(md).not.toContain("[Browse]");
    expect(md).not.toContain("## First-60s hook strategy");
    expect(md).not.toContain("## LinkedIn post");
    expect(md).not.toContain("## Community post");
  });

  it("labels each title with its angle when titleAngles is present", () => {
    const md = formatYoutubeMarkdown(v2Pack);
    expect(md).toContain("1. [Browse] How agents actually work");
    expect(md).toContain("2. [Search] 5 agent mistakes to stop making");
    expect(md).toContain("3. [Benefit] Agents in 8 minutes");
  });

  it("a title past the angles array renders bare — the label is a hint, not data", () => {
    const md = formatYoutubeMarkdown({
      ...v2Pack,
      titles: [...v2Pack.titles, "user-added fourth"],
    });
    expect(md).toContain("4. user-added fourth");
    expect(md).not.toContain("4. [");
  });

  it("renders the v2 sections when present, in order after the tags", () => {
    const md = formatYoutubeMarkdown(v2Pack);
    const hook = md.indexOf("## First-60s hook strategy");
    const linkedin = md.indexOf("## LinkedIn post");
    const community = md.indexOf("## Community post");
    expect(hook).toBeGreaterThan(md.indexOf("## Tags"));
    expect(linkedin).toBeGreaterThan(hook);
    expect(community).toBeGreaterThan(linkedin);
    expect(md).toContain("Show the finished dashboard at 0:05, then rewind to how.");
    expect(md).toContain("Link in comments.");
    expect(md).toContain("Go watch!");
  });

  it("omits the timestamp block when the pack has no chapters", () => {
    const md = formatYoutubeMarkdown({ ...pack, chapters: undefined });
    expect(md).not.toContain(YOUTUBE_TIMESTAMPS_HEADING);
    const empty = formatYoutubeMarkdown({ ...pack, chapters: [] });
    expect(empty).not.toContain(YOUTUBE_TIMESTAMPS_HEADING);
  });

  it("chaptersFromSec rebases stamps and drops chapters before the window", () => {
    const md = formatYoutubeMarkdown(pack, { chaptersFromSec: 65 });
    expect(md).toContain("0:00 The pattern");
    expect(md).toContain("1:00 Payoff");
    expect(md).not.toContain("Hook");
  });
});
