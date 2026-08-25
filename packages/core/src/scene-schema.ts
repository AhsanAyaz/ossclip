import { z } from "zod/v4";

/**
 * How the stage is arranged while a scene is active (BRAINSTORM §4.6, PHASE1
 * §1). `lower-third` and the two `split-*` layouts are landscape-native
 * additions (R15 §54) — the frame-aware slot table gives every layout
 * geometry in BOTH aspects (the split axis follows the frame's long edge:
 * side-by-side in 16:9, stacked in 9:16), so the editor's layout switch can
 * never render nothing.
 */
export const LayoutSchema = z.enum([
  "full-bleed",
  "video-top",
  "pip-bubble",
  "graphic-only",
  "blurred-behind",
  "lower-third",
  "split-left",
  "split-right",
]);
export type Layout = z.infer<typeof LayoutSchema>;

export const SceneComponentIdSchema = z.enum([
  "TitleCard",
  "StatCard",
  "RuleCard",
  "StrikethroughReveal",
  "FlowDiagram",
  "TerminalMock",
  "ChatMock",
  "ScreenshotFrame",
  "BulletList",
]);
export type SceneComponentId = z.infer<typeof SceneComponentIdSchema>;

/**
 * Where a scene sits — anchored to transcript word indices, never seconds,
 * so a cleanup-level change re-resolves cleanly (PHASE1 §5).
 */
export const SceneAnchorSchema = z.object({
  startWord: z.number().int().nonnegative(),
  endWord: z.number().int().nonnegative(),
});
export type SceneAnchor = z.infer<typeof SceneAnchorSchema>;

