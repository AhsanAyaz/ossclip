import { describe, expect, it } from "vitest";
import { RESTART_PREFIX_CONFIDENCE, type RetakeGroup } from "@ossclip/core";
import { inferredRetakesEnabled, retakeCutsFor } from "../src/produce";

/**
 * The 2026-08-16 gate decision, verbatim: "Bloopers and retakes go
 * hand-in-hand. Do not do retakes without bloopers... If blooper is there,
 * we do it, else we don't." Inferred retake collapse runs iff a blooper
 * marker was given; `--collapse-retakes` is a parseable legacy no-op (the
 * roundtrip suite pins that it still parses). Both helpers are pure exports
 * of produce.ts so the matrix needs no run, no TTY, no filesystem.
 */
describe("inferredRetakesEnabled", () => {
  it("a marker enables retakes", () => {
    expect(inferredRetakesEnabled("blooper")).toBe(true);
  });

  it("no marker disables retakes — whatever --collapse-retakes said", () => {
    expect(inferredRetakesEnabled(undefined)).toBe(false);
  });

  it("a blank or whitespace marker counts as absent, same as findBloopSpans' own refusal", () => {
    expect(inferredRetakesEnabled("")).toBe(false);
    expect(inferredRetakesEnabled("   ")).toBe(false);
  });
});

describe("retakeCutsFor: confidence per rule", () => {
  const cut = { startWord: 0, endWord: 3, startSec: 200.0, endSec: 200.53, similarity: 1 };
  const base: RetakeGroup = {
    kept: { startWord: 4, endWord: 10, startSec: 201.0, endSec: 203.08 },
    cuts: [cut],
    hallucinated: [],
    undecided: [],
  };

  it("an ordinary similarity group carries no confidence — buildCutlist's 0.9 default stands", () => {
    const [entry] = retakeCutsFor([base]);
    expect(entry!.confidence).toBeUndefined();
  });

  it("an exact-prefix group carries RESTART_PREFIX_CONFIDENCE (0.85)", () => {
    const [entry] = retakeCutsFor([{ ...base, rule: "exact-prefix" }]);
    expect(entry!.confidence).toBe(RESTART_PREFIX_CONFIDENCE);
    expect(RESTART_PREFIX_CONFIDENCE).toBe(0.85);
  });
});
