/**
 * The facts every failed LLM call can state without guessing why it failed.
 *
 * From the 2026-08-22 incident (FINDINGS §132): a `--produce --aspect 16:9`
 * run on an 11-minute take timed out twice at agy's print timeout — 10m each,
 * 25 minutes burned — and died with "Is Antigravity installed and logged in?"
 * on an agy that was installed, logged in and working. What that user needed
 * was not a better guess, it was the shape of the wait: two attempts, ten
 * minutes each. Attempt facts self-diagnose a hang, and they stay true when
 * the classification is wrong — so both CLI providers print them for EVERY
 * failure class, and gate only the advice.
 *
 * Pure, and shared so the two providers cannot drift into two formats for the
 * same sentence.
 */

/** `600_000 → "10m0s"`, `1_500 → "1.5s"` — an at-a-glance wall time. */
export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Floored, not rounded: 1m59.6s must not print as "1m60s".
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/**
 * "2 attempts, 10m0s and 10m0s" — how many calls ran and how long each took,
 * with `extra` appended for a provider that has a clock worth naming (agy's
 * `--print-timeout`). An empty list still says "0 attempts": a call that never
 * spawned is itself the diagnosis.
 */
export function attemptFactsLine(attemptMs: readonly number[], extra?: string): string {
  const times = attemptMs.map(formatElapsed);
  const listed =
    times.length > 1
      ? `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`
      : (times[0] ?? "");
  return (
    `${attemptMs.length} attempt${attemptMs.length === 1 ? "" : "s"}` +
    `${listed ? `, ${listed}` : ""}${extra ? `, ${extra}` : ""}.`
  );
}
