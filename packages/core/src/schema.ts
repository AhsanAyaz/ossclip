import { z } from "zod/v4";

/** A single transcribed word, in SOURCE time (seconds). */
export const WordSchema = z.object({
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  conf: z.number().min(0).max(1).optional(),
});
export type Word = z.infer<typeof WordSchema>;

export const TranscriptSchema = z.object({
  language: z.string().default("en"),
  words: z.array(WordSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const CleanupLevelSchema = z.enum(["exact", "light", "standard", "aggressive"]);
export type CleanupLevel = z.infer<typeof CleanupLevelSchema>;

export const RemovalReasonSchema = z.enum(["silence", "pause", "filler", "retake", "user", "clip"]);
export type RemovalReason = z.infer<typeof RemovalReasonSchema>;

/**
 * One span of the source timeline. The cutlist is a full partition of
 * [0, source duration]: every instant is either kept or removed, with a reason.
 */
export const SegmentSchema = z.object({
  srcIn: z.number().nonnegative(),
  srcOut: z.number().nonnegative(),
  kind: z.enum(["keep", "remove"]),
  reason: RemovalReasonSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const SpanSchema = z.object({
  start: z.number(),
  end: z.number(),
});
export type Span = z.infer<typeof SpanSchema>;

export const AnalysisSchema = z.object({
  /** Acoustic silences (ffmpeg silencedetect), source time. */
  silences: z.array(SpanSchema),
  /** Inter-word transcript gaps, incl. leading/trailing dead air. */
  gaps: z.array(SpanSchema),
  /**
   * Regions containing no audible speech, after transcript veto — the
   * candidate pool every silence/pause cut is drawn from.
   */
  cuttable: z.array(SpanSchema),
  /**
   * Sub-silence pauses from the RMS series (≥120 ms, below speech − 10 dB):
   * too short to cut, but they are where phrases actually break. `silences`
   * has a 0.35 s floor and `gaps` is empty on `-ml 1` output, so this is the
   * only dense phrase signal the pipeline has (FINDINGS §18).
   */
  breaths: z.array(SpanSchema).default([]),
  /** Standalone filler interjections (um, uh, …). */
  fillers: z.array(
    z.object({
      wordIndex: z.number().int(),
      text: z.string(),
      start: z.number(),
      end: z.number(),
    }),
  ),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const ProbeSchema = z.object({
  duration: z.number().positive(),
  /**
   * DISPLAYED dimensions, after the rotation matrix (R27 §119) — not the raw
   * stream's. A phone/camera writes a portrait take as a landscape stream plus
   * a 90° display matrix, and ffmpeg's filter chain auto-rotates, so the raw
   * numbers disagree with every measurement taken through ffmpeg.
   */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  hasAudio: z.boolean(),
  /**
   * The stream's rotation in degrees (0/90/180/270), recorded so a workdir says
   * why its geometry is what it is. Optional: pre-§119 `production.json` files
   * predate it and must still parse.
   */
  rotation: z.number().int().optional(),
});
export type Probe = z.infer<typeof ProbeSchema>;

export const RenderSettingsSchema = z.object({
  width: z.number().int().positive().default(1080),
  height: z.number().int().positive().default(1920),
  fps: z.number().positive().default(30),
});
export type RenderSettings = z.infer<typeof RenderSettingsSchema>;

import { SceneSchema, ThemeSchema } from "./scene-schema";

/**
 * The sound-effect plan as `production.json` STORES it: the level it was
 * planned at plus the surviving placements.
 *
 * Restated here rather than imported from `producer/sfx.ts` on purpose, and
 * the duplication is load-bearing: this module is in the EDITOR's runtime
 * graph (browser.ts → overrides.ts → `RemovalReasonSchema`), while
 * `producer/sfx.ts` reaches `beats.ts` → `cover.ts` → `node:child_process`.
 * Importing the model-facing schema here would drag the whole producer — and
 * node — into the Remotion/editor bundle. The two shapes are pinned equal by
 * a test (`sfx-production-slot.test.ts`), which is what keeps this from
 * becoming a silent second truth: the model-facing one caps `rationale` on the
 * way IN (R27 §123's `cappedText`), and by the time a placement is stored the
 * cap has already been applied.
 */
export const ProductionSfxSchema = z.object({
  level: z.enum(["subtle", "normal", "meme"]),
  placements: z.array(
    z.object({
      soundId: z.string(),
      /** Index into the REPAIRED transcript — word indices, never seconds. */
      word: z.number().int().nonnegative(),
      /**
       * The scene whose ENTRANCE this sound marks, when it has one
       * (2026-08-29). Optional and absent-means-speech-synced, so every plan
       * written before the field parses byte-identically. `word` above stays
       * required beside it — it is the fallback when the scene is deleted or
       * re-planned away (`SfxPlacementSchema` owns the full argument).
       */
      sceneId: z.string().optional(),
      gain: z.number().min(0).max(2).optional(),
      rationale: z.string().optional(),
    }),
  ),
});
export type ProductionSfx = z.infer<typeof ProductionSfxSchema>;

/** The single source of truth for a production. Every pipeline stage is a pure function over this. */
export const ProductionSchema = z.object({
  version: z.literal(1),
  source: z.object({
    path: z.string(),
    probe: ProbeSchema,
    audioPath: z.string().optional(),
    mezzaninePath: z.string().optional(),
    /** Measured face box (FINDINGS §13) — a property of the source; null = no face found. */
    face: z
      .object({
        centerXFrac: z.number(),
        centerYFrac: z.number(),
        sizeFrac: z.number(),
        framesSampled: z.number().int(),
        framesDetected: z.number().int(),
      })
      .nullable()
      .optional(),
  }),
  cleanup: CleanupLevelSchema,
  /** User intent for the producer brain ("educational video about agents…"). */
  intent: z.string().optional(),
  /**
   * The RAW ASR transcript. `analysis` and `cutlist` index into this array,
   * so it must stay the untouched one — see `repairs` for the corrections
   * applied downstream (FINDINGS §17).
   */
  transcript: TranscriptSchema.optional(),
  /**
   * Mishearing corrections applied before captions, scene copy and grounding.
   * Kept as a diff rather than a second transcript so the production stays
   * reproducible: `applyRepairs(transcript, repairs.filter(r => r.applied))`
   * reconstructs exactly what was rendered.
   */
  repairs: z
    .array(
      z.object({
        startWord: z.number().int(),
        endWord: z.number().int(),
        heard: z.string(),
        correction: z.string(),
        applied: z.boolean(),
        rejected: z.string().optional(),
      }),
    )
    .optional(),
  analysis: AnalysisSchema.optional(),
  /**
   * What this run ACTUALLY cut — post cleanup-choices, post user cuts. Every
   * consumer that treats the cutlist as the applied truth (`formatCutReport`,
   * the four NLE exporters, `analyze`'s marker count) reads this one, which
   * is why it stays the resolved list rather than the proposal: recording the
   * proposal here would make each of them re-apply the choices or lie.
   */
  cutlist: z.array(SegmentSchema).optional(),
  /**
   * The automatic PROPOSAL (cut review step 3) — `buildCutlist`'s output
   * before `applyCleanupChoices` vetoes and before user cuts subtract. Kept
   * alongside because the resolution is lossy: a vetoed removal merges into
   * a plain keep, so `cutlist` alone cannot tell the editor which categories
   * the user declined — its checkboxes and seams re-derive the veto state
   * from THIS list + `overrides.json`'s `cleanup`, through the same
   * `applyCleanupChoices` produce ran. Optional: pre-step-3 files predate it
   * and must still parse (readers fall back to `cutlist`, which back then
   * WAS the proposal plus user cuts).
   */
  cutlistProposed: z.array(SegmentSchema).optional(),
  /**
   * Present on a `--clip` run (R19 §93): the target and the resolved window.
   * `startWord`/`endWord` are indices into the PRE-slice repaired transcript
   * (the space selection ran in); the seconds are source time and stay
   * meaningful against the sliced `transcript` stored above.
   */
  clip: z
    .object({
      targetSec: z.number().positive(),
      startWord: z.number().int().nonnegative(),
      endWord: z.number().int().nonnegative(),
      startSec: z.number().nonnegative(),
      endSec: z.number().nonnegative(),
      reason: z.string(),
    })
    .optional(),
  scenes: z.array(SceneSchema).optional(),
  /**
   * The `--sfx` placement plan (level + word-anchored placements), post
   * `normalizeSfxPlan`. Optional and absent-means-no-sound-design, so every
   * pre-feature `production.json` parses unchanged — and so a run without the
   * flag writes a file byte-identical to what it always wrote.
   *
   * WORDS, not seconds, like every other anchor in this file: the cutlist can
   * change under a re-render, and a second-stamped placement would drift off
   * the moment it does (the resolver re-derives output time through the
   * TimeMap, `resolveSfxCues`).
   */
  sfx: ProductionSfxSchema.optional(),
  /**
   * WHO planned this production (R16 §78). `usage.json` answers "what did
   * that cost", but it describes one run and a fully-cached re-run makes no
   * calls — so the provider that actually chose these scenes used to vanish
   * from the workdir. This travels with the artefact it explains.
   *
   * `cached: true` means this run made no LLM calls and the provider named
   * here is the one carried forward from the run that did.
   */
  producer: z
    .object({
      provider: z.string(),
      /** Models seen this run, editorial first — the tiering is visible. */
      models: z.array(z.string()).default([]),
      cached: z.boolean().default(false),
      at: z.string().optional(),
    })
    .optional(),
  theme: ThemeSchema.optional(),
  render: RenderSettingsSchema,
});
export type Production = z.infer<typeof ProductionSchema>;
