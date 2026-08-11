import { describe, expect, it } from "vitest";
import { findBloopSpans, formatBloopSpan } from "../src/blooper";
import { buildCutlist } from "../src/cutlist";
import { TimeMap } from "../src/timemap";
import type { Analysis, Transcript } from "../src/schema";

/**
 * R27 §122. The speaker marks a flub by saying a word out loud. That is the
 * deterministic subset of retake removal — no model, so `buildCutlist` stays a
 * pure function and the "same input, same edit" guarantee survives.
 */

/** A transcript from words, at 0.5s per word. */
const speak = (text: string): Transcript => ({
  language: "en",
  words: text.split(/\s+/).map((t, i) => ({ text: t, start: i * 0.5, end: i * 0.5 + 0.4 })),
});

const NO_ANALYSIS: Analysis = {
  cuttable: [],
  fillers: [],
  silences: [],
  gaps: [],
  breaths: [],
};

/** The real pattern, from the take that motivated this (words 205-228). */
const REAL =
  "Fix at most three issues. " +
  "That could be one of the cases where you can say blooper. " +
  "That could be one of blooper. " +
  "That could be the exit condition.";

describe("findBloopSpans", () => {
  it("cuts back to the start of the sentence the marker spoiled", () => {
    const t = speak("This is fine. I meant to say something else blooper. This is the good take.");
    const [span, ...rest] = findBloopSpans(t, "blooper");
    expect(rest).toEqual([]);
    expect(formatBloopSpan(t, span!)).toBe('"I meant to say something else blooper."');
  });

  it("collapses consecutive marked attempts into one cut", () => {
    // Two flubs back to back is one continuous stretch of unusable take, not
    // two cuts with an island of half-sentence between them.
    const t = speak(REAL);
    const spans = findBloopSpans(t, "blooper");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.markers).toBe(2);
    expect(formatBloopSpan(t, spans[0]!)).toBe(
      '"That could be one of the cases where you can say blooper. That could be one of blooper." (2 attempts)',
    );
  });

  it("keeps the good take that follows, and the sentence before", () => {
    const t = speak(REAL);
    const [span] = findBloopSpans(t, "blooper");
    const kept = t.words.filter((_, i) => i < span!.startWord || i > span!.endWord);
    const text = kept.map((w) => w.text).join(" ");
    expect(text).toBe("Fix at most three issues. That could be the exit condition.");
  });

  it("is case- and punctuation-insensitive, like the filler detector", () => {
    const t = speak("Say it again. Wrong words Blooper! The right words.");
    expect(findBloopSpans(t, "blooper")).toHaveLength(1);
    // The marker as typed is normalized too, so --blooper-marker "Blooper." works.
    expect(findBloopSpans(t, "Blooper.")).toHaveLength(1);
  });

  it("finds nothing when the marker is never said", () => {
    expect(findBloopSpans(speak(REAL), "scratch")).toEqual([]);
  });

  it("refuses an empty marker rather than matching every word", () => {
    expect(findBloopSpans(speak(REAL), "")).toEqual([]);
    expect(findBloopSpans(speak(REAL), "  ")).toEqual([]);
  });

  it("handles a marker in the very first sentence", () => {
    const t = speak("Bad opening blooper. The real opening.");
    const [span] = findBloopSpans(t, "blooper");
    expect(span!.startWord).toBe(0);
    expect(formatBloopSpan(t, span!)).toBe('"Bad opening blooper."');
  });

  it("reports source seconds spanning the whole flub", () => {
    const t = speak("Good. Bad words blooper. Good again.");
    const [span] = findBloopSpans(t, "blooper");
    expect(span!.startSec).toBe(t.words[span!.startWord]!.start);
    expect(span!.endSec).toBe(t.words[span!.endWord]!.end);
  });

  // Field bug: whisper transcribed the spoken marker "blooper" as "looker"
  // (Levenshtein distance 2 on normalized tokens; sound-alike rejects the
  // pair because the b/l onset differs — see phonetics.ts soundsSimilar).
  // --blooper-marker blooper never fired. Task 3, editor-dogfood-fixes plan.
  it("fuzzy-matches an ASR mishearing of a marker at least 6 characters long", () => {
    const t = speak("This is fine. I meant to say something else looker. This is the good take.");
    const spans = findBloopSpans(t, "blooper");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.matched).toEqual(["looker"]);
  });

  it("surfaces the fuzzy hit in the report line instead of cutting silently", () => {
    const t = speak("This is fine. I meant to say something else looker. This is the good take.");
    const [span] = findBloopSpans(t, "blooper");
    expect(formatBloopSpan(t, span!)).toContain('matched "looker" ~ "blooper"');
  });

  // Field bug, first real run of the feature (§125, PHASE1-FINDINGS.md):
  // soundsSimilar("builds", "blooper") is true — same "b" onset, score over
  // the 0.34 floor — even though the words are unrelated and Levenshtein
  // distance is 6. That arm cut 86.8% of a 125.9s video. Levenshtein alone
  // (<=2) does not have this failure mode, so the fuzzy arm is now
  // Levenshtein-only; "builds" must never match a "blooper" marker.
  it("does not fuzzy-match an unrelated same-onset word ('builds' for 'blooper')", () => {
    const t = speak("This is fine. Look at how the app builds. This is the good take.");
    expect(findBloopSpans(t, "blooper")).toEqual([]);
  });

  // Field bug, third field run (FINDINGS §133): the announce take says the
  // word "bloopers" as CONTENT — "it removes the bloopers", describing the
  // feature — and Levenshtein distance to the "blooper" marker is 1, so the
  // fuzzy arm cut 7.08s of good take back to its sentence start. An
  // inflection of the marker is a real word the speaker can say on purpose;
  // only ASR mishearings are fair game for fuzzy. Plain plurals of the
  // marker (and the marker as plural of a singular said as content) stay
  // exact-only.
  it("does not fuzzy-match a plural of the marker spoken as content", () => {
    const t = speak(
      "Use your terminal and it automatically removes the bloopers. This is the good take.",
    );
    expect(findBloopSpans(t, "blooper")).toEqual([]);
  });

  it("does not fuzzy-match the singular when the marker itself is plural", () => {
    const t = speak("This take mentions a blooper as content. This is the good take.");
    expect(findBloopSpans(t, "bloopers")).toEqual([]);
  });

  it("still cuts an exact marker even when its plural also appears as content", () => {
    const t = speak(
      "It removes the bloopers automatically. I flubbed this sentence blooper. This is the good take.",
    );
    const spans = findBloopSpans(t, "blooper");
    expect(spans).toHaveLength(1);
    expect(formatBloopSpan(t, spans[0]!)).toBe('"I flubbed this sentence blooper."');
  });

  // Guard: a short marker is too easy to confuse with ordinary words
  // ("cut" ~ "cat"/"but" both sound-alike and are within edit distance 2),
  // so fuzzy matching only turns on once the marker is long enough that a
  // false positive is unlikely. Short markers stay exact-only.
  it("keeps a short marker exact-only — no fuzzy match for 'cut'", () => {
    const t = speak("Say the word but. Then say cat too. Nobody said the marker.");
    expect(findBloopSpans(t, "cut")).toEqual([]);
  });
});

