/**
 * Renders an argv into the command line a user could have typed. Printed as
 * `▸ running:` before every wizard run, so the wizard is also a flags lesson.
 *
 * This takes the SAME array that gets executed. A wizard that teaches one
 * command and runs another is worse than no wizard, and rendering from the
 * executed array makes that failure unrepresentable rather than unlikely.
 */

// Deliberately an allowlist, not a "needs quoting" denylist: a character
// nobody thought about ends up quoted (harmless) instead of unquoted (wrong).
// Backslash and colon are in it so `D:\CWA\TiDB` — the exact shape of path
// this feature exists for — renders bare rather than wrapped in quotes.
const SAFE = /^[A-Za-z0-9._\-/\\:=@+,]+$/;

export function quoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (SAFE.test(arg)) return arg;
  if (platform === "win32") {
    // cmd doubles an embedded quote. Backslashes are left alone — escaping
    // them would corrupt every Windows path this prints.
    return `"${arg.replace(/"/g, '""')}"`;
  }
  // POSIX single quotes have no escape character: close, emit an escaped
  // quote, reopen.
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function renderCommand(argv: string[], platform: NodeJS.Platform = process.platform): string {
  return ["ossclip", ...argv].map((a) => quoteArg(a, platform)).join(" ");
}
