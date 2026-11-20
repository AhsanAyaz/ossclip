/**
 * One shot drawn by the LLM, with repairs (storyboard design §3, §5, §6;
 * §167): a draw (or redraw) call, the injected checks, and up to
 * `DRAW_MAX_REPAIRS` repair calls fed with what failed.
 *
 * The checks are injected as one function because they are I/O this module
 * must not do: the type check reads the kit's source and the still render
 * starts a browser (both in the CLI and renderer). That keeps the loop
 * testable with a scripted provider and a stub check.
 */
import type { LlmProvider } from "../producer/provider";
import type { DrawIssue } from "./static-check";
import { DrawReplySchema, drawPrompt, redrawPrompt, repairPrompt, type DrawRedraw, type DrawRequest } from "./prompt";

/** Repairs per version (plan Global Constraints): three calls in all, then the version is marked failed (design §5, G8). */
export const DRAW_MAX_REPAIRS = 2;

/**
 * The output budget for one call. A 400-line scene is about 5,000 to 7,000
 * tokens once escaped into a JSON string, and a thinking model's thought
 * tokens draw from the same budget (R20 §98). 16,000 is the API providers'
 * own default and the ceiling the design states (§3): asking for more is
 * not honoured, and a reply that would need more is the cut-off the repair
 * answers with a request for a shorter scene.
 */
export const DRAW_MAX_TOKENS = 16000;

/** One call and what came of it. `error` is the provider's failure text, when the call threw and there is no code. */
export interface DrawAttempt {
  code: string | null;
  said: string | null;
  issues: DrawIssue[];
  error?: string;
}

/** `code` and `said` are the passing attempt's when `ok`, else the last attempt that returned code (null if none did). */
export interface DrawResult {
  ok: boolean;
  code: string | null;
  said: string | null;
  attempts: DrawAttempt[];
  /** Set when `shouldStop` ended the draw before its next call; `ok` is then false (§169). */
  stopped?: true;
}

/** Every check a version goes through, in order (static, type, stills); returns the first failing stage's issues, or []. */
export type DrawCheck = (code: string) => Promise<DrawIssue[]>;

/**
 * Draws one shot, or redraws it from a note when `redraw` is given.
 *
 * Never throws for a failing provider or a failing check: a cut-off reply,
 * a timeout or invalid JSON is one failed attempt (Review Focus 3), and
 * after the last repair the result is `ok: false` with every attempt, so
 * one bad shot never fails the run (G8). A `check` that throws is different:
 * that is ossclip failing (a missing kit, a broken install), not the
 * scene, and sending it to the LLM as a repair would hide it. It propagates.
 *
 * `shouldStop` is asked before every call, never during one (§169): the
 * editor's Stop must not pay for another minute-long call once the author
 * has asked, but a call already sent is cheaper to let finish than to tear
 * out of a provider mid-reply. A stopped draw is `ok: false` with
 * `stopped: true` and what it had so far; the caller decides what a stopped
 * version leaves on disk.
 */
export async function drawShot(a: {
  provider: LlmProvider;
  req: DrawRequest;
  check: DrawCheck;
  redraw?: DrawRedraw;
  shouldStop?: () => boolean;
}): Promise<DrawResult> {
  const attempts: DrawAttempt[] = [];
  let prompt = a.redraw ? redrawPrompt(a.req, a.redraw) : drawPrompt(a.req);

  for (let n = 0; n <= DRAW_MAX_REPAIRS; n++) {
    if (a.shouldStop?.() === true) return { ...lastCode(attempts), ok: false, attempts, stopped: true };
    let reply: { code: string; said: string };
    try {
      reply = await a.provider.complete({
        system: prompt.system,
        user: prompt.user,
        schema: DrawReplySchema,
        schemaName: "drawn_scene",
        // Writing a whole scene is the judgement the shot rests on (design §3).
        tier: "editorial",
        maxTokens: DRAW_MAX_TOKENS,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      attempts.push({ code: null, said: null, issues: [], error });
      prompt = repairPrompt(a.req, { code: null, issues: [], error, redraw: a.redraw });
      continue;
    }

    const issues = await a.check(reply.code);
    attempts.push({ code: reply.code, said: reply.said, issues });
    if (issues.length === 0) return { ok: true, code: reply.code, said: reply.said, attempts };
    prompt = repairPrompt(a.req, { code: reply.code, issues, redraw: a.redraw });
  }

  return { ...lastCode(attempts), ok: false, attempts };
}

/**
 * The last code, not the first: it is the one that had every repair, and
 * the failed version written to disk is the one the author can read.
 * (A reversed copy: `findLast` is ES2023 and the workspace's lib is ES2022.)
 */
function lastCode(attempts: readonly DrawAttempt[]): { code: string | null; said: string | null } {
  const last = [...attempts].reverse().find((t) => t.code !== null);
  return { code: last?.code ?? null, said: last?.said ?? null };
}
