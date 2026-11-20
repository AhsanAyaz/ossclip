/**
 * One author edit of the plan table (storyboard design §10 "Table view";
 * plan Task 4; §168): drop, restore, reword, move, or add a shot. The
 * editor's `POST /api/storyboard/edit` parses the body with
 * `StoryboardEditSchema` and saves what `applyStoryboardEdit` returns.
 *
 * Pure, so the rules are tested without a server or a workdir.
 *
 * B2a (§169) adds the approval: `approve`, which only the server's approve
 * job applies, and `unapprove` ("Remove from video"), which a request may.
 *
 * Every edit of an existing shot sets `touched`, because `touched` is what
 * makes a row survive "Plan again" (design §2, `isProtectedShot`): a shot the
 * author dropped, reworded or moved is the author's, and a re-plan that
 * replaced it would undo the review. A drop included: a dropped planner row
 * that came back as a fresh planned shot on the same words would bring back
 * what the author refused.
 */
import { z } from "zod/v4";
import { newShotId, type ShotApproval, type Storyboard, type StoryboardShot } from "@ossclip/core";

/**
 * `StoryboardShotSchema`'s bound on `idea` (core storyboard/record.ts),
 * restated for the message; `saveStoryboard` parses the record, so the two
 * cannot drift without a failing save.
 */
const STORYBOARD_IDEA_MAX = 400;

export type StoryboardEdit =
  | { op: "drop"; id: string }
  | { op: "restore"; id: string }
  | { op: "idea"; id: string; idea: string }
  | { op: "span"; id: string; startWord: number; endWord: number }
  | { op: "add"; startWord: number; endWord: number; idea: string }
  /**
   * Server-internal (§169): the approve job writes the approval its render
   * made. Never accepted from a request body (`StoryboardEditSchema` has no
   * such op), because an approval names files and a clip key the server
   * alone has checked; one typed into a request would put any `src` into
   * the video without a render.
   */
  | { op: "approve"; id: string; approval: ShotApproval }
  | { op: "unapprove"; id: string };

/** The edits a request may ask for: every one but `approve`. */
export type StoryboardRequestEdit = Exclude<StoryboardEdit, { op: "approve" }>;

/**
 * The request body. Indices are whole numbers of any sign and the idea any
 * string: the range and the length are `applyStoryboardEdit`'s to check,
 * because its message can say what the transcript holds and how long the
 * idea was, where a zod issue could only say "too small". An unknown `op`
 * fails here, never falls through to some other edit.
 */
export const StoryboardEditSchema: z.ZodType<StoryboardRequestEdit> = z.discriminatedUnion("op", [
  z.object({ op: z.literal("drop"), id: z.string().min(1) }),
  z.object({ op: z.literal("restore"), id: z.string().min(1) }),
  z.object({ op: z.literal("idea"), id: z.string().min(1), idea: z.string() }),
  z.object({ op: z.literal("span"), id: z.string().min(1), startWord: z.number().int(), endWord: z.number().int() }),
  z.object({ op: z.literal("add"), startWord: z.number().int(), endWord: z.number().int(), idea: z.string() }),
  z.object({ op: z.literal("unapprove"), id: z.string().min(1) }),
]);

/**
 * An edit the table cannot take. Its own class so the endpoint can answer
 * 400 with the message for this and nothing else: every message is written
 * for the author to act on, and the editor shows it as it is.
 */
export class StoryboardEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryboardEditError";
  }
}

/**
 * The idea as stored: trimmed, 1 to `STORYBOARD_IDEA_MAX` characters (the
 * record's own bounds, so a saved edit can always be loaded again).
 */
function cleanIdea(idea: string): string {
  const t = idea.trim();
  if (t.length === 0) throw new StoryboardEditError("the idea is empty: say what is on screen and how it moves");
  if (t.length > STORYBOARD_IDEA_MAX) {
    throw new StoryboardEditError(`the idea is ${t.length} characters; a shot's idea holds at most ${STORYBOARD_IDEA_MAX}`);
  }
  return t;
}

