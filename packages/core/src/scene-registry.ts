import { z } from "zod/v4";
import {
  type Layout,
  type PlannerComponentId,
  type SceneComponentId,
  type ScriptComponentId,
} from "./scene-schema";

/**
 * The scene library's contract, React-free so both the producer brain and the
 * render layer share one source of truth. Taste lives in the components; the
 * LLM only fills these props. Copy caps enforce the virality grammar
 * (short, numeric, high-contrast — BRAINSTORM §4.5).
 */

/**
 * The default share of a scene a paced reveal takes (reveal-timing spec §5):
 * the last item lands about two-thirds in, so the full graphic holds before
 * the cut. Lives here, not in the renderer, because the editor's slider shows
 * it as the value of an unset `revealSpeed` and the two must agree.
 */
export const REVEAL_SPEED_DEFAULT = 0.66;

/**
 * Author-only reveal controls for the four item-revealing components (spec
 * §5). Every one is OPTIONAL with no `.default()` on purpose: absence is how
 * the renderer tells "the author never touched this" from an explicit choice,
 * and a legacy scene must keep its legacy stagger until someone does (plan
 * Review Focus 5). A default here would flip every old scene onto the paced
 * path the moment it re-parsed.
 *
 * The LLM never sees these — see `llmPropsSchema`.
 */
const RevealPropsShape = {
  reveal: z.enum(["auto", "synced", "paced"]).optional(),
  pacing: z.enum(["even", "accelerate", "decelerate", "ease-in-out"]).optional(),
  revealSpeed: z.number().min(0.1).max(1).optional(),
  entrance: z.enum(["pop", "fade", "rise", "bounce"]).optional(),
};

export const REVEAL_PROP_KEYS = ["reveal", "pacing", "revealSpeed", "entrance"] as const;

/**
 * The plain icons a pattern scene may draw (§161). Here rather than beside
 * the `Icon` primitive in scenes because the props schemas below take it as a
 * `z.enum` (CardRow's `icon`, plan Task 4) and core cannot import from
 * scenes; the primitive imports this tuple and keys its drawings by it, so a
 * name added here without a drawing fails the scenes typecheck. "none" is a
 * real member, not an absence: the schema defaults to it and the card draws
 * no icon slot at all.
 */
export const ICON_NAMES = [
  "none",
  "chat",
  "doc",
  "search",
  "terminal",
  "code",
  "check",
  "bolt",
  "user",
  "robot",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

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
    .array(
      z.object({
        text: z.string().min(1).max(32),
        struck: z.boolean().default(false),
        /**
         * Verdict glyph before the line (R16 §66): `cross` renders ✗ in the
         * danger color, `check` ✓ in the success color — the wrong-vs-right
         * list variant. Defaults to none, so every existing production
         * renders byte-identically.
         */
        mark: z.enum(["none", "cross", "check"]).default("none"),
      }),
    )
    .min(1)
    .max(4),
  ...RevealPropsShape,
});

/**
 * An enumeration (R16 §67): the speaker lists parallel things and each gets a
 * bullet row. Born from a real miss — "what you need is AI harness, context
 * engineering, prompt engineering" was bent into a title-plus-strike card
 * that struck a thing the speaker RECOMMENDED, because no component said
 * "list".
 */
export const BulletListProps = z.object({
  /** Small kicker above the list ("WHAT YOU NEED"). */
  title: z.string().max(28).optional(),
  items: z.array(z.string().min(1).max(36)).min(2).max(5),
});

