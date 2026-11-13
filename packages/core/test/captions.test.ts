import { describe, expect, it } from "vitest";
import {
  backfillSrcStart,
  buildCaptionLines,
  CAPTION_THEME_IDS,
  captionKeyFor,
  captionPackingFor,
  captionsNeedNastaliq,
  CaptionThemeIdSchema,
  enforceLineDwell,
  lineDirection,
  MAX_CAPTION_WORD_LEAD_SEC,
  MIN_CAPTION_LINE_DWELL_SEC,
  type CaptionChoreography,
  type CaptionLine,
} from "../src/captions";
import {
  applyCaptionEdits,
  applyCaptionRangeEdits,
  applyCaptionWordHides,
} from "../src/overrides";
import { TimeMap, type KeptSpan } from "../src/timemap";
import type { Segment, Transcript } from "../src/schema";

describe("buildCaptionLines", () => {
  const identity = (duration: number): TimeMap =>
    new TimeMap([{ srcIn: 0, srcOut: duration, kind: "keep" } satisfies Segment]);

  it("groups words into lines of at most maxWords", () => {
    const transcript: Transcript = {
      language: "en",
      words: Array.from({ length: 7 }, (_, i) => ({
        text: `w${i}`,
        start: i * 0.3,
        end: i * 0.3 + 0.25,
      })),
    };
    const lines = buildCaptionLines(transcript, identity(3), { maxWordsPerLine: 3 });
    expect(lines.map((l) => l.words.length)).toEqual([3, 3, 1]);
  });

  it("starts a new line after a long speech gap", () => {
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "a", start: 0, end: 0.2 },
        { text: "b", start: 1.5, end: 1.7 }, // 1.3 s gap > default 0.6
      ],
    };
    const lines = buildCaptionLines(transcript, identity(2));
    expect(lines).toHaveLength(2);
  });

  it("drops words that were cut and re-times survivors into output time", () => {
    const cutlist: Segment[] = [
      { srcIn: 0, srcOut: 1, kind: "keep" },
      { srcIn: 1, srcOut: 3, kind: "remove", reason: "filler" },
      { srcIn: 3, srcOut: 4, kind: "keep" },
    ];
    const map = new TimeMap(cutlist);
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "kept", start: 0.2, end: 0.8 },
        { text: "um", start: 1.5, end: 2.5 }, // fully removed
        { text: "also", start: 3.2, end: 3.8 },
      ],
    };
    const lines = buildCaptionLines(transcript, map);
    const texts = lines.flatMap((l) => l.words.map((w) => w.text));
    expect(texts).toEqual(["kept", "also"]);
    const also = lines.flatMap((l) => l.words).find((w) => w.text === "also")!;
    expect(also.start).toBeCloseTo(1.2, 6); // 3.2 source − 2 s removed
  });

  it("splits lines at scene boundaries and clamps holds to them (FINDINGS §6b)", () => {
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "before", start: 0.0, end: 0.4 },
        { text: "after", start: 0.6, end: 1.0 }, // scene boundary at 0.5 sits between them
      ],
    };
    const lines = buildCaptionLines(transcript, identity(3), { breakpoints: [0.5] });
    expect(lines).toHaveLength(2); // would be one line without the boundary
    expect(lines[0]!.end).toBeLessThanOrEqual(0.5 + 1e-9); // hold clamped at the boundary
    expect(lines[1]!.start).toBeCloseTo(0.6, 6);
  });

  it("6-word landscape packing still flushes at graphic-cue boundaries (2026-08-16 v2 review)", () => {
    // Six words that would pack into ONE line under {maxWordsPerLine: 6,
    // maxLineDuration: 2.4} — the landscape options — with a graphic-cue
    // boundary between words 3 and 4. Wider packing raises how often a line
    // COULD span a boundary, so the §6b flush must keep winning: a line
    // crossing a layout change sits in the wrong layout's caption band.
    const transcript: Transcript = {
      language: "en",
      words: Array.from({ length: 6 }, (_, i) => ({
        text: `w${i}`,
        start: i * 0.3,
        // Short words so none physically SPANS the 0.8s boundary — a word
        // that does stays readable past it by design (the flush-time clamp's
        // own single-word rule), which is not what this test is pinning.
        end: i * 0.3 + 0.15,
      })),
    };
    const opts = { maxWordsPerLine: 6, maxLineDuration: 2.4 };
    // Without the boundary the six words are one line — the packing works…
    expect(buildCaptionLines(transcript, identity(3), opts)).toHaveLength(1);
    // …and with it they split there, hold clamped, exactly as at 3 words.
    const lines = buildCaptionLines(transcript, identity(3), { ...opts, breakpoints: [0.8] });
    expect(lines.map((l) => l.words.length)).toEqual([3, 3]);
    expect(lines[0]!.end).toBeLessThanOrEqual(0.8 + 1e-9);
  });

  describe("MAX_CAPTION_WORD_LEAD_SEC — §18 stamp-stretch clamp (field case 2026-08-17)", () => {
    // The incident's shape: 21s of played-back video audio (no speech, so no
    // silence to cut) stamped into "Okay,"'s interval by whisper's contiguous
    // stamps. Its stamped start smeared back to ~100 while it was spoken near
    // 121.5 — the END stamp is the acoustic truth.
    const incident: Transcript = {
      language: "en",
      words: [
        { text: "before,", start: 99.5, end: 100 },
        { text: "Okay,", start: 100, end: 121.5 },
      ],
    };

    it("clamps the display start toward the end stamp, and the packer breaks the line at the clamped gap", () => {
      const lines = buildCaptionLines(incident, identity(122));
      // Clamped gap 19.5s > 0.6 maxGap → the stretched word gets its own line,
      // so nothing renders during the dead span.
      expect(lines).toHaveLength(2);
      const okay = lines[1]!;
      expect(okay.start).toBeCloseTo(120, 6); // 121.5 − 1.5, not the stamped 100
      // The previous line does NOT stretch to fill: hold only (100 + 0.35),
      // and 0.85s already clears the dwell floor so nothing extends it.
      expect(lines[0]!.end).toBeCloseTo(100.35, 6);
      // Nothing on screen in (100.35, 120).
      expect(lines[0]!.end).toBeLessThanOrEqual(100.35 + 1e-9);
      expect(okay.start).toBeGreaterThanOrEqual(120 - 1e-9);
    });

    it("karaoke word timing uses the clamped start — the highlight cannot precede its line", () => {
      const lines = buildCaptionLines(incident, identity(122));
      const okay = lines[1]!.words[0]!;
      expect(okay.start).toBeCloseTo(120, 6);
      expect(okay.start).toBeGreaterThanOrEqual(lines[1]!.start - 1e-9);
      // The §137 anchor keeps the RAW source stamp — a caption edit made
      // before this clamp existed still keys to the same word.
      expect(okay.srcStart).toBe(100);
    });

    it("leaves a stamp of exactly MAX_CAPTION_WORD_LEAD_SEC untouched", () => {
      const transcript: Transcript = {
        language: "en",
        words: [{ text: "slow", start: 10, end: 10 + MAX_CAPTION_WORD_LEAD_SEC }],
      };
      const word = buildCaptionLines(transcript, identity(13))[0]!.words[0]!;
      expect(word.start).toBe(10); // max(10, 12 − 2) — the boundary is inclusive
    });

    it("clamps a 2.43s revived-retake smear to 1.5s ending on its true end (field case 2026-08-26)", () => {
      // `dedicated`, stamped 51.42→53.85 inside a revived retake: the pause
      // after it was absorbed into the word. Under the old 2.0 bar this still
      // displayed for a full 2.0s — the smear SLIPPED UNDER it, which is what
      // moved the constant to 1.5.
      const transcript: Transcript = {
        language: "en",
        words: [{ text: "dedicated", start: 51.42, end: 53.85 }],
      };
      const word = buildCaptionLines(transcript, identity(60))[0]!.words[0]!;
      expect(word.end).toBeCloseTo(53.85, 6); // the trustworthy edge, untouched
      expect(word.end - word.start).toBeCloseTo(1.5, 6);
      expect(word.srcStart).toBe(51.42); // §137 anchor keeps the RAW stamp
    });

    it("leaves an ordinary 0.4s word alone — the tighter bar cannot truncate real speech", () => {
      const transcript: Transcript = {
        language: "en",
        words: [{ text: "ordinary", start: 3, end: 3.4 }],
      };
      const word = buildCaptionLines(transcript, identity(6))[0]!.words[0]!;
      expect(word.start).toBe(3);
      expect(word.end).toBe(3.4);
    });

    it("changes NOTHING for normal sub-1.5s stamps — the 7-word fixture's full result is pinned", () => {
      // Byte-for-byte pin of the pre-clamp output (same expressions the
      // fixture uses, so float identity holds): any drift in an ordinary
      // transcript means the clamp leaked past the stretched-stamp case.
      const transcript: Transcript = {
        language: "en",
        words: Array.from({ length: 7 }, (_, i) => ({
          text: `w${i}`,
          start: i * 0.3,
          end: i * 0.3 + 0.25,
        })),
      };
      const word = (i: number) => ({
        text: `w${i}`,
        start: i * 0.3,
        end: i * 0.3 + 0.25,
        srcStart: i * 0.3,
      });
      expect(buildCaptionLines(transcript, identity(3), { maxWordsPerLine: 3 })).toEqual([
        // Holds clamp to the next line's start (3·0.3, 6·0.3); both of those
        // windows are 0.9s, already past the dwell floor, so they are the
        // pre-clamp values verbatim.
        { words: [word(0), word(1), word(2)], start: 0 * 0.3, end: 3 * 0.3 },
        { words: [word(3), word(4), word(5)], start: 3 * 0.3, end: 6 * 0.3 },
        // The last line's hold gives it 0.6s — under MIN_CAPTION_LINE_DWELL_SEC
        // — and with no neighbour it takes the floor outright, still inside the
        // 3s output duration.
        { words: [word(6)], start: 6 * 0.3, end: 6 * 0.3 + MIN_CAPTION_LINE_DWELL_SEC },
      ]);
    });
  });

  it("never extends a line past the next line or the output end", () => {
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "a", start: 0, end: 0.2 },
        { text: "b", start: 1.5, end: 1.9 },
      ],
    };
    const map = identity(2);
    const lines = buildCaptionLines(transcript, map);
    expect(lines[0]!.end).toBeLessThanOrEqual(lines[1]!.start + 1e-9);
    expect(lines[lines.length - 1]!.end).toBeLessThanOrEqual(map.outputDuration + 1e-9);
  });

  it("repairs the whole revived-retake shape end to end (field case 2026-08-26)", () => {
    // The measured shape, in one transcript: a smeared word (a 2.43s stamp
    // that absorbed the pause after it), then ten words crammed into 0.25s,
    // then ordinary speech. Zero gaps between them, as whisper's contiguous
    // stamps always give (§18).
    const words = [
      { text: "dedicated", start: 10, end: 12.43 },
      ..."context could read 50 files and then gives a clean".split(" ").map((text, i) => ({
        text,
        start: 12.43 + i * 0.025,
        end: 12.43 + (i + 1) * 0.025,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        text: `n${i}`,
        start: 13.5 + i * 0.5,
        end: 13.5 + i * 0.5 + 0.4,
      })),
    ];
    const map = identity(20);
    const lines = buildCaptionLines({ language: "en", words }, map);

    // No word squats: every display window is inside the lead clamp.
    for (const w of lines.flatMap((l) => l.words)) {
      expect(w.end - w.start).toBeLessThanOrEqual(MAX_CAPTION_WORD_LEAD_SEC + 1e-9);
    }
    // Every line either clears the dwell floor or is GAP-STARVED — there was
    // no slack after it to take. Those are the only two honest outcomes: the
    // display cannot slow the speech down.
    const starved = lines.map((line, i) => {
      const cap = lines[i + 1]?.start ?? map.outputDuration;
      return line.end >= cap - 1e-9;
    });
    lines.forEach((line, i) => {
      expect(
        line.end - line.start >= MIN_CAPTION_LINE_DWELL_SEC - 1e-9 || starved[i],
      ).toBe(true);
    });
    // …and the burst really does exercise BOTH arms: some of its lines are
    // starved flashes, and the one that finally has a gap in front of the
    // normal speech takes the floor.
    expect(
      lines.some((l, i) => starved[i] && l.end - l.start < MIN_CAPTION_LINE_DWELL_SEC - 1e-9),
    ).toBe(true);
    expect(lines.some((l) => Math.abs(l.end - l.start - MIN_CAPTION_LINE_DWELL_SEC) < 1e-9)).toBe(
      true,
    );
    // Windows stay ordered and non-overlapping (§115).
    for (let i = 0; i + 1 < lines.length; i++) {
      expect(lines[i]!.end).toBeLessThanOrEqual(lines[i + 1]!.start + 1e-9);
    }
  });
});

