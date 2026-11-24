/**
 * "Plan again" (storyboard design §2 "Planning again", G10; §168): a fresh
 * plan replaces only the rows nobody steered. A row the author changed,
 * added or had drawn keeps its id, and with it the drawings under
 * `storyboard/<id>/` and the author's notes; a dropped row the author
 * dropped stays dropped, so the planner cannot bring back what was refused.
 *
 * Pure, and it runs no limits: the caller runs `enforcePlanLimits` on the
 * fresh shots with the protected kept rows as `blocked` before merging, so
 * by the time they arrive here they already fit around what survives.
 */
import { newShotId, type PlannedShot, type Storyboard, type StoryboardShot } from "./record";

/**
 * A row "Plan again" must not replace: touched by the author, added by the
 * author, or drawn. `hasVersions` is passed in because versions live in the
 * draw record on disk (`history.json`), which this pure module cannot read.
 */
export function isProtectedShot(s: StoryboardShot, hasVersions: boolean): boolean {
  return s.touched || s.origin === "author" || hasVersions;
}

export function mergePlanAgain(
  sb: Storyboard,
  fresh: PlannedShot[],
  hasVersions: (id: string) => boolean,
): Storyboard {
  const survivors = sb.shots.filter((s) => isProtectedShot(s, hasVersions(s.id)));
  // Ids are handed out from `nextShot`, never from the removed rows, so an
  // id with drawings on disk can never name a new shot (plan Global
  // Constraints). In start order, so the ids read in the order of the video.
  let next: Storyboard = { ...sb, shots: survivors };
  const added: StoryboardShot[] = [];
  for (const p of [...fresh].sort((a, b) => a.startWord - b.startWord)) {
    const r = newShotId(next);
    next = r.sb;
    added.push({
      id: r.id,
      startWord: p.startWord,
      endWord: p.endWord,
      idea: p.idea,
      why: p.why,
      priority: p.priority,
      assets: [...p.assets],
      kept: true,
      origin: "planner",
      touched: false,
    });
  }
  // Stable: a survivor sorts before a fresh shot on the same start word.
  const shots = [...survivors, ...added].sort((a, b) => a.startWord - b.startWord);
  return { ...next, shots };
}
