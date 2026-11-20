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
    // `--script` goes too, with its value (explainer plan Task 8): it is a
    // request to PLAN from the script, the very thing a pinned render must
    // not do, and produce refuses it beside `--scenes`. The script's text is
    // not lost — the replay carries production.json's `script` record forward.
    if (arg === "--script") {
      i++;
      continue;
    }
    // `--storyboard` and its `--assets <dir>` go for the same reason (§168):
    // a storyboard run plans, and produce refuses it beside `--scenes`.
    // `--storyboard` is a bare flag, `--assets` takes its value with it. A
    // replan keeps both (the early return above).
    if (arg === "--storyboard") continue;
    if (arg === "--assets") {
      i++;
      continue;
    }
    out.push(arg);
  }
  out.push("--scenes", opts.scenesPath);
  return out;
}

/**
 * True when the recorded argv holds `--storyboard` (§169). The edit server's
 * Render asks it when there are no scenes to pin: `renderReplayArgs` strips
 * `--storyboard` only when it pins, so a storyboard project with nothing
 * approved would replay a storyboard run, which renders nothing. A token
 * test, as the strip above is: `--storyboard` is a bare flag.
 */
export function isStoryboardCommand(recorded: readonly string[]): boolean {
  return recorded.includes("--storyboard");
}

/**
 * The recorded args as the command that actually ran (§129). Before the fix,
 * wizard and bare-path runs recorded process.argv — the ORIGINAL
 * invocation, missing the `produce` literal the re-entered parse actually
 * ran — so replaying them verbatim dies at commander's front door with
 * "error: unknown option '--llm'". produce is the ONLY command that ever
 * writes command.json, so an args array not starting with "produce" can
 * only be that bug: prepend the literal. A modern record — and a legacy
 * directly-typed `ossclip produce …` — already starts with it and is
 * untouched.
 *
 * Lifted out of the edit server's /api/render (§162) because `ossclip kit`
 * replays the same record to refresh a stale project, and a kit that healed
 * differently would refresh a project the editor's Render could not.
 */
export function healRecordedProduceArgs(recorded: readonly string[]): string[] {
  return recorded[0] === "produce" ? [...recorded] : ["produce", ...recorded];
}

/**
 * The text of `scenes-reviewed.json` from production.json's TEXT: its
 * `scenes`, the plan on screen, or undefined when there is no plan to pin —
 * unreadable JSON, an old production.json without `scenes`, or an empty
 * list. Undefined means "replay the recorded command" (renderReplayArgs'
 * no-plan case), never a refusal.
 *
 * Pure, the file I/O stays with each caller: the edit server's Render and
 * `ossclip kit`'s refresh (§162) both pin the plan this way, and one parse
 * is what keeps them pinning the same one.
 */
export function reviewedScenesText(productionJson: string): string | undefined {
  try {
    const production = JSON.parse(productionJson) as { scenes?: unknown };
    if (!Array.isArray(production.scenes) || production.scenes.length === 0) return undefined;
    return `${JSON.stringify(production.scenes, null, 2)}\n`;
  } catch {
    return undefined;
  }
}

/**
 * The argv of the storyboard sync run (plan B2a Task 4; §169): the run an
 * approval, a drop, a restore or an unapprove of an approved shot starts so
 * `produce` (the only writer of production.json) puts the shot's clip scene
 * in or takes it out. Pure, from the recorded argv as `/api/render` heals it.
 *
 * Built from the recorded command but not dependent on it still being a
 * storyboard command: a Render records its own argv, so after the first
 * Render `command.json` holds `--scenes …` and no `--storyboard` (found in
 * Task 3). So:
 *  - `--scenes <value>` goes: produce refuses it beside `--storyboard`, and
 *    the pinned plan is the one without this approval.
 *  - `--render` and `--no-render` go: a storyboard run never renders
 *    (`storyboardFlag`), and the editor's Render does that afterwards.
 *  - `--open-editor` and `--review` go and `--no-open-editor` is added: the
 *    editor is already open, a second one would fight it for the port, and
 *    `--review` beside `--no-open-editor` is a refusal (`reviewFlag`).
 *  - `--storyboard` is added when absent.
 *  - `--assets <assetsDir>` replaces a recorded one when the storyboard has
 *    a folder; with none given a recorded one stays as it was.
 */
export function storyboardSyncArgs(recorded: readonly string[], assetsDir: string | undefined): string[] {
  const out: string[] = [];
  for (let i = 0; i < recorded.length; i++) {
    const arg = recorded[i]!;
    if (arg === "--scenes") {
      i++;
      continue;
    }
    if (assetsDir !== undefined && arg === "--assets") {
      i++;
      continue;
    }
    if (arg === "--render" || arg === "--no-render" || arg === "--open-editor" || arg === "--review") continue;
    out.push(arg);
  }
  if (!out.includes("--storyboard")) out.push("--storyboard");
  if (assetsDir !== undefined) out.push("--assets", assetsDir);
  if (!out.includes("--no-open-editor")) out.push("--no-open-editor");
  return out;
}