export const FlowDiagramProps = z.object({
  nodes: z.array(z.string().min(1).max(16)).min(2).max(5),
  /** Emphasize the terminal node (white chip, like CHURN in the reference). */
  emphasizeLast: z.boolean().default(true),
  ...RevealPropsShape,
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
  /**
   * A counter tag on the last window's top-right corner ("+1,568 lines"),
   * the playbook's diff-stat badge (§161, plan Task 8). Optional with no
   * default, so a scene without one parses to exactly the props it always
   * had. Script-only for the LLM (`SCRIPT_ONLY_PROP_KEYS`): showing it in a
   * run without `--script` would change that run's props prompt (G6).
   */
  badge: z.string().max(16).optional(),
  ...RevealPropsShape,
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
   * The comment-CTA word the viewer is asked to type, plain and unformatted —
   * the render quotes and capitalizes it ('"AGENTS"'), because formatting never
   * lives in LLM output (FINDINGS §16). Setting it also collapses the scene to
   * that ONE bubble (FINDINGS §28b), so it is only correct when the ask really
   * is "comment <word>". A "reply with a number / which one" ask has no word to
   * type and must leave this unset — `rejectCtaKeyword` drops it if it slips
   * through, and the exchange in `messages` renders instead.
   */
  keyword: z
    .string()
    .max(16)
    .optional()
    .describe(
      "ONLY for a 'comment <word>' ask: the single distinctive word the viewer types, " +
        "plain and unformatted. Leave unset for any other CTA — especially " +
        "'reply with a number/which one', where there is no word to type. Never a " +
        "referential filler like 'number', 'answer', 'comment' or 'below'.",
    ),
  ...RevealPropsShape,
});

export const ScreenshotFrameProps = z.object({
  /**
   * File name inside the render public dir; omitted → styled placeholder
   * frame. NEVER invent one (R22 §112): the producer reads the transcript
   * and a take that mentions a file will tempt it into naming that file,
   * which does not exist beside the video and used to kill the render.
   * `produce` strips any `src` it cannot find, so a guess costs a warning
   * rather than a failure — but the right output is no `src` at all.
   */
  src: z
    .string()
    .optional()
    .describe(
      "OMIT THIS unless the user supplied an actual image file beside the video — " +
        "never invent a filename from the transcript; without it the frame renders " +
        "as a styled placeholder, which is the intended look",
    ),
  label: z.string().max(32).optional(),
  kenBurns: z.boolean().default(true),
});

/**
 * A transparent video clip made elsewhere, placed by a script's `clip:` cue
 * (explainer spec 1.4). Never written by an LLM: `src` and `durationSec` come
 * from the clip import (a VP9-alpha WebM in the render's public dir, and its
 * probed length), so there is no default for either — a clip scene without
 * them has nothing to play and is dropped as invalid rather than rendered as
 * a missing file.
 */
export const ClipSceneProps = z.object({
  /** Path inside the render public dir, as `staticFile()` takes it. */
  src: z.string().min(1),
  /** The clip's own length: the scene lasts this long, not its word span. */
  durationSec: z.number().positive(),
  /**
   * The clip's audio plays under the voice at this level; nothing is ducked
   * (spec 1.4). Bounded at 0 dB because a browser's media `volume` throws
   * above 1 (10^(dB/20) > 1 for any positive gain), which would take the
   * editor's Player down with it; −40 dB is already inaudible under a voice.
   * The bounds are also what gives the Inspector a slider (§153's derived
   * controls skip an unbounded number).
   */
  gainDb: z.number().min(-40).max(0).default(-13),
  muted: z.boolean().default(false),
});

/*
 * Field notes on the four script-only cards (§161). The acceptance run on
 * real footage picked the right card for every plain cue and wrote weak
 * props: a `channel` of "channel", a `BugCard` with no `mockWrong`, a
 * `highlight: 0` the speaker never made. A `.describe()` reaches the model
 * because the props prompt embeds `z.toJSONSchema` of the LLM-facing copy
 * (`llmPropsSchema`). Only these four carry new notes: their schemas are
 * shown in script runs alone, while a note on one of the nine planner
 * components would change the frozen props prompt every run sees (G6,
 * `llm-props-schemas.pre-reveal.json`).
 */

