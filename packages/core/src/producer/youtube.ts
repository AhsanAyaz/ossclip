import { z } from "zod/v4";
import type { Word } from "../schema";
import type { TimeMap } from "../timemap";
import { isSentenceEnd } from "../clip";
import type { LlmProvider } from "./provider";
import { cappedText } from "./beats";

/**
 * The `--youtube` SEO pack (Y2, 2026-08-16; prompt v2 2026-08-17): title
 * options, a description with measured chapter timestamps spliced in,
 * hashtags and tags, written beside the video as `<out>.youtube.md` so the
 * upload form is a paste job instead of a second writing session.
 *
 * Free text is `cappedText`, not `.max()` — the §112 doctrine as applied in
 * beats.ts: LLM output is untrusted input, validated where the pipeline can
 * still degrade instead of at the point where it can only die. A title one
 * word over budget must cost a word, never the run.
 *
 * Two sections a human YouTube-strategist workflow would include are
 * deliberately NOT here (prompt v2 decision):
 *  - competitor analysis — the provider has no browsing, so "competitor
 *    research" would be confident hallucination dressed up as strategy;
 *  - a thumbnail prompt — ossclip GENERATES the actual thumbnail from the
 *    real portrait (thumbnail.ts), which beats prose describing an imaginary
 *    one.
 */

/**
 * Bump whenever buildYoutubePrompt changes what it asks for: a prompt change
 * changes the answer, so the Y2 pack cache key carries this (the §78
 * cache-key posture) — an old cached pack must not survive a new prompt.
 */
export const YOUTUBE_PROMPT_VERSION = "v3";

export const YoutubeChapterSchema = z.object({
  /** Output-timeline seconds — the produced video's clock, not the source's. */
  atSec: z.number().nonnegative(),
  title: cappedText(80),
});
export type YoutubeChapter = z.infer<typeof YoutubeChapterSchema>;

/**
 * The three labeled title angles for YouTube's Test & Compare A/B feature
 * (prompt v2): browse = story/curiosity for home-page CTR, search =
 * keyword/tool-name for evergreen search, benefit = the ROI claim. "alt"
 * covers any extra option past the three.
 */
export const TitleAngleSchema = z.enum(["browse", "search", "benefit", "alt"]);
export type TitleAngle = z.infer<typeof TitleAngleSchema>;

export const YoutubePackSchema = z.object({
  /** Distinct angles on the same video, not five rewordings of one. */
  titles: z.array(cappedText(100)).min(3).max(5),
  /**
   * Parallel to `titles`, one angle label each. OPTIONAL for back-compat:
   * packs approved before prompt v2 carry bare titles, and the approved-file
   * contract (YOUTUBE_APPROVED_BASENAME) means those files must keep parsing
   * verbatim forever.
   */
  titleAngles: z.array(TitleAngleSchema).optional(),
  /** Prompted for keyword-first-lines, hashtags-at-end; free-form otherwise.
   * Chapter timestamps are NOT the model's to write — the formatter splices
   * the measured ones in (spliceTimestampsIntoDescription). */
  description: z.string(),
  hashtags: z.array(z.string()),
  tags: z.array(z.string()),
  chapters: z.array(YoutubeChapterSchema).optional(),
  /** Advisory first-60-seconds retention note for the CREATOR — never pasted
   * into YouTube. Optional: pre-v2 packs never carried it. */
  hook60: cappedText(400).optional(),
  /** A ready-to-post LinkedIn announcement. Optional, pre-v2 back-compat. */
  linkedinPost: cappedText(1500).optional(),
  /** A short YouTube community post for existing subscribers. Optional. */
  communityPost: cappedText(400).optional(),
  /**
   * Ready-to-post captions for the other short-video platforms (prompt v3,
   * 2026-08-26), written by the same call that already has the transcript
   * and audience in context — a publish step that derived these from titles
   * would ship title-spam as its ceiling. Every field optional: pre-v3
   * approved packs must keep parsing verbatim forever, and `deriveCaption`
   * (publish/captions.ts) fills any gap deterministically at publish time.
   */
  platformCaptions: z
    .object({
      instagram: cappedText(2200).optional(),
      tiktok: cappedText(2200).optional(),
      x: cappedText(280).optional(),
      facebook: cappedText(2200).optional(),
    })
    .optional(),
});
export type YoutubePack = z.infer<typeof YoutubePackSchema>;

