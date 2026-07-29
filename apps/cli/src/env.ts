import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Load `.env` files into `process.env` (R16 §77).
 *
 * The provider keys are the one piece of configuration ossclip reads from the
 * environment rather than `~/.ossclip/config.json` — secrets do not belong in
 * a file that gets pasted into issues. But "export it in your shell" is a bad
 * contract for a tool you launch from an editor, a script, or a replayed
 * `command.json`: the key was set in the shell that ran `produce` and absent
 * everywhere else, so auto-detection silently picked a different provider.
 *
 * Read in order, FIRST hit wins for each key, and a real environment variable
 * always beats a file — an explicit `GEMINI_API_KEY=… ossclip produce` must
 * not be overridden by a stale `.env`:
 *   1. `$OSSCLIP_ENV_FILE`, when set
 *   2. `.env` walking UP from the cwd, nearest first
 *   3. `~/.ossclip/.env`
 *
 * The upward walk is not a flourish: `pnpm --filter ossclip exec …` runs
 * with the cwd set to `apps/cli`, so a repo-root `.env` — the only place
 * anyone puts one — is invisible to a plain `<cwd>/.env` lookup. Same reason
 * every JS toolchain walks up for its config.
 *
 * Parsing is deliberately small: `KEY=value`, `#` comments, blank lines, an
 * optional `export ` prefix, and surrounding quotes stripped. Anything fancier
 * belongs in a shell, not in a secrets file.
 */
export function loadEnvFiles(cwd: string = process.cwd()): string[] {
  const upward: string[] = [];
  for (let dir = resolve(cwd); ; ) {
    upward.push(join(dir, ".env"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const candidates = [
    process.env.OSSCLIP_ENV_FILE ? resolve(process.env.OSSCLIP_ENV_FILE) : null,
    ...upward,
    join(homedir(), ".ossclip", ".env"),
  ].filter((p): p is string => Boolean(p));

  const loaded: string[] = [];
  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // absent is the normal case, not an error
    }
    let applied = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
      if (!key) continue;
      // The real environment wins: never clobber what the caller set.
      if (process.env[key] !== undefined) continue;
      const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
      process.env[key] = value;
      applied++;
    }
    if (applied > 0) loaded.push(path);
  }
  return loaded;
}
