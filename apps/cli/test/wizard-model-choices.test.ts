import { describe, expect, it } from "vitest";
import {
  CUSTOM_MODEL,
  bareWhisperModelName,
  whisperLanguagePrefill,
  whisperModelChoices,
} from "../src/interactive/produce-wizard";

/**
 * The modelDir → choices enumeration (Urdu field test 2026-08-05): a
 * downloaded fine-tune like ggml-medium-urdu.bin must be pickable from the
 * wizard by its bare name, the canonical .en trio must stay offered whether
 * or not downloaded, and a free-text escape must always exist. Since the
 * curated table gained downloadable fine-tunes (2026-08-17), those are
 * offered exactly like the canonicals — pickable before they're installed,
 * with their provenance note as the hint. Pure — no TTY, no filesystem.
 */
describe("whisperModelChoices", () => {
  it("empty dir: canonicals AND the curated fine-tune marked as needing download, plus the free-text escape", () => {
    const choices = whisperModelChoices([]);
    expect(choices.map((c) => c.value)).toEqual([
      "base.en", "small.en", "medium.en", "medium-urdu", CUSTOM_MODEL,
    ]);
    for (const c of choices.slice(0, 4)) {
      expect(c.hint).toContain("will need download");
    }
  });

  it("the curated entry carries its provenance note as the hint", () => {
    const urdu = whisperModelChoices([]).find((c) => c.value === "medium-urdu")!;
    expect(urdu.hint).toContain("Urdu fine-tune");
    expect(urdu.hint).toContain("will need download");
  });

  it("lists an installed fine-tune by its bare name and unmarks installed canonicals", () => {
    const choices = whisperModelChoices([
      "ggml-small.en.bin",
      "ggml-my-finetune.bin",
    ]);
    expect(choices.map((c) => c.value)).toEqual([
      "base.en", "small.en", "medium.en", "medium-urdu", "my-finetune", CUSTOM_MODEL,
    ]);
    const small = choices.find((c) => c.value === "small.en")!;
    expect(small.hint).not.toContain("will need download");
    const base = choices.find((c) => c.value === "base.en")!;
    expect(base.hint).toContain("will need download");
    const mine = choices.find((c) => c.value === "my-finetune")!;
    expect(mine.hint).toBe("installed");
  });

  it("an installed curated model is listed ONCE, unmarked, keeping its note", () => {
    const choices = whisperModelChoices(["ggml-medium-urdu.bin"]);
    const urdu = choices.filter((c) => c.value === "medium-urdu");
    expect(urdu).toHaveLength(1);
    expect(urdu[0]!.hint).toContain("Urdu fine-tune");
    expect(urdu[0]!.hint).not.toContain("will need download");
  });

  it("ignores files that are not ggml-*.bin models", () => {
    const choices = whisperModelChoices([
      ".DS_Store",
      "readme.txt",
      "ggml-my-finetune.bin.part", // an in-flight download is not a model
      "small.en.bin", // no ggml- prefix — not what produce.ts would resolve
      "ggml-", // degenerate name, no capture
    ]);
    expect(choices.map((c) => c.value)).toEqual([
      "base.en", "small.en", "medium.en", "medium-urdu", CUSTOM_MODEL,
    ]);
  });

  it("sorts multiple custom models deterministically", () => {
    const choices = whisperModelChoices(["ggml-zz-test.bin", "ggml-aa-test.bin"]);
    expect(choices.map((c) => c.value)).toEqual([
      "base.en", "small.en", "medium.en", "medium-urdu", "aa-test", "zz-test", CUSTOM_MODEL,
    ]);
  });
});

/**
 * Review fix (Urdu field test 2026-08-05): the language prefill classified
 * on `.endsWith(".en")`, so an absolute path to an ENGLISH model —
 * /x/ggml-small.en.bin, which ends in ".bin" — was prefilled `auto`.
 */
describe("bareWhisperModelName", () => {
  it("strips ggml-/.bin decoration from an absolute path", () => {
    expect(bareWhisperModelName("/models/ggml-small.en.bin")).toBe("small.en");
    expect(bareWhisperModelName("/models/ggml-medium-urdu.bin")).toBe("medium-urdu");
  });

  it("leaves a bare select value untouched", () => {
    expect(bareWhisperModelName("small.en")).toBe("small.en");
    expect(bareWhisperModelName("medium-urdu")).toBe("medium-urdu");
  });

  it("handles partial decoration", () => {
    expect(bareWhisperModelName("ggml-base.en")).toBe("base.en");
    expect(bareWhisperModelName("tiny.en.bin")).toBe("tiny.en");
  });
});

/**
 * The language follow-up's prefill (2026-08-17): a curated fine-tune's own
 * language beats the `auto` heuristic — plain Enter on medium-urdu must run
 * `-l ur`, the exact code it was trained for, not an auto-detect gamble.
 */
describe("whisperLanguagePrefill", () => {
  it("a curated model prefills its table language, through either spelling", () => {
    expect(whisperLanguagePrefill("medium-urdu")).toBe("ur");
    expect(whisperLanguagePrefill("/models/ggml-medium-urdu.bin")).toBe("ur");
  });

  it("an .en model prefills empty — whisper's en default, no flag emitted", () => {
    expect(whisperLanguagePrefill("small.en")).toBe("");
    expect(whisperLanguagePrefill("/x/ggml-small.en.bin")).toBe("");
  });

  it("an unknown non-.en model keeps the auto heuristic", () => {
    expect(whisperLanguagePrefill("my-own-finetune")).toBe("auto");
  });
});