/** YouTube's hard cap on the tags field, counted over the comma-joined text. */
export const YOUTUBE_TAGS_LIMIT = 500;

/**
 * Post-parse guard for the tags field: drop tags from the END until the
 * comma-joined line fits YouTube's limit. From the end because the prompt
 * asks for relevance order — the least relevant tag is the one a budget cut
 * should cost. Degrade-don't-die (§112): the schema cannot express a
 * joined-length cap, and refusing the whole pack over an over-enthusiastic
 * tag list would discard the titles and description that were fine.
 */
export function trimTagsToLimit(tags: string[], limit: number = YOUTUBE_TAGS_LIMIT): string[] {
  const kept = [...tags];
  while (kept.length > 0 && kept.join(", ").length > limit) {
    kept.pop();
  }
  return kept;
}

/**
 * The workdir file the editor's SEO panel writes (2026-08-17), mirroring the
 * thumbnail approval contract (THUMBNAIL_APPROVED_BASENAME, thumbnail.ts):
 * once it exists, produce's Y2 block uses the pack VERBATIM — no cache
 * lookup, no LLM call — because an edited pack is the user's decision, and a
 * fresh generation would silently discard it. Holds a plain `YoutubePack`,
 * no skip variant: the `--youtube` flag itself gates the feature, so there
 * is no "opted in then declined" state for a pack the way there is for a
 * thumbnail. Deleting the file is the regenerate gesture.
 */
export const YOUTUBE_APPROVED_BASENAME = "youtube-pack-approved.json";

/**
 * How much transcript the prompt carries. Field-measured 2026-08-17: at the
 * old 10k cap a 21-minute video's chapters STOPPED AT 8:32 — the model can
 * only chapter what it reads, and a truncated transcript silently produces
 * chapters for the excerpt while looking complete. 60k chars ≈ 15k tokens
 * covers ~45 minutes of stamped talk for pennies; past that the truncation
 * note at least tells the model (and the chapters) where the coverage ends.
 * `stampedTranscript` pre-caps to this same constant, so
 * `buildYoutubePrompt`'s own cap is a backstop for raw-text callers, never a
 * second cut of stamped input.
 */
export const YOUTUBE_TRANSCRIPT_CHAR_CAP = 60_000;

