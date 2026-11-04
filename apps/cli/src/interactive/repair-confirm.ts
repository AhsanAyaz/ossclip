import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod/v4";
import type { AppliedRepair, TranscriptRepair } from "@ossclip/core";
import { multiselect, text, unwrap } from "./prompts";

/**
 * Transcript repair confirmation (2026-11-04).
 *
 * The repair pass's gates decide on their own and the user found out from the
 * cut report — after the beat sheet, graphics and captions were built from
 * the result. Field case: "Esmeyaz." → "Ahsan Ayaz." was refused as "a
 * rewrite, not a repair", and it was the right answer. So before planning,
 * the user sees every proposal, flips the wrong verdicts, and types what was
 * actually said for anything they untick.
 *
 * Pure decision logic here; the prompts ride an injectable seam
 * (`RepairPrompts`), the thumbnail-approve split, so the loop is testable
 * with a scripted object and no TTY.
 */

export const RepairDecisionSchema = z.object({
  startWord: z.number().int(),
  endWord: z.number().int(),
  heard: z.string(),
  correction: z.string(),
  /** Ticked: apply the proposal as written, gates or no gates. */
  keep: z.boolean(),
  /** Unticked with text typed: what was actually said. */
  said: z.string().optional(),
});
export type RepairDecision = z.infer<typeof RepairDecisionSchema>;

export const RepairDecisionsFileSchema = z.object({
  decisions: z.array(RepairDecisionSchema).default([]),
  /**
   * Dictionary terms THIS take added through a typed correction. Left out of
   * the transcript and repair cache keys so adding them does not throw away
   * this take's transcript (the author's call, 2026-11-04: "keep today's
   * transcript"). Any other dictionary change still invalidates, as before.
   */
  addedTerms: z.array(z.string()).default([]),
});
export type RepairDecisionsFile = z.infer<typeof RepairDecisionsFileSchema>;

export const REPAIR_DECISIONS_FILE = "repair-decisions.json";

/** Absent or unreadable reads as "nothing decided" — the prompt simply asks again. */
export async function loadRepairDecisions(path: string): Promise<RepairDecisionsFile> {
  try {
    return RepairDecisionsFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { decisions: [], addedTerms: [] };
  }
}

export async function saveRepairDecisions(path: string, file: RepairDecisionsFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * A proposal's identity: where it sits and what it says. The located span,
 * not the model's claimed one — `applyRepairs` re-derives the index, and a
 * cached replay re-derives the same one, so a decision survives a re-run.
 */
export function proposalKey(p: {
  startWord: number;
  endWord: number;
  heard: string;
  correction: string;
}): string {
  return JSON.stringify([p.startWord, p.endWord, p.heard, p.correction]);
}

/** Proposals the user has not ruled on yet — the only ones a re-run asks about. */
export function unseenProposals(
  repairs: readonly AppliedRepair[],
  decisions: readonly RepairDecision[],
): AppliedRepair[] {
  const seen = new Set(decisions.map(proposalKey));
  return repairs.filter((r) => !seen.has(proposalKey(r)));
}

/** Case- and edge-punctuation-insensitive, for "did they type what was heard?". */
const loose = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/**
 * Turn the model's proposals plus the user's decisions into the proposal
 * list `applyRepairs` should see, and which of them the user vouched for.
 *
 *   no decision          → as proposed; the gates decide (today's behavior)
 *   ticked               → as proposed, confirmed (skips the rewrite gates)
 *   unticked + said text → the user's words, confirmed
 *   unticked, no text    → dropped: what was heard stays
 *
 * `confirmed` is identity-based on the returned objects — `applyRepairs`
 * hands the predicate the exact object it was given.
 */
export function decidedProposals(
  repairs: readonly AppliedRepair[],
  decisions: readonly RepairDecision[],
): {
  proposals: TranscriptRepair[];
  confirmed: (r: TranscriptRepair) => boolean;
  /** Proposals the user unticked without a replacement — for the report. */
  dropped: AppliedRepair[];
} {
  const byKey = new Map(decisions.map((d) => [proposalKey(d), d]));
  const vouched = new Set<TranscriptRepair>();
  const proposals: TranscriptRepair[] = [];
  const dropped: AppliedRepair[] = [];
  for (const r of repairs) {
    const base = { startWord: r.startWord, endWord: r.endWord, heard: r.heard, correction: r.correction };
    const d = byKey.get(proposalKey(r));
    if (!d) {
      proposals.push(base);
      continue;
    }
    if (d.keep) {
      vouched.add(base);
      proposals.push(base);
      continue;
    }
    const said = d.said?.trim();
    if (said && loose(said) !== loose(r.heard)) {
      const mine = { ...base, correction: said };
      vouched.add(mine);
      proposals.push(mine);
      continue;
    }
    dropped.push({ ...r, applied: false, rejected: "you unticked it", byUser: true });
  }
  return { proposals, confirmed: (r) => vouched.has(r), dropped };
}

/**
 * Dictionary terms from typed corrections, minus anything already in the
 * dictionary (case-insensitive) — the author asked for typed fixes to land
 * there so whisper and the repair pass know the word from then on. Edge
 * punctuation is stripped: "Ahsan Ayaz." is a sentence end, not the term.
 */
export function newDictionaryTerms(
  decisions: readonly RepairDecision[],
  dictionary: readonly string[],
): string[] {
  const have = new Set(dictionary.map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const d of decisions) {
    if (d.keep || !d.said) continue;
    const term = d.said.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!term || loose(term) === loose(d.heard) || have.has(term.toLowerCase())) continue;
    have.add(term.toLowerCase());
    out.push(term);
  }
  return out;
}