/**
 * Two to four parallel things as a row of cards (§161, plan Task 4): steps,
 * tools, options, one card each in spoken order. Script-only. Each card is
 * one reveal item, so it lands on its own spoken words. The caps (18 and 24)
 * are what four cards in one 16:9 row can hold at the 34 px floor without a
 * third line; the layout is solved in scenes' `cardRowMetrics`.
 */
export const CardRowProps = z.object({
  cards: z
    .array(
      z.object({
        text: z
          .string()
          .min(1)
          .max(18)
          .describe("The item's name in one to three words, as the speaker says it."),
        sub: z
          .string()
          .max(24)
          .optional()
          .describe("A short technical tag such as a command or file name. Omit when the speaker gives none."),
        icon: z
          .enum(ICON_NAMES)
          .default("none")
          .describe("A plain icon that fits the item; 'none' when nothing fits."),
      }),
    )
    .min(2)
    .max(4),
  /** The chosen card: drawn in `accent` and bumped once the row has landed. */
  highlight: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe("Index of the one card the speaker singles out. Omit when no card is singled out."),
  ...RevealPropsShape,
});

/**
 * The call to action, performed on screen (§161, plan Task 5): a comment
 * typed into a box, a Subscribe button pressed, a link in a URL bar.
 * Script-only. No reveal props: it is one card with no items to land on
 * words, and its motion is a timeline of its own (`ctaTimeline`). No `logo`
 * (plan decision 2): a file-path prop needs ScreenshotFrame's staging and
 * safety checks, so the card shows `channel` beside a plain icon. The caps
 * are what one card holds in 9:16 at the 34 px floor (`ctaCardMetrics`).
 */
export const CtaCardProps = z.object({
  action: z.enum(["comment", "subscribe", "link"]),
  /** The headline; for a comment with no `keyword`, the comment itself. */
  text: z.string().min(1).max(40).describe("The ask, in the speaker's words."),
  /** The asked-for word: the comment typed, or the link shown. */
  keyword: z
    .string()
    .max(16)
    .optional()
    .describe(
      "For 'comment': the exact word the viewer is asked to comment. For 'link': the link text. " +
        "Omit for 'subscribe'.",
    ),
  /** Beside the Subscribe button; absent, the row is the button alone. */
  channel: z
    .string()
    .max(24)
    .optional()
    .describe("The channel's name, only when the speaker says it. Omit otherwise; never write a placeholder."),
});

/**
 * One numbered problem, shown failing (§161, plan Task 6): a red number
 * badge, a two-line headline and its consequence, and a mock of the bug — a
 * caption with a word struck through or run off the edge, or code lines with
 * the wrong one in red — closed by a sticker. Script-only. No reveal props:
 * it builds on a timeline of its own (`bugTimeline`), not one item per beat.
 *
 * Flat on purpose (plan Task 6): the mock's kind and fault are top-level
 * enums so the Inspector derives a dropdown for each from this schema, and
 * `mockLines` is a plain string array the editor retypes as `mock-N`
 * elements. In 9:16 the mock is not drawn (`bugMockVisible`); the caps are
 * what the text panel holds there at the 34 px floor (`bugCardMetrics`).
 */
export const BugCardProps = z.object({
  number: z
    .number()
    .int()
    .min(1)
    .max(9)
    .describe("The number the speaker gives this problem; 1 when they give none."),
  headline: z.string().min(1).max(40).describe("The problem in a few words."),
  /** The consequence, under the headline in `danger`. */
  sub: z
    .string()
    .max(40)
    .optional()
    .describe("The consequence, in the speaker's words. Do not repeat it in sticker."),
  mock: z
    .enum(["none", "caption", "lines"])
    .default("none")
    .describe(
      "'caption' shows one caption with a faulty word; 'lines' shows up to four lines of text or code " +
        "with one faulty line; 'none' when neither fits.",
    ),
  /** Caption words (`caption`) or code lines (`lines`), in order. */
  mockLines: z
    .array(z.string().max(32))
    .max(4)
    .default([])
    .describe(
      "For 'caption': the words of one short caption, one word per entry, in order. " +
        "For 'lines': the lines. Leave empty when mock is 'none'.",
    ),
  /** The entry of `mockLines` that is wrong; absent or out of range marks none. */
  mockWrong: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe("Index of the entry in mockLines that shows the fault. Always set it when mock is not 'none'."),
  /**
   * How a wrong caption word fails: struck through, or cut off at the
   * panel's edge. A `lines` mock never reads it (BugCard's `LinesMock`).
   */
  mockFault: z
    .enum(["struck", "clipped"])
    .default("struck")
    .describe("'struck' crosses the faulty entry out; 'clipped' cuts it off at the edge and applies to 'caption' only."),
  /** Not drawn when it repeats `sub` (scenes' `bugStickerText`). */
  sticker: z
    .string()
    .max(14)
    .optional()
    .describe("One or two words that close the beat, such as a verdict the speaker says. Omit when there is none."),
});

