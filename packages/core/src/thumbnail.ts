import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { LlmProvider } from "./producer/provider";
import { cappedText } from "./producer/beats";
import { coverHeadline } from "./cover";

/**
 * The `--youtube` AI thumbnail (Y3, 2026-08-16): a Gemini-generated 16:9
 * image built from the creator's portrait photo plus an LLM-written concept,
 * written beside the video as `<out>.thumbnail.png`. Strictly additive — the
 * frame-grab cover pipeline is untouched, and every failure here degrades to
 * "the cover stands".
 *
 * Everything in this file except `generateThumbnailImage` is pure: the
 * skip/generate decision, both prompt builders and the response-byte
 * extraction are all testable without a network, an API key, or the SDK.
 */

/**
 * User-specified slug (2026-08-16); config `thumbnailModel` overrides. The
 * slug is taken on faith — an API rejection surfaces VERBATIM and is never
 * retried, the isNonRetryableAgyFailure posture (FINDINGS §132): a bad model
 * name is deterministic, so a retry loop only burns quota restating it.
 */
export const THUMBNAIL_MODEL_DEFAULT = "gemini-3.1-flash-lite-image";

export type ThumbnailDecision =
  | "generate"
  | "skip-no-youtube"
  | "skip-no-portrait"
  | "skip-no-key"
  | "skip-portrait-missing";

/**
 * Whether a run generates an AI thumbnail, as one pure function so the whole
 * matrix is a table test. Ordered by how early the user could have known:
 * the feature is off (no --youtube), never configured (no portrait path),
 * unauthenticated (no GEMINI_API_KEY — env-only, secrets never live in
 * config.json, env.ts rule), and only then the runtime surprise (a portrait
 * path that points at nothing). The graceful-fallback contract is the user
 * decision of 2026-08-16: portrait/key missing → the frame-grab cover stands.
 */
export function thumbnailDecision(
  youtube: boolean,
  portraitPath: string | undefined,
  hasKey: boolean,
  portraitExists: boolean,
): ThumbnailDecision {
  if (!youtube) return "skip-no-youtube";
  if (!portraitPath) return "skip-no-portrait";
  if (!hasKey) return "skip-no-key";
  if (!portraitExists) return "skip-portrait-missing";
  return "generate";
}

/**
 * Portrait formats the Gemini API accepts as `inlineData`, keyed by lowercase
 * extension. A map, not a sniff: the file was pointed at by the user
 * (`--portrait` / config `portrait`), and an extension outside this table is
 * a loud skip at the call site rather than a guessed mime type the API
 * rejects with a worse message.
 */
export const PORTRAIT_MIME_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** `photo.PNG` → `image/png`; anything outside the table → undefined. */
export function portraitMimeType(path: string): string | undefined {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext ? PORTRAIT_MIME_TYPES[ext] : undefined;
}

/**
 * The LLM-written concept the image prompt is built from. `cappedText`, not
 * `.max()` — §112 as applied in beats.ts: LLM output is untrusted input, and
 * a concept one word over budget must cost a word, never the thumbnail.
 * `overlayText` is ADDITIONALLY passed through `coverHeadline` by the caller
 * to cap WORDS — the schema caps characters, but overlay text at thumbnail
 * size has the same 4-9 word ceiling a cover banner does (§35).
 */
export const ThumbnailConceptSchema = z.object({
  /** One vivid scene — what the image shows. */
  scene: cappedText(300),
  /** The 3-6 word text rendered ON the image, verbatim. */
  overlayText: cappedText(60),
  /** Palette, lighting, mood — craft direction for the image model. */
  styleNotes: cappedText(300),
});
export type ThumbnailConcept = z.infer<typeof ThumbnailConceptSchema>;

/**
 * The §35 WORD cap on overlay text, as the ONE helper every concept-accepting
 * path calls (2026-08-17, editor thumbnail panel): thumbnailStep, the
 * pre-render approval, the interactive edit parser and the editor's
 * regenerate endpoint must all produce byte-identical text — the overlay
 * feeds `thumbnailImageCacheName`, so two spellings of this cap would mint
 * two cache keys for one concept. `|| raw` keeps the schema-capped text when
 * coverHeadline rejects the whole line (e.g. all-stopword): an overlay the
 * user typed must never silently become an EMPTY overlay.
 */