describe("enforceLineDwell — MIN_CAPTION_LINE_DWELL_SEC (field case 2026-08-26)", () => {
  /** A line whose words are irrelevant to the sweep — it never reads them. */
  const line = (start: number, end: number, text = "w"): CaptionLine => ({
    words: [{ text, start, end, srcStart: start }],
    start,
    end,
  });

  it("extends a flash line into the following gap, to exactly the floor", () => {
    const [first] = enforceLineDwell([line(0, 0.06), line(5, 5.5)]);
    expect(first!.end).toBeCloseTo(MIN_CAPTION_LINE_DWELL_SEC, 9);
  });

  it("never extends past the next line's start — no overlap, no reorder (§115)", () => {
    const out = enforceLineDwell([line(0, 0.06), line(0.4, 0.9)]);
    expect(out[0]!.end).toBe(0.4);
    expect(out[0]!.end).toBeLessThanOrEqual(out[1]!.start);
  });

  it("leaves a zero-gap flash run alone — the display cannot slow speech down", () => {
    // The 98%-zero-gap case measured on the field transcript: no slack exists,
    // so the sweep must return the run untouched rather than push lines later.
    const run = [line(0, 0.06), line(0.06, 0.12), line(0.12, 0.18), line(0.18, 5)];
    const out = enforceLineDwell(run);
    expect(out).toEqual(run);
    expect(out[0]).toBe(run[0]); // verbatim, not a rebuilt copy
  });

  it("extends the LAST line free of any neighbour, still capped by maxEnd", () => {
    expect(enforceLineDwell([line(0, 0.06)])[0]!.end).toBeCloseTo(MIN_CAPTION_LINE_DWELL_SEC, 9);
    // No frames past the output end to draw a caption over.
    expect(enforceLineDwell([line(0, 0.06)], { maxEnd: 0.3 })[0]!.end).toBe(0.3);
  });

  it("stops at the next breakpoint — readability never moves a line into the wrong layout band (§6b)", () => {
    const out = enforceLineDwell([line(0, 0.06), line(5, 5.5)], { breakpoints: [0.2] });
    expect(out[0]!.end).toBe(0.2);
  });

  it("returns lines that already clear the floor VERBATIM", () => {
    const ok = [line(0, 0.9), line(1, 2)];
    const out = enforceLineDwell(ok);
    expect(out[0]).toBe(ok[0]);
    expect(out[1]).toBe(ok[1]);
  });

  it("leaves the karaoke word stamps of an extended line byte-unchanged", () => {
    // The dwell is the LINE's window. Stretching the last word's highlight to
    // fill it would just reproduce the stuck-highlight bug one layer down.
    const original = line(0, 0.06, "flash");
    const words = original.words;
    const out = enforceLineDwell([original, line(5, 5.5)]);
    expect(out[0]!.end).not.toBe(original.end); // it really was extended…
    expect(out[0]!.words).toBe(words); // …and the stamps are the same array
    expect(out[0]!.words[0]).toEqual({ text: "flash", start: 0, end: 0.06, srcStart: 0 });
  });

  it("is monotone: no line's START ever moves, so a later line is never pushed", () => {
    const lines = [line(0, 0.06), line(0.5, 0.56), line(2, 2.05)];
    const out = enforceLineDwell(lines);
    expect(out.map((l) => l.start)).toEqual(lines.map((l) => l.start));
    // Line 0 is capped by its neighbour (0.5), line 1 has the gap to take the
    // whole floor, line 2 is last — and none of that moved any start.
    expect(out[0]!.end).toBe(0.5);
    expect(out[1]!.end).toBeCloseTo(0.5 + MIN_CAPTION_LINE_DWELL_SEC, 9);
    expect(out[2]!.end).toBeCloseTo(2 + MIN_CAPTION_LINE_DWELL_SEC, 9);
  });
});