/** 125 → "2:05" — YouTube's own chapter-list spelling. */
function chapterStamp(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** What a truncated stamped transcript ends with — the model must know it is
 * reading an excerpt, or it will write a description that promises only the
 * first half. */
const TRUNCATION_NOTE = "[transcript truncated — the video continues]";

/**
 * The transcript as the prompt's chapter evidence (prompt v2): one line per
 * sentence, prefixed with the sentence's first surviving word's OUTPUT time
 * as `[m:ss]`. This is the pack's unique advantage over paste-a-transcript
 * prompt tools — words carry SOURCE times and the TimeMap converts them to
 * the produced video's clock, so chapters can be measured instead of the
 * guessed "0:00 Intro" everyone else ships.
 *
 * Fully-cut sentences (every word `mapWord` → null) are skipped: they are
 * not in the video, and stamping them would hand the model timestamps that
 * point at content the viewer never sees. Pure — words + map in, string
 * out — so the mapping, the cut-skip and the cap are testable without an
 * LLM or a filesystem.
 *
 * The cap reserves room for TRUNCATION_NOTE up front, so the result NEVER
 * exceeds `maxChars` — truncated or not — and whole sentences are dropped
 * rather than sliced mid-line, which would leave a dangling stamp.
 */
export function stampedTranscript(
  words: readonly Word[],
  map: TimeMap,
  opts: { maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? YOUTUBE_TRANSCRIPT_CHAR_CAP;
  // isSentenceEnd reads punctuation off Transcript-shaped input.
  const t = { language: "en", words: [...words] };
  const budget = maxChars - TRUNCATION_NOTE.length - 1;
  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    if (i < words.length - 1 && !isSentenceEnd(t, i)) continue;
    const sentence = words.slice(start, i + 1);
    start = i + 1;
    // The stamp is the first SURVIVING word's output time, not the first
    // word's: a sentence whose opening filler was cut starts, on the
    // viewer's clock, at the first word they hear.
    let stampSec: number | null = null;
    for (const w of sentence) {
      const mapped = map.mapWord(w);
      if (mapped) {
        stampSec = mapped.start;
        break;
      }
    }
    if (stampSec === null) continue; // the whole sentence was cut
    const line = `[${chapterStamp(stampSec)}] ${sentence.map((w) => w.text).join(" ")}`;
    const cost = lines.length === 0 ? line.length : line.length + 1;
    if (used + cost > budget) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += cost;
  }
  if (truncated) lines.push(TRUNCATION_NOTE);
  return lines.join("\n");
}

/** YouTube ignores a chapter list whose entries run shorter than this. */
export const YOUTUBE_CHAPTER_MIN_GAP_SEC = 10;
/** ...or that carries fewer timestamps than this. */
export const YOUTUBE_CHAPTER_MIN_COUNT = 3;

/**
 * Post-parse guard for the chapters field — trimTagsToLimit's posture
 * applied to YouTube's chapter rules, which the schema cannot express:
 * the list must start at 0:00, hold ≥3 entries, and give every chapter
 * ≥10 seconds, or YouTube silently ignores the WHOLE list. Degrade-don't-die
 * (§112): repair what can be repaired, drop what cannot, and return [] —
 * "no chapters", which the formatter renders as no timestamp block — rather
 * than ship a list YouTube would reject wholesale anyway.
 *
 *  - unsorted input sorts ascending (the model's list order is untrusted);
 *  - chapters at or past the video's end are dropped — a stamp the video
 *    never reaches is a hallucinated one;
 *  - a first chapter within the 10s minimum of 0 snaps TO 0 (it IS the
 *    intro, mis-stamped); one further out gets a synthetic 0:00 "Intro"
 *    prepended — the unnamed opening is real content, and 0:00 is mandatory;
 *  - of a pair closer than 10s, the LATER one drops (the earlier stamp is
 *    the section's true start).
 */
export function normalizeChapters(
  chapters: readonly YoutubeChapter[],
  durationSec: number,
): YoutubeChapter[] {
  const sorted = [...chapters]
    .sort((a, b) => a.atSec - b.atSec)
    .filter((c) => c.atSec < durationSec);
  if (sorted.length === 0) return [];
  const first = sorted[0]!;
  const list: YoutubeChapter[] =
    first.atSec === 0
      ? sorted
      : first.atSec < YOUTUBE_CHAPTER_MIN_GAP_SEC
        ? [{ ...first, atSec: 0 }, ...sorted.slice(1)]
        : [{ atSec: 0, title: "Intro" }, ...sorted];
  const kept: YoutubeChapter[] = [];
  for (const c of list) {
    const prev = kept[kept.length - 1];
    if (prev === undefined || c.atSec - prev.atSec >= YOUTUBE_CHAPTER_MIN_GAP_SEC) kept.push(c);
  }
  return kept.length >= YOUTUBE_CHAPTER_MIN_COUNT ? kept : [];
}

export interface YoutubePromptArgs {
  /** The stamped transcript (stampedTranscript) — sentences prefixed with
   * their `[m:ss]` output-clock time. Plain text still works (raw-text
   * callers just get no measured chapters worth trusting). */
  transcriptText: string;
  /** `--intent`, when the run had one. */
  intent?: string;
  /** The producer's hook, when a beat sheet exists — the strongest claim. */
  hook?: string;
  /** The cover banner text, when a beat sheet wrote one. */
  coverText?: string;
  /**
   * Who watches the channel (`--audience` / config `audience`, 2026-08-16):
   * titles and tags for "junior devs learning agents" are a different pack
   * than for "engineering managers", and only the user knows which one this
   * channel is.
   */
  audience?: string;
  /** Output duration in seconds — the ceiling no chapter may pass. */
  durationSec: number;
}

/**
 * Pure prompt builder, separated from the provider call so the
 * include/omit matrix (intent, hook, coverText, audience) and the transcript
 * cap are testable without an LLM.
 */
export function buildYoutubePrompt(args: YoutubePromptArgs): { system: string; user: string } {
  const system =
    "You are an expert YouTube growth strategist writing upload metadata for a finished video. " +
    "The transcript's sentences are each prefixed with a [m:ss] timestamp on the FINAL video's " +
    "clock — measured from the actual edit, not estimated. Match the creator's tone from the " +
    "transcript, and never make a claim the video does not deliver: click-drivers that deliver, " +
    "not clickbait.\n" +
    "- titles: 3-5 options for YouTube's Test & Compare A/B feature, each a DISTINCT angle, " +
    "labeled in the parallel titleAngles array: \"browse\" — story/curiosity, zero jargon, " +
    "before/after tension, built for home-page CTR; \"search\" — keyword-heavy, names the exact " +
    "tools and technologies, built for evergreen search; \"benefit\" — the ROI, \"do X in N " +
    "minutes\". Include at least one of each of those three; label any extra option \"alt\". " +
    "Target at most 70 characters (search results truncate around 70, browse cards earlier).\n" +
    "- description: the FIRST TWO lines are the search snippet — the primary keyword plus a " +
    "curiosity hook. Then a body of short paragraphs or bullets carrying the secondary keywords, " +
    "a call to action near the end, and 3-5 hashtags as the LAST line. Do NOT write timestamp " +
    "or chapter lines in the description — the measured chapter timestamps are spliced in " +
    "automatically.\n" +
    "- hashtags: the same 3-5, as an array.\n" +
    "- tags: search keywords and phrases a viewer would type, ordered by relevance — the most " +
    "important first.\n" +
    "- chapters: 4-10, USING ONLY the [m:ss] stamps that appear in the transcript — atSec is " +
    "that stamp converted to seconds, never a time you estimated. The first chapter is at 0. " +
    "Titles at most 50 characters, keyword-bearing but written for a human scanning the list.\n" +
    "- hook60: a first-60-seconds retention note for the CREATOR (it is never published) — e.g. " +
    "\"show the final result at 0:05, then rewind to how\" — grounded in what this transcript " +
    "actually opens with.\n" +
    "- linkedinPost: a story-driven LinkedIn post about this video: short lines with line " +
    "breaks, a curiosity gap, no hashtag spam, ending by pointing to the link in the comments " +
    "(the LinkedIn convention for off-platform links).\n" +
    "- communityPost: a short, casual YouTube community post for existing subscribers.\n" +
    "- platformCaptions: ready-to-post captions for the OTHER platforms this short goes to, " +
    "each written for that platform's culture, not copies of each other: \"instagram\" — a " +
    "hook line, short scannable lines, 3-5 hashtags at the end (max 2200 chars); \"tiktok\" — " +
    "casual and direct, 2-4 hashtags (max 2200 chars); \"x\" — ONE punchy post, max 280 " +
    "characters INCLUDING hashtags, no link (links go in a reply); \"facebook\" — " +
    "conversational, a question or hook up front, minimal hashtags (max 2200 chars).";
  const capped =
    args.transcriptText.length > YOUTUBE_TRANSCRIPT_CHAR_CAP
      ? // Slice + say so: the model must know it is reading an excerpt, or it
        // will write a description that promises only the first half.
        `${args.transcriptText.slice(0, YOUTUBE_TRANSCRIPT_CHAR_CAP)}\n${TRUNCATION_NOTE}`
      : args.transcriptText;
  const user =
    (args.intent ? `Intent: ${args.intent}\n` : "") +
    (args.hook ? `Hook (already chosen by the producer): ${args.hook}\n` : "") +
    (args.coverText ? `Cover headline: ${args.coverText}\n` : "") +
    (args.audience ? `Audience: ${args.audience}\n` : "") +
    `Total runtime: ${chapterStamp(args.durationSec)} — chapters must not exceed it.\n\n` +
    `Transcript:\n${capped}`;
  return { system, user };
}

/** One editorial call → a validated, tag-trimmed, chapter-normalized pack. */
export async function generateYoutubePack(
  provider: LlmProvider,
  args: YoutubePromptArgs,
): Promise<YoutubePack> {
  const { system, user } = buildYoutubePrompt(args);
  const pack = await provider.complete({
    system,
    user,
    schema: YoutubePackSchema,
    schemaName: "youtube_pack",
    tier: "editorial",
  });
  // Both post-parse guards live HERE, beside the call, so every path that
  // stores the pack (the Y2 cache, the approved file) already holds a
  // publishable one. An empty normalized list degrades to "no chapters"
  // (undefined), which the formatter renders as no timestamp block.
  const chapters = normalizeChapters(pack.chapters ?? [], args.durationSec);
  return {
    ...pack,
    tags: trimTagsToLimit(pack.tags),
    chapters: chapters.length > 0 ? chapters : undefined,
  };
}

/** The heading the timestamp block opens with inside the description. */
export const YOUTUBE_TIMESTAMPS_HEADING = "⏱️ Timestamps:";

/** A line that is nothing but hashtags — the description's prompted last
 * line, which the timestamp splice must stay above. */
function isHashtagLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/);
  return tokens.length > 0 && tokens.every((t) => t.startsWith("#") && t.length > 1);
}

