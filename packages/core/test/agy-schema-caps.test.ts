import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { stripAbsorbableCaps } from "../src/producer/antigravity";
import { ClipBeatSheetSchema, cappedText } from "../src/producer/beats";

/**
 * One real way a generation gets thrown away (§151) — and explicitly NOT the
 * reason agy times out. That was the theory these tests were written under,
 * and replaying the exact failing request standalone refuted it: with
 * maxLength stripped it still timed out, and with the schema flag dropped
 * entirely it still timed out. The hang is upstream (§143, §149).
 *
 * What IS real, captured from a live call:
 *
 *   "status": "ERROR"
 *   "error": "invalid arguments:\n- at '/hook': maxLength: got 136, want 120"
 *
 * The model wrote 136 characters where our schema allows 120, so a whole
 * generation was thrown away over a length our own parse would have absorbed
 * silently. Every one of up to 24 moments carries three capped strings, all of
 * which must land under their limit on the SAME attempt.
 *
 * Our own parse already absorbs an overshoot: `cappedText` truncates at a word
 * boundary rather than rejecting. The cap on the wire was therefore doing no
 * work we needed, at the cost of the entire call.
 *
 * The rule this encodes: strip only what we can absorb locally. Structure
 * stays — a 25th moment or an invented sceneKind is NOT something truncation
 * can quietly fix, and that is what structured output is actually for.
 */
describe("stripAbsorbableCaps", () => {
  it("drops maxLength, which cappedText already absorbs by truncating", () => {
    const out = stripAbsorbableCaps({ type: "string", maxLength: 120 });
    expect(out).toEqual({ type: "string" });
  });

  it("keeps enum, const and type — truncation cannot repair a wrong VALUE", () => {
    const schema = {
      anyOf: [
        { type: "string", enum: ["TitleCard", "StatCard"] },
        { type: "string", const: "none" },
      ],
    };
    expect(stripAbsorbableCaps(schema)).toEqual(schema);
  });

  it("keeps maxItems — a 25th moment is not something we can silently shorten", () => {
    const out = stripAbsorbableCaps({
      type: "array",
      maxItems: 24,
      minItems: 1,
      items: { type: "string", maxLength: 60 },
    });
    expect(out).toEqual({ type: "array", maxItems: 24, minItems: 1, items: { type: "string" } });
  });

  it("keeps required and properties intact", () => {
    const out = stripAbsorbableCaps({
      type: "object",
      required: ["hook"],
      properties: { hook: { type: "string", maxLength: 120 } },
    });
    expect(out).toEqual({
      type: "object",
      required: ["hook"],
      properties: { hook: { type: "string" } },
    });
  });

  it("reaches every nesting depth of the REAL beat sheet schema", () => {
    const stripped = stripAbsorbableCaps(z.toJSONSchema(ClipBeatSheetSchema));
    expect(JSON.stringify(stripped)).not.toContain("maxLength");
    // The parts that make it a contract are still there.
    expect(JSON.stringify(stripped)).toContain("maxItems");
    expect(JSON.stringify(stripped)).toContain("TitleCard");
  });

  it("does not mutate the caller's schema — toJSONSchema output is reused", () => {
    const original = { type: "string", maxLength: 120 };
    stripAbsorbableCaps(original);
    expect(original).toEqual({ type: "string", maxLength: 120 });
  });
});

/**
 * The prerequisite for the strip being SAFE (§151). Every capped string has to
 * absorb an overshoot locally, or removing the wire cap just moves the
 * rejection from agy's validator to our own parse — a hard failure instead of
 * a retry loop, which is worse.
 */
describe("every capped string truncates rather than rejects", () => {
  it("cappedText truncates at a word boundary", () => {
    const parsed = cappedText(20).parse("one two three four five six seven eight");
    expect(parsed.length).toBeLessThanOrEqual(20);
    expect(parsed).toBe("one two three four");
  });

  it("the clip highlight's reason absorbs an overshoot instead of throwing", () => {
    // Was a bare z.string().max(200): the one cap in the beat sheet that
    // rejected. Stripping it from the wire without this would have turned an
    // agy rejection into a local one.
    const long = "why this window ".repeat(40);
    expect(long.length).toBeGreaterThan(200);
    const sheet = ClipBeatSheetSchema.parse({
      hook: "a hook",
      coverText: "cover",
      moments: [{ startWord: 0, endWord: 3, purpose: "p", onScreenCopy: "c", sceneKind: "none" }],
      highlight: { startWord: 0, endWord: 3, reason: long },
    });
    expect(sheet.highlight.reason.length).toBeLessThanOrEqual(200);
  });
});
