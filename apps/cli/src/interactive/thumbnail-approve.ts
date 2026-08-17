import { copyFile, writeFile } from "node:fs/promises";
import {
  ThumbnailConceptSchema,
  approvedOverlayText,
  buildThumbnailPrompt,
  type GenerateThumbnailImageOptions,
  type ThumbnailConcept,
  type ThumbnailConceptApproved,
} from "@ossclip/core";
import { openInViewer } from "../open";
import { select, text, unwrap } from "./prompts";

/**
 * The pre-render concept approval and the post-generation retry loop
 * (thumbnail UX, 2026-08-16). Both exist for the same field incident class:
 * the concept/image models make a judgement call the user only discovers
 * AFTER a multi-minute render — approval moves the concept judgement before
 * the render, the retry loop makes the image judgement cheap to redo.
 *
 * Every prompt goes through the injectable `ApprovePrompts` seam so the loop
 * logic is testable with a scripted object — no TTY, no clack, the tty.ts
 * doctrine applied one layer up. The default implementation wraps clack via
 * ./prompts and inherits its cancel-exits-cleanly behavior (unwrap).
 */

export interface ApprovePrompts {
  /** Returns the chosen option's value — already unwrapped, never a cancel symbol. */
  select(opts: {
    message: string;
    options: { value: string; label: string; hint?: string }[];
  }): Promise<string>;
  /** Returns the typed text — already unwrapped. */
  text(opts: { message: string; initialValue?: string; placeholder?: string }): Promise<string>;
}

/** The live clack-backed prompts; tests inject a scripted replacement. */
export function clackApprovePrompts(): ApprovePrompts {
  return {
    select: async (opts) => unwrap(await select(opts)) as string,
    text: async (opts) => unwrap(await text({ ...opts, defaultValue: "" })) as string,
  };
}

/**
 * The concept as the three lines the approval prompt displays. Pure so the
 * formatting (overlay first — it is the one thing the viewer will read) is
 * pinned without a TTY.
 */
export function formatConceptLines(concept: ThumbnailConcept): string[] {
  return [
    `  overlay: ${concept.overlayText}`,
    `  scene:   ${concept.scene}`,
    `  style:   ${concept.styleNotes}`,
  ];
}

/**
 * Re-validate a hand-edited concept: through the SAME schema the LLM's
 * output takes (an edit is user input, parsed not coerced), plus
 * `approvedOverlayText`'s WORD cap on the overlay — the schema caps
 * characters, but overlay text at thumbnail size keeps a cover banner's 4-9
 * word ceiling (§35), and an edit must not smuggle a paragraph past the cap
 * the generated path enforces. The helper is thumbnailStep's exact
 * treatment, shared so the image cache key never sees two spellings of one
 * concept.
 */
export function editedConcept(fields: {
  scene: string;
  overlayText: string;
  styleNotes: string;
}): ThumbnailConcept {
  const parsed = ThumbnailConceptSchema.parse(fields);
  return { ...parsed, overlayText: approvedOverlayText(parsed.overlayText) };
}

export interface ApproveConceptArgs {
  /**
   * One concept call, note optional — produce injects the provider-backed
   * call (with audience/brief steer and phase timing); tests inject a stub.
   */
  generateConcept: (note?: string) => Promise<ThumbnailConcept>;
  /** A concept to present first (the workdir cache) — skips the initial call. */
  initial?: ThumbnailConcept;
  prompts?: ApprovePrompts;
  log?: (line: string) => void;
}

/**
 * The approval loop: display → use / edit / regenerate-with-note / skip.
 * Returns what the caller writes into `thumbnail-concept-approved.json` —
 * the approved concept, or `{skip: true}` so the post-render step (and every
 * non-TTY replay) skips loudly instead of silently regenerating.
 */
