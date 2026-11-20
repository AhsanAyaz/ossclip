/**
 * One drawn shot's record on disk (storyboard design §9, §167): the shot's
 * idea, its versions and what became of each, the draft, the author's notes
 * and what every draw run cost. `history.json` beside the version files holds
 * exactly this, zod-parsed on every load.
 *
 * Pure: the schemas and the one rule a load applies. The files are the CLI's
 * (apps/cli/src/draw/shot-store.ts), which builds every path from an id or a
 * name only after it has passed the schema here (plan Review Focus 4): a shot
 * id or an asset name is typed by the author or read from a folder, and
 * `../x` must die as a parse error, never become a directory.
 */
import { z } from "zod/v4";

/**
 * A shot id is a directory name under `storyboard/`. Lower case, digits and
 * dashes, starting with a letter or digit: no `.`, no `/`, no `\`, so no
 * spelling of it can leave that folder, and no case-folding file system can
 * make two ids one directory.
 */
export const ShotIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

/**
 * An asset's file name, as copied into the render's public dir and named to
 * the LLM. A dot is allowed inside (`logo.dark.png`) but not first, so `..`
 * and hidden files are out; no separator of either kind. The extension is
 * the design's list (§4): images the kit's `Asset` draws through `<img>`, so
 * an SVG asset cannot run script.
 */
export const AssetNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(png|jpe?g|svg|webp)$/i);

/**
 * One version. No `result` means the run that made it never finished (Ctrl-C,
 * a crash): it is written that way BEFORE the first LLM call and given its
 * result at the end, so an interrupted draw is recognisable on the next load
 * (design §9: "work in progress is not a stored state"; Review Focus 5).
 *
 * `promptVersion` is `DRAW_PROMPT_VERSION` at the time, so the gate (§167) can
 * tell which prompt drew what. Optional only so a record is never refused for
 * lacking it; the command always writes it.
 */
export const ShotVersionSchema = z.object({
  n: z.number().int().positive(),
  result: z.union([z.literal("ok"), z.object({ failed: z.string() })]).optional(),
  kitVersion: z.number().int(),
  promptVersion: z.number().int().optional(),
  said: z.string().optional(),
  /**
   * The idea and length this version was drawn from (§169). The history
   * holds one idea, and "Draw again" (design §10) replaces it while the
   * earlier versions stay, so without these a version drawn from the old
   * idea would read as drawn from the new one. Optional so every record
   * written before them still parses; `versionIdea` and `versionDurationSec`
   * fall back to the history's, which is what such a version was drawn from.
   */
  idea: z.string().optional(),
  durationSec: z.number().positive().optional(),
});
export type ShotVersion = z.infer<typeof ShotVersionSchema>;

export const ShotHistorySchema = z.object({
  id: ShotIdSchema,
  idea: z.string(),
  spokenLine: z.string(),
  durationSec: z.number().positive(),
  /**
   * The `--assets` folder, absolute, when the shot has one. Stored rather
   * than the staged copies: every run stages the files again into a fresh
   * render directory (the bundle's public dir must be made for the render,
   * renderer drawn/render.ts), so a redraw sees the folder as it is now.
   */
  assetsDir: z.string().optional(),
  versions: z.array(ShotVersionSchema),
  draft: z.number().int().positive().nullable(),
  /** Never decreases and is never handed out twice, so a discarded version's number is not reused (design §9, Review Focus 5). */
  nextVersion: z.number().int().positive(),
  notes: z.array(z.object({ onVersion: z.number().int(), text: z.string() })),
  runs: z.array(
    z.object({
      version: z.number().int(),
      provider: z.string(),
      model: z.string().optional(),
      calls: z.number().int(),
      seconds: z.number(),
    }),
  ),
});
export type ShotHistory = z.infer<typeof ShotHistorySchema>;

/**
 * The record as the next load sees it: every version without a result is
 * dropped (an interrupted draw, design §9), and `nextVersion` stays where it
 * was so the dropped number is never handed out again.
 *
 * The draft stays when it still names an `ok` version: the author's choice
 * of draft is theirs, and design §6 lets them make an earlier version the
 * draft again. Otherwise it falls to the latest remaining `ok` version, or
 * null when there is none, so a draft can never point at a version that is
 * gone or failed.
 */
export function discardUnfinished(h: ShotHistory): ShotHistory {
  const versions = h.versions.filter((v) => v.result !== undefined);
  const ok = versions.filter((v) => v.result === "ok").map((v) => v.n);
  const draft = h.draft !== null && ok.includes(h.draft) ? h.draft : ok.length > 0 ? Math.max(...ok) : null;
  return { ...h, versions, draft };
}

/**
 * The idea version `n` was drawn from: its own, else the history's (§169).
 * A version with no idea of its own predates the field, and until a "Draw
 * again" the history's idea is the one every version was drawn from; a
 * "Draw again" stamps them first (`stampVersionIdeas`), so the fallback is
 * never the replacing idea. A number with no version also falls back.
 */
export function versionIdea(h: Pick<ShotHistory, "idea" | "versions">, n: number): string {
  return h.versions.find((v) => v.n === n)?.idea ?? h.idea;
}

/** The length version `n` was drawn at, by `versionIdea`'s rule. */
export function versionDurationSec(h: Pick<ShotHistory, "durationSec" | "versions">, n: number): number {
  return h.versions.find((v) => v.n === n)?.durationSec ?? h.durationSec;
}

/**
 * Every version given the idea and length it was drawn from, before a "Draw
 * again" replaces the history's (§169). Without this a version written
 * before the fields existed would fall back to the NEW idea, and read as
 * drawn from it.
 */
export function stampVersionIdeas(h: ShotHistory): ShotHistory {
  return {
    ...h,
    versions: h.versions.map((v) => ({ ...v, idea: v.idea ?? h.idea, durationSec: v.durationSec ?? h.durationSec })),
  };
}

/**
 * The notes a redraw of the draft sends as already applied (design §6;
 * §169): those made on a version drawn from the same idea as the draft.
 * After a "Draw again" the earlier notes are about another drawing, and sent
 * to the LLM they would steer the new one toward what the author moved
 * away from. Empty when there is no draft.
 */
export function notesForRedraw(h: Pick<ShotHistory, "idea" | "versions" | "notes" | "draft">): ShotHistory["notes"] {
  if (h.draft === null) return [];
  const idea = versionIdea(h, h.draft);
  return h.notes.filter((note) => versionIdea(h, note.onVersion) === idea);
}
