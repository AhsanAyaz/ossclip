import { describe, expect, it } from "vitest";
import {
  CUSTOM_MODEL,
  bareWhisperModelName,
  whisperModelChoices,
} from "../src/interactive/produce-wizard";

/**
 * The modelDir → choices enumeration (Urdu field test 2026-08-05): a
 * downloaded fine-tune like ggml-medium-urdu.bin must be pickable from the
 * wizard by its bare name, the canonical .en trio must stay offered whether
 * or not downloaded, and a free-text escape must always exist. Pure — no TTY,
 * no filesystem.
 */
describe("whisperModelChoices", () => {
  it("empty dir: canonicals marked as needing download, plus the free-text escape", () => {
    const choices = whisperModelChoices([]);
    expect(choices.map((c) => c.value)).toEqual(["base.en", "small.en", "medium.en", CUSTOM_MODEL]);
    for (const c of choices.slice(0, 3)) {
      expect(c.hint).toContain("will need download");
    }
  });

  it("lists an installed fine-tune by its bare name and unmarks installed canonicals", () => {
    const choices = whisperModelChoices([
      "ggml-small.en.bin",
      "ggml-medium-urdu.bin",
    ]);
    expect(choices.map((c) => c.value)).toEqual([
      "base.en", "small.en", "medium.en", "medium-urdu", CUSTOM_MODEL,
    ]);
    const small = choices.find((c) => c.value === "small.en")!;
    expect(small.hint).not.toContain("will need download");
    const base = choices.find((c) => c.value === "base.en")!;
    expect(base.hint).toContain("will need download");
    const urdu = choices.find((c) => c.value === "medium-urdu")!;
    expect(urdu.hint).toBe("installed");
  });

  it("ignores files that are not ggml-*.bin models", () => {
    const choices = whisperModelChoices([
      ".DS_Store",
      "readme.txt",
      "ggml-medium-urdu.bin.part", // an in-flight download is not a model
      "small.en.bin", // no ggml- prefix — not what produce.ts would resolve
      "ggml-", // degenerate name, no capture
    ]);
    expect(choices.map((c) => c.value)).toEqual(["base.en", "small.en", "medium.en", CUSTOM_MODEL]);
  });

  it("sorts multiple custom models deterministically", () => {
    const choices = whisperModelChoices(["ggml-zz-test.bin", "ggml-aa-test.bin"]);
    expect(choices.map((c) => c.value)).toEqual([
      "base.en", "small.en", "medium.en", "aa-test", "zz-test", CUSTOM_MODEL,
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
