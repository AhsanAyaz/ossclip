import { z } from "zod/v4";
import type { LlmProvider } from "./provider";
import { YOUTUBE_TRANSCRIPT_CHAR_CAP } from "./youtube";
import { truncateAtWordBoundary } from "../publish/captions";

/**
 * Regenerate ONE network's caption from the editor's publish panel
 * (handoff 2026-08-29 item 4). The prompt carries the transcript, the
 * caption AS THE PANEL HOLDS IT (the user's manual edits included — the
 * model must see what the user sees) and the user's correction, and returns
 * replacement text only: nothing here writes to the pack or sends anything.
 *
 * Pure prompt builder separated from the provider call, the
 * `buildYoutubePrompt` split, so the include/cap matrix is testable without
 * an LLM.
 */

export const CaptionRegenSchema = z.object({ caption: z.string() });

export interface CaptionRegenArgs {
  /** The network the caption posts to ("linkedin", "x", …) — named in the
   * prompt so the rewrite keeps that platform's idiom. */
  network: string;
  /** What the panel's box holds right now, manual edits and all. */
  currentCaption: string;
  /** The user's correction — the whole reason this call exists. */
  instruction: string;
  /** The transcript as plain text — the only source of factual claims. */
  transcriptText: string;
  /** The platform's caption cap (publish/captions.ts's captionCap). */
  charCap: number;
}

/** What a truncated transcript ends with — the model must know it is reading
 * an excerpt (buildYoutubePrompt's TRUNCATION_NOTE rule, restated because
 * that constant is module-private and this note's wording is its own). */
const TRUNCATION_NOTE = "[transcript truncated — the video continues]";

/**
 * Platform idiom the model is told to write toward — the author's own
 * per-platform shapes (his voice guide), not generic social-media advice.
 * Keyed by publish provider name; absence falls through to nothing extra.
 */
const NETWORK_PRACTICES: Record<string, string> = {
  linkedin:
    "LinkedIn: the fullest version — the reader's gap first, then what was built, one " +
    "technical detail worth defending, the honest limitation inline, warm low-key close. " +
    "Short paragraphs, but never one-line 'broetry' stacked for the algorithm.",
  "linkedin-page":
    "LinkedIn page: same shape as a personal LinkedIn post — gap first, specifics over " +
    "adjectives, honest limitation inline, no broetry.",
  youtube:
    "YouTube description: plain what-it-does in the first two lines (that is all most " +
    "viewers see), keep any existing timestamps/chapters and links intact.",
  facebook:
    "Facebook: conversational, front-load the reader's problem in the first sentence, " +
    "shorter than LinkedIn.",
  instagram:
    "Instagram: short — the visual leads, the caption carries ONE specific. Links do not " +
    "work in captions, so 'link in bio' phrasing, never a raw URL. Keep existing hashtags " +
    "unless instructed.",
  threads:
    "Threads: short and conversational like Instagram; one specific, no hashtag walls.",
  x: "X: the gap and the one surprising detail — nothing padded.",
  tiktok: "TikTok: short hook line plus existing hashtags.",
};

export function buildCaptionRegenPrompt(args: CaptionRegenArgs): { system: string; user: string } {
  const system =
    "You rewrite ONE social media caption for a finished video, applying the user's " +
    "instruction. Hard rules:\n" +
    "- Every factual claim in the caption must be supported by the transcript. If the video " +
    "uses a number or story as an EXAMPLE or hypothetical, never state it as a fact — this " +
    "exact failure has shipped: a video said \"imagine 50 teams applied\" as an example, and " +
    "the published caption stated \"50 teams applied\" as fact.\n" +
    "- NEVER use an em-dash (—) or en-dash (–) anywhere in the caption. Where a pause or " +
    "soft pivot is needed, use an ellipsis (\"...\") — that is the author's voice, not a typo " +
    "to clean up.\n" +
    "- Specifics over adjectives: no \"powerful\", \"seamless\", \"game-changing\". Name the " +
    "actual number or detail, and only numbers the transcript supports.\n" +
    "- No engagement bait (\"thoughts?\", \"drop a comment\", \"who else...\"), no emoji " +
    "bullets or rocket emoji; at most a single \":)\".\n" +
    "- Respect the character cap given for this network — the platform truncates or rejects " +
    "anything longer.\n" +
    "- Keep the author's voice and structure from the current caption unless the instruction " +
    "says otherwise: this is a correction, not a rewrite from scratch.\n" +
    "- Output only the caption text, nothing else.";
  const practice = NETWORK_PRACTICES[args.network];
  // The same cap buildYoutubePrompt applies, imported rather than restated:
  // slice + say so, so the model knows it is reading an excerpt.
  const capped =
    args.transcriptText.length > YOUTUBE_TRANSCRIPT_CHAR_CAP
      ? `${args.transcriptText.slice(0, YOUTUBE_TRANSCRIPT_CHAR_CAP)}\n${TRUNCATION_NOTE}`
      : args.transcriptText;
  const user =
    `Network: ${args.network} (character cap: ${args.charCap})\n` +
    (practice ? `Platform practice: ${practice}\n` : "") +
    "\n" +
    `Current caption:\n${args.currentCaption}\n\n` +
    `Instruction from the author:\n${args.instruction}\n\n` +
    `Transcript:\n${capped}`;
  return { system, user };
}

/**
 * The em/en-dash ban enforced mechanically — the prompt asks, this
 * guarantees. Ellipsis replaces a mid-sentence dash (the author's own pause
 * idiom); a dash already followed by ellipsis-like punctuation just drops.
 */
export function stripDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, "... ").replace(/\.\.\.\s+(?=[.…])/g, "");
}

/** One editorial call → the replacement caption, capped at a word boundary
 * as the belt-and-braces backstop (the schema cannot express a length cap
 * the model is guaranteed to honor). */
export async function generateCaptionRegen(
  provider: LlmProvider,
  args: CaptionRegenArgs,
): Promise<string> {
  const { system, user } = buildCaptionRegenPrompt(args);
  const { caption } = await provider.complete({
    system,
    user,
    schema: CaptionRegenSchema,
    schemaName: "caption_regen",
    // Editorial on purpose: this rewrites the copy real accounts publish,
    // which is exactly the judgement tier the beat sheet buys.
    tier: "editorial",
  });
  return truncateAtWordBoundary(stripDashes(caption), args.charCap);
}
