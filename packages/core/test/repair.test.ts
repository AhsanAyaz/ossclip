import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import type { LlmProvider } from "../src/producer/provider";
import {
  TranscriptRepairSchema,
  applyRepairs,
  reconcileCopy,
  repairTranscript,
} from "../src/producer/repair";
import { MockProvider } from "../src/producer/mock";
import { buildCaptionLines } from "../src/captions";
import { TimeMap } from "../src/timemap";
import type { Scene } from "../src/scene-schema";
import type { Transcript } from "../src/schema";

/** Contiguous stamps, exactly like whisper `-ml 1` output. */
function mk(words: string[], per = 0.5): Transcript {
  return {
    language: "en",
    words: words.map((text, i) => ({ text, start: i * per, end: (i + 1) * per })),
  };
}

/** The real §17 take: "code churn" came back as "coach and". */
const heardTake = mk(["our", "coach", "and", "went", "up", "861%"]);

describe("applyRepairs — accepts genuine mishearings", () => {
  it("repairs the observed 'coach and' → 'code churn'", () => {
    const { transcript, applied } = applyRepairs(heardTake, [
      { startWord: 1, endWord: 2, heard: "coach and", correction: "code churn" },
    ]);
    expect(transcript.words.map((w) => w.text)).toEqual([
      "our", "code", "churn", "went", "up", "861%",
    ]);
    expect(applied[0]).toMatchObject({ applied: true });
  });

  it("keeps the ASR's own measured boundaries when the word count is unchanged", () => {
    const { transcript } = applyRepairs(heardTake, [
      { startWord: 1, endWord: 2, heard: "coach and", correction: "code churn" },
    ]);
    // Timings are measurements, not guesses — they must survive untouched.
    expect(transcript.words[1]).toMatchObject({ start: 0.5, end: 1 });
    expect(transcript.words[2]).toMatchObject({ start: 1, end: 1.5 });
  });

  it("splits one word into two inside its own span when the count changes", () => {
    const t = mk(["our", "CodeChun", "doubled"]);
    const { transcript, applied } = applyRepairs(t, [
      { startWord: 1, endWord: 1, heard: "CodeChun", correction: "code churn" },
    ]);
    expect(applied[0]!.applied).toBe(true);
    expect(transcript.words.map((w) => w.text)).toEqual(["our", "code", "churn", "doubled"]);
    // Both new words live strictly inside the original [0.5, 1.0] window.
    expect(transcript.words[1]!.start).toBe(0.5);
    expect(transcript.words[2]!.end).toBe(1);
    expect(transcript.words[1]!.end).toBeGreaterThan(transcript.words[1]!.start);
    expect(transcript.words[2]!.start).toBe(transcript.words[1]!.end);
  });

  it("applies multiple repairs without index drift", () => {
    const t = mk(["the", "coach", "and", "rose", "and", "the", "text", "fell"]);
    const { transcript, applied } = applyRepairs(t, [
      { startWord: 1, endWord: 2, heard: "coach and", correction: "code churn" },
      { startWord: 6, endWord: 6, heard: "text", correction: "tax" },
    ]);
    expect(applied.every((a) => a.applied)).toBe(true);
    expect(transcript.words.map((w) => w.text)).toEqual([
      "the", "code", "churn", "rose", "and", "the", "tax", "fell",
    ]);
  });

  it("re-derives a slightly wrong index from the quoted text", () => {
    // The model quoted the right words but named index 3 instead of 1.
    const { transcript, applied } = applyRepairs(heardTake, [
      { startWord: 3, endWord: 4, heard: "coach and", correction: "code churn" },
    ]);
    expect(applied[0]).toMatchObject({ applied: true, startWord: 1, endWord: 2 });
    expect(transcript.words[1]!.text).toBe("code");
    expect(transcript.words[3]!.text).toBe("went");
  });

  it("word timings stay sorted and non-overlapping after every repair", () => {
    const { transcript } = applyRepairs(mk(["a", "CodeChun", "b", "text", "c"]), [
      { startWord: 1, endWord: 1, heard: "CodeChun", correction: "code churn" },
      { startWord: 3, endWord: 3, heard: "text", correction: "tax" },
    ]);
    for (let i = 1; i < transcript.words.length; i++) {
      expect(transcript.words[i]!.start).toBeGreaterThanOrEqual(transcript.words[i - 1]!.end - 1e-9);
      expect(transcript.words[i]!.end).toBeGreaterThan(transcript.words[i]!.start);
    }
  });
});

