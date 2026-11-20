/**
 * The draw call's prompts and reply schema (storyboard design §3, §5, §6;
 * §167): one prompt for a first draft, one for a repair after a failed
 * check or a failed call, one for a redraw from the author's note.
 *
 * Every call stands alone: a provider keeps no conversation, so a repair or
 * a redraw restates the shot. The system text is the same for all three —
 * the rules, the kit and the examples — and only the user text says which
 * of the three this is.
 *
 * The rule lists are built from the static check's own constants
 * (static-check.ts), not retyped, so the prompt cannot promise what the
 * check rejects (draw-shot.test.ts pins that they agree). Where the prompt
 * says a consequence in words (`style={{ top: 10 }}` passes, `area.top`
 * does not), the check's behaviour is the truth and a test runs it.
 *
 * Pure: strings in, strings out. The kit's declarations arrive as
 * `kitReference` because core cannot import the scenes package (scenes
 * depends on core).
 */
import { z } from "zod/v4";
import {
  DRAW_ALLOWED_ELEMENTS,
  DRAW_ALLOWED_REMOTION,
  DRAW_FORBIDDEN_NAMES,
  DRAW_KIT_MODULE,
  DRAW_MAX_LINES,
  type DrawIssue,
} from "./static-check";
import { DRAW_EXAMPLES } from "./examples";

/**
 * Recorded with every drawn version (Task 6's history) so the gate (§167)
 * can tell which prompt drew what. Bumped whenever the text below or the
 * schema changes what is asked. Its own number: no other prompt shares it,
 * and runs without the draw command never read it (plan Global Constraints).
 */
export const DRAW_PROMPT_VERSION = 1;

/**
 * The reply. `said` is capped, not trimmed: a reply that overruns it fails
 * the schema in the provider and counts as one failed attempt, like any
 * other malformed reply (plan Task 5).
 */
export const DrawReplySchema = z.object({ code: z.string().min(1), said: z.string().max(300) });
export type DrawReply = z.infer<typeof DrawReplySchema>;

export interface DrawRequest {
  idea: string;
  /** What the speaker says while the shot is on screen; may be empty. */
  spokenLine: string;
  durationSec: number;
  width: number;
  height: number;
  /** `DRAW_KIT_REFERENCE` from `@ossclip/scenes/draw/reference`, passed in (see the header). */
  kitReference: string;
  assets: { name: string; width: number; height: number; note?: string }[];
}

export interface DrawNote {
  text: string;
}

/** A redraw's inputs: the version being redrawn, the notes already applied to earlier versions (oldest first), the new note. */
export interface DrawRedraw {
  code: string;
  notes: DrawNote[];
  note: DrawNote;
}

/**
 * Elements the prompt names as rejected. Not the rule — the rule is the
 * allow-list, and anything off it is rejected — but the ones an LLM reaches
 * for (an `<img>` for a picture, `<use>` for a repeated shape, `<style>` for
 * CSS). draw-shot.test.ts runs each through the check, so none of them can
 * end up on the allow-list while the prompt still forbids it.
 */
export const DRAW_NAMED_REJECTED_ELEMENTS = [
  "img",
  "image",
  "use",
  "foreignObject",
  "a",
  "script",
  "style",
  "iframe",
  "video",
  "audio",
  "link",
  "object",
  "embed",
  "animate",
] as const;

/**
 * Each issue message is cut to this many characters, ellipsis included. A
 * type error can spell out a whole props type (hundreds of characters), and
 * three repairs of a scene with several of them would spend the budget on
 * the compiler's prose instead of on the fix.
 */
const ISSUE_MESSAGE_MAX = 400;

/**
 * A provider's error text is cut to this many characters. The useful part
 * ("output truncated at max_tokens", "timeout waiting for response") comes
 * first; what follows is often a whole raw reply.
 */
const PROVIDER_ERROR_MAX = 300;

/** `text` in at most `max` characters, the last of them an ellipsis when it was cut. */
function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const join = (names: readonly string[]) => names.join(", ");