/**
 * Splice the measured chapter list INTO the description text — YouTube
 * parses chapters FROM the description, so a separate list beside it would
 * make the user hand-merge two blocks the file exists to spare them. The
 * block lands after the body but ABOVE a trailing hashtag line when the
 * description has one (the prompt asks for hashtags last, and search treats
 * that placement specially). Pure and exported so the above/below matrix is
 * testable on its own.
 */
export function spliceTimestampsIntoDescription(
  description: string,
  chapters: readonly YoutubeChapter[],
): string {
  const body = description.trimEnd();
  if (chapters.length === 0) return body;
  const block = [
    YOUTUBE_TIMESTAMPS_HEADING,
    ...chapters.map((c) => `${chapterStamp(c.atSec)} ${c.title}`),
  ].join("\n");
  const lines = body.split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (lines.length > 1 && isHashtagLine(last)) {
    const head = lines.slice(0, -1).join("\n").trimEnd();
    return `${head}\n\n${block}\n\n${last}`;
  }
  return `${body}\n\n${block}`;
}

/** How a titleAngle spells inside the markdown's numbered list. */
const ANGLE_LABELS: Record<TitleAngle, string> = {
  browse: "Browse",
  search: "Search",
  benefit: "Benefit",
  alt: "Alt",
};

/**
 * The pack as the markdown file a user pastes from. Pure — the produce
 * orchestration owns the write.
 *
 * Chapters render INSIDE the description (spliceTimestampsIntoDescription),
 * not as their own section: the description is the one paste target, and a
 * separate `## Chapters` block was a second copy of the same lines. The
 * optional prompt-v2 sections (hook strategy, LinkedIn, community) render
 * only when the pack carries them, so a pre-v2 pack formats exactly as it
 * always did.
 *
 * `chaptersFromSec` rebases chapter stamps by subtracting it (dropping any
 * chapter that would land before 0), for a caller whose chapters are on some
 * other clock than the output's. Default 0 — stamps pass through.
 */
