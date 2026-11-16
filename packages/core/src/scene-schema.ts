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

/**
 * The components an LLM may choose — the beat sheet's `sceneKind` enum. A
 * frozen subset of `SceneComponentIdSchema`, not the whole of it (explainer
 * spec G6): the beat-sheet JSON schema is built from THIS enum, so a
 * component added to the scene library for one feature (ClipScene, which
 * only a script's `clip:` cue can place) would otherwise reach every run's
 * planner and change what it is asked. Order is today's, and part of the
 * prompt.
 */
export const PlannerComponentIdSchema = z.enum([
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
export type PlannerComponentId = z.infer<typeof PlannerComponentIdSchema>;

/**
 * The pattern scenes only a SCRIPT's planner may offer (§161, plan Task 4).
 * A second list beside the frozen one, never an addition to it: the beat
 * sheet's `sceneKind` enum is `PlannerComponentIdSchema`, so a card added
 * there would change the ask of every run without `--script` (G6). Here it
 * reaches only `ScriptPlanSchema` and the script menu, whose prompt version
 * is its own (`SCRIPT_PLAN_PROMPT_VERSION`). Later pattern scenes append to
 * this list; order is menu order after the nine.
 */
export const ScriptOnlyComponentIdSchema = z.enum(["CardRow", "CtaCard", "BugCard", "PhoneDemo"]);
export type ScriptOnlyComponentId = z.infer<typeof ScriptOnlyComponentIdSchema>;

/**
 * What a script cue may be shown as: the nine, then the script-only cards.
 * The script planner's `sceneKind` and the `[Name]` hint check both parse
 * with this, so a hint can name a card the beat sheet never offers.
 */
export const ScriptComponentIdSchema = z.enum([
  ...PlannerComponentIdSchema.options,
  ...ScriptOnlyComponentIdSchema.options,
]);
export type ScriptComponentId = z.infer<typeof ScriptComponentIdSchema>;

/**
 * Every component a scene may render: the script planner's menu plus the
 * ones no planner may pick. Stored in production.json and overrides, so a
 * project that uses a new id cannot be opened by an older ossclip (spec,
 * Compatibility) — already true whenever a component is added.
 */
export const SceneComponentIdSchema = z.enum([
  ...ScriptComponentIdSchema.options,
  "ClipScene",
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
  /**
   * Where the graphic enters and where each item is spoken, in the same
   * word-index space as `anchor` (the clip slice on clip runs) — the matcher's answer, computed ONCE at plan time
   * (`planCue`, reveal-timing spec §7). Its presence is the gate: assembly
   * applies on-cue starts and synced items only to a scene that carries it,
   * so an old plan / production.json / scenes-reviewed.json (no `cue`)
   * renders with today's timing exactly — "new plans only" (decision 1) is
   * structural rather than a version check, and the editor's Render replays
   * the cue that was reviewed instead of re-matching edited props.
   */
  cue: z
    .object({
      /** Word index (`anchor`'s space) the graphic enters on, before the lead-in. */
      entryWord: z.number().int().nonnegative(),
      /** Per staggered item, the word index (`anchor`'s space) it is spoken on, or null. */
      itemWords: z.array(z.number().int().nonnegative().nullable()).optional(),
    })
    .optional(),
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
   * Set on a plain cue carved out of a KEPT (vetoed) cleanup removal
   * (`carveKeptTakes`, cut-review rework 2026-08-26) — the SOURCE range the
   * user chose to keep, so the timeline can render the revived stretch as
   * its own labeled block instead of an indistinguishable part of the
   * neighbouring take. Explicit field over id-prefix sniffing on purpose;
   * optional so every render-props/production.json written before it exists
   * parses byte-identically. A DISMISSED range's carved cue does NOT carry
   * this — dismissed material is ordinary footage.
   */
  kept: z
    .object({ srcIn: z.number().nonnegative(), srcOut: z.number().nonnegative() })
    .optional(),
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
      /** Audio gain for this window, 1 = as recorded — mirror of
       * `SceneOverrideSchema.video.volume`, which owns the argument. */
      volume: z.number().min(0).max(4).optional(),
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
  /**
   * Per staggered item, the ABSOLUTE output second it enters on (its spoken
   * word's start minus `ITEM_LEAD_SEC`), or null for an item to be paced —
   * set by `assembleScenes` only from a planned `scene.cue` whose item list
   * still matches the rendered items. Absolute rather than relative to the
   * cue start (reveal-timing spec, "Builder-check answers", superseding §3's
   * `itemSec`): items stay on their words wherever the final start lands —
   * floor, de-overlap, editor drag, `timing` pin — and a split's second half
   * inherits them through `...cue` with no re-basing. Optional so every
   * render-props.json / production.json written before it parses unchanged;
   * absence means "pace the items", today's stagger.
   */
  reveal: z
    .object({ itemAtSec: z.array(z.number().nonnegative().nullable()) })
    .optional(),
  /**
   * The OUTPUT second the entry word is spoken on — lead-free, the word
   * itself — set by `assembleScenes` only when the on-cue post-pass actually
   * moved `startSec` (reveal-timing spec §2). The editor's live preview
   * re-times the start from THIS, not from `startSec`: the start's lead can
   * fall in the kept span before a seam the word sits after, so a veto
   * restoring that seam's gap would otherwise move the graphic early by the
   * whole restored gap (final review I-3). Dropped on a pinned cue (the pin
   * wins) and on a split's second half (it starts at the split, not on the
   * word). Optional and absent on every legacy / unmoved cue, which
   * therefore stays byte-identical.
   */
  entryAtSec: z.number().nonnegative().optional(),
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
  // The explainer look's extra roles (design §2.2). Each default is the
  // colour that role is drawn with today — `accent2`/`highlight` the accent,
  // `info` the muted grey, `ink` the background — so a theme without them
  // (every render-props written before they existed, and every run without
  // `--look`) renders the same pixels (plan G6). The terminal pair is the
  // exception, below.
  /** Second accent: the playbook's blue beside its orange `accent`. */
  accent2: z.string().default("#FFE14D"),
  /** The playbook's yellow, its own role because the explainer `accent` is
   * orange and a yellow mark must not turn orange with it. */
  highlight: z.string().default("#FFE14D"),
  /** The playbook's cyan, distinct from the `muted` grey. */
  info: z.string().default("#9A9AA3"),
  /** The playbook's near-black ink, distinct from the slate `bg`. */
  ink: z.string().default("#0B0B0E"),
  /**
   * The terminal window and its title bar. Optional with NO default (§161):
   * the window has always been drawn in `cardBg`, and a fixed "#15151B"
   * default painted a user's config `cardBg` over with the factory colour
   * on every run without `--look`. Unset means "follow `cardBg`"; read them
   * through `terminalColors`, never directly.
   */
  terminalBg: z.string().optional(),
  terminalBar: z.string().optional(),
  /**
   * Gates loading the bundled font files. "system" (the default) loads
   * nothing, so every other run keeps today's font resolution; only the
   * explainer look turns it to "bundled". An enum, not a boolean, so a
   * hand-edited typo fails the parse instead of reading as off.
   */
  fonts: z.enum(["system", "bundled"]).default("system"),
  /**
   * Gates the explainer motion (typed terminal lines, count-up numbers). On
   * the theme rather than a component prop because a new prop on an
   * existing component changes the frozen planner schema (plan G6, decision 4).
   */
  motion: z.enum(["classic", "explainer"]).default("classic"),
});
export type Theme = z.infer<typeof ThemeSchema>;
export const defaultTheme: Theme = ThemeSchema.parse({});

/**
 * The colours a terminal-style surface is drawn in. `terminalBg` falls back
 * to `cardBg` and `terminalBar` to the window's colour, so a theme that sets
 * neither draws the window in its card colour, as before the roles existed
 * (§161), and one that sets only `terminalBg` gets a bar that matches it.
 */
export function terminalColors(theme: Theme): { bg: string; bar: string } {
  const bg = theme.terminalBg ?? theme.cardBg;
  return { bg, bar: theme.terminalBar ?? bg };
}

type ThemeShape = typeof ThemeSchema.shape;
/** Each field of `ThemeSchema` with its `.default(...)` wrapper peeled off. */
type UndefaultedThemeShape = {
  [K in keyof ThemeShape]: ThemeShape[K] extends z.ZodDefault<infer Inner> ? Inner : ThemeShape[K];
};

/**
 * A theme LAYER: the keys someone actually set, each validated exactly as
 * `ThemeSchema` validates it, and nothing filled in (§161). Not
 * `ThemeSchema.partial()`: zod 4's `.partial()` keeps every field's
 * `.default(...)`, so that parsed `{}` into the whole factory palette, and
 * every layer built on it (overrides.json's `theme`, the config theme)
 * silently overwrote whatever sat beneath it with the defaults.
 *
 * Derived from `ThemeSchema.shape` rather than hand-listed so a role added
 * there later is a valid override key the moment it exists. Unknown keys are
 * stripped (plain `z.object`), the same as the `.partial()` it replaces; a
 * caller that wants them refused adds `.strict()`.
 */
export const ThemeOverrideSchema = z
  .object(
    Object.fromEntries(
      Object.entries(ThemeSchema.shape).map(([key, field]) => [
        key,
        field instanceof z.ZodDefault ? field.unwrap() : field,
      ]),
    ) as UndefaultedThemeShape,
  )
  .partial();
