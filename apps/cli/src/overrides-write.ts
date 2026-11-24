import { readFile, rename, writeFile } from "node:fs/promises";
import type { OverrideDoc } from "@ossclip/core";

/**
 * The one sanctioned `overrides.json` write (PLAN 2026-08-04 Task 4), and the
 * rule about when it may spend the `.bak`.
 *
 * Lifted out of `produce.ts` so the backup rule is testable at all: nothing in
 * the repo invokes `produce()` (it needs ffmpeg, a transcript, a workdir and a
 * render), and "the previous copy is still on disk, byte for byte" is a claim
 * about a FILE — there is no pure form of it. `produce.ts` keeps the decision
 * of WHETHER to write, the ordering relative to `render-props.json`, and the
 * `console.log`.
 */

/**
 * Replace `overrides.json`, optionally refreshing `overrides.json.bak` first.
 *
 * REFRESHING THE BACKUP IS NOT PART OF WRITING (final review round 2, Critical
 * 2 residual). The `.bak` is single-generation, so every refresh SPENDS
 * whatever it held, and the two writers have very different claims on it:
 *
 *  - A CUT re-anchoring rewrites absolute output-second VALUES all over the
 *    doc — split times, pins, framing — from a frame the pipeline just
 *    recomputed. That is unreadable in a diff and irreversible by hand, so the
 *    copy it replaces is worth keeping and this is the write the `.bak` exists
 *    for.
 *  - A CAPTION-KEY migration differs from the copy on disk in caption KEYS
 *    only, every one of which the run just printed by name, and (since
 *    `captionEditsToKeep`) it deletes nothing. There is nothing in the old
 *    copy worth recovering — while the `.bak` it would overwrite may be the
 *    user's last PRE-CUT save, which on the §137 field workdir is the only
 *    artefact holding `splits: [0.6]` and so the only route back to the split
 *    half they deleted (`legacySplitId` can no longer derive `600` from a
 *    re-anchored `splits: [0]`).
 *
 * The first cut of the §137 fix refreshed unconditionally, which meant the
 * branch's own marquee scenario — three of that user's four retypes recovered
 * — destroyed the evidence for the other half of the same bug. Gating the
 * WRITE on work done (`produce.ts`) only removed the zero-repair case; this is
 * the rest of it.
 *
 * Atomic via tmp+rename either way, matching the edit server's own
 * `PUT /overrides` handler: the producer or a live editor session may read
 * this file at any moment, and a half-written document would be worse than a
 * stale one.
 */
export async function writeOverrideDoc(
  overridesPath: string,
  doc: OverrideDoc,
  opts: { refreshBackup: boolean },
): Promise<void> {
  if (opts.refreshBackup) {
    try {
      const raw = await readFile(overridesPath, "utf8");
      await writeFile(`${overridesPath}.bak`, raw);
    } catch {
      // Nothing on disk to back up (first cut ever applied here) — fine.
    }
  }
  const tmp = `${overridesPath}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2));
  await rename(tmp, overridesPath);
}

/**
 * Why produce wrote `overrides.json` — the operands of its write gate, one
 * flag each (`produce.ts`, the `writeOverrideDoc` call). Only `cutChanged`
 * spends the `.bak`; the rest name what else moved.
 */
export interface OverridesWriteReasons {
  cutChanged: boolean;
  captionKeysReanchored: boolean;
  hidesPruned: boolean;
  sceneKeysRemapped: boolean;
  splitSrcResolved: boolean;
  splitHalvesChanged: boolean;
  takeLooksMigrated: boolean;
  /** `reconcileSplitAnchors` wrote a split's idle anchor onto where it cut
   * (split-positions-by-source R7-4, R8-3). */
  splitsReconciled: boolean;
}

/** What each non-cut reason did, in the order the gate lists them. */
const REASON_PHRASES: ReadonlyArray<[Exclude<keyof OverridesWriteReasons, "cutChanged">, string]> = [
  ["captionKeysReanchored", "caption edits re-anchored to source-time caption keys"],
  ["hidesPruned", "caption hides the cut already removed retired"],
  ["sceneKeysRemapped", "scene edits re-keyed to their anchors' new ids"],
  ["splitSrcResolved", "split source anchors recorded"],
  ["splitHalvesChanged", "take halves re-keyed to their splits"],
  ["takeLooksMigrated", "take looks moved onto source time"],
  // Last, as the gate lists it last.
  ["splitsReconciled", "split anchors reconciled to where they cut"],
];

/**
 * What the run says about that write. Pure, and separate from the write for
 * the house reason — but also because the two halves of this sentence are the
 * two halves of the decision above, and a line that claims a backup nobody
 * took is how a user finds out too late (final review round 2).
 *
 * It names every reason the gate fired on, not just the cut-or-caption pair
 * it started with: once five more flags joined the gate, a run whose only
 * write was the one-time take-look migration printed "re-anchored to
 * source-time caption keys" over a doc whose caption keys had not moved
 * (take-looks-by-source final review, Minor 1; `looks1.log`). The one line
 * telling the author their file changed has to say why it did.
 */
export function overridesWriteLine(reasons: OverridesWriteReasons): string {
  const others = REASON_PHRASES.filter(([flag]) => reasons[flag]).map(([, phrase]) => phrase);
  if (reasons.cutChanged) {
    return (
      "▸ overrides.json re-anchored to the new cut and saved (previous copy kept as .bak)" +
      (others.length > 0 ? `; also ${others.join("; ")}` : "")
    );
  }
  return (
    `▸ overrides.json saved${others.length > 0 ? ` — ${others.join("; ")}` : ""} ` +
    "(overrides.json.bak left alone — it may be an older, pre-cut copy worth more than this one)"
  );
}