describe("applyRepairs — refuses everything that is not a mishearing", () => {
  const reject = (repair: Parameters<typeof applyRepairs>[1][number], t = heardTake) => {
    const { transcript, applied } = applyRepairs(t, [repair]);
    expect(applied[0]!.applied).toBe(false);
    expect(applied[0]!.rejected).toBeTruthy();
    expect(transcript.words.map((w) => w.text)).toEqual(t.words.map((w) => w.text));
    return applied[0]!.rejected!;
  };

  it("refuses a paraphrase that sounds nothing like the span", () => {
    expect(reject({ startWord: 1, endWord: 2, heard: "coach and", correction: "revenue" }))
      .toMatch(/sound|length/);
  });

  it("refuses censorship or tidying disguised as a repair", () => {
    expect(reject({ startWord: 3, endWord: 4, heard: "went up", correction: "increased" }))
      .toBeTruthy();
  });

  it("refuses a span it cannot find anywhere near the claimed index", () => {
    expect(reject({ startWord: 0, endWord: 1, heard: "totally absent", correction: "totally absend" }))
      .toMatch(/no span near/);
  });

  it("refuses an out-of-range span", () => {
    expect(reject({ startWord: 99, endWord: 100, heard: "coach and", correction: "code churn" }))
      .toMatch(/no span near/);
  });

  it("refuses an inverted span", () => {
    expect(reject({ startWord: 3, endWord: 1, heard: "coach and", correction: "code churn" }))
      .toMatch(/ends before/);
  });

  it("refuses a span long enough to be a rewrite", () => {
    const t = mk(["one", "two", "three", "four", "five", "six"]);
    expect(
      reject({ startWord: 0, endWord: 4, heard: "one two three four five", correction: "x" }, t),
    ).toMatch(/rewrite/);
  });

  it("refuses an empty correction — deleting words is not repairing them", () => {
    expect(reject({ startWord: 1, endWord: 1, heard: "coach", correction: "   " }))
      .toMatch(/empty/);
  });

  it("refuses a no-op", () => {
    expect(reject({ startWord: 1, endWord: 1, heard: "coach", correction: "coach" }))
      .toMatch(/identical/);
  });

  it("refuses the second of two overlapping repairs", () => {
    const { applied } = applyRepairs(heardTake, [
      { startWord: 1, endWord: 2, heard: "coach and", correction: "code churn" },
      { startWord: 2, endWord: 2, heard: "and", correction: "end" },
    ]);
    expect(applied[0]!.applied).toBe(true);
    expect(applied[1]!.rejected).toMatch(/overlaps/);
  });

  it("refuses a repair straddling a cut", () => {
    const { applied } = applyRepairs(
      heardTake,
      [{ startWord: 1, endWord: 2, heard: "coach and", correction: "code churn" }],
      { isCut: () => true },
    );
    expect(applied[0]!.rejected).toMatch(/cut/);
  });

  it("refuses a split that would make sub-frame words", () => {
    const t: Transcript = {
      language: "en",
      words: [{ text: "CodeChun", start: 0, end: 0.05 }],
    };
    const { applied } = applyRepairs(t, [
      { startWord: 0, endWord: 0, heard: "CodeChun", correction: "code churn" },
    ]);
    expect(applied[0]!.rejected).toMatch(/too short/);
  });
});

describe("repairTranscript", () => {
  it("is fail-soft: a throwing provider yields the raw transcript, not an error", async () => {
    const boom: LlmProvider = {
      name: "boom",
      usage: [],
      async complete<T>(): Promise<T> {
        throw new Error("provider exploded");
      },
    };
    const out = await repairTranscript(boom, heardTake);
    expect(out.error).toMatch(/exploded/);
    expect(out.applied).toEqual([]);
    expect(out.transcript.words).toEqual(heardTake.words);
  });

  it("the mock provider handles the repair call (offline path stays first-class)", async () => {
    const out = await repairTranscript(new MockProvider(), heardTake);
    expect(out.error).toBeUndefined();
    expect(out.applied).toEqual([]);
    expect(out.transcript.words).toEqual(heardTake.words);
  });

  it("drives a scripted provider end to end", async () => {
    const provider: LlmProvider = {
      name: "scripted",
      usage: [],
      async complete<T>(req: { schema: z.ZodType<T> }): Promise<T> {
        return req.schema.parse({
          repairs: [{ startWord: 1, endWord: 2, heard: "coach and", correction: "code churn" }],
        });
      },
    };
    const out = await repairTranscript(provider, heardTake);
    expect(out.transcript.words.map((w) => w.text)).toContain("churn");
  });

  it("an empty transcript needs no call", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: "counting",
      usage: [],
      async complete<T>(req: { schema: z.ZodType<T> }): Promise<T> {
        calls++;
        return req.schema.parse({ repairs: [] });
      },
    };
    await repairTranscript(provider, { language: "en", words: [] });
    expect(calls).toBe(0);
  });

  it("the schema caps how much of a take may be rewritten", () => {
    const many = Array.from({ length: 13 }, () => ({
      startWord: 0, endWord: 0, heard: "a", correction: "b",
    }));
    expect(TranscriptRepairSchema.safeParse({ repairs: many }).success).toBe(false);
  });
});

