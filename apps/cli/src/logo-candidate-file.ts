/**
 * Which file on disk answers for a logo candidate (logo-finder Task 6
 * ruling, "bind each candidate to its suggestion"). Pure: the editor's
 * candidate routes read production.json and hand its `overlays` here, then
 * do the fs themselves — the `openCommand()`/`openInBrowser()` split, so the
 * refusal matrix is testable without a server.
 *
 * The client names a candidate by `(suggestion id, n)` and NEVER by path.
 * `LogoCandidateSchema` already pins `file` to `logo-candidates/<slug>/<n>.<ext>`,
 * but nothing ties that `<slug>` to the suggestion carrying it: a hand-edited
 * production.json could point suggestion `a`'s candidate at suggestion `b`'s
 * directory. That is refused here, and the result is re-checked to sit
 * inside `<workdir>/logo-candidates/` so a schema change cannot loosen it.
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import { ProductionOverlaysSchema } from "@ossclip/core";
import { LOGO_CANDIDATES_DIR } from "./logo-finder";

/** The one error both candidate routes answer with (Task 6 ruling, verbatim). */
export const NO_SUCH_LOGO_CANDIDATE = "no such logo candidate";

/**
 * The absolute path of suggestion `suggestionId`'s candidate `n`, or `null`
 * when there is no such candidate. `overlays` is production.json's raw
 * `overlays` value: missing, corrupt or suggestion-less all mean "none".
 */
export function logoCandidatePath(
  overlays: unknown,
  workdir: string,
  suggestionId: string,
  n: number,
): string | null {
  const parsed = ProductionOverlaysSchema.safeParse(overlays);
  if (!parsed.success) return null;
  const suggestion = parsed.data.suggestions?.find((s) => s.id === suggestionId);
  const candidate = suggestion?.candidates[n];
  if (suggestion === undefined || candidate === undefined) return null;
  if (!candidate.file.startsWith(`${LOGO_CANDIDATES_DIR}/${suggestion.id}/`)) return null;
  const root = resolve(workdir, LOGO_CANDIDATES_DIR);
  const abs = resolve(workdir, ...candidate.file.split("/"));
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return join(root, rel);
}