export async function approveThumbnailConcept(
  args: ApproveConceptArgs,
): Promise<ThumbnailConceptApproved> {
  const { prompts = clackApprovePrompts(), log = console.log } = args;
  let concept = args.initial ?? (await args.generateConcept());
  for (;;) {
    log("▸ thumbnail concept:");
    for (const line of formatConceptLines(concept)) log(line);
    const choice = await prompts.select({
      message: "Use this thumbnail concept?",
      options: [
        { value: "use", label: "use it" },
        { value: "edit", label: "edit fields" },
        { value: "regenerate", label: "regenerate with a note" },
        { value: "skip", label: "skip thumbnail", hint: "the frame-grab cover stands" },
      ],
    });
    if (choice === "use") return concept;
    if (choice === "skip") return { skip: true };
    if (choice === "edit") {
      // Prefilled per field so an edit is a tweak, not a retype; the result
      // loops back to the display so the user confirms what they typed.
      concept = editedConcept({
        overlayText: await prompts.text({
          message: "Overlay text (3-6 punchy words)",
          initialValue: concept.overlayText,
        }),
        scene: await prompts.text({ message: "Scene", initialValue: concept.scene }),
        styleNotes: await prompts.text({ message: "Style notes", initialValue: concept.styleNotes }),
      });
      continue;
    }
    // regenerate: one note, one fresh concept call, back to the display.
    const note = (
      await prompts.text({
        message: "What should the concept do differently?",
        placeholder: "less abstract — show the actual terminal output",
      })
    ).trim();
    concept = await args.generateConcept(note || undefined);
  }
}

export interface ThumbnailRetryArgs {
  /** The `<out>.thumbnail.png` the step wrote — overwritten on each retry. */
  imagePath: string;
  /** The workdir cache — overwritten too, or a warm re-run would revert the retry. */
  imageCachePath: string;
  /** The approved/generated concept — UNCHANGED across retries by design. */
  concept: ThumbnailConcept;
  apiKey: string;
  model: string;
  portrait: { data: string; mimeType: string };
  /** The injected-generate seam (thumbnailStep's exactly) — tests never touch the SDK. */
  generate: (opts: GenerateThumbnailImageOptions) => Promise<Uint8Array>;
  /** The injected viewer seam (openInViewer's shape) — tests never spawn a viewer. */
  open?: (path: string) => void;
  prompts?: ApprovePrompts;
  log?: (line: string) => void;
}

/**
 * The post-generation retry loop: keep, or regenerate with a note. Each
 * retry is ONE image call — the concept stays fixed and the note rides the
 * image prompt as a must-honor revision (buildThumbnailPrompt's
 * `revisionNote`) — and the loop asks again after every result, so the user
 * can iterate until "keep". A failed retry keeps the previous image on disk
 * (both files were only overwritten on success) and says so.
 */
export async function thumbnailRetryLoop(args: ThumbnailRetryArgs): Promise<void> {
  const { prompts = clackApprovePrompts(), log = console.log, open = openInViewer } = args;
  for (;;) {
    // Show the image before EVERY keep/regenerate prompt — top of the loop,
    // so each regeneration reopens the NEW file. The user is confirming what
    // they see, not a path (thumbnail UX, 2026-08-17).
    try {
      open(args.imagePath);
    } catch {
      // A headless-ish env or a missing xdg-open must not kill an
      // interactive confirm that can proceed on the printed path — same
      // posture as openInBrowser's error handler.
      log(`▸ could not open viewer — ${args.imagePath}`);
    }
    const choice = await prompts.select({
      message: `Thumbnail written → ${args.imagePath}. Keep it?`,
      options: [
        { value: "keep", label: "keep" },
        { value: "regenerate", label: "regenerate with a note" },
      ],
    });
    if (choice === "keep") return;
    const note = (
      await prompts.text({
        message: "What should change in the image?",
        placeholder: "warmer lighting, less clutter behind me",
      })
    ).trim();
    // An empty note would regenerate with zero new information — the same
    // dice re-rolled at API cost. Re-ask instead of guessing what changed.
    if (!note) continue;
    try {
      const bytes = await args.generate({
        apiKey: args.apiKey,
        model: args.model,
        prompt: buildThumbnailPrompt(args.concept, true, note),
        portrait: args.portrait,
      });
      // Cache first, then the destination — the same overwrite order a crash
      // between the two degrades safest under: a stale destination beside a
      // fresh cache self-heals on the next run's copy, the reverse would
      // revert the user's retry on every warm re-run.
      await writeFile(args.imageCachePath, bytes);
      await copyFile(args.imageCachePath, args.imagePath);
      log(`✓ thumbnail regenerated → ${args.imagePath}`);
    } catch (err) {
      // §132 posture verbatim from thumbnailStep: surface the API's message,
      // never retry silently, and the previous image stands.
      log(
        `▸ thumbnail: regeneration failed (${err instanceof Error ? err.message : String(err)}) ` +
          "— keeping the previous image",
      );
    }
  }
}
