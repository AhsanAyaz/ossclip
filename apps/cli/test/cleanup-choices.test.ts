import { describe, expect, it } from "vitest";
import type { Segment } from "@ossclip/core";
import { cleanupChoicesLine } from "../src/produce";

/**
 * The one loud line for cleanup vetoes changing a run's cut (cut review
 * step 3) — pure, so the phrasing is assertable without driving produce.
 * The gate (only printed when something was vetoed) lives at the call site,
 * like the user-cut line's own `cuts.length > 0`.
 */

const remove = (srcIn: number, srcOut: number, reason?: Segment["reason"]): Segment => ({
  srcIn,
  srcOut,
  kind: "remove",
  ...(reason ? { reason } : {}),
});

describe("cleanupChoicesLine", () => {
  it("counts re-kept spans per reason with the seconds each restores", () => {
    const line = cleanupChoicesLine(
      [remove(8, 11, "pause"), remove(22, 23, "pause"), remove(14, 14.5, "filler")],
      15.2,
    );
    expect(line).toBe(
      "▸ cleanup choices kept 2 pause removal(s) (+4.0s), 1 filler removal(s) (+0.5s) — 15.2s output",
    );
  });

  it("a reasonless removal is named rather than dropped from the account", () => {
    // buildCutlist always labels its removals, but the schema allows a bare
    // one (a hand-edited file) — the line must still add up.
    expect(cleanupChoicesLine([remove(1, 2)], 10)).toBe(
      "▸ cleanup choices kept 1 unlabeled removal(s) (+1.0s) — 10.0s output",
    );
  });
});
