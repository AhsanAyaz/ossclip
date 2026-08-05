import { describe, expect, it } from "vitest";
import {
  COVER_MAX_WORDS,
  coverDecision,
  coverHeadline,
  laplacianVariance,
  scoreCandidate,
} from "../src/cover";

/** A flat grey frame — no edges at all. */
const flat = (w: number, h: number) => new Uint8Array(w * h).fill(128);
/** Hard vertical stripes — maximum edge energy. */
const stripes = (w: number, h: number) =>
  Uint8Array.from({ length: w * h }, (_, i) => ((i % w) % 2 === 0 ? 0 : 255));
/** The same stripes blurred — what a frame caught mid-motion looks like. */
const blurred = (w: number, h: number) =>
  Uint8Array.from({ length: w * h }, (_, i) => 128 + 40 * Math.sin(((i % w) / w) * Math.PI * 4));

describe("cover frame scoring (FINDINGS §31)", () => {
  it("ranks sharp frames above blurred ones, and blurred above flat", () => {
    const sharp = laplacianVariance(stripes(64, 64), 64, 64);
    const soft = laplacianVariance(blurred(64, 64), 64, 64);
    const none = laplacianVariance(flat(64, 64), 64, 64);
    expect(sharp).toBeGreaterThan(soft);
    expect(soft).toBeGreaterThan(none);
    expect(none).toBeCloseTo(0, 6);
  });

  it("a face outranks sharpness — a cover without the speaker is the wrong cover", () => {
    const withFace = scoreCandidate({
      timeSec: 5, durationSec: 10, sharpness: 10, hasFace: true, maxSharpness: 100,
    });
    const sharperNoFace = scoreCandidate({
      timeSec: 5, durationSec: 10, sharpness: 100, hasFace: false, maxSharpness: 100,
    });
    expect(withFace).toBeGreaterThan(sharperNoFace);
  });

  it("among faces, the sharper frame wins", () => {
    const base = { timeSec: 5, durationSec: 10, hasFace: true, maxSharpness: 100 };
    expect(scoreCandidate({ ...base, sharpness: 90 })).toBeGreaterThan(
      scoreCandidate({ ...base, sharpness: 20 }),
    );
  });

  it("earlier frames break ties, so the cover matches the opening", () => {
    const base = { durationSec: 10, sharpness: 50, hasFace: true, maxSharpness: 100 };
    expect(scoreCandidate({ ...base, timeSec: 1 })).toBeGreaterThan(
      scoreCandidate({ ...base, timeSec: 9 }),
    );
  });
});

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe("cover headline cap (FINDINGS §35)", () => {
  it("leaves a headline that is already short alone", () => {
    expect(coverHeadline("SIX MONTHS OF MAX, FREE")).toBe("SIX MONTHS OF MAX, FREE");
  });

  it("caps the real §35 case — the full hook reused verbatim", () => {
    // 13 words across five lines in the shipped cover; the reference grid
    // runs 4-9 words over 1-3 lines.
    const out = coverHeadline(
      "CLAUDE GAVE ME SIX MONTHS OF MAX PLAN FOR FREE — AND NOT FOR THE REASON YOU THINK",
    );
    expect(words(out)).toBeLessThanOrEqual(COVER_MAX_WORDS);
    expect(out).not.toContain("REASON");
  });

  it("prefers the clause before the dash when it fits", () => {
    expect(coverHeadline("I QUIT MY JOB — HERE IS WHAT HAPPENED NEXT TO ME")).toBe(
      "I QUIT MY JOB",
    );
  });

  it("never stops on a preposition or article", () => {
    // "…OF" reads as a truncation bug; "…MONTHS" reads as an edit.
    const out = coverHeadline("THE ONE THING NOBODY TELLS YOU ABOUT THE FUTURE OF WORK");
    expect(out.toLowerCase()).not.toMatch(/\b(of|the|and|to|for|a|an)$/);
    expect(words(out)).toBeLessThanOrEqual(COVER_MAX_WORDS);
  });

  it("never crosses the dash while truncating", () => {
    // Cutting into the elaboration produces a sentence fragment, which is
    // worse than a short headline.
    const out = coverHeadline(
      "SIX THINGS I LEARNED SHIPPING AN OPEN SOURCE VIDEO TOOL — NUMBER FOUR SURPRISED ME",
    );
    expect(out).not.toContain("NUMBER");
  });

  it("does not turn a two-word opener into the whole headline", () => {
    // "FREE MONEY" alone is not the claim; the sentence is.
    const out = coverHeadline("FREE MONEY: HOW I GOT SIX MONTHS OF CLAUDE MAX AT NO COST");
    expect(words(out)).toBeGreaterThan(2);
  });

  it("an empty headline stays empty — the caller decides what that means", () => {
    expect(coverHeadline("")).toBe("");
    expect(coverHeadline("   ")).toBe("");
  });
});

describe("cover decision (Urdu field run 2026-08-05)", () => {
  it("hook text present → banner cover, unchanged from before", () => {
    expect(coverDecision(true, "SIX MONTHS OF MAX, FREE")).toBe("banner");
  });

  it("no hook text → textless cover, not a skip — the face frame needs no text", () => {
    expect(coverDecision(true, "")).toBe("textless");
    // Whitespace is what an empty beat-sheet field can round-trip to.
    expect(coverDecision(true, "   ")).toBe("textless");
  });

  it("--no-cover wins over everything, text or not", () => {
    expect(coverDecision(false, "SIX MONTHS OF MAX, FREE")).toBe("none");
    expect(coverDecision(false, "")).toBe("none");
  });
});