function systemPrompt(req: DrawRequest): string {
  const svgElements = DRAW_ALLOWED_ELEMENTS.filter((e) => e !== "div" && e !== "span");
  const examples = DRAW_EXAMPLES.map(
    (ex, i) => `Example ${i + 1}. ${ex.description}\n--- begin example ${i + 1} ---\n${ex.code.trimEnd()}\n--- end example ${i + 1} ---`,
  ).join("\n\n");

  return `You draw one shot of a video as code. The author describes the shot in a sentence; you write a single React component in TypeScript (a TSX file) that Remotion renders frame by frame into a transparent clip, which is laid over the speaker's video.

Why the rules below exist
Your file is checked by a machine before any person sees it: first a static check of its imports, elements, names and strings, then a type check against the drawing kit, then three still frames are rendered. If a check fails, the code comes back to you with each problem and its line, to fix. Remotion renders frames out of order, several at a time, so every frame has to be computable on its own from the time alone. And the scene may be rendered again at another length, so its timing is relative to its duration.

Your reply
A JSON object with two fields:
- code: the whole TSX file as one string. Always the complete file, never a fragment or a diff.
- said: one line, under 300 characters, saying what you drew and how it moves.

The file
It has a default export with this signature, where durationSec is the scene's length in seconds:
export default function Scene({ durationSec }: { durationSec: number })
It may import only from these modules, each name by name ({ a, b }), never a default or namespace import of remotion or the kit:
- react
- remotion: ${join(DRAW_ALLOWED_REMOTION)}
- ${DRAW_KIT_MODULE}: the names in the kit reference below
No other module, no dynamic import(). Images, network access and timers are not available, on purpose.

How every frame is drawn
- The background is transparent. Do not fill the frame or put a full-frame rectangle or colour behind the scene; it is drawn over the video or over a backdrop the author chose.
- The frame is a pure function of time. Compute everything from t = useSceneTime() (seconds since the scene started). No Math.random: when you want scatter, derive it from an index with a fixed formula. No clocks (Date, performance.now). No timers. No state or effects that change what is drawn (useState, useEffect or useRef carrying values from one frame to the next): the frames are not rendered in order.
- Place every beat as a fraction of durationSec (for example 0.3 * durationSec) or with beatStarts from the kit. Let the last beat finish before the end and the last state hold to the end, so the scene works at another length. Idle motion such as a bob or a swinging tail may keep going.
- Text uses the theme's fonts only: fontFamily: theme.fontDisplay, or theme.fontMono for code, with theme = useTheme().
- Interface elements (cards, labels, bubbles, arrows, text) use the theme's palette: theme.accent, theme.fg, theme.cardBg and the other colours in the kit reference. Illustrations (characters, props, objects) may use their own colours.
- All content stays inside the safe area: useSafeArea() returns { x, y, width, height } in pixels. Position and size things from it rather than from fixed numbers.
- The file has at most ${DRAW_MAX_LINES} lines. It contains no run of three backticks anywhere, not even in a comment or a string: a command-line provider strips such runs from replies, which would break the file.

What you may draw with
- Elements: HTML div and span; the SVG elements ${join(svgElements)}; the parts the kit exports; AbsoluteFill and Sequence from remotion; components you declare in this file as functions.
- Every other element is rejected, including ${join(DRAW_NAMED_REJECTED_ELEMENTS)}.
- These names are rejected anywhere in the code, as a variable, function, parameter or property name, and as a property read (x.name or x["name"]): ${join(DRAW_FORBIDDEN_NAMES)}. The one place such a word is allowed is a key you write in an object literal, so style={{ top: 10 }} is fine. In practice: do not name a variable top, open, self, parent, frames or location, do not read .top from anything (the safe area is { x, y, width, height } for this reason), and do not destructure { top }.
- No string or template text may contain http:, https:, //, data: or a url( that is not a local reference. So: no xmlns attribute on svg (React does not need one); gradients, clips, masks and filters are used through url(#id) of an element defined in this file, for example fill="url(#body)"; no images, fonts or backgrounds from anywhere else. One of the author's images is drawn only with <Asset name="…" /> from the kit, and only for a name in the shot's asset list.

Draw the picture
The author wants a picture that moves. When the idea describes a thing (a character, an object, a place, an action), draw it: build it from SVG paths and shapes (a body, limbs, a face, props), give it colour and some layered detail, and animate it, moving, turning, scaling or bending its parts with time (interpolate from remotion helps). Do not fall back to a card with text when the idea describes a picture. Text is for a label, a number or a line someone says, and stays short. The kit's parts are for interface elements such as cards, pills and badges, not a stand-in for drawing.

The drawing kit
The declarations of ${DRAW_KIT_MODULE}, with one comment per export:
--- begin kit reference ---
${req.kitReference.trimEnd()}
--- end kit reference ---

Two worked examples
Both are complete files that pass every check. They show the shape of a scene, not the look of this one.

${examples}`;
}

