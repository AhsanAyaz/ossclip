/**
 * Planning from the author's script (explainer design §1.3): each aligned cue
 * becomes ONE moment on the words the alignment found, and a single LLM call
 * only chooses the component and writes the copy for the cues that need it.
 *
 * Why a separate call and schema rather than the beat sheet with the cues
 * pasted in: the beat-sheet call is the segmentation judgement — it picks the
 * word spans — and here the spans are already decided by the script. Its
 * schema also requires a hook and caps moments at 24, and its prompt carries
 * the short-form virality grammar (alternate with talking head, ~45%
 * coverage) that an explainer whose every line has a cue would fight. And the
 * beat-sheet prompt and schema are frozen for runs without `--script` (G6),
 * so script mode cannot extend them either.
 */
import { z } from "zod/v4";
import type { Transcript } from "../schema";
import { LayoutSchema, ScriptComponentIdSchema, type Scene } from "../scene-schema";
import { SCENE_REGISTRY, scriptComponentIds } from "../scene-registry";
import type { AlignedCue } from "../script/align";
import { cappedText, type BeatsValidationIssue, type ScriptMoment } from "./beats";
import { momentSceneId } from "./scene-props";
import type { LlmProvider } from "./provider";

/**
 * Part of the script-plan cache key (Task 8), bumped whenever the prompt or
 * schema below changes what is asked. Its own version, not
 * `PRODUCER_PROMPT_VERSION`: bumping that would re-plan every non-script take
 * for a change that cannot affect them (spec, Compatibility).
 *
 * "s2": the menu, the `sceneKind` enum and the hint check grew the
 * script-only cards (§161, plan Tasks 4-8 — one bump for the lot, since none
 * of them ships alone). An "s1" plan was asked without them, so it must not
 * be served to a script that now hints `[CardRow]` (plan Review Focus 4).
 */
export const SCRIPT_PLAN_PROMPT_VERSION = "s2";

/**
 * Most cues one script may carry (§1.3). A ceiling on the one call that plans
 * them all: past it the reply is long enough that a provider truncating it
 * would silently drop the tail cues to the TitleCard fallback. A 4-minute
 * explainer is ~24 cues; 40 leaves room without inviting a whole course.
 */
export const MAX_SCRIPT_CUES = 40;

/**
 * A `clip:` cue's imported clip (Task 6). `src` is relative to the render's
 * public dir. Not `ResolvedClip`, which the plan named it: that name is already
 * `@ossclip/core`'s resolved `--clip` window (clip.ts).
 */
export interface ResolvedScriptClip {
  cueId: string;
  src: string;
  durationSec: number;
}

export interface ScriptPlanInput {
  aligned: AlignedCue[];
  clips: ResolvedScriptClip[];
}

/**
 * A script that cannot be planned as written — too many cues, a `[Name]` hint
 * that is no script component, a clip cue with no clip. Thrown before any LLM
 * call, with a message written to be shown as-is: each of these is the
 * author's to fix in the script, and degrading would place something they did
 * not ask for.
 */
export class ScriptPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptPlanError";
  }
}

/** One entry per non-clip cue, echoing the cue's id. */
export const ScriptPlanSchema = z.object({
  cues: z.array(
    z.object({
      id: z.string(),
      // The script menu (the nine plus the script-only cards), never the
      // full id enum: no LLM may place a ClipScene (G6 doctrine,
      // scene-schema.ts). This schema is script mode's alone, so widening it
      // changes no other run's ask.
      sceneKind: z.union([ScriptComponentIdSchema, z.literal("none")]),
      layout: LayoutSchema.optional(),
      // Capped, never rejected (§123/§151, `cappedText`).
      onScreenCopy: cappedText(60),
    }),
  ),
});
type ScriptPlanReply = z.infer<typeof ScriptPlanSchema>;

