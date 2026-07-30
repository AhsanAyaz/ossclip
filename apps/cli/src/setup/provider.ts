import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The LLM-provider step of `ossclip setup`.
 *
 * A key is only ever taken interactively and saved to `~/.ossclip/.env` —
 * the file `loadEnvFiles` (R16 §77) already reads last, so a shell export
 * or a project `.env` still wins. Secrets stay out of config.json, which
 * people paste into issues.
 */

export interface ProviderIO {
  /** Ask one question, return the trimmed answer ("" for just-Enter). */
  ask(question: string): Promise<string>;
  say(line: string): void;
}

export async function promptForProvider(io: ProviderIO, configDir: string): Promise<void> {
  io.say("");
  io.say("An LLM provider is only needed for `--produce` (the graphics planner).");
  io.say("Cutting + captions run fully local without one.");
  io.say("  1) I have an Anthropic API key");
  io.say("  2) I have a Google Gemini API key");
  io.say("  3) I use Claude Code (already logged in — no key needed)");
  io.say("  Enter) skip for now");
  const choice = (await io.ask("Choice: ")).trim();
  if (choice === "3") {
    io.say("▸ nothing to save — ossclip finds the claude CLI on PATH by itself.");
    return;
  }
  const envKey = choice === "1" ? "ANTHROPIC_API_KEY" : choice === "2" ? "GEMINI_API_KEY" : null;
  if (!envKey) {
    io.say("▸ skipped — `ossclip doctor` will remind you what --produce needs.");
    return;
  }
  const value = (await io.ask(`${envKey}=`)).trim();
  if (!value) {
    io.say("▸ empty — skipped.");
    return;
  }
  const envPath = saveProviderKey(configDir, envKey, value);
  io.say(`▸ saved to ${envPath} (delete that line to revoke)`);
}

export function saveProviderKey(configDir: string, key: string, value: string): string {
  const envPath = join(configDir, ".env");
  mkdirSync(dirname(envPath), { recursive: true });
  appendFileSync(envPath, `${key}=${value}\n`, { mode: 0o600 });
  return envPath;
}
