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