export function approvedOverlayText(raw: string): string {
  return coverHeadline(raw) || raw;
}

/**
 * The workdir image cache's filename: model + the concept actually prompted +
 * the portrait's CONTENT (sha1 of its bytes, not its path or mtime — a
 * swapped portrait at the same path must regenerate). Extracted from
 * thumbnailStep (2026-08-17) because the editor's regenerate endpoint writes
 * the same cache, and a second spelling of the key would let the two callers
 * cache past each other. The concept is serialized with the field order
 * PINNED here rather than trusting the caller's object: both callers build
 * concepts through `ThumbnailConceptSchema`, whose parse order this matches,
 * so existing caches stay valid — and a future caller with a hand-built
 * object cannot silently re-key everything by ordering its literal
 * differently.
 */
export function thumbnailImageCacheName(
  model: string,
  concept: ThumbnailConcept,
  portraitSha1: string,
): string {
  const key = createHash("sha1")
    .update(
      JSON.stringify([
        model,
        {
          scene: concept.scene,
          overlayText: concept.overlayText,
          styleNotes: concept.styleNotes,
        },
        portraitSha1,
      ]),
    )
    .digest("hex")
    .slice(0, 8);
  return `thumbnail-${key}.png`;
}

/**
 * The workdir file the pre-render approval step writes (thumbnail UX,
 * 2026-08-16): once it exists, `thumbnailStep` uses it VERBATIM and never
 * asks a model for a concept again — the user approved (and possibly edited)
 * this exact text, and a fresh concept call would discard their edit.
 */
export const THUMBNAIL_APPROVED_BASENAME = "thumbnail-concept-approved.json";

/**
 * What the approved file holds: the approved concept, or an explicit
 * `{skip: true}` — the user answered "skip thumbnail" at the approval prompt,
 * and that decision must survive into the (non-interactive) replay exactly
 * like an approval does, as a LOUD skip rather than a silent regeneration.
 * Skip variant FIRST in the union: a concept object can never carry `skip`
 * and a skip object can never carry the concept's required fields, so order
 * only matters for error messages — but skip-first means a hand-added `skip`
 * key wins over a leftover concept body instead of being ignored.
 */
export const ThumbnailConceptApprovedSchema = z.union([
  z.object({ skip: z.literal(true) }),
  ThumbnailConceptSchema,
]);
export type ThumbnailConceptApproved = z.infer<typeof ThumbnailConceptApprovedSchema>;

/**
 * How much transcript the concept prompt carries. Half the youtube.ts cap: a
 * thumbnail concept is about the video's ONE claim, not its coverage, and
 * the hook/intent lines already carry the strongest steer.
 */
export const THUMBNAIL_TRANSCRIPT_CHAR_CAP = 4000;

export interface ThumbnailConceptPromptArgs {
  /** The producer's hook, when a beat sheet exists — the strongest claim. */
  hook?: string;
  /** `--intent`, when the run had one. */
  intent?: string;
  /** The repaired transcript's plain text — what the viewer actually hears. */
  transcriptText: string;
  /** Who watches the channel (`--audience` / config) — steers the angle. */
  audience?: string;
  /**
   * The durable thumbnail steer (`--thumbnail-brief` / config). Marked
   * must-honor in the prompt: this is the user's standing instruction, not a
   * suggestion the model may trade away against its own craft rules.
   */
  brief?: string;
  /**
   * The youtube pack's FIRST title, when the pack already exists — thumbnail
   * and title must tell one story, and the first title is the pack's lead
   * angle. The pre-render approval step runs BEFORE the pack is generated
   * (the pack writes after render), so it passes the hook instead; only
   * thumbnailStep's own post-pack concept call can supply this.
   */
  titleAngle?: string;
  /**
   * A per-call creator note ("regenerate with a note" at the approval
   * prompt). Must-honor like the brief, but transient — it lives in this one
   * call and is never persisted to config or the concept cache.
   */
  note?: string;
}

/**
 * Pure prompt builder for the concept call, separated from the provider so
 * the include/omit matrix (hook, intent, audience, brief, titleAngle, note)
 * and the transcript cap are testable without an LLM.
 */