describe("reconcileCopy — the overlay and the captions must agree (§21)", () => {
  const scene = (props: Record<string, unknown>, endWord: number): Scene => ({
    id: "s0",
    anchor: { startWord: 0, endWord },
    layout: "video-top",
    component: "StatCard",
    props,
    overrides: {},
  });

  it("corrects the caption toward the graphic: 'text' → 'Tax'", () => {
    // The exact defect reported: graphic read "Orchestration Tax", caption
    // underneath read "Orchestration text".
    const t = mk(["the", "orchestration", "text", "is", "real"]);
    const { transcript, applied } = reconcileCopy(t, [
      scene({ label: "ORCHESTRATION TAX", value: "34%" }, 4),
    ]);
    // The label is ALL CAPS for the screen; the caption keeps speech casing.
    expect(transcript.words.map((w) => w.text)).toEqual([
      "the", "orchestration", "tax", "is", "real",
    ]);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ heard: "text", correction: "tax" });
  });

  it("keeps a capitalised word capitalised", () => {
    const t = mk(["The", "Text", "rose"]);
    const { transcript } = reconcileCopy(t, [scene({ label: "TAX" }, 2)]);
    expect(transcript.words[1]!.text).toBe("Tax");
  });

  it("never changes word count or timings — anchors stay valid", () => {
    const t = mk(["the", "orchestration", "text", "is", "real"]);
    const { transcript } = reconcileCopy(t, [scene({ label: "ORCHESTRATION TAX" }, 4)]);
    expect(transcript.words).toHaveLength(t.words.length);
    transcript.words.forEach((w, i) => {
      expect(w.start).toBe(t.words[i]!.start);
      expect(w.end).toBe(t.words[i]!.end);
    });
  });

  it("leaves stylised copy alone — shortening a word for the screen is editing", () => {
    // "SHIP" sounds like "shipped" and always will; rewriting the caption to
    // match would put a word in the speaker's mouth they never said.
    const t = mk(["we", "shipped", "it", "fast"]);
    const { transcript, applied } = reconcileCopy(t, [scene({ label: "SHIP IT", value: "1" }, 3)]);
    expect(applied).toEqual([]);
    expect(transcript.words.map((w) => w.text)).toEqual(["we", "shipped", "it", "fast"]);
  });

  it("leaves plurals and tenses alone", () => {
    const t = mk(["the", "agent", "helped"]);
    const { applied } = reconcileCopy(t, [scene({ label: "AGENTS", value: "3" }, 2)]);
    expect(applied).toEqual([]);
  });

  it("does not touch words outside the scene's own anchor span", () => {
    const t = mk(["text", "then", "later", "orchestration", "text"]);
    const { transcript } = reconcileCopy(t, [scene({ label: "TAX" }, 1)]);
    expect(transcript.words[4]!.text).toBe("text"); // outside the anchor
  });

  it("leaves a word the speaker genuinely says elsewhere alone", () => {
    // "tax" appears verbatim in the take, so "text" here is a real word choice.
    const t = mk(["tax", "and", "text", "differ"]);
    const { applied } = reconcileCopy(t, [scene({ label: "TAX" }, 3)]);
    expect(applied).toEqual([]);
  });

  it("end to end: the rendered caption spells the word the graphic spells", () => {
    // The §21 contradiction must be unreachable through the real pipeline —
    // repair, then reconcile, then the caption builder the renderer consumes.
    const raw = mk(["the", "orchestration", "text", "is", "brutal"]);
    const repaired = applyRepairs(raw, [
      { startWord: 2, endWord: 2, heard: "text", correction: "tax" },
    ]).transcript;
    const scenes = [scene({ label: "ORCHESTRATION TAX", value: "34%" }, 4)];
    const final = reconcileCopy(repaired, scenes).transcript;

    const map = new TimeMap([{ srcIn: 0, srcOut: 3, kind: "keep" }]);
    const captionWords = buildCaptionLines(final, map).flatMap((l) =>
      l.words.map((w) => w.text.toLowerCase()),
    );
    const labelTokens = String(scenes[0]!.props.label).toLowerCase().split(/\s+/);
    for (const token of labelTokens) {
      expect(captionWords, `caption must contain "${token}"`).toContain(token);
    }
    expect(captionWords).not.toContain("text");
  });
});