const SCRIPT_PLAN_SYSTEM = `You are the producer for an explainer video. The author wrote a script before recording: each cue below is an on-screen instruction ("🎬") with the lines spoken while it is on screen. The cues are already placed on the spoken words; your job is to choose how each cue is shown and write its on-screen copy.

Rules — follow these as hard policies:
- The cue text is the instruction. Choose the component that shows what it describes; do not second-guess the author's intent.
- On-screen copy may only use words and numbers that appear in the cue text or the spoken text. Never introduce a name, number or claim from anywhere else. Copy is SHORT: numbers over adjectives, never full sentences.
- FOOTAGE: some cues describe footage, not a graphic ("Screen recording: …", "B-roll of …", "Back to your face", "GitHub page for …", "Browser: …"). For such a cue answer sceneKind "none": the speaker stays on screen and the cue is reported to the author.
- A cue marked "component: <Name> (fixed)" has its component chosen by the author: answer that component and write only its copy. Never answer "none" for it.
- Return one entry for EVERY cue, echoing its id exactly. You may set \`layout\`; omit it for the component's default.`;

/**
 * The fallback copy: the cue text, as the props call's TitleCard fallback
 * uses a moment's copy. `cappedText` cuts at a word boundary when one keeps
 * most of the budget — the same truncation the reply's copy gets.
 */
const fallbackCopy = (cueText: string): string => cappedText(60).parse(cueText);
const capPurpose = (text: string): string => cappedText(100).parse(text);

function buildScriptPlanUserPrompt(cues: ReadonlyArray<{ aligned: AlignedCue; fixed?: string }>): string {
  // `id:` and `cue:` open their lines so the mock provider can read the ids
  // back off the prompt (mock.ts), the way it reads `[n]` word indices.
  const blocks = cues.map(({ aligned, fixed }) =>
    `--- cue ---\n` +
    `id: ${aligned.cue.id}\n` +
    `cue: ${aligned.cue.cueText}\n` +
    `spoken: ${aligned.cue.spoken.join(" ")}` +
    (fixed ? `\ncomponent: ${fixed} (fixed)` : ""),
  );
  // `scriptComponentIds()`, never the registry's keys: ClipScene is placed
  // by `clip:` cues only and must not be offered (G6). The script-only cards
  // are offered HERE and nowhere else (plan Task 4).
  const menu = scriptComponentIds()
    .map((id) => `- ${id}: ${SCENE_REGISTRY[id].whenToUse}`)
    .join("\n");
  return (
    `Cues (${cues.length}), in script order:\n\n${blocks.join("\n\n")}\n\n` +
    `Scene components available (sceneKind values; "none" = footage, no graphic):\n${menu}`
  );
}

/**
 * Moments for the aligned cues of a script, `moments[i]` for `aligned[i]`.
 *
 * Spans come from the alignment and nothing the reply says can move them: the
 * anti-goal is a cue placed on the wrong words (§1.2), and an LLM re-reading
 * the transcript is exactly how that would happen.
 *
 * - `clip:` cues skip the LLM entirely: a talking-head moment plus a
 *   ClipScene in `clipScenes`, which the caller appends after the props call
 *   (the props call has nothing to write for a clip).
 * - `[Component]` cues keep the author's component whatever the reply says,
 *   including "none"; the reply still writes their copy.
 * - A thrown call is retried once; after that, and for any cue the reply
 *   leaves out, the cue falls back to a TitleCard of its own cue text and an
 *   issue says so (§1.3) — one cue's miss never costs the others.
 *
 * The spoken text in the prompt is the SCRIPT's lines, not the transcript's:
 * it is the author's spelling of what they meant to say, free of ASR
 * mishearings, and the props call that follows already reads the transcript
 * slice as heard. `transcript` is accepted so a later version can show both
 * without changing the signature; this one does not read it.
 */