export function buildThumbnailConceptPrompt(args: ThumbnailConceptPromptArgs): {
  system: string;
  user: string;
} {
  const system =
    "You are a YouTube thumbnail strategist designing a high-CTR thumbnail concept for a " +
    "finished video.\n" +
    "- scene: ONE vivid scene — a single concrete image, not a collage of ideas.\n" +
    "- overlayText: 3-6 punchy words rendered on the image. A claim or a tension, never a " +
    "full sentence, and never a clickbait claim the video does not deliver.\n" +
    "- styleNotes: palette, lighting and mood direction for the image model — specific " +
    "enough to constrain it, short enough to not fight the scene.\n" +
    // Pose conflict fix (debugged 2026-08-16): the reference photo is frontal
    // with arms crossed, but a concept saying "holding his head in
    // frustration" made the image model follow the scene's choreography over
    // the image prompt's keep-pose rule. The fix starts HERE — a concept
    // that never choreographs the person cannot lose that fight downstream.
    "- The creator appears from a fixed reference photo whose pose CANNOT change " +
    "(frontal, natural). Design the scene AROUND the person — lighting, props, screen " +
    "content, composition — never choreograph the person's body or hands.";
  const capped =
    args.transcriptText.length > THUMBNAIL_TRANSCRIPT_CHAR_CAP
      ? // Slice + say so (youtube.ts posture): the model must know it is
        // reading an excerpt, or it will anchor the concept on the first half.
        `${args.transcriptText.slice(0, THUMBNAIL_TRANSCRIPT_CHAR_CAP)}\n[transcript truncated — the video continues]`
      : args.transcriptText;
  const user =
    (args.intent ? `Intent: ${args.intent}\n` : "") +
    (args.hook ? `Hook (already chosen by the producer): ${args.hook}\n` : "") +
    // One story across the upload: when the pack's lead title exists, the
    // thumbnail must be its visual restatement, not a second pitch.
    (args.titleAngle
      ? `Video title (already chosen — the thumbnail must tell the same story): ${args.titleAngle}\n`
      : "") +
    (args.audience ? `Audience: ${args.audience}\n` : "") +
    (args.brief ? `Creator brief (must be honored): ${args.brief}\n` : "") +
    (args.note ? `Creator note (must be honored): ${args.note}\n` : "") +
    `\nTranscript:\n${capped}`;
  return { system, user };
}

/** One editorial call → a validated concept. */
export async function generateThumbnailConcept(
  provider: LlmProvider,
  args: ThumbnailConceptPromptArgs,
): Promise<ThumbnailConcept> {
  const { system, user } = buildThumbnailConceptPrompt(args);
  return provider.complete({
    system,
    user,
    schema: ThumbnailConceptSchema,
    schemaName: "thumbnail_concept",
    tier: "editorial",
  });
}

/**
 * The image-model prompt, with the craft rules baked in as fixed text rather
 * than left to the concept call: the concept model picks WHAT to show, this
 * function owns HOW a YouTube thumbnail is built (16:9, subject in a third,
 * overlay verbatim, legible at grid size). Pure — the hasPortrait branch is
 * a table test.
 *
 * `revisionNote` is the post-generation retry loop's one input ("regenerate
 * with a note"): the concept is UNCHANGED, the note rides the image prompt
 * only, marked must-honor and appended last so it reads as the final word.
 */
