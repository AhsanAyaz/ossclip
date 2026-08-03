import { basename } from "node:path";
import type { Candidate } from "./resolve-workdir";
import { assertInteractive, select, unwrap } from "./prompts";

/**
 * The "several runs under .ossclip" rung. Newest first is already guaranteed
 * by resolveWorkdir; this only renders the choice.
 */
export async function pickWorkdir(candidates: Candidate[]): Promise<string> {
  assertInteractive("workdir picker");
  return unwrap(
    await select({
      message: "Several produce runs here — which one?",
      options: candidates.map((c, i) => ({
        value: c.path,
        label: basename(c.path),
        hint: i === 0 ? "most recent" : undefined,
      })),
    }),
  ) as string;
}
