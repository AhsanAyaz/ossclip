/**
 * Reading the author's video script (explainer design §1.1): the markdown the
 * playbook's script skill writes before recording, where `🎬` lines say what
 * is on screen and `🗣️` lines say what is spoken.
 *
 * PURE: text in, cues out. Reading the file, resolving `clip:` paths against
 * the script's folder and validating `[Component]` names against the registry
 * all happen elsewhere (Task 4, Task 8), so the format's rules are testable on
 * a string and a typo'd hint is reported by the code that knows the valid set.
 */
import { createHash } from "node:crypto";

export type ScriptCueHint =
  | { kind: "none" }
  /** Validated against the registry by the planner, not here. */
  | { kind: "component"; component: string }
  /** As written in the script, relative to the script file's folder. */
  | { kind: "clip"; path: string }
  | { kind: "screen" };

export interface ScriptCue {
  /** `cue-${index}-${first 8 hex of sha1(cueText)}` — see `cueId`. */
  id: string;
  /** 0-based order of `🎬` lines in the file. */
  index: number;
  /** The `🎬` text, inline markup removed, hint prefix removed. */
  cueText: string;
  hint: ScriptCueHint;
  /** The `🗣️` lines this cue covers, inline markup removed, in order. */
  spoken: string[];
  /** 1-based source line of the `🎬`, so a report can point at the script. */
  line: number;
}

// The variation selector (U+FE0F) is optional on purpose: `🗣️` is two code
// points and `🎬` is often typed with one, and keyboards, editors and
// copy-paste add or drop the selector freely. A script whose speaker emoji
// lost its selector must not silently become a script with no spoken lines.
const CUE_LINE = /^\u{1F3AC}️?\s*(.*)$/u;
const SPOKEN_LINE = /^\u{1F5E3}️?\s*(.*)$/u;
// `#hashtag` prose is not a heading; markdown requires the space (or nothing).
const HEADING_LINE = /^#{1,6}(?:\s|$)/;

const CLIP_HINT = /^clip:\s*(.*)$/i;
const SCREEN_HINT = /^screen:\s*(.*)$/i;
// `[Name]` but not `[text](url)`: a cue that opens with a markdown link is
// prose about a page, not a forced component. Anything else in brackets IS a
// hint, typos included, so that `[Bug Card]` reaches the planner's
// unknown-name error instead of silently becoming plain cue text.
const COMPONENT_HINT = /^\[([^\]\n]+)\](?!\()\s*(.*)$/;

/**
 * Remove `**bold**`, `` `code` `` and `*emphasis*`, keeping their text.
 *
 * The real script carries all three (`🗣️ **One.** When you cut…`, ``🗣️ I typed
 * `/egm:egm-brainstorm`.``), and alignment compares against what whisper
 * heard, which has no markup. One alternation pass rather than three replaces:
 * a code span is matched before an asterisk inside it can be, so `` `a*b*c` ``
 * keeps its asterisks. Emphasis needs non-space just inside both asterisks,
 * so arithmetic like `2 * 3` is left alone. Underscore forms are deliberately
 * not stripped: scripts name files and flags (`caption_themes`), and eating
 * their underscores would change the words.
 */
export function stripInlineMarkup(text: string): string {
  return text
    .replace(
      /`([^`]*)`|\*\*(.+?)\*\*|\*(?=\S)([^*]*?\S)\*/g,
      (_m, code: string | undefined, bold: string | undefined, em: string | undefined) =>
        code ?? bold ?? em ?? "",
    )
    .trim();
}

/**
 * Position plus a hash of the cue's own text (§1.3): editing a spoken line or
 * another cue's text leaves this id alone, while two cues with the same text
 * (a repeated "Terminal" cue) still get distinct ids. Adding
 * or removing a cue before this one does shift it — position is half the id.
 */
function cueId(index: number, cueText: string): string {
  const hash = createHash("sha1").update(cueText).digest("hex").slice(0, 8);
  return `cue-${index}-${hash}`;
}

/** Split a `🎬` line's text into its hint and the cue text that remains. */
function readHint(raw: string): { hint: ScriptCueHint; rest: string } {
  const clip = CLIP_HINT.exec(raw);
  if (clip) return { hint: { kind: "clip", path: clip[1]!.trim() }, rest: clip[1]! };
  const screen = SCREEN_HINT.exec(raw);
  if (screen) return { hint: { kind: "screen" }, rest: screen[1]! };
  const component = COMPONENT_HINT.exec(raw);
  if (component) {
    return { hint: { kind: "component", component: component[1]!.trim() }, rest: component[2]! };
  }
  return { hint: { kind: "none" }, rest: raw };
}

/**
 * Every `🎬` cue in the script, in file order, with the `🗣️` lines it covers.
 *
 * Attachment rule (§1.1): a spoken line belongs to the most recent cue IN THE
 * SAME HEADING SECTION. A heading ends the section, so a `🗣️` line that opens a
 * section before any `🎬` stays talking head rather than being glued onto the
 * previous section's last graphic. Blank lines, `✂️` editing notes and prose
 * do not end a cue: the playbook puts a blank line between every spoken line
 * (the EGM hook's first cue covers two of them).
 *
 * Hints are read from the raw line, before markup is stripped, so a `clip:`
 * path is kept exactly as written for the file check that names it.
 */
export function parseScript(markdown: string): ScriptCue[] {
  const cues: ScriptCue[] = [];
  let current: ScriptCue | null = null;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (HEADING_LINE.test(line)) {
      current = null;
      continue;
    }
    const cue = CUE_LINE.exec(line);
    if (cue) {
      const { hint, rest } = readHint(cue[1]!.trim());
      const cueText = stripInlineMarkup(rest);
      const index = cues.length;
      current = { id: cueId(index, cueText), index, cueText, hint, spoken: [], line: i + 1 };
      cues.push(current);
      continue;
    }
    const spoken = SPOKEN_LINE.exec(line);
    if (spoken && current) {
      const text = stripInlineMarkup(spoken[1]!);
      // An empty `🗣️` is a placeholder in a draft, not a line to align.
      if (text) current.spoken.push(text);
    }
  }
  return cues;
}
