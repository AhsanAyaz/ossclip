import { loadConfig, saveConfigPatch, type OpenEditorPref } from "@ossclip/core";
import type { ProduceResult } from "../produce";
import { decideOpenEditor } from "./prefs";
import { isInteractive, select, unwrap } from "./prompts";

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
    ) as "yes" | "no" | "always" | "never";

    if (answer === "always" || answer === "never") {
      const next: OpenEditorPref = answer === "always" ? "always" : "never";
      const path = saveConfigPatch({ openEditorAfterProduce: next });
      // Say where the answer went, and how to take it back — a preference
      // saved silently is one the user cannot find again.
      console.log(`▸ saved openEditorAfterProduce="${next}" to ${path}`);
    }
    open = answer === "yes" || answer === "always";
  }

  if (!open) return;

  const { startEditServer, resolveEditorPageDir } = await import("../edit");
  const pageDir = resolveEditorPageDir();
  if (pageDir === null) {
    // Not fatal here: the render succeeded. Say what is missing and stop.
    console.log(
      "▸ editor UI isn't built — run `pnpm build` once, then `ossclip edit` " +
        `${result.workdir}`,
    );
    return;
  }
  const server = await startEditServer(result.workdir, { port: opts.port, pageDir });
  console.log(`▸ editor at ${server.url}`);
  const { openInBrowser } = await import("../open");
  openInBrowser(server.url);
}
