/**
 * The planner call (storyboard design §2 "The plan"; §168): one `complete`
 * call that reads the transcript and proposes the shots of the plan table.
 *
 * A prompt of its own, used only by a storyboard run (design §2, G9): the
 * beat-sheet prompt is frozen for runs without `--storyboard`, and its
 * grammar (a hook, template components, 40-50% coverage) is not this one's.
 * It plans pictures an artist will draw, not components to fill.
 *
 * The prompt states every limit with its reason, but nothing here enforces
 * one: `enforcePlanLimits` (./limits) is the one place a reply is made safe,
 * and the caller runs it, so the planner's own words reach the report.
 *
 * Pure apart from the one provider call.
 */
import { z } from "zod/v4";
import { MAX_SCENE_SEC } from "../assemble";
import type { LlmProvider } from "../producer/provider";
import { STORYBOARD_COVERAGE, STORYBOARD_MIN_SHOT_SEC, type PlannedShot } from "./record";

/**
 * Part of the plan cache key (plan Task 3), bumped whenever the prompt or
 * the reply schema changes what is asked. Its own version: no other prompt
 * shares it, so a change here re-plans no run without `--storyboard`.
 */
export const STORYBOARD_PLAN_PROMPT_VERSION = "b1";

/**
 * Most shots one reply may hold. A 4-minute video at the coverage limit
 * holds about 24 shots of 6 seconds; past 40 a reply is long enough that a
 * provider cutting it off would silently lose the end of the video.
 */
const STORYBOARD_PLAN_MAX_SHOTS = 40;

/**
 * The reply. Indices are bare integers on purpose, with no bounds: a reply
 * with a reversed or out-of-range span is still a plan worth keeping the
 * rest of, and the limits fix or drop that one shot with a reason (plan
 * Review Focus 1). A schema failure would throw the whole plan away.
 */
export const StoryboardPlanReplySchema = z.object({
  shots: z
    .array(
      z.object({
        startWord: z.number().int(),
        endWord: z.number().int(),
        idea: z.string().min(1).max(400),
        why: z.string().max(200),
        priority: z.number().int().min(1).max(3),
        assets: z.array(z.string()),
      }),
    )
    .max(STORYBOARD_PLAN_MAX_SHOTS),
});
export type StoryboardPlanReply = z.infer<typeof StoryboardPlanReplySchema>;

export interface StoryboardPlanInput {
  /** The raw transcript's words; indices are into this list. */
  words: readonly { text: string }[];
  /** Indices of the words the effective cut removes (design §2 "Which cut"). */
  cut: ReadonlySet<number>;
  outputDurationSec: number;
  width: number;
  height: number;
  intent?: string;
  assets: { name: string; width: number; height: number; note?: string }[];
  /** Spans a kept shot already covers, on "Plan again": the planner proposes only around them (design §2). */
  taken: readonly { startWord: number; endWord: number; idea: string }[];
}

const pct = Math.round(STORYBOARD_COVERAGE * 100);

/**
 * The same for every video, so everything that varies is in the user
 * prompt. Plain prose in short sections, each limit with its reason: a
 * planner that knows why a limit exists plans inside it, and one that is
 * only told the number argues with it at the edges. The two character
 * counts are the reply schema's caps, stated because one idea past its cap
 * fails the schema and with it the whole plan, not just that shot.
 */
const SYSTEM = `You plan the drawn shots of a talking-head video.

The situation
The video is one person talking to the camera. A shot is an animated drawing laid over the speaker for a stretch of what they say: a character acting out a point, an object that changes, a small diagram that builds. You plan the shots from the transcript; you do not draw them. Each shot is drawn later by a separate artist, as code-drawn SVG. That artist sees only your idea for the shot and the line spoken while it is on screen, nothing else of the video, so every idea must stand alone.

What a shot can show
Characters, animals, objects and props, simple places, diagrams, arrows, numbers and short labels, all drawn as animated SVG and moving over time. A shot cannot show photos, screenshots or footage of anything, and it has no sound. A moment that needs one of those gets no shot. The author may provide a few images, such as a logo; a shot may use them by name, and the message lists them.

Why each shot must earn its place
The author reviews your plan as a table before anything is drawn, and pays for each drawing. So plan a shot only where a picture explains more than the speaker's face does: something easier to see than to hear, a comparison, a process, a small story the speaker tells, a number that matters. Leave the opening hook, and the lines where the speaker talks straight to the viewer (a call to action, such as asking them to follow or comment), without a shot unless a picture adds something there; in those lines the face is the point. A few strong shots are worth more than many weak ones.

The limits, and why
- A shot lasts ${STORYBOARD_MIN_SHOT_SEC} to ${MAX_SCENE_SEC} seconds of the video as cut. That is the range a shot can be drawn at: shorter is gone before it can be read, longer outstays one drawing.
- All shots together cover at most ${pct}% of the runtime, so the speaker stays present. The viewer came for the person.
- Shots do not overlap, and each one starts after the one before it ends. One drawing is on screen at a time.
After your reply a program holds the plan to these limits without asking you: a shot that overlaps the one before it loses its start, and when the shots cover too much, the lowest priority ones are removed. A plan that stays inside the limits reaches the author as you meant it.

How to give a shot's words
The transcript lists every word with its index, as [12]word. A word the video cut is shown as [13]⟦word⟧: the viewer never hears it, so never build an idea on it. A shot is the inclusive range of word indices from startWord to endWord, and both ends should be kept words. Start on the first word of the line the picture belongs to, so the drawing appears as the speaker begins that thought, and end on the last word of it.

Priority
1 means the video is worse without this shot. 2 means the shot helps. 3 means it is nice to have. Judge it honestly: when the plan is too long, the shots with priority 3 go first.

The idea
One or two sentences, under 400 characters, saying what is on screen and how it moves, written for the artist who sees nothing else. Name the things to draw and what they do; describe the picture, not the speaker's argument. Keep any words on screen to short labels. Two examples of ideas, on subjects chosen to be unlike this video's; take their kind, not their content:
- A character scene: "A small bear in an apron carries a stack of pancakes that grows taller with each step, wobbles, and tips over onto the table."
- A diagram-like scene: "Three boxes labelled seed, sprout and tree appear from left to right, each joined to the next by an arrow that draws itself in, and leaves sprout from the last box."
Then why: one line, under 200 characters, on what this picture shows that the speaker's face alone would not.
Then assets: the names of the author's images the shot uses, exactly as listed, or an empty list. Most shots use none.

Your reply
The shots in the order they appear, at most ${STORYBOARD_PLAN_MAX_SHOTS}, each with startWord, endWord, idea, why, priority and assets.`;

