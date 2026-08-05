import { describe, expect, it } from "vitest";
import { buildConcatFilter, planFolderConcat, type ConcatEntry } from "../src/concat";

/**
 * folder-input-brief.md: pointing `produce` at a folder concats its clips
 * first. These two functions are the PURE half of that feature (CLAUDE.md's
 * pure/IO split) — the regression test for the field bug that motivated the
 * split: a hand-built ffmpeg filtergraph corrupted by shell expansion (zsh
 * `:a`) left every concat slot silently playing clip 1's audio, because
 * nothing validated the filter STRING. `buildConcatFilter`'s label-uniqueness
 * assertions below are that validation.
 */

describe("planFolderConcat", () => {
  const entry = (name: string, mtimeMs: number, size = 100): ConcatEntry => ({ name, mtimeMs, size });

  it("sorts by name (default) as a plain codepoint sort, not locale collation", () => {
    const entries = [entry("clip10.mov", 3), entry("clip2.mov", 1), entry("Clip1.mov", 2)];
    // Plain codepoint order: uppercase 'C' (0x43) sorts before lowercase 'c'
    // (0x63) — a locale-aware sort would interleave them instead, and would
    // disagree with `ls` on a case-sensitive filesystem (the brief's spec).
    expect(planFolderConcat(entries, "name")).toEqual(["Clip1.mov", "clip10.mov", "clip2.mov"]);
  });

  it("sorts by mtime, oldest first", () => {
    const entries = [entry("c.mov", 300), entry("a.mov", 100), entry("b.mov", 200)];
    expect(planFolderConcat(entries, "mtime")).toEqual(["a.mov", "b.mov", "c.mov"]);
  });

  it("breaks an mtime tie by name — a batch copy often shares one timestamp", () => {
    const entries = [entry("z.mov", 100), entry("a.mov", 100), entry("m.mov", 100)];
    expect(planFolderConcat(entries, "mtime")).toEqual(["a.mov", "m.mov", "z.mov"]);
  });

  it("does not mutate its input", () => {
    const entries = [entry("b.mov", 2), entry("a.mov", 1)];
    const copy = [...entries];
    planFolderConcat(entries, "name");
    expect(entries).toEqual(copy);
  });
});

describe("buildConcatFilter", () => {
  it("gives every [i:v]/[i:a] input label exactly once, for n inputs", () => {
    const n = 11; // the field-bug folder's actual clip count
    const filter = buildConcatFilter(n, { w: 1080, h: 1920 });
    for (let i = 0; i < n; i++) {
      expect(filter.match(new RegExp(`\\[${i}:v\\]`, "g"))).toHaveLength(1);
      expect(filter.match(new RegExp(`\\[${i}:a\\]`, "g"))).toHaveLength(1);
    }
    // No stray 12th input reference — the exact regression the field bug was:
    // a slot that silently referenced input 0 again instead of its own index.
    expect(filter.match(/\[\d+:[va]\]/g)).toHaveLength(n * 2);
  });

  it("produces the documented concat tail: [v0][a0]…concat=n=N:v=1:a=1[outv][outa]", () => {
    const filter = buildConcatFilter(3, { w: 1080, h: 1920 });
    expect(filter).toMatch(/\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3:v=1:a=1\[outv\]\[outa\]$/);
  });

  it("scale+pad target every video chain identically, letterboxing rather than cropping", () => {
    const filter = buildConcatFilter(2, { w: 1920, h: 1080 });
    // force_original_aspect_ratio=decrease + pad is the letterbox contract —
    // never crop, since produce's own framing decides crops later.
    const videoChains = filter.split(";").filter((c) => /\[v\d+\]$/.test(c));
    expect(videoChains).toHaveLength(2);
    for (const chain of videoChains) {
      expect(chain).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
      expect(chain).toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2");
      expect(chain).toContain("fps=30");
      expect(chain).toContain("setsar=1");
      expect(chain).toContain("format=yuv420p");
    }
  });

  it("resamples every audio chain to 48kHz stereo", () => {
    const filter = buildConcatFilter(2, { w: 1080, h: 1920 });
    const audioChains = filter.split(";").filter((c) => /\[a\d+\]$/.test(c));
    expect(audioChains).toHaveLength(2);
    for (const chain of audioChains) {
      expect(chain).toContain("aresample=48000");
      expect(chain).toContain("aformat=channel_layouts=stereo");
    }
  });
});
