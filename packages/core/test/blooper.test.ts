import { describe, expect, it } from "vitest";
import { findBloopSpans, formatBloopSpan } from "../src/blooper";
import { buildCutlist } from "../src/cutlist";
import { TimeMap } from "../src/timemap";
import type { Analysis, Span, Transcript, Word } from "../src/schema";

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

/**
 * 2026-08-16 incident (output ~10:02): whisper's stamp-stretch (§18) put the
 * stamped end of the spoken "blooper." at 670.0 while the audio ran to
 * ~670.4 — proven by the bracketing silences 668.09–669.3 and 670.4–671.68 —
 * so 0.4s of audible "blooper" leaked past the cut, plus a debris "And"
 * whisper stamped over the tail. The `silences` argument lets the span end
 * extend through the marker's own trailing dead air (MAX_MARKER_BLEED_SEC).
 * The fixture also doubles as the clip-run offset case: word stamps sit deep
 * in source time (66x s) exactly like a sliced transcript, whose words keep
 * SOURCE seconds — full-source silences are the correct pairing at both
 * produce.ts call sites.
 */
describe("findBloopSpans: end bleed through trailing silence (2026-08-16 incident)", () => {
  const incidentWords: Word[] = [
    { text: "Keep", start: 665.0, end: 665.4 },
    { text: "this.", start: 665.4, end: 666.0 },
    { text: "That", start: 666.0, end: 666.5 },
    { text: "was", start: 666.5, end: 667.0 },
    { text: "wrong", start: 667.0, end: 668.09 },
    // Stamped end 670.0; acoustic end ~670.4 — the leak.
    { text: "blooper.", start: 669.3, end: 670.0 },
    // Debris whisper stamped over the marker's acoustic tail.
    { text: "And", start: 670.0, end: 670.4 },
    { text: "the", start: 671.68, end: 672.0 },
    { text: "good", start: 672.0, end: 672.4 },
    { text: "take.", start: 672.4, end: 673.0 },
  ];
  const incident: Transcript = { language: "en", words: incidentWords };
  const incidentSilences: Span[] = [
    { start: 668.09, end: 669.3 },
    { start: 670.4, end: 671.68 },
  ];

  it("incident numbers, exact: stamped end 670.0 extends through the 670.4–671.68 silence to 671.68", () => {
    const spans = findBloopSpans(incident, "blooper", incidentSilences);
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.startSec).toBe(666.0);
    expect(s.endSec).toBe(671.68);
    // The debris "And" (670.0–670.4) now sits INSIDE the cut seconds even
    // though it is past endWord — the seconds are what buildCutlist removes.
    expect(s.endWord).toBe(5);
  });

  it("does not absorb a silence past the bleed window", () => {
    // Same shape, but the trailing silence starts 0.76s after the stamped
    // end — past MAX_MARKER_BLEED_SEC (0.75). A pause that far out is the
    // gap before the NEXT take, not the marker's own tail.
    const far: Span[] = [{ start: 670.76, end: 671.68 }];
    const [s] = findBloopSpans(incident, "blooper", far);
    expect(s!.endSec).toBe(670.0);
  });

  it("chains through consecutive silences when each lands inside the extended window", () => {
    // Absorbing the first silence brings the second within the 0.75s bleed
    // window of the NEW end — the extension must re-scan, not single-pass.
    const chained: Span[] = [
      { start: 670.4, end: 671.0 },
      { start: 671.5, end: 672.3 },
    ];
    const [s] = findBloopSpans(incident, "blooper", chained);
    expect(s!.endSec).toBe(672.3);
  });

  it("behaves byte-identically to today when no silences are passed", () => {
    expect(findBloopSpans(incident, "blooper", [])).toEqual(findBloopSpans(incident, "blooper"));
    const [s] = findBloopSpans(incident, "blooper");
    expect(s!.endSec).toBe(670.0);
  });

  it("merges a following attempt whose sentence start sits at or before the EXTENDED end (seconds, not word indices)", () => {
    // The debris word ends its own "sentence" ("And."), so the next
    // attempt's walk-back stops AFTER it — the spans are not word-index
    // adjacent, and only the extended endSec (11.0, through the 10.4–11.0
    // silence) reaches the second attempt's first word at 11.0.
    const words: Word[] = [
      { text: "Wrong", start: 9.0, end: 9.5 },
      { text: "blooper.", start: 9.5, end: 10.0 },
      { text: "And.", start: 10.0, end: 10.4 },
      { text: "Also", start: 11.0, end: 11.4 },
      { text: "bad", start: 11.4, end: 11.8 },
      { text: "blooper.", start: 11.8, end: 12.3 },
      { text: "Good.", start: 13.5, end: 14.0 },
    ];
    const t: Transcript = { language: "en", words };
    const silences: Span[] = [{ start: 10.4, end: 11.0 }];
    const spans = findBloopSpans(t, "blooper", silences);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.markers).toBe(2);
    expect(spans[0]!.startWord).toBe(0);
    expect(spans[0]!.endWord).toBe(5);
    // Without the silence, the same transcript stays two separate spans —
    // the seconds arm never fires on unextended ends here, so the old
    // word-adjacency behavior is untouched.
    expect(findBloopSpans(t, "blooper")).toHaveLength(2);
  });
});

describe("findBloopSpans: walk-back cap (MAX_WALKBACK_SEC)", () => {
  it("caps an unpunctuated backscan at 30s, flags the span, and the report line shouts", () => {
    // 70 words with no terminal punctuation anywhere — an ASR run-on. The
    // scan must stop ~30s back from the marker's end instead of eating the
    // whole take back to word 0.
    const t = speak("la ".repeat(70).trim() + " blooper.");
    const [span, ...rest] = findBloopSpans(t, "blooper");
    expect(rest).toEqual([]);
    expect(span!.truncated).toBe(true);
    expect(span!.startWord).toBeGreaterThan(0);
    // The span's own extent respects the cap.
    expect(span!.endSec - span!.startSec).toBeLessThanOrEqual(30);
    expect(formatBloopSpan(t, span!)).toContain(
      "(walk-back capped at 30s — unpunctuated stretch; check this cut)",
    );
  });

  it("an ordinary punctuated flub is not flagged", () => {
    const t = speak("This is fine. I meant to say something else blooper. This is the good take.");
    const [span] = findBloopSpans(t, "blooper");
    expect(span!.truncated).toBeUndefined();
    expect(formatBloopSpan(t, span!)).not.toContain("capped");
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
