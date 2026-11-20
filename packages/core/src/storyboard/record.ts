/**
 * The storyboard's plan table on disk (storyboard design §2, §9; §168):
 * `storyboard.json` in the workdir holds exactly this, zod-parsed on every
 * load. One row per shot: the words it sits on, the idea, why it earns a
 * picture, its priority, the assets it uses, and whether the author kept,
 * changed or added it.
 *
 * Pure, and browser-safe on purpose: the editor's table reads and edits
 * this record, so the module imports nothing but zod and the draw record's
 * two name schemas (shot-record.ts imports zod only). A Node import here
 * would carry into the editor bundle through ./browser.
 */
import { z } from "zod/v4";
import { AssetNameSchema, ShotIdSchema } from "../draw/shot-record";

/**
 * Most of the kept runtime the shots may cover (design Decision 2). The rest
 * is the speaker's face: a talking-head video whose speaker is hidden more
 * than this stops being one.
 */
export const STORYBOARD_COVERAGE = 0.6;

/**
 * The shortest shot, in seconds: the lower bound `ossclip draw` accepts for
 * a duration (§167). A shorter plan row could never be drawn, so the limits
 * drop it before the author pays to review it.
 */
export const STORYBOARD_MIN_SHOT_SEC = 2;

/**
 * One shot. Word indices are raw transcript indices (design §2,
 * "Anchoring"), so a cut edit never moves a shot to other words; a shot whose
 * words the author later cuts is shown as cut away, not re-anchored.
 *
 * `touched` is set by any edit of the author's (drop, reword, move): with
 * `origin: "author"` and a drawn version it is what makes a shot survive
 * "Plan again" (design §2, G10). `kept: false` is a dropped row, kept in the
 * file so the author can restore it and so its id is never handed out again.
 */
export const StoryboardShotSchema = z
  .object({
    id: ShotIdSchema,
    startWord: z.number().int().nonnegative(),
    endWord: z.number().int().nonnegative(),
    idea: z.string().min(1).max(400),
    why: z.string().max(200),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    assets: z.array(AssetNameSchema),
    kept: z.boolean(),
    origin: z.enum(["planner", "author"]),
    touched: z.boolean(),
  })
  .refine((s) => s.endWord >= s.startWord, { message: "endWord is before startWord", path: ["endWord"] });
export type StoryboardShot = z.infer<typeof StoryboardShotSchema>;

/**
 * `nextShot` never decreases, so an id is never reused after its shot is
 * removed (plan Global Constraints): a later shot named `s3` must not inherit
 * the drawn versions under `storyboard/s3/` of the shot that had it before.
 * `assetsDir` is the `--assets` folder, absolute, as the draw record stores it.
 */
export const StoryboardSchema = z.object({
  version: z.literal(1),
  intent: z.string().optional(),
  assetsDir: z.string().optional(),
  nextShot: z.number().int().positive(),
  shots: z.array(StoryboardShotSchema),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

/**
 * A fresh id, `s<nextShot>`, and the storyboard with `nextShot` past it.
 *
 * An id already in `shots` is skipped rather than handed out: a hand-edited
 * file whose `nextShot` fell behind its rows would otherwise give two shots
 * one id, and one shot's drawings to the other.
 */
export function newShotId(sb: Storyboard): { id: string; sb: Storyboard } {
  const taken = new Set(sb.shots.map((s) => s.id));
  let n = sb.nextShot;
  while (taken.has(`s${n}`)) n++;
  return { id: `s${n}`, sb: { ...sb, nextShot: n + 1 } };
}

/**
 * One shot as the planner proposes it, before it has an id or a row. Indices
 * may be anything the reply held: `enforcePlanLimits` is what makes them safe.
 */
export interface PlannedShot {
  startWord: number;
  endWord: number;
  idea: string;
  why: string;
  priority: 1 | 2 | 3;
  assets: string[];
}