/** The dictionary the transcript and repair CACHE KEYS see — see `addedTerms`. */
export function cacheKeyDictionary(
  dictionary: readonly string[],
  addedTerms: readonly string[],
): string[] {
  const added = new Set(addedTerms);
  return dictionary.filter((t) => !added.has(t));
}

export interface RepairPrompts {
  /** Returns the ticked values — already unwrapped, never a cancel symbol. */
  multiselect(opts: {
    message: string;
    options: { value: string; label: string; hint?: string }[];
    initialValues: string[];
  }): Promise<string[]>;
  /** Returns the typed text — already unwrapped; "" when left empty. */
  text(opts: { message: string; placeholder?: string }): Promise<string>;
}

/** The live clack-backed prompts; tests inject a scripted replacement. */
export function clackRepairPrompts(): RepairPrompts {
  return {
    multiselect: async (opts) =>
      unwrap(await multiselect({ ...opts, required: false })) as string[],
    text: async (opts) => (unwrap(await text({ ...opts, defaultValue: "" })) as string) ?? "",
  };
}

/** The tick-list label: what was heard, what it becomes. */
export function repairLabel(r: AppliedRepair): string {
  return `"${r.heard}" → "${r.correction}"`;
}

/**
 * One tick list for the whole set (the author: "whole list, only change the
 * wrong ones"), the gates' verdicts as the starting ticks, then one question
 * per unticked proposal. Enter on an untouched list reproduces exactly what
 * the gates decided.
 */
export async function confirmRepairs(
  pending: readonly AppliedRepair[],
  prompts: RepairPrompts,
): Promise<RepairDecision[]> {
  if (pending.length === 0) return [];
  const ticked = new Set(
    await prompts.multiselect({
      message: "Transcript repairs — space to toggle, enter to accept",
      options: pending.map((r, i) => ({
        value: String(i),
        label: repairLabel(r),
        ...(r.applied ? {} : { hint: `refused: ${r.rejected ?? "gate"}` }),
      })),
      initialValues: pending.flatMap((r, i) => (r.applied ? [String(i)] : [])),
    }),
  );
  const out: RepairDecision[] = [];
  for (const [i, r] of pending.entries()) {
    const base = { startWord: r.startWord, endWord: r.endWord, heard: r.heard, correction: r.correction };
    if (ticked.has(String(i))) {
      out.push({ ...base, keep: true });
      continue;
    }
    const said = (
      await prompts.text({
        message: `"${r.heard}" — what was actually said? (enter = keep as heard)`,
      })
    ).trim();
    out.push({ ...base, keep: false, ...(said ? { said } : {}) });
  }
  return out;
}
