import { describe, expect, it } from "vitest";
import {
  MODELS,
  modelImpliedLanguage,
  modelUrl,
  validModelSources,
  whisperModelPath,
} from "../src/setup/manifest";
import { resolveWhisperLanguage } from "../src/produce";

/**
 * Custom/fine-tuned model sources (2026-08-17). Three bugs this suite pins
 * shut: the path-resolution rule was triplicated (produce/doctor/plan), the
 * download URL was hardcoded to the ggerganov mirror in three places — so
 * every custom name 404'd and the suggested `curl -L` saved the 404 HTML as
 * a fake model — and a non-English fine-tune without `-l` silently decoded
 * English garbage (Urdu field test 2026-08-05).
 */
describe("whisperModelPath — the one resolution rule", () => {
  it("a bare name lives in modelDir as ggml-<name>.bin", () => {
    expect(whisperModelPath("small.en", "/m")).toBe("/m/ggml-small.en.bin");
  });

  it("a custom name resolves identically — the round trip the wizard relies on", () => {
    expect(whisperModelPath("medium-urdu", "/m")).toBe("/m/ggml-medium-urdu.bin");
  });

  it("an absolute model is a file path, used verbatim", () => {
    expect(whisperModelPath("/x/my-finetune.bin", "/m")).toBe("/x/my-finetune.bin");
  });
});

describe("modelUrl precedence — config modelSources > curated entry > ggerganov default", () => {
  it("stock models default to the ggerganov mirror", () => {
    expect(modelUrl("small.en")).toBe(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
    );
  });

  it("a curated entry's own url wins over the default mirror", () => {
    expect(modelUrl("medium-urdu")).toBe(MODELS["medium-urdu"]!.url);
    expect(modelUrl("medium-urdu")).not.toContain("ggerganov");
  });

  it("a config modelSources entry beats even a curated url", () => {
    expect(modelUrl("medium-urdu", { "medium-urdu": "https://example.com/mine.bin" })).toBe(
      "https://example.com/mine.bin",
    );
  });

  it("a config entry for some OTHER name changes nothing", () => {
    expect(modelUrl("small.en", { "my-model": "https://example.com/mine.bin" })).toContain(
      "ggerganov",
    );
  });
});

describe("the curated medium-urdu entry stays pinned", () => {
  it("points at the community GGML conversion and implies Urdu", () => {
    const m = MODELS["medium-urdu"]!;
    expect(m.url).toBe(
      "https://huggingface.co/CodeWithAhsan/whisper-medium-urdu-ggml/resolve/main/ggml-medium-urdu.bin",
    );
    expect(m.language).toBe("ur");
    // Exact size + sha1 of the author's converted file, measured 2026-08-17
    // before the HF upload — the same bytes the published file carries.
    expect(m.sizeMB).toBe(1463);
    expect(m.sha1).toBe("59769d590f62eeeb3bc3f5b82ce8c03b6e96831e");
    // Provenance must survive into the wizard hint and setup's download line.
    expect(m.note).toContain("Urdu fine-tune");
  });
});

describe("validModelSources — the config key's consumer-side vetting", () => {
  it("accepts a record of name → URL strings, values trimmed", () => {
    expect(validModelSources({ "my-model": " https://example.com/m.bin " })).toEqual({
      "my-model": "https://example.com/m.bin",
    });
  });

  it("rejects everything else all-or-nothing — no salvaging half a typo'd map", () => {
    expect(validModelSources("https://example.com")).toBeUndefined(); // a string, not a record
    expect(validModelSources({ "my-model": 42 })).toBeUndefined(); // a non-string URL
    expect(validModelSources({ ok: "https://x", bad: "  " })).toBeUndefined(); // a blank URL
    expect(validModelSources({})).toBeUndefined(); // empty = nothing to override
    expect(validModelSources(undefined)).toBeUndefined();
    expect(validModelSources(null)).toBeUndefined();
    expect(validModelSources(["https://x"])).toBeUndefined();
  });
});

describe("modelImpliedLanguage — the curated table's language, keyed on the bare name", () => {
  it("resolves either spelling of a curated fine-tune", () => {
    expect(modelImpliedLanguage("medium-urdu")).toBe("ur");
    expect(modelImpliedLanguage("/x/ggml-medium-urdu.bin")).toBe("ur");
  });

  it("is undefined for stock models and unknown fine-tunes — whisper's en default stands", () => {
    expect(modelImpliedLanguage("small.en")).toBeUndefined();
    expect(modelImpliedLanguage("my-own-model")).toBeUndefined();
  });
});

describe("resolveWhisperLanguage — flag > config > model-implied", () => {
  it("a typed flag always wins", () => {
    expect(resolveWhisperLanguage("de", "ur", "ur")).toEqual({ language: "de", source: "flag" });
  });

  it("the config supplies the default when no flag is typed, trimmed", () => {
    expect(resolveWhisperLanguage(undefined, " ur ", undefined)).toEqual({
      language: "ur",
      source: "config",
    });
    // …and it beats the model table's implied code.
    expect(resolveWhisperLanguage(undefined, "auto", "ur").language).toBe("auto");
  });

  it("the curated model's language is the last rung — medium-urdu alone decodes Urdu", () => {
    expect(resolveWhisperLanguage(undefined, undefined, "ur")).toEqual({
      language: "ur",
      source: "model",
    });
  });

  it("a malformed config value warns and falls through, never coerces", () => {
    const v = resolveWhisperLanguage(undefined, 42, "ur");
    expect(v.language).toBe("ur");
    expect(v.source).toBe("model");
    expect(v.warning).toContain("config language ignored");
    // Blank string is the same malformation — a bare `-l` must never spawn.
    expect(resolveWhisperLanguage(undefined, "  ", undefined)).toMatchObject({
      language: undefined,
      source: null,
    });
  });

  it("nothing set anywhere keeps whisper's en default — no -l at all", () => {
    expect(resolveWhisperLanguage(undefined, undefined, undefined)).toEqual({
      language: undefined,
      source: null,
    });
  });
});