export function formatYoutubeMarkdown(
  pack: YoutubePack,
  opts: { chaptersFromSec?: number } = {},
): string {
  const lines: string[] = ["# YouTube pack", "", "## Title options", ""];
  pack.titles.forEach((t, i) => {
    // Labels only when the pack carries angles (prompt v2); a mismatched or
    // missing entry renders the bare title — the label is a hint, not data
    // the paste depends on.
    const angle = pack.titleAngles?.[i];
    lines.push(`${i + 1}. ${angle !== undefined ? `[${ANGLE_LABELS[angle]}] ` : ""}${t}`);
  });
  const from = opts.chaptersFromSec ?? 0;
  const chapters = (pack.chapters ?? [])
    .filter((c) => c.atSec - from >= 0)
    .map((c) => ({ ...c, atSec: c.atSec - from }));
  lines.push(
    "",
    "## Description",
    "",
    spliceTimestampsIntoDescription(pack.description, chapters),
    "",
    "## Hashtags",
    "",
  );
  // Paste-ready: one line, every entry carrying its # exactly once whether or
  // not the model already spelled it.
  lines.push(pack.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" "));
  lines.push("", "## Tags (comma-separated)", "", pack.tags.join(", "));
  if (pack.hook60) lines.push("", "## First-60s hook strategy", "", pack.hook60.trimEnd());
  if (pack.linkedinPost) lines.push("", "## LinkedIn post", "", pack.linkedinPost.trimEnd());
  if (pack.communityPost) lines.push("", "## Community post", "", pack.communityPost.trimEnd());
  const captions = pack.platformCaptions;
  if (captions) {
    const order = [
      ["Instagram", captions.instagram],
      ["TikTok", captions.tiktok],
      ["X", captions.x],
      ["Facebook", captions.facebook],
    ] as const;
    for (const [label, text] of order) {
      if (text) lines.push("", `## ${label} caption`, "", text.trimEnd());
    }
  }
  return `${lines.join("\n")}\n`;
}
