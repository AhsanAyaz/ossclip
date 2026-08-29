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
  opts: {
    flag: boolean | undefined;
    port: number;
    /**
     * Whether the user TYPED `--editor-port`. Commander's 5174 default is not
     * a choice anybody made, so the common case must be free to attach or step
     * around a busy port; only a typed port is defended (edit-port.ts's
     * `pinned`, and the `--port` half of the same rule in program.ts).
     */
    portPinned: boolean;
  },
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
  // The same busy-port ladder `ossclip edit` runs (edit-port.ts): a produce
  // finishing into an already-open editor on THIS project attaches to it
  // instead of dying on EADDRINUSE — which here would throw away the run's
  // whole summary behind a stack trace. `liveEditPortDeps` reads the real
  // `isInteractive()`, so the three-way prompt is available exactly where this
  // offer already asks questions, and absent in a piped run.
  const { openEditServer, liveEditPortDeps } = await import("../edit-port");
  const opened = await openEditServer(
    result.workdir,
    { port: opts.port, pinned: opts.portPinned },
    liveEditPortDeps((port) => startEditServer(result.workdir, { port, pageDir })),
  );
  if (opened.kind === "cancelled") return;
  const url = opened.kind === "attached" ? opened.url : opened.server.url;
  // The attach path already printed "▸ already open at …"; a second line
  // underneath it would read as a second server.
  if (opened.kind === "started") console.log(`▸ editor at ${url}`);
  const { openInBrowser } = await import("../open");
  openInBrowser(url);
}