describe("CaptionWord.srcStart (§137)", () => {
  it("carries the SOURCE start, not the output start, so a re-cut cannot move it", () => {
    // One kept span starting 2.0s into the source: output 0 === source 2.0.
    // TimeMap's constructor takes a cutlist of `Segment`s and derives the
    // output side itself — only `kind: "keep"` spans contribute to it.
    const map = new TimeMap([{ srcIn: 2, srcOut: 5, kind: "keep" } satisfies Segment]);
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "alpha", start: 2.5, end: 2.9 },
        { text: "beta", start: 3.5, end: 3.9 },
      ],
    };

    const words = buildCaptionLines(transcript, map).flatMap((l) => l.words);

    expect(words.map((w) => w.text)).toEqual(["alpha", "beta"]);
    // output times are shifted by the cut...
    expect(words[0]!.start).toBeCloseTo(0.5, 3);
    // ...the source anchor is not.
    expect(words[0]!.srcStart).toBeCloseTo(2.5, 3);
    expect(words[1]!.srcStart).toBeCloseTo(3.5, 3);
  });
});

describe("backfillSrcStart (§137 — render-props.json predates the field)", () => {
  // A legacy file's words carry only {text,start,end}; the cast the editor
  // loads render props through would let them past the type unchallenged.
  const legacyLine = (words: { text: string; start: number; end: number }[]): CaptionLine =>
    ({ start: words[0]!.start, end: words[words.length - 1]!.end, words }) as unknown as CaptionLine;

  it("recovers the source start the file's own spans imply", () => {
    // The same 2.0s-in kept span, in the form render-props.json stores it.
    const spans: KeptSpan[] = [{ srcIn: 2, srcOut: 5, outIn: 0, outOut: 3 }];
    const lines = [legacyLine([{ text: "alpha", start: 0.5, end: 0.9 }])];

    const out = backfillSrcStart(lines, spans);

    expect(out[0]!.words[0]!.srcStart).toBeCloseTo(2.5, 6);
    expect(out[0]!.words[0]!.start).toBeCloseTo(0.5, 6); // output timing untouched
  });

  it("leaves an already-migrated line alone rather than recomputing it", () => {
    // `srcStart` may have come from a map these spans no longer describe, so a
    // present value wins over anything projection would say (here: 9, not 2.5).
    const spans: KeptSpan[] = [{ srcIn: 2, srcOut: 5, outIn: 0, outOut: 3 }];
    const lines: CaptionLine[] = [
      { start: 0.5, end: 0.9, words: [{ text: "alpha", start: 0.5, end: 0.9, srcStart: 9 }] },
    ];

    const out = backfillSrcStart(lines, spans);

    expect(out[0]!.words[0]!.srcStart).toBe(9);
    expect(out[0]!.words[0]).toBe(lines[0]!.words[0]); // same object, not a copy
  });

  it("fills only the missing words in a MIXED line, never re-deriving a real anchor", () => {
    // A half-migrated file (one produce run wrote the field, an older one did
    // not) falls past the document-wide short-circuit, so the per-word guard is
    // the only thing standing between a real anchor and projection silently
    // overwriting it. `alpha` carries 9, which these spans would NEVER produce
    // — projection says 2.5 — so a recompute is visible rather than plausible.
    const spans: KeptSpan[] = [{ srcIn: 2, srcOut: 5, outIn: 0, outOut: 3 }];
    const migrated = { text: "alpha", start: 0.5, end: 0.9, srcStart: 9 };
    const lines = [
      { start: 0.5, end: 1.9, words: [migrated, { text: "beta", start: 1.5, end: 1.9 }] },
    ] as unknown as CaptionLine[];

    const out = backfillSrcStart(lines, spans);

    expect(out[0]!.words[0]!.srcStart).toBe(9); // survives, un-recomputed
    expect(out[0]!.words[0]).toBe(migrated); // and byte-identical: the same object
    expect(out[0]!.words[1]!.srcStart).toBeCloseTo(3.5, 6); // the gap is filled
  });

  it("projects a word in the SECOND kept span, not just the first", () => {
    // Two spans with a 5s hole between them: a hardcoded `spans[0]` would say
    // 5.5 here, and single-span fixtures alone could never tell the difference.
    const spans: KeptSpan[] = [
      { srcIn: 2, srcOut: 5, outIn: 0, outOut: 3 },
      { srcIn: 10, srcOut: 12, outIn: 3, outOut: 5 },
    ];
    const lines = [legacyLine([{ text: "later", start: 3.5, end: 3.9 }])];

    expect(backfillSrcStart(lines, spans)[0]!.words[0]!.srcStart).toBeCloseTo(10.5, 6);
  });

  it("survives an empty spans array instead of throwing on a truncated file", () => {
    const out = backfillSrcStart([legacyLine([{ text: "alpha", start: 0.5, end: 0.9 }])], []);
    expect(out[0]!.words[0]!.srcStart).toBe(0); // no spans: nothing to project onto
  });
});

