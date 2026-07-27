import { z } from "zod/v4";
import { type Layout, type SceneComponentId } from "./scene-schema";

/**
 * The scene library's contract, React-free so both the producer brain and the
 * render layer share one source of truth. Taste lives in the components; the
 * LLM only fills these props. Copy caps enforce the virality grammar
 * (short, numeric, high-contrast — BRAINSTORM §4.5).
 */

export const TitleCardProps = z.object({
  eyebrow: z.string().max(28).optional(),
  title: z
    .string()
    .min(1)
    .max(48)
    .describe("the claim WITHOUT the emphasis token — never repeat the emphasis here"),
  /** A huge emphasized token — a number or 1–2 punch words ("861%"). */
  emphasis: z
    .string()
    .max(16)
    .optional()
    .describe("the number/punch token pulled OUT of the title (e.g. '861%') — not a duplicate of it"),
  sub: z.string().max(64).optional(),
});

export const StatCardProps = z.object({
  label: z.string().min(1).max(28),
  value: z.string().min(1).max(12),
  caption: z.string().max(40).optional(),
  /** Inverted emphasis block (light card on dark stage) for the punch stat. */
  inverted: z.boolean().default(false),
});

export const RuleCardProps = z.object({
  kicker: z.string().min(1).max(24),
  text: z.string().min(1).max(40),
  /** Rendered below, struck through — the rejected alternative. */
  struck: z.string().max(40).optional(),
});

export const StrikethroughRevealProps = z.object({
  lines: z
    .array(z.object({ text: z.string().min(1).max(32), struck: z.boolean().default(false) }))
    .min(1)
    .max(4),
});

export const FlowDiagramProps = z.object({
  nodes: z.array(z.string().min(1).max(16)).min(2).max(5),
  /** Emphasize the terminal node (white chip, like CHURN in the reference). */
  emphasizeLast: z.boolean().default(true),
});

export const TerminalMockProps = z.object({
  windows: z
    .array(
      z.object({
        title: z.string().max(24),
        lines: z.array(z.string().max(40)).min(1).max(6),
      }),
    )
    .min(1)
    .max(5),
  /** Fan-out label under the windows ("OUTPUT ×1"). */
  fanOut: z.string().max(20).optional(),
});

export const ChatMockProps = z.object({
  messages: z
    .array(
      z.object({
        from: z.enum(["user", "agent"]),
        text: z.string().min(1).max(60),
      }),
    )
    .min(1)
    .max(4),
  /**
   * The comment-CTA word the viewer is asked to type. The COMPONENT renders
   * it quoted and capitalized ('"AGENTS"') wherever it appears in a message —
   * formatting never lives in LLM output (FINDINGS §16).
   */
  keyword: z
    .string()
    .max(16)
    .optional()
    .describe("the single comment/CTA word the viewer should type, plain and unformatted"),
});

export const ScreenshotFrameProps = z.object({
  /** File name inside the render public dir; omitted → styled placeholder frame. */
  src: z.string().optional(),
  label: z.string().max(32).optional(),
  kenBurns: z.boolean().default(true),
});

export interface SceneComponentMeta {
  propsSchema: z.ZodTypeAny;
  defaultProps: Record<string, unknown>;
  defaultLayout: Layout;
  /**
   * Layouts a REPEAT of this component may use instead, so the same card
   * treatment twice in one video doesn't read as a template (FINDINGS §20).
   * Varying the layout is safe where swapping the component is not — layout
   * is presentation, while a component swap is an editorial judgement that
   * can demand props the beat has no material for (a StatCard needs a number).
   *
   * Invariant, property-tested: an alternate's graphic slot is never SHORTER
   * than the default's. Components size their type against their default slot
   * — FlowDiagram literally budgets against `graphic-only` — so moving one
   * into a smaller slot would re-open the overflow bug of §1/§12. Components
   * that already sit in the tallest slot therefore have no alternate.
   */
  altLayouts: Layout[];
  /** One-liner the producer prompt uses to pick components. */
  whenToUse: string;
}

export const SCENE_REGISTRY: Record<SceneComponentId, SceneComponentMeta> = {
  TitleCard: {
    propsSchema: TitleCardProps,
    defaultProps: { title: "TITLE" },
    defaultLayout: "pip-bubble",
    altLayouts: [],
    whenToUse:
      "The core claim or hook as big typography; use `emphasis` for a huge number or punch word.",
  },
  // Layout mix policy (FINDINGS §4): the speaker's face is the product.
  // Stat/Rule cards sit UNDER a big face (video-top, the reference's
  // signature frame); only TitleCard demotes it to a bubble, and only the
  // diagram/terminal mocks may take the frame alone — briefly.
  StatCard: {
    propsSchema: StatCardProps,
    defaultProps: { label: "METRIC", value: "+0%" },
    defaultLayout: "video-top",
    altLayouts: ["blurred-behind"],
    whenToUse: "One striking metric (value like '+242%', '×3', '5s'); punchline in `caption`.",
  },
  RuleCard: {
    propsSchema: RuleCardProps,
    defaultProps: { kicker: "RULE", text: "DO THE THING" },
    defaultLayout: "video-top",
    altLayouts: ["blurred-behind"],
    whenToUse:
      "A prescriptive takeaway ('CAPACITY RULE / CAP ACTIVE AGENTS'); `struck` shows the rejected alternative.",
  },
  StrikethroughReveal: {
    propsSchema: StrikethroughRevealProps,
    defaultProps: { lines: [{ text: "NOT THIS", struck: true }] },
    defaultLayout: "blurred-behind",
    altLayouts: ["graphic-only"],
    whenToUse: "Negation/contrast beat — big words over the blurred speaker, some struck through.",
  },
  FlowDiagram: {
    propsSchema: FlowDiagramProps,
    defaultProps: { nodes: ["A", "B"] },
    defaultLayout: "graphic-only",
    altLayouts: [],
    whenToUse: "A causal chain or pipeline as chips with arrows (TEAM → AI AGENTS → CHURN).",
  },
  TerminalMock: {
    propsSchema: TerminalMockProps,
    defaultProps: { windows: [{ title: "terminal-01", lines: ["$ run"] }] },
    defaultLayout: "graphic-only",
    altLayouts: [],
    whenToUse: "Anything about running code/processes/agents — stylized terminal windows.",
  },
  ChatMock: {
    propsSchema: ChatMockProps,
    defaultProps: { messages: [{ from: "user", text: "hello" }] },
    defaultLayout: "blurred-behind",
    altLayouts: ["graphic-only"],
    whenToUse:
      "A quoted phrase or exchange as chat bubbles over the blurred speaker; for a comment-CTA beat, set `keyword` to the word viewers should type.",
  },
  ScreenshotFrame: {
    propsSchema: ScreenshotFrameProps,
    defaultProps: {},
    defaultLayout: "video-top",
    altLayouts: ["blurred-behind"],
    whenToUse: "Reference to a document/PR/review — a framed screenshot look with a label chip.",
  },
};

/**
 * Resolution order per PHASE1 §2: componentDefaults ← props ← overrides.
 * Returns null when the merged result doesn't validate.
 */
export function resolveSceneProps(
  component: SceneComponentId,
  props: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> | null {
  const meta = SCENE_REGISTRY[component];
  const merged = { ...meta.defaultProps, ...props, ...overrides };
  const parsed = meta.propsSchema.safeParse(merged);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}