function checkRange(startWord: number, endWord: number, wordCount: number): void {
  if (startWord < 0 || endWord >= wordCount || startWord > endWord) {
    throw new StoryboardEditError(
      `words ${startWord} to ${endWord} are not a span of the transcript, which has ${wordCount} words ` +
        `(a span runs from a first word to a last word at or after it, numbered from 0)`,
    );
  }
}

/** The first words of an idea, enough for the author to recognise the row. */
function ideaStart(idea: string): string {
  const words = idea.split(/\s+/).filter((w) => w.length > 0);
  return words.length <= 5 ? words.join(" ") : `${words.slice(0, 5).join(" ")}…`;
}

/**
 * Refuses a span that shares a word with another KEPT shot. Two kept shots
 * on one word would be two drawings over one moment, which the video cannot
 * show; a dropped shot is not on screen, so its words are free.
 */
function checkOverlap(sb: Storyboard, startWord: number, endWord: number, selfId: string | null): void {
  const hit = sb.shots.find(
    (s) => s.kept && s.id !== selfId && s.startWord <= endWord && startWord <= s.endWord,
  );
  if (hit !== undefined) {
    throw new StoryboardEditError(
      `words ${startWord} to ${endWord} overlap shot ${hit.id} ("${ideaStart(hit.idea)}") on words ` +
        `${hit.startWord} to ${hit.endWord}: move or drop that shot first`,
    );
  }
}

/** Start order, stable, so the file reads in the order of the video as the planner writes it. */
const sorted = (shots: StoryboardShot[]): StoryboardShot[] => [...shots].sort((a, b) => a.startWord - b.startWord);

export function applyStoryboardEdit(sb: Storyboard, edit: StoryboardEdit, wordCount: number): Storyboard {
  if (edit.op === "add") {
    const idea = cleanIdea(edit.idea);
    checkRange(edit.startWord, edit.endWord, wordCount);
    checkOverlap(sb, edit.startWord, edit.endWord, null);
    const next = newShotId(sb);
    // Priority 1: a shot the author asked for by hand is the one they want
    // most, and the coverage limit drops the highest number first.
    const added: StoryboardShot = {
      id: next.id,
      startWord: edit.startWord,
      endWord: edit.endWord,
      idea,
      why: "",
      priority: 1,
      assets: [],
      kept: true,
      origin: "author",
      touched: true,
    };
    return { ...next.sb, shots: sorted([...next.sb.shots, added]) };
  }

  const target = sb.shots.find((s) => s.id === edit.id);
  if (target === undefined) throw new StoryboardEditError(`there is no shot ${edit.id} in the storyboard`);
  let changed: StoryboardShot;
  switch (edit.op) {
    case "drop":
      changed = { ...target, kept: false, touched: true };
      break;
    case "restore":
      // Checked again: the author may have moved another shot onto these
      // words while this one was dropped.
      checkOverlap(sb, target.startWord, target.endWord, target.id);
      changed = { ...target, kept: true, touched: true };
      break;
    case "idea":
      changed = { ...target, idea: cleanIdea(edit.idea), touched: true };
      break;
    case "span":
      checkRange(edit.startWord, edit.endWord, wordCount);
      checkOverlap(sb, edit.startWord, edit.endWord, target.id);
      changed = { ...target, startWord: edit.startWord, endWord: edit.endWord, touched: true };
      break;
    // Approval does not set `touched`: an approved shot is drawn, and its
    // versions already protect it from "Plan again" (`isProtectedShot`).
    case "approve":
      // The job checks this before it renders; checked again here because
      // the author can drop the shot while its clip renders, and a dropped
      // shot's approval would come back into the video on a restore.
      if (!target.kept) throw new StoryboardEditError(`shot ${target.id} was dropped while it was approved; restore it and approve again`);
      changed = { ...target, approval: edit.approval };
      break;
    case "unapprove": {
      if (target.approval === undefined) throw new StoryboardEditError(`shot ${target.id} is not in the video: it has no approval to remove`);
      const { approval: _removed, ...rest } = target;
      changed = rest;
      break;
    }
  }
  return { ...sb, shots: sorted(sb.shots.map((s) => (s.id === target.id ? changed : s))) };
}