const formatDuration = (sec: number) => `${sec} seconds`;

/** The shot, restated in every user prompt because no call sees an earlier one. */
function shotSection(req: DrawRequest): string {
  const orientation = req.width > req.height ? "landscape" : req.width < req.height ? "portrait" : "square";
  const spoken = req.spokenLine.trim() === "" ? "(none given)" : `"${req.spokenLine}"`;
  const assets =
    req.assets.length === 0
      ? "There are no assets for this shot: draw everything yourself."
      : `The author's images, usable with <Asset name="…" /> by these names only:\n${req.assets
          .map((a) => `- ${a.name}: ${a.width} x ${a.height} px${a.note ? `, ${a.note}` : ""}`)
          .join("\n")}\nDraw anything else the idea needs yourself.`;
  return `The shot
Idea: ${req.idea}
Spoken while it is on screen: ${spoken}
Duration: ${formatDuration(req.durationSec)} (durationSec). Place the beats as fractions of it: the scene may be rendered again at another length.
Frame: ${req.width} x ${req.height} pixels, ${orientation}.

Assets
${assets}`;
}

const codeBlock = (label: string, code: string) => `--- begin ${label} ---\n${code.trimEnd()}\n--- end ${label} ---`;

/** Earlier notes oldest first, then the new one, so the order the author gave them is the order the LLM reads them. */
function notesSection(r: DrawRedraw): string {
  const earlier =
    r.notes.length === 0
      ? "Earlier notes: none."
      : `Earlier notes on this shot, oldest first, already applied to the current scene:\n${r.notes.map((n, i) => `${i + 1}. ${n.text}`).join("\n")}`;
  return `${earlier}\n\nThe new note:\n${r.note.text}`;
}

/** The first draft of a shot. */
export function drawPrompt(req: DrawRequest): { system: string; user: string } {
  return { system: systemPrompt(req), user: `${shotSection(req)}\n\nWrite the scene.` };
}

/** A new version of an existing scene from the author's note (design §6). */
export function redrawPrompt(req: DrawRequest, a: DrawRedraw): { system: string; user: string } {
  return {
    system: systemPrompt(req),
    user: `${shotSection(req)}

The author has seen this scene and wants a change.

The current scene:
${codeBlock("current scene", a.code)}

${notesSection(a)}

Write the whole file again with the new note applied. Keep everything the note does not ask to change, and keep the earlier notes applied.`,
  };
}

/**
 * A repair after a failed attempt (design §5): the code and its issues, or,
 * when the call itself failed (cut off at the token limit, timed out, not
 * valid JSON), what happened and a request for a shorter scene — there is no
 * code to quote, and a smaller file is what fits the limit (Review Focus 3).
 *
 * `redraw` keeps the author's note in view: a repair of a redraw that loses
 * the note would fix the code by undoing what the author asked for, and
 * after a failed call it is the only place the note and the current scene
 * survive.
 */
export function repairPrompt(
  req: DrawRequest,
  a: { code: string | null; issues: DrawIssue[]; error?: string; redraw?: DrawRedraw },
): { system: string; user: string } {
  const redrawContext = a.redraw
    ? `\n\nThis is a redraw of an existing scene from the author's note.\n\n${notesSection(a.redraw)}`
    : "";

  if (a.code === null) {
    const error = capText(a.error ?? "no reply", PROVIDER_ERROR_MAX);
    const current = a.redraw ? `\n\nThe scene the note applies to:\n${codeBlock("current scene", a.redraw.code)}` : "";
    return {
      system: systemPrompt(req),
      user: `${shotSection(req)}${redrawContext}${current}

Your last reply did not arrive as a usable scene. The provider reported: ${error}
This usually means the reply was cut off at the output limit, took too long, or was not valid JSON. Write the scene again, shorter and simpler: fewer elements, shorter paths, no repeated blocks, well under ${DRAW_MAX_LINES} lines. Return the whole file.`,
    };
  }

  const problems = a.issues.map((i) => `- line ${i.line} (${i.rule}): ${capText(i.message, ISSUE_MESSAGE_MAX)}`).join("\n");
  return {
    system: systemPrompt(req),
    user: `${shotSection(req)}${redrawContext}

Your scene did not pass the checks.

Your scene:
${codeBlock("scene", a.code)}

Problems, with the line each was found on:
${problems}

Fix every problem and return the whole file again. Keep everything that was not part of a problem as it was.`,
  };
}