export function buildThumbnailPrompt(
  concept: ThumbnailConcept,
  hasPortrait: boolean,
  revisionNote?: string,
): string {
  const lines = [
    "Create a YouTube thumbnail image.",
    "",
    ...(hasPortrait
      ? [
          // Identity FIRST, before Scene/Style (pose incident, debugged
          // 2026-08-16): with the identity block buried under the scene, a
          // concept that choreographed the person ("holding his head in
          // frustration") beat the keep-pose rule — the image model weighs
          // what it reads first. Identity is the HARD constraint, everything
          // else is negotiable (user directive 2026-08-16: the first
          // generation produced a face that "isn't me" — a thumbnail with
          // someone else's face is worse than no thumbnail). The reference
          // photo is ground truth: the model may relight and
          // recontextualize, never redraw the person.
          "Identity requirements — these override everything below:",
          "- The person in the reference photo MUST appear with their face reproduced at " +
            "100% accuracy — this is the single most important requirement. Treat the " +
            "reference photo as ground truth for identity: exact same facial structure, " +
            "eyes, nose, mouth, skin tone, facial hair, hairline and glasses. Do not " +
            "idealize, de-age, slim, or otherwise alter any facial feature.",
          "- Keep the head pose, angle and framing of the face as close to the reference " +
            "photo as possible. Only the lighting and color grade may adapt to match the " +
            "scene; the face itself must stay photorealistic and identical to the " +
            "reference, never stylized or repainted.",
          "- Place that person prominently in the left or right third of the frame, " +
            "integrated naturally into the scene (matching light and color, no cut-out " +
            "look). If any requirement conflicts with facial accuracy, facial accuracy " +
            "wins.",
          "- The scene adapts to the person; never re-pose, re-angle, or choreograph the " +
            "person to fit the scene.",
          "",
        ]
      : []),
    `Scene: ${concept.scene}`,
    `Style: ${concept.styleNotes}`,
    "",
    "Requirements:",
    "- 16:9 landscape, at least 1280x720.",
    // Quotes on their own line: overlay text is the one part of the image
    // with a right answer, and image models paraphrase anything stated
    // loosely — but the instruction word itself must not touch the quoted
    // string. The first field run (2026-08-16) used `reading EXACTLY: "…"`
    // and the model painted "EXACTLY:" into the thumbnail as a headline.
    "- Render bold, high-contrast overlay text. The overlay must contain this",
    "  text and nothing else:",
    `  ${concept.overlayText}`,
    "- Vivid and eye-catching but not cluttered — one focal point.",
    "- No watermarks, no logos, no borders.",
    "- Every element must stay legible when the image is displayed 320px wide.",
    ...(revisionNote
      ? ["", `Revision note from the creator (must be honored): ${revisionNote}`]
      : []),
  ];
  return lines.join("\n");
}

/**
 * Pull the first image part's bytes out of a generateContent response.
 *
 * Isolated in ONE small function on purpose: the @google/genai response
 * shape is the SDK's to drift (plan risk note, 2026-08-16), and when it
 * does, this is the only code that knows about `candidates[].content.parts`.
 * Treats the response as `unknown` so the pure tests exercise it with plain
 * objects and never import the SDK.
 */
export function extractImageBytes(response: unknown): Uint8Array {
  const candidates = (response as { candidates?: unknown })?.candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const parts = (candidate as { content?: { parts?: unknown } })?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const data = (part as { inlineData?: { data?: unknown } })?.inlineData?.data;
        if (typeof data === "string" && data.length > 0) {
          return new Uint8Array(Buffer.from(data, "base64"));
        }
      }
    }
  }
  throw new Error(
    "the model returned no image — the response had no inlineData part " +
      "(model refusal or a text-only reply)",
  );
}

export interface GenerateThumbnailImageOptions {
  apiKey: string;
  model: string;
  prompt: string;
  /** The creator's portrait as base64 `inlineData`, when the run has one. */
  portrait?: { data: string; mimeType: string };
}

/**
 * The ONE I/O function of this module: call Gemini image generation and
 * return the image bytes.
 *
 * The SDK import is LAZY and lives here, nowhere else: core is near-zero-dep
 * by design (only @anthropic-ai/sdk + zod), and every run that is not a
 * `--youtube`-with-portrait-and-key run must never pay for loading
 * @google/genai — a static import would tax every produce for a feature most
 * runs never reach.
 *
 * Errors are NOT retried and surface the API's message verbatim — the
 * isNonRetryableAgyFailure posture (§132): the model slug is user-specified,
 * a rejection of it is deterministic, and a retry loop would only restate it.
 */
export async function generateThumbnailImage(
  opts: GenerateThumbnailImageOptions,
): Promise<Uint8Array> {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const response = await ai.models.generateContent({
    model: opts.model,
    contents: [
      {
        role: "user",
        parts: [
          // Portrait FIRST, prompt second — the prompt refers back to "the
          // reference photo", so the photo must already be on the table.
          ...(opts.portrait
            ? [{ inlineData: { data: opts.portrait.data, mimeType: opts.portrait.mimeType } }]
            : []),
          { text: opts.prompt },
        ],
      },
    ],
  });
  return extractImageBytes(response);
}