export const SceneSchema = z.object({
  id: z.string(),
  anchor: SceneAnchorSchema,
  layout: LayoutSchema,
  component: SceneComponentIdSchema,
  /** LLM-owned; replaced wholesale on re-plan. Validated against the registry. */
  props: z.record(z.string(), z.unknown()),
  /** User-owned; NEVER clobbered by a re-plan. Merged over props at resolve time. */
  overrides: z.record(z.string(), z.unknown()).default({}),
  /** Why the producer chose this — surfaced in the report for taste-debugging. */
  rationale: z.string().optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

/** A resolved, output-timed scene — what the composition actually renders. */
export const SceneCueSchema = z
  .object({
  id: z.string(),
  /**
   * "graphic" cues come from the producer; "plain" cues are derived filler
   * (`fillPlainCues`) — one per continuous take, so every second of the
   * timeline is a selectable block whose framing can be edited. OPTIONAL
   * rather than defaulted, deliberately: `render-props.json` reaches the
   * editor as plain JSON with no schema parse, so cues written before this
   * field existed carry no `kind` at runtime — absence means "graphic", and
   * a defaulted (required-in-type) field would let code read `.kind` as
   * always-present when it isn't. Always test `kind === "plain"`, never
   * `=== "graphic"`.
   */
  kind: z.enum(["graphic", "plain"]).optional(),
  /**
   * The plan anchor this cue was resolved from — the scene's word range,
   * carried through so an edit made against this cue can be re-keyed when a
   * re-plan renumbers ids (handoff-edit-anchoring; §137 is the caption-side
   * precedent). Optional: plain fill cues have no plan anchor, and
   * render-props.json written before this field carries none — absence means
   * "id-only identity", exactly today's behaviour.
   */
  anchor: SceneAnchorSchema.optional(),
  layout: LayoutSchema,
  /**
   * Required for graphic cues (the superRefine below enforces it), absent on
   * plain ones. The optionality is the consumer checklist: TS strict forces
   * every `cue.component`/`cue.props` reader to state what it does with a
   * plain cue.
   */
  component: SceneComponentIdSchema.optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  /**
   * Overrides the layout's graphic slot for this cue only. Set when the
   * source already has text where the layout would have drawn, so the graphic
   * is moved into a genuinely free band instead of being skipped
   * (FINDINGS §26). Fractions of the frame, like every other rect.
   */
  graphicRect: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    })
    .optional(),
  /**
   * Per-element nudges from the user's edit layer, by `data-edit-id`.
   * Mirrors `ElementTransformSchema` (overrides.ts) field for field,
   * duplicated because this is the RESOLVED cue shape, not the override
   * doc — `hidden` (PLAN Task 2) travels the same path `dx`/`dy`/`scale`
   * already do: `applyOverrides` copies the override's `elements` onto the
   * cue verbatim, so a hand-set flag reaches here unchanged.
   */
  elements: z.record(z.string(), z.object({
    dx: z.number().optional(),
    dy: z.number().optional(),
    scale: z.number().positive().optional(),
    hidden: z.boolean().optional(),
  })).optional(),
  /**
   * How the video sits in this scene's slot, when the automatic face-aware
   * crop needs a hand (see `SceneOverrideSchema.video`). `scale` under 1 zooms
   * OUT — more of the source, backdrop showing where it no longer covers.
   */
  video: z
    .object({
      scale: z.number().positive().max(4).optional(),
      dy: z.number().optional(),
      dx: z.number().optional(),
      /** `false` switches the automatic idle-zoom layer off for this scene. */
      autoZoom: z.boolean().optional(),
    })
    .optional(),
  /**
   * The pip bubble, reshaped per scene (R14 §52): mask roundness (0 = square
   * card, 1 = the default circle) and the slot's top-left placement, frame
   * fractions. Only consulted when the cue's resolved layout is `pip-bubble` —
   * it is a property of the bubble, not of the video in general.
   */
  pip: z
    .object({
      cornerRadius: z.number().min(0).max(1).optional(),
      x: z.number().min(0).max(1).optional(),
      y: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /**
   * Vertical centre for this scene's captions, frame fraction (R15 §56) —
   * a hand-set anchor that wins over the layout's `captionAnchor` and the
   * automatic avoidance. Set from the editor; travels on the cue so the
   * renderer and the preview agree.
   */
  captionY: z.number().min(0).max(1).optional(),
  /** Caption size multiplier for this scene (R16 §64) — scales the track's
   * base font size, same convention as every other scale control. */
  captionScale: z.number().min(0.2).max(3).optional(),
  /** True when the user set an absolute time, detaching this cue from its words. */
  pinned: z.boolean().optional(),
  })
  .superRefine((cue, ctx) => {
    if (cue.kind !== "plain" && (cue.component === undefined || cue.props === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "a graphic cue requires component and props; only kind: \"plain\" may omit them",
      });
    }
  });
export type SceneCue = z.infer<typeof SceneCueSchema>;

/**
 * Where the speaker's face sits in the SOURCE frame, measured once per source
 * (FINDINGS §13). The stage derives each layout's vertical crop bias from
 * this instead of guessing with a constant.
 */
export const FaceCropSchema = z.object({
  /** Vertical center of the face, 0..1 of source height. */
  centerYFrac: z.number().min(0).max(1),
  /** Face height as a fraction of source height (informational for now). */
  sizeFrac: z.number().min(0).max(1).optional(),
  /**
   * Horizontal center, 0..1 of source width. Only matters when the source is
   * WIDER than the slot it fills — a portrait take is cropped vertically and
   * the speaker's horizontal position is whatever the source framed. A
   * landscape take in a vertical slot is cropped horizontally instead, and
   * centring it blindly can crop the speaker out of their own video.
   */
  centerXFrac: z.number().min(0).max(1).optional(),
  /**
   * The source's width/height. Absent means "the same 9:16 the frame is",
   * which is what every crop calculation used to assume outright — true for
   * phone footage, wrong for a webcam recording or a screen capture.
   */
  sourceAspect: z.number().positive().optional(),
  /**
   * What the measured face IS: the frame's subject, or an incidental face in
   * a frame that is really about something else (2026-08-16 incident: a
   * screen recording's camera PiP, 12% of frame height at the bottom-right,
   * dragged the cover crop to the frame bottom and decapitated the speaker
   * everywhere they appeared full-frame). "screen" tells the stage to center
   * the cover instead of biasing toward the face. Absent means "face" — every
   * pre-existing render-props keeps its old behavior.
   */
  subject: z.enum(["face", "screen"]).optional(),
});
export type FaceCrop = z.infer<typeof FaceCropSchema>;

/** Design tokens. Components read ONLY these — no hardcoded colors/fonts. */
export const ThemeSchema = z.object({
  bg: z.string().default("#0B0B0E"),
  fg: z.string().default("#FFFFFF"),
  accent: z.string().default("#FFE14D"),
  muted: z.string().default("#9A9AA3"),
  /** Affirmative green — the ✓ of §66's verdict lines; the editor's own
   * "Saved" green, so the system stays one palette. */
  success: z.string().default("#5FBF77"),
  cardBg: z.string().default("#15151B"),
  cardBorder: z.string().default("#2A2A33"),
  danger: z.string().default("#FF5C5C"),
  radiusPx: z.number().default(24),
  fontDisplay: z
    .string()
    .default("'Inter', 'Helvetica Neue', 'Arial Black', Arial, sans-serif"),
  fontMono: z.string().default("'SF Mono', 'Cascadia Code', Consolas, monospace"),
});
export type Theme = z.infer<typeof ThemeSchema>;
export const defaultTheme: Theme = ThemeSchema.parse({});