export async function planScriptMoments(
  provider: LlmProvider,
  input: ScriptPlanInput,
  transcript: Transcript,
): Promise<{ moments: ScriptMoment[]; clipScenes: Scene[]; issues: BeatsValidationIssue[] }> {
  const { aligned } = input;
  if (aligned.length > MAX_SCRIPT_CUES) {
    throw new ScriptPlanError(
      `the script has ${aligned.length} placed cues; at most ${MAX_SCRIPT_CUES} are supported — split the video or merge cues`,
    );
  }

  // Every script error is found before the call, so a typo costs no tokens.
  // The same list the menu offers, so a hint can name exactly what the
  // planner could have chosen — and the CLI's pre-transcription check
  // (`scriptCueProblems`) parses with the same schema.
  const valid = scriptComponentIds();
  const clipsByCue = new Map(input.clips.map((c) => [c.cueId, c]));
  const fixedKinds = new Map<number, ScriptMoment["sceneKind"]>();
  for (let i = 0; i < aligned.length; i++) {
    const { cue } = aligned[i]!;
    if (cue.hint.kind === "component") {
      const parsed = ScriptComponentIdSchema.safeParse(cue.hint.component);
      if (!parsed.success) {
        throw new ScriptPlanError(
          `unknown component [${cue.hint.component}] in the cue at script line ${cue.line}; valid names: ${valid.join(", ")}`,
        );
      }
      fixedKinds.set(i, parsed.data);
    }
    if (cue.hint.kind === "clip" && !clipsByCue.has(cue.id)) {
      throw new ScriptPlanError(
        `the clip cue at script line ${cue.line} (${cue.hint.path}) has no imported clip`,
      );
    }
  }

  const planned = aligned.flatMap((a, i) =>
    a.cue.hint.kind === "clip" ? [] : [{ aligned: a, index: i, fixed: fixedKinds.get(i) }],
  );

  const issues: BeatsValidationIssue[] = [];
  let reply: ScriptPlanReply | null = null;
  let lastError = "";
  if (planned.length > 0) {
    const user = buildScriptPlanUserPrompt(planned.map((p) => ({ aligned: p.aligned, fixed: p.fixed })));
    for (let attempt = 0; attempt < 2 && reply === null; attempt++) {
      try {
        reply = await provider.complete({
          system: SCRIPT_PLAN_SYSTEM,
          user,
          schema: ScriptPlanSchema,
          schemaName: "script_plan",
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  // First entry per id wins: a reply that repeats an id gets no second vote.
  const byId = new Map<string, ScriptPlanReply["cues"][number]>();
  for (const entry of reply?.cues ?? []) if (!byId.has(entry.id)) byId.set(entry.id, entry);

  const moments: ScriptMoment[] = [];
  const clipScenes: Scene[] = [];
  for (let i = 0; i < aligned.length; i++) {
    const a = aligned[i]!;
    const { cue } = a;
    const span = { startWord: a.startWord, endWord: a.endWord };
    const purpose = capPurpose(cue.cueText);

    if (cue.hint.kind === "clip") {
      const clip = clipsByCue.get(cue.id)!;
      // The cue text of a clip cue is its file path, which is no headline;
      // the spoken line is the author's words and is what `hook` (the first
      // moment's copy) would show on a cover if the script opens on a clip.
      moments.push({ ...span, purpose, onScreenCopy: fallbackCopy(cue.spoken.join(" ")), sceneKind: "none" });
      clipScenes.push({
        id: momentSceneId(i),
        anchor: span,
        // Full frame over the speaker (spec 1.4); the props are the import's,
        // and the registry fills gainDb and muted.
        layout: SCENE_REGISTRY.ClipScene.defaultLayout,
        component: "ClipScene",
        props: { src: clip.src, durationSec: clip.durationSec },
        overrides: {},
        rationale: "script clip",
      });
      continue;
    }

    const fixed = fixedKinds.get(i);
    const entry = byId.get(cue.id);
    if (!entry) {
      issues.push({
        moment: i,
        issue:
          reply === null
            ? `script_plan failed (${lastError.slice(0, 120)}); ${cue.id} falls back to ${fixed ?? "TitleCard"} from its cue text`
            : `script_plan reply left out ${cue.id}; it falls back to ${fixed ?? "TitleCard"} from its cue text`,
      });
      // A hinted cue keeps the author's component even here: the hint is
      // never overridden, and the props call can still fill it from the slice.
      moments.push({ ...span, purpose, onScreenCopy: fallbackCopy(cue.cueText), sceneKind: fixed ?? "TitleCard" });
      continue;
    }

    const sceneKind = fixed ?? entry.sceneKind;
    if (sceneKind === "none") {
      // Recorded so the report (Task 8) can list the cue as left to footage
      // rather than silently showing nothing where the script asked for a shot.
      issues.push({ moment: i, issue: `footage cue ${cue.id}: no graphic, stays talking head` });
    }
    moments.push({
      ...span,
      purpose,
      onScreenCopy: entry.onScreenCopy,
      sceneKind,
      // A layout picked for a different component than the one shown may not
      // be in its repertoire — dropped, as `forceComponent` drops it.
      ...(entry.layout && entry.sceneKind === sceneKind ? { layout: entry.layout } : {}),
    });
  }
  return { moments, clipScenes, issues };
}