describe("blooper spans through buildCutlist", () => {
  const t = speak(REAL);
  const duration = t.words[t.words.length - 1]!.end + 0.5;

  it('emits the reserved "retake" reason, which nothing else has ever emitted', () => {
    const cut = buildCutlist({
      transcript: t,
      analysis: NO_ANALYSIS,
      duration,
      level: "standard",
      bloops: findBloopSpans(t, "blooper"),
    });
    const retakes = cut.filter((s) => s.kind === "remove" && s.reason === "retake");
    expect(retakes).toHaveLength(1);
  });

  it("stays a full partition of [0, duration] — the TimeMap invariant", () => {
    const cut = buildCutlist({
      transcript: t,
      analysis: NO_ANALYSIS,
      duration,
      level: "standard",
      bloops: findBloopSpans(t, "blooper"),
    });
    let cursor = 0;
    for (const s of cut) {
      expect(s.srcIn).toBeCloseTo(cursor, 9);
      cursor = s.srcOut;
    }
    expect(cursor).toBeCloseTo(duration, 9);
    const map = new TimeMap(cut);
    const kept = cut.filter((s) => s.kind === "keep").reduce((a, s) => a + (s.srcOut - s.srcIn), 0);
    expect(map.outputDuration).toBeCloseTo(kept, 9);
  });

  it("splits the surrounding keep in three — the interior case --clip cannot do", () => {
    const cut = buildCutlist({
      transcript: t,
      analysis: NO_ANALYSIS,
      duration,
      level: "standard",
      bloops: findBloopSpans(t, "blooper"),
    });
    expect(cut.map((s) => s.kind)).toEqual(["keep", "remove", "keep"]);
  });

  it("the flubbed words are gone from output time, the good take survives", () => {
    const bloops = findBloopSpans(t, "blooper");
    const map = new TimeMap(
      buildCutlist({ transcript: t, analysis: NO_ANALYSIS, duration, level: "standard", bloops }),
    );
    const survives = (word: string): boolean => {
      const w = t.words.find((x) => x.text === word)!;
      return map.mapWord(w) !== null;
    };
    expect(survives("issues."), "the sentence before the flub").toBe(true);
    expect(survives("condition."), "the good take after it").toBe(true);
    expect(survives("blooper."), "the marker itself").toBe(false);
  });

  it("changes nothing when no marker was passed", () => {
    const withOut = buildCutlist({ transcript: t, analysis: NO_ANALYSIS, duration, level: "standard" });
    expect(withOut).toEqual([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
  });

  it("--cleanup exact still means exact, even with a marker", () => {
    // "Touch nothing" outranks a flag asking for a cut; they contradict, and
    // the more conservative one wins rather than the one typed last.
    const cut = buildCutlist({
      transcript: t,
      analysis: NO_ANALYSIS,
      duration,
      level: "exact",
      bloops: findBloopSpans(t, "blooper"),
    });
    expect(cut).toEqual([{ srcIn: 0, srcOut: duration, kind: "keep" }]);
  });
});