describe("lineDirection — first-strong-character heuristic (UAX #9 P2/P3)", () => {
  it("resolves a pure Urdu line RTL", () => {
    expect(lineDirection("یہ ایک ٹاپک ہے")).toBe("rtl");
  });

  it("resolves a pure English line LTR", () => {
    expect(lineDirection("this is a topic")).toBe("ltr");
  });

  // The Urdu field transcript (2026-08-05) code-switches: a line opening with
  // a Latin loanword resolves by its FIRST STRONG character — LTR — which is
  // the standard bidi answer, not the language code's.
  it("resolves a leading-Latin code-switched Urdu line LTR", () => {
    expect(lineDirection("Fulfillment کیا ہے")).toBe("ltr");
  });

  it("skips digits and punctuation, which are bidi-weak/neutral", () => {
    expect(lineDirection("2026 میں یہ")).toBe("rtl");
    expect(lineDirection('"یہ"')).toBe("rtl");
    expect(lineDirection("2026: a year")).toBe("ltr");
  });

  it("defaults LTR when no strong character exists", () => {
    expect(lineDirection("123 456!")).toBe("ltr");
  });

  it("resolves Hebrew RTL too, not just Arabic script", () => {
    expect(lineDirection("שלום עולם")).toBe("rtl");
  });
});

