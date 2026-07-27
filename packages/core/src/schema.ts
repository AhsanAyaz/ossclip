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

export const RemovalReasonSchema = z.enum(["silence", "pause", "filler", "retake", "user"]);
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
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  hasAudio: z.boolean(),
});
export type Probe = z.infer<typeof ProbeSchema>;

export const RenderSettingsSchema = z.object({
  width: z.number().int().positive().default(1080),
  height: z.number().int().positive().default(1920),
  fps: z.number().positive().default(30),
});
export type RenderSettings = z.infer<typeof RenderSettingsSchema>;

import { SceneSchema, ThemeSchema } from "./scene-schema";

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
  transcript: TranscriptSchema.optional(),
  analysis: AnalysisSchema.optional(),
  cutlist: z.array(SegmentSchema).optional(),
  scenes: z.array(SceneSchema).optional(),
  theme: ThemeSchema.optional(),
  render: RenderSettingsSchema,
});
export type Production = z.infer<typeof ProductionSchema>;
