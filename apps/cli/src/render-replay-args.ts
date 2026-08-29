/**
 * The argv the editor's Render button replays (2026-08-29).
 *
 * A render started FROM the editor must reproduce what the user just
 * reviewed. Replaying `command.json` verbatim did not: it carried
 * `--produce`, so every render re-called the LLM, and the beat-sheet cache
 * key covers the repaired words and the MEASURED framing — both of which the
 * user's own editor work changes. The plan came back renumbered, edits
 * anchored to scenes it no longer had were orphaned, and an approved cut was
 * silently rewritten (the failure `produce.ts`' §143 note already named once,
 * 2026-08-23; hit again through a different door).
 *
 * So the editor pins the plan on screen with `--scenes` (no LLM in the loop)
 * and drops `--produce`. The two paths stay distinct on purpose:
 *
 *  - CLI/CI: `--produce` plans fresh. The command line is the authority.
 *  - Editor: the reviewed plan is the authority; `replan` opts back in.
 *
 * Pure, so the whole matrix is testable without spawning a produce.
 */
/** The reviewed plan the editor pins for a render (see the module docstring).
 * Its own name, never `scenes-<key>.json`: those are keyed to a beat sheet
 * this render may no longer match. */
export const REVIEWED_SCENES_BASENAME = "scenes-reviewed.json";

export function renderReplayArgs(
  recorded: readonly string[],
  opts: { scenesPath?: string; replan?: boolean },
): string[] {
  // A deliberate re-plan replays exactly what was recorded — including
  // `--produce` when it was there, since that IS the fresh-plan request.
  if (opts.replan === true || opts.scenesPath === undefined) return [...recorded];

  const out: string[] = [];
  for (let i = 0; i < recorded.length; i++) {
    const arg = recorded[i]!;
    // `--produce` is a boolean flag: drop it alone, never a following value.
    if (arg === "--produce") continue;
    // An existing `--scenes <path>` is dropped WITH its value: two of them
    // would let commander pick one, and the stale one is precisely the plan
    // the editor is not showing.
    if (arg === "--scenes") {
      i++;
      continue;
    }
    out.push(arg);
  }
  out.push("--scenes", opts.scenesPath);
  return out;
}