describe("captionsNeedNastaliq — the ONE font-staging predicate (2026-08-17)", () => {
  const line = (...texts: string[]): CaptionLine => ({
    words: texts.map((text, i) => ({ text, start: i, end: i + 0.5, srcStart: i })),
    start: 0,
    end: texts.length,
  });

  it("false for a pure-Latin caption set — those renders must stay byte-identical", () => {
    expect(captionsNeedNastaliq([])).toBe(false);
    expect(captionsNeedNastaliq([line("this", "is", "a"), line("topic")])).toBe(false);
  });

  it("true when ANY line lays out RTL, even one among Latin lines", () => {
    expect(captionsNeedNastaliq([line("this", "is"), line("یہ", "ایک")])).toBe(true);
  });

  it("agrees with lineDirection on the code-switched edge — a leading-Latin line is LTR", () => {
    // Same first-strong rule per line: if lineDirection says LTR, this must
    // not stage a font that line will never ask for.
    expect(captionsNeedNastaliq([line("Fulfillment", "کیا", "ہے")])).toBe(
      lineDirection("Fulfillment کیا ہے") === "rtl",
    );
  });
});

describe("CaptionThemeIdSchema & AI CaptionChoreography in buildCaptionLines", () => {
  const identity = (duration: number): TimeMap =>
    new TimeMap([{ srcIn: 0, srcOut: duration, kind: "keep" } satisfies Segment]);

  it("exposes the 5 deterministic caption theme presets", () => {
    expect(CAPTION_THEME_IDS).toEqual(["default", "founder", "punch", "boxed", "minimal"]);
    for (const id of CAPTION_THEME_IDS) {
      expect(CaptionThemeIdSchema.safeParse(id).success).toBe(true);
    }
    expect(CaptionThemeIdSchema.safeParse("unknown-theme").success).toBe(false);
  });

  it("captionPackingFor includes choreographed safety ceilings alongside standard limits", () => {
    expect(captionPackingFor(false)).toEqual({
      maxWordsPerLine: 3,
      maxLineDuration: 1.2,
      maxChoreographedWords: 5,
      maxChoreographedDuration: 2.2,
    });
    expect(captionPackingFor(true)).toEqual({
      maxWordsPerLine: 6,
      maxLineDuration: 2.4,
      maxChoreographedWords: 8,
      maxChoreographedDuration: 3.2,
    });
  });

  it("packs semantic phrases up to 5 words in portrait when choreography is supplied, attaching emphasisScale and role", () => {
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "We", start: 0.0, end: 0.25 },
        { text: "shipped", start: 0.25, end: 0.55 },
        { text: "this", start: 0.55, end: 0.80 },
        { text: "in", start: 0.80, end: 1.00 },
        { text: "48h", start: 1.00, end: 1.40 },
        { text: "Now", start: 1.50, end: 1.80 },
        { text: "watch", start: 1.80, end: 2.20 },
      ],
    };
    const choreography: CaptionChoreography = {
      phrases: [
        { startSrcSec: 0.0, endSrcSec: 1.00, role: "hook" },
        { startSrcSec: 1.50, endSrcSec: 1.80, role: "impact" },
      ],
      words: {
        [captionKeyFor(1.0)]: { emphasisScale: 1.35 },
        [captionKeyFor(1.8)]: { emphasisScale: 1.25 },
      },
    };

    const lines = buildCaptionLines(transcript, identity(3), {
      ...captionPackingFor(false),
      choreography,
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]!.words.map((w) => w.text)).toEqual(["We", "shipped", "this", "in", "48h"]);
    expect(lines[0]!.role).toBe("hook");
    expect(lines[0]!.words[4]!.emphasisScale).toBe(1.35);
    expect(lines[0]!.words[0]!.emphasisScale).toBeUndefined();

    expect(lines[1]!.words.map((w) => w.text)).toEqual(["Now", "watch"]);
    expect(lines[1]!.role).toBe("impact");
    expect(lines[1]!.words[1]!.emphasisScale).toBe(1.25);
  });

  it("packs revived gap words outside choreographed phrases with standard unchoreographed limits and without merging into the next phrase", () => {
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "Hook", start: 0.0, end: 0.3 },
        { text: "one", start: 0.3, end: 0.6 },
        // Revived gap words at 1.0..2.2 (4 words that were originally cut)
        { text: "revived", start: 0.8, end: 1.0 },
        { text: "gap", start: 1.0, end: 1.2 },
        { text: "words", start: 1.2, end: 1.4 },
        { text: "extra", start: 1.4, end: 1.6 },
        // Second choreographed phrase starting at 2.0
        { text: "Final", start: 1.8, end: 2.1 },
        { text: "impact", start: 2.1, end: 2.5 },
      ],
    };
    const choreography: CaptionChoreography = {
      phrases: [
        { startSrcSec: 0.0, endSrcSec: 0.3, role: "hook" },
        { startSrcSec: 1.8, endSrcSec: 2.1, role: "impact" },
      ],
      words: {},
    };

    const lines = buildCaptionLines(transcript, identity(4), {
      ...captionPackingFor(false),
      choreography,
    });

    // Phrase 0: ["Hook", "one"] (role: "hook")
    // Revived gap: 4 words -> split at standard portrait maxWordsPerLine=3 into ["revived", "gap", "words"] and ["extra"] (role: undefined)
    // Phrase 1: ["Final", "impact"] (role: "impact")
    expect(lines.map((l) => l.words.map((w) => w.text))).toEqual([
      ["Hook", "one"],
      ["revived", "gap", "words"],
      ["extra"],
      ["Final", "impact"],
    ]);
    expect(lines.map((l) => l.role)).toEqual(["hook", undefined, undefined, "impact"]);
  });

  it("splits a choreographed phrase at a scene breakpoint or safety ceiling, keeping 'hook' only on the first sub-line when not split by a graphic breakpoint and dropping 'impact' when split", () => {
    const transcript: Transcript = {
      language: "en",
      words: [
        { text: "One", start: 0.0, end: 0.2 },
        { text: "two", start: 0.25, end: 0.45 },
        { text: "three", start: 0.6, end: 0.8 },
        { text: "four", start: 0.85, end: 1.05 },
        { text: "five", start: 1.1, end: 1.3 },
        { text: "six", start: 1.35, end: 1.55 },
      ],
    };
    const hookChoreo: CaptionChoreography = {
      phrases: [{ startSrcSec: 0.0, endSrcSec: 1.35, role: "hook" }],
      words: {},
    };
    // Safety ceiling splits 6-word hook phrase into 5 + 1; first sub-line keeps 'hook', second drops it
    const splitHook = buildCaptionLines(transcript, identity(2), {
      ...captionPackingFor(false),
      choreography: hookChoreo,
    });
    expect(splitHook.map((l) => l.words.length)).toEqual([5, 1]);
    expect(splitHook[0]!.role).toBe("hook");
    expect(splitHook[1]!.role).toBeUndefined();

    const impactChoreo: CaptionChoreography = {
      phrases: [{ startSrcSec: 0.0, endSrcSec: 0.85, role: "impact" }],
      words: {},
    };
    const splitImpact = buildCaptionLines(transcript, identity(2), {
      ...captionPackingFor(false),
      breakpoints: [0.5],
      choreography: impactChoreo,
    });
    expect(splitImpact[0]!.role).toBeUndefined();
    expect(splitImpact[1]!.role).toBeUndefined();
  });

  it("preserves emphasisScale and line.role across applyCaptionEdits, applyCaptionRangeEdits, and applyCaptionWordHides", () => {
    const baseLines: CaptionLine[] = [
      {
        start: 0.0,
        end: 1.2,
        role: "hook",
        words: [
          { text: "We", start: 0.0, end: 0.3, srcStart: 1.0 },
          { text: "uh", start: 0.3, end: 0.5, srcStart: 1.3 },
          { text: "shipped", start: 0.5, end: 0.9, srcStart: 1.5, emphasisScale: 1.35 },
          { text: "fast", start: 0.9, end: 1.2, srcStart: 1.9, emphasisScale: 1.2 },
        ],
      },
    ];

    // 1. Word retype preserves emphasisScale and line.role
    const retyped = applyCaptionEdits(baseLines, {
      [captionKeyFor(1.5)]: { text: "SHIPPED", was: "shipped" },
    }).lines;
    expect(retyped[0]!.role).toBe("hook");
    expect(retyped[0]!.words[2]!.text).toBe("SHIPPED");
    expect(retyped[0]!.words[2]!.emphasisScale).toBe(1.35);

    // 2. Word hide preserves line.role and remaining words' emphasisScale
    const afterHide = applyCaptionWordHides(retyped, {
      [captionKeyFor(1.3)]: { was: "uh" },
    }).lines;
    expect(afterHide[0]!.role).toBe("hook");
    expect(afterHide[0]!.words.map((w) => w.text)).toEqual(["We", "SHIPPED", "fast"]);
    expect(afterHide[0]!.words[1]!.emphasisScale).toBe(1.35);

    // 3. Equal-count range edit preserves emphasisScale and line.role
    const afterEqualRange = applyCaptionRangeEdits(afterHide, [
      {
        fromKey: captionKeyFor(1.5),
        toKey: captionKeyFor(1.9),
        text: "LAUNCHED NOW",
        was: "SHIPPED fast",
      },
    ]).lines;
    expect(afterEqualRange[0]!.role).toBe("hook");
    expect(afterEqualRange[0]!.words[1]!.text).toBe("LAUNCHED");
    expect(afterEqualRange[0]!.words[1]!.emphasisScale).toBe(1.35);
    expect(afterEqualRange[0]!.words[2]!.text).toBe("NOW");
    expect(afterEqualRange[0]!.words[2]!.emphasisScale).toBe(1.2);

    // 4. Count-changing range edit preserves line.role while minting unscaled replacement words
    const afterMergedRange = applyCaptionRangeEdits(afterHide, [
      {
        fromKey: captionKeyFor(1.5),
        toKey: captionKeyFor(1.9),
        text: "LAUNCHED",
        was: "SHIPPED fast",
      },
    ]).lines;
    expect(afterMergedRange[0]!.role).toBe("hook");
    expect(afterMergedRange[0]!.words.map((w) => w.text)).toEqual(["We", "LAUNCHED"]);
    expect(afterMergedRange[0]!.words[1]!.emphasisScale).toBeUndefined();
  });
});