/**
 * The transcript as the beat sheet shows it (`buildBeatsUserPrompt`,
 * producer/beats.ts): every word with its index, cut words kept in the
 * listing and marked, so indices stay raw-transcript indices (design §2
 * "Anchoring") and a span may cross a tightened retake. Restated here
 * because beats.ts builds its listing inline and is frozen for runs without
 * `--storyboard`; marking is unconditional since this prompt is new.
 */
function wordListing(words: readonly { text: string }[], cut: ReadonlySet<number>): string {
  return words.map((w, i) => (cut.has(i) ? `[${i}]⟦${w.text}⟧` : `[${i}]${w.text}`)).join(" ");
}

const seconds = (x: number) => `${x.toFixed(1)} seconds`;

export function storyboardPlanPrompt(input: StoryboardPlanInput): { system: string; user: string } {
  const orientation = input.width > input.height ? "landscape" : input.width < input.height ? "portrait" : "square";
  const intent = input.intent?.trim()
    ? `Intent: ${input.intent.trim()}`
    : "Intent: none given. Judge what the video is for from the transcript.";
  const assets =
    input.assets.length === 0
      ? "There are no assets for this video: expect everything to be drawn."
      : `The author's images, which a shot may use by these names only:\n${input.assets
          .map((a) => `- ${a.name}: ${a.width} x ${a.height} px${a.note ? `, ${a.note}` : ""}`)
          .join("\n")}\nAnything else a shot needs is drawn.`;
  const taken =
    input.taken.length === 0
      ? ""
      : `Already taken\nThese spans have a shot the author is keeping. Plan no shot that overlaps one:\n${input.taken
          .map((t) => `- words ${t.startWord} to ${t.endWord}, "${t.idea}": do not plan here`)
          .join("\n")}\n\n`;

  const user = `The video
${intent}
Frame: ${input.width} x ${input.height} pixels, ${orientation}.
Runtime after the cut: ${seconds(input.outputDurationSec)}.

The limits
Each shot lasts ${STORYBOARD_MIN_SHOT_SEC} to ${MAX_SCENE_SEC} seconds.
All shots together cover at most ${pct}% of the runtime, which is ${seconds(STORYBOARD_COVERAGE * input.outputDurationSec)}.
No two shots overlap.

Assets
${assets}

${taken}Word-indexed transcript (indices refer to this list):
${wordListing(input.words, input.cut)}`;

  return { system: SYSTEM, user };
}

/**
 * One call; a provider failure throws, and the caller decides what a failed
 * plan means (the run stops, the editor answers `ok: false`). The reply is
 * returned as the planner gave it: the schema bounds `priority` to 1-3, so
 * the cast only narrows the type to what was already checked.
 */
export async function planStoryboard(provider: LlmProvider, input: StoryboardPlanInput): Promise<PlannedShot[]> {
  const { system, user } = storyboardPlanPrompt(input);
  const reply = await provider.complete({
    system,
    user,
    schema: StoryboardPlanReplySchema,
    schemaName: "storyboard_plan",
    // Choosing the moments a video is drawn at is the judgement the
    // storyboard rests on (design §2), as the beat sheet is for a plain run.
    tier: "editorial",
  });
  return reply.shots.map((s) => ({
    startWord: s.startWord,
    endWord: s.endWord,
    idea: s.idea,
    why: s.why,
    priority: s.priority as 1 | 2 | 3,
    assets: s.assets,
  }));
}