/**
 * "This is how captions sit on a phone" (§161, plan Task 7): a stand-in
 * vertical video with caption words in its lower third and checklist pills
 * building beside it (16:9) or under it (9:16). Script-only. Each pill is
 * one reveal item, so it lands on its spoken words; the caption is on the
 * phone from its entrance.
 *
 * The caps are a real caption chunk, not a sentence (plan author,
 * 2026-11-16): the first caps (eight words of 14) could only be drawn one
 * word a line at the 34 px floor in a phone ~430 px wide, eight lines up
 * the panel. Six words of 12 is a chunk a caption actually shows. Pill
 * caps are what one 16:9 column beside the phone holds at the floor
 * (`phoneDemoMetrics`).
 */
export const PhoneDemoProps = z.object({
  caption: z
    .array(
      z.object({
        text: z.string().min(1).max(12),
        /** An emphasised word sits in ink on a tilted yellow or orange box. */
        emphasis: z
          .enum(["none", "yellow", "orange"])
          .default("none")
          .describe("Mark at most two words; 'none' for the rest."),
      }),
    )
    .min(1)
    .max(6)
    .describe("The caption shown on the phone: two to six words from the spoken line, one word per entry, in order."),
  pills: z
    .array(
      z.object({
        text: z.string().min(1).max(22),
        /** ok: success border and a tick; bad: danger border and a cross; plain: accent2, no mark. */
        state: z
          .enum(["ok", "bad", "plain"])
          .default("ok")
          .describe(
            "'bad' for something described as wrong, 'ok' for something described as right, 'plain' otherwise.",
          ),
      }),
    )
    .max(4)
    .default([])
    .describe("One short label per point the speaker makes, in spoken order."),
  ...RevealPropsShape,
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
  /**
   * false = never offered to an LLM (ClipScene). Default true. Every planner
   * menu reads `plannerComponentIds()`, never the registry's keys, so a
   * component added for one mode cannot change another mode's prompt (G6).
   */
  plannerSelectable?: boolean;
  /**
   * true = offered only by a SCRIPT's planner (`scriptComponentIds()`), never
   * by the beat sheet (`plannerComponentIds()`), whose menu and enum are
   * frozen for runs without `--script` (G6). Not `plannerSelectable: false`,
   * which means "never written by an LLM" and also hides the editor's swap:
   * a script-only component IS a card an LLM fills, and the editor offers it
   * in the swap for every project (plan decision 5).
   */
  scriptOnly?: boolean;
  /**
   * false = no frosted scrim behind it over live video. Default true. A
   * transparent clip is designed to sit on the speaker; a scrim would frost
   * the very footage it is drawn over (spec 1.4/1.5).
   */
  scrim?: boolean;
  /**
   * When set, the scene lasts this long instead of its word span — a clip
   * plays for its own length, whatever the words under it (spec 1.4). Read
   * from the RESOLVED props, so an edited duration is the one honoured.
   */
  fixedDurationSec?: (props: Record<string, unknown>) => number | undefined;
  /**
   * true = the graphic's slot is the whole frame, whatever the layout or a
   * routed/hand-set `graphicRect` says (`graphicSlotFor`). A clip was authored
   * at frame size with its own margins, so the full-bleed band (0.77 × 0.36)
   * shrank it to a postage stamp and a safe-area clamp would crop margins the
   * author already left. Default false; only ClipScene and the script-only
   * pattern scenes set it (they lay themselves out inside the frame with
   * their own 100 px margin, plan decision 1), so every planner component's
   * geometry is unchanged (G6).
   */
  fullFrame?: boolean;
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
    whenToUse:
      "Negation/contrast beat — big words over the blurred speaker. Strike EVERY line of the " +
      "phrase the speaker negates, not just its tail — a half-struck claim reads as a typo. " +
      'For wrong-vs-right lists, set mark: "cross"/"check" (✗/✓) per line instead.',
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
  BulletList: {
    propsSchema: BulletListProps,
    defaultProps: { items: ["FIRST", "SECOND"] },
    defaultLayout: "blurred-behind",
    altLayouts: ["graphic-only"],
    whenToUse:
      "An ENUMERATION — the speaker lists two or more parallel things " +
      "('what you need is X, Y, Z'). One bullet per item, optional kicker title. " +
      "Use this for lists instead of bending TitleCard or StrikethroughReveal around them.",
  },
  // Script-only pattern scenes (§161): after the nine, so the script menu
  // keeps the nine in today's order and appends; before ClipScene, which no
  // menu lists. Full frame over the speaker with no scrim, like the
  // hand-made transparent clips they replace (plan decision 1).
  CardRow: {
    propsSchema: CardRowProps,
    defaultProps: { cards: [{ text: "ONE" }, { text: "TWO" }, { text: "THREE" }] },
    defaultLayout: "full-bleed",
    altLayouts: [],
    whenToUse:
      "The line lists two to four parallel things (steps, tools, options). One card per item, " +
      "in spoken order; set highlight to the chosen one.",
    scriptOnly: true,
    scrim: false,
    fullFrame: true,
  },
  CtaCard: {
    propsSchema: CtaCardProps,
    defaultProps: { action: "subscribe", text: "Subscribe for more" },
    defaultLayout: "full-bleed",
    altLayouts: [],
    whenToUse:
      "The line asks the viewer to do something: comment a word, subscribe or follow, or open a link. " +
      "Put the asked-for word in keyword.",
    scriptOnly: true,
    scrim: false,
    fullFrame: true,
  },
  BugCard: {
    propsSchema: BugCardProps,
    defaultProps: { number: 1, headline: "The problem" },
    defaultLayout: "full-bleed",
    altLayouts: [],
    whenToUse:
      "The line names one specific problem or bug, often numbered. headline says it in a few words; " +
      "sub is the consequence. Use mock 'caption' or 'lines' only with words the speaker says.",
    scriptOnly: true,
    scrim: false,
    fullFrame: true,
  },
  PhoneDemo: {
    propsSchema: PhoneDemoProps,
    defaultProps: { caption: [{ text: "YOUR" }, { text: "CAPTIONS", emphasis: "yellow" }] },
    defaultLayout: "full-bleed",
    altLayouts: [],
    whenToUse:
      "The line explains how captions or a vertical video look or behave. caption holds the words shown " +
      "on the phone; pills are short checklist labels, one per point the speaker makes.",
    scriptOnly: true,
    scrim: false,
    fullFrame: true,
  },
  // Last on purpose: registry order is menu order, and a planner menu that
  // ever did include this entry would at least not reorder the nine.
  ClipScene: {
    propsSchema: ClipSceneProps,
    // Empty: there is no honest default clip (see ClipSceneProps).
    defaultProps: {},
    // Full frame over the speaker, no scrim (spec 1.4). Phase 1 gets the
    // whole frame from `fullFrame`, a per-component flag, not from new 16:9
    // layout geometry (plan, "Deviation from the spec"): full-bleed keeps the
    // speaker full frame underneath, and the flag widens only this
    // component's slot.
    defaultLayout: "full-bleed",
    altLayouts: [],
    // Never shown to a model (plannerSelectable: false); present only
    // because the field is required.
    whenToUse: "A transparent video clip placed by a script's `clip:` cue; never planned.",
    plannerSelectable: false,
    scrim: false,
    fullFrame: true,
    fixedDurationSec: (props) =>
      typeof props.durationSec === "number" ? props.durationSec : undefined,
  },
};

/**
 * The components the beat-sheet planner may offer, in registry order — the
 * source of every LLM-facing component menu outside script mode (G6). Equal
 * to `PlannerComponentIdSchema.options` by test; the cast is sound for
 * exactly that reason. Script-only entries are filtered here, not only
 * absent from the enum: the beat-sheet menu is built from this list, and a
 * card leaking into it would change every run's prompt.
 */
export function plannerComponentIds(): PlannerComponentId[] {
  return (Object.keys(SCENE_REGISTRY) as SceneComponentId[]).filter(
    (id) => SCENE_REGISTRY[id].plannerSelectable !== false && !SCENE_REGISTRY[id].scriptOnly,
  ) as PlannerComponentId[];
}

/**
 * What a script's planner may offer, in registry order: the nine, then the
 * script-only cards. Equal to `ScriptComponentIdSchema.options` by test, the
 * same sound-cast argument as `plannerComponentIds`. Also the editor's swap
 * list (plan decision 5): every card is swappable to every other, in any
 * project; only ClipScene stays out.
 */
export function scriptComponentIds(): ScriptComponentId[] {
  return (Object.keys(SCENE_REGISTRY) as SceneComponentId[]).filter(
    (id) => SCENE_REGISTRY[id].plannerSelectable !== false,
  ) as ScriptComponentId[];
}

/**
 * Props of the frozen planner components that only a script run's props
 * call is shown (§161, plan Task 8). The explainer look grew copy slots on
 * components every run uses; offering them outside script mode would change
 * the schema text in every props prompt — the byte-identical prompt G6
 * freezes (`llm-props-schemas.pre-reveal.json`). Only the LLM's view is
 * narrowed: the registry schema keeps them, so a scene that has one parses
 * and renders it in any run.
 */
export const SCRIPT_ONLY_PROP_KEYS: Partial<Record<SceneComponentId, readonly string[]>> = {
  TerminalMock: ["badge"],
};

/**
 * The copy of a component's props schema the prop-writing LLM call is shown
 * (reveal-timing spec, "The LLM does not set"). Reveal props are an author's
 * call, not copy: the model has no idea how the take sounds, and offering it
 * the keys would invite it to "fill" them — and it would change the schema
 * text in every prop-call prompt. Omitting them keeps that prompt
 * byte-identical to before the props existed.
 *
 * `mode` is the run's: `"auto"` (no `--script`, the default) also omits the
 * component's `SCRIPT_ONLY_PROP_KEYS`, so that prompt stays frozen too (G6);
 * `"script"` offers them.
 *
 * A component with nothing to omit gets its registry schema back untouched —
 * the same object, so "unchanged" is identity, not just equal output.
 */
export function llmPropsSchema(
  component: SceneComponentId,
  mode: "auto" | "script" = "auto",
): z.ZodType {
  const schema = SCENE_REGISTRY[component].propsSchema;
  if (!(schema instanceof z.ZodObject)) return schema as z.ZodType;
  const hidden = [
    ...REVEAL_PROP_KEYS,
    ...(mode === "auto" ? (SCRIPT_ONLY_PROP_KEYS[component] ?? []) : []),
  ];
  const present = hidden.filter((k) => k in schema.shape);
  if (present.length === 0) return schema as z.ZodType;
  const mask = Object.fromEntries(present.map((k) => [k, true as const]));
  return (schema as z.ZodObject).omit(mask) as z.ZodType;
}

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
