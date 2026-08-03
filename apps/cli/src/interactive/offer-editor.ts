import { loadConfig, saveConfigPatch, type OpenEditorPref } from "@ossclip/core";
import type { ProduceResult } from "../produce";
import { answerToDecision, decideOpenEditor, type OpenEditorAnswer } from "./prefs";
import { isInteractive, select, unwrap } from "./prompts";
import { renderCommand } from "./render";

/**
 * The offer at the end of a produce run. The user who prompted this work
 * asked "how can I open the editor?" BEFORE running anything — the answer
 * belongs at the moment there is finally something to open.
 */
export async function offerEditor(
  result: ProduceResult,
  opts: { flag: boolean | undefined; port: number },
): Promise<void> {
  const pref: OpenEditorPref = loadConfig().openEditorAfterProduce ?? "ask";
  const decision = decideOpenEditor({
    flag: opts.flag,
    pref,
    interactive: isInteractive(),
    rendered: result.rendered,
  });

  if (decision === "skip") return;

  let open = decision === "open";
  if (decision === "ask") {
    const answer = unwrap(
      await select({
        message: "Open the editor on this project?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
          { value: "always", label: "Yes, and stop asking" },
          { value: "never", label: "No, and stop asking" },
        ],
      }),
    ) as OpenEditorAnswer;

    // The mapping itself lives in prefs.ts, where four answers are asserted
    // without a TTY — this file is I/O and a manual walk was its only cover.
    const decided = answerToDecision(answer);
    if (decided.pref !== undefined) {
      const path = saveConfigPatch({ openEditorAfterProduce: decided.pref });
      // Say where the answer went, and how to take it back — a preference
      // saved silently is one the user cannot find again.
      console.log(`▸ saved openEditorAfterProduce="${decided.pref}" to ${path}`);
    }
    open = decided.open;
  }

  if (!open) return;

  const { startEditServer, resolveEditorPageDir } = await import("../edit");
  const pageDir = resolveEditorPageDir();
  if (pageDir === null) {
    // Not fatal here: the render succeeded. Say what is missing and stop.
    // Through renderCommand like every other `ossclip edit <path>` we print:
    // hand-built, this one quoted nothing, so a workdir with a space in it
    // printed a command that fails.
    console.log(
      "▸ editor UI isn't built — run `pnpm build` once, then " +
        renderCommand(["edit", result.workdir]),
    );
    return;
  }
  const server = await startEditServer(result.workdir, { port: opts.port, pageDir });
  console.log(`▸ editor at ${server.url}`);
  const { openInBrowser } = await import("../open");
  openInBrowser(server.url);
}
