import { describe, expect, it } from "vitest";
import { transcriptCacheReusable } from "../src/produce";

/**
 * The transcript cache decision (review fix, Urdu field test 2026-08-05):
 * transcript.json used to be reused on existence alone, so a warm workdir
 * silently served the stale English transcript on the first
 * `--whisper-language ur` retry, and equally defeated the model A/B the
 * --whisper-model help text advertises. Pure — no workdir, no whisper.
 */
describe("transcriptCacheReusable", () => {
  const DEFAULT = "small.en";

  it("reuses when the recorded key matches the request exactly", () => {
    const v = transcriptCacheReusable(
      { model: "medium-urdu", language: "ur" },
      { model: "medium-urdu", language: "ur" },
      DEFAULT,
    );
    expect(v.reuse).toBe(true);
  });

  it("re-transcribes when only the language differs — the motivating retry", () => {
    const v = transcriptCacheReusable(
      { model: "medium-urdu" },
      { model: "medium-urdu", language: "ur" },
      DEFAULT,
    );
    expect(v.reuse).toBe(false);
    // The recorded key is surfaced so the console line can say WHY.
    expect(v.recorded).toEqual({ model: "medium-urdu" });
  });

  it("re-transcribes when the model differs — the advertised A/B", () => {
    const v = transcriptCacheReusable(
      { model: "base.en" },
      { model: "medium.en" },
      DEFAULT,
    );
    expect(v.reuse).toBe(false);
  });

  it("keyless workdir + default request reuses — old workdirs must not re-transcribe spuriously", () => {
    const v = transcriptCacheReusable(null, { model: DEFAULT }, DEFAULT);
    expect(v.reuse).toBe(true);
    expect(v.recorded).toEqual({ model: DEFAULT });
  });

  it("keyless workdir + non-default request re-transcribes", () => {
    expect(transcriptCacheReusable(null, { model: "medium-urdu", language: "ur" }, DEFAULT).reuse).toBe(false);
    expect(transcriptCacheReusable(null, { model: DEFAULT, language: "ur" }, DEFAULT).reuse).toBe(false);
    expect(transcriptCacheReusable(null, { model: "medium.en" }, DEFAULT).reuse).toBe(false);
  });

  it("treats an empty recorded language as whisper's en default", () => {
    // A key file predating the empty-string guard must not wedge the cache.
    expect(
      transcriptCacheReusable({ model: DEFAULT, language: "" }, { model: DEFAULT }, DEFAULT).reuse,
    ).toBe(true);
  });
});
