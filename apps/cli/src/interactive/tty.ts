import { cancel, isCancel } from "@clack/prompts";

/**
 * The ONE interactivity check in the codebase. Everything that might prompt
 * asks this; nothing else sniffs `isTTY` directly. A second, subtly different
 * check is how a CLI ends up hanging in somebody's CI waiting on an answer
 * nobody can give.
 */
export interface TtyDeps {
  env: NodeJS.ProcessEnv;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}

const liveDeps = (): TtyDeps => ({
  env: process.env,
  // `isTTY` is `undefined` rather than `false` on a pipe — compare explicitly.
  stdinIsTty: process.stdin.isTTY === true,
  stdoutIsTty: process.stdout.isTTY === true,
});

export function isInteractive(deps: TtyDeps = liveDeps()): boolean {
  // Truthiness, not presence: some shells export CI= (empty) merely because
  // the variable is declared, and that must not silence prompts on a real
  // terminal.
  if (deps.env.OSSCLIP_NO_INTERACTIVE) return false;
  if (deps.env.CI) return false;
  return deps.stdinIsTty && deps.stdoutIsTty;
}

/**
 * Cancelling is not a failure. Ctrl-C or Esc at any prompt exits 0 with the
 * same wording `ossclip setup` already uses for the same situation — never a
 * stack trace, never a half-run.
 */
const exitOnCancel = (): never => {
  cancel("nothing changed.");
  process.exit(0);
};

export function unwrap<T>(
  value: T | symbol,
  onCancel: () => never = exitOnCancel,
  // Injected because clack's sentinel is a module-local Symbol("clack:cancel")
  // that is never exported — a test cannot construct one, and Symbol.for()
  // produces a look-alike with a different identity that isCancel rejects.
  cancelled: (v: unknown) => boolean = isCancel,
): T {
  if (cancelled(value)) return onCancel();
  return value as T;
}

/**
 * Guards the prompt helpers themselves. Reaching a prompt without a TTY means
 * a caller forgot to check `isInteractive()` — a programming error that should
 * fail loudly in the test suite, not silently block a pipeline.
 */
export function assertInteractive(what: string, check: () => boolean = () => isInteractive()): void {
  if (!check()) {
    throw new Error(`internal: ${what} tried to prompt without a TTY`);
  }
}
