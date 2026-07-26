import { z } from "zod/v4";

/** How the stage is arranged while a scene is active (BRAINSTORM §4.6, PHASE1 §1). */
export const LayoutSchema = z.enum([
  "full-bleed",
  "video-top",
  "pip-bubble",
  "graphic-only",
  "blurred-behind",
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
export const SceneCueSchema = z.object({
  id: z.string(),
  layout: LayoutSchema,
  component: SceneComponentIdSchema,
  props: z.record(z.string(), z.unknown()),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
});
export type SceneCue = z.infer<typeof SceneCueSchema>;

/** Design tokens. Components read ONLY these — no hardcoded colors/fonts. */
export const ThemeSchema = z.object({
  bg: z.string().default("#0B0B0E"),
  fg: z.string().default("#FFFFFF"),
  accent: z.string().default("#FFE14D"),
  muted: z.string().default("#9A9AA3"),
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
