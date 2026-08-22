import { describe, expect, it } from "vitest";
import { attemptFactsLine, formatElapsed } from "../src/producer/failure";

/**
 * The line the 2026-08-22 incident asked for (§132): after 25 minutes of
 * hanging, "2 attempts, 10m0s and 10m0s" is the sentence that would have told
 * the user what happened — so it prints for every failure class, and it has to
 * read the same from both CLI providers.
 */
describe("attempt facts", () => {
  it("formats a wall time at the scale a user reads it", () => {
    expect(formatElapsed(600_000)).toBe("10m0s"); // the incident's own attempt
    expect(formatElapsed(1_500)).toBe("1.5s");
    expect(formatElapsed(0)).toBe("0.0s");
    // Floored, not rounded: a near-minute must not print as "1m60s".
    expect(formatElapsed(119_600)).toBe("1m59s");
    expect(formatElapsed(60_000)).toBe("1m0s");
  });

  it("states how many calls ran and how long each took", () => {
    expect(attemptFactsLine([600_000, 600_000], "--print-timeout 10m")).toBe(
      "2 attempts, 10m0s and 10m0s, --print-timeout 10m.",
    );
    // Singular, and no trailing clock for a provider that has none to name.
    expect(attemptFactsLine([1_200])).toBe("1 attempt, 1.2s.");
    expect(attemptFactsLine([1_000, 2_000, 3_000])).toBe("3 attempts, 1.0s, 2.0s and 3.0s.");
  });

  it("says 0 attempts rather than nothing when no call ever ran", () => {
    // A pre-spawn refusal is itself the diagnosis — an empty list must not
    // silently produce a sentence that reads like one attempt happened.
    expect(attemptFactsLine([])).toBe("0 attempts.");
    expect(attemptFactsLine([], "--print-timeout 10m")).toBe("0 attempts, --print-timeout 10m.");
  });
});
