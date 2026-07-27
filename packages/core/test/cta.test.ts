import { describe, expect, it } from "vitest";
import { rejectCtaKeyword } from "../src/cta";

/**
 * The comment-CTA keyword mechanic (FINDINGS §16/§28b) implements ONE shape of
 * ask: "comment AGENTS and I'll send it". The keyword is a distinctive word the
 * viewer literally types, and the render gives it the whole frame.
 *
 * A "reply with a number" ask is a different shape. The author's own clip says
 * "which one did you not know? Type in the comments the number of it" — the
 * producer extracted `number`, so the render showed a `"NUMBER"` pill and the
 * caption read `comments the "NUMBER"`. There is no word to type; the viewer is
 * meant to reply with a digit the producer cannot know. The mechanic must not
 * fire at all.
 */
describe("rejectCtaKeyword", () => {
  it("rejects the referential filler of a reply-with-a-number ask", () => {
    expect(rejectCtaKeyword("number")).toBeTruthy();
    expect(rejectCtaKeyword("answer")).toBeTruthy();
    expect(rejectCtaKeyword("reply")).toBeTruthy();
    expect(rejectCtaKeyword("comment")).toBeTruthy();
    expect(rejectCtaKeyword("comments")).toBeTruthy();
    expect(rejectCtaKeyword("below")).toBeTruthy();
  });

  it("rejects function words, which never carry a CTA", () => {
    expect(rejectCtaKeyword("it")).toBeTruthy();
    expect(rejectCtaKeyword("this")).toBeTruthy();
    expect(rejectCtaKeyword("one")).toBeTruthy();
  });

  it("keeps a real keyword CTA — a distinctive term the viewer types", () => {
    expect(rejectCtaKeyword("agents")).toBeNull();
    expect(rejectCtaKeyword("guide")).toBeNull();
    expect(rejectCtaKeyword("claude")).toBeNull();
    expect(rejectCtaKeyword("template")).toBeNull();
  });

  it("is case- and whitespace-insensitive, and rejects empty input", () => {
    expect(rejectCtaKeyword("  NUMBER ")).toBeTruthy();
    expect(rejectCtaKeyword("")).toBeTruthy();
    expect(rejectCtaKeyword(undefined)).toBeTruthy();
  });

  it("gives a reason, so a rejection is logged rather than silent", () => {
    expect(rejectCtaKeyword("number")).toMatch(/./);
  });
});
