import { describe, expect, it } from "vitest";
import { coverSampleTimes } from "../src/cover";
import { keptSecondsBetween, resolveClipWindow } from "../src/clip";
import { buildSfxUserPrompt, normalizeSfxPlan, sfxBudget } from "../src/producer/sfx";
import type { BeatSheet } from "../src/producer/beats";
import type { LoadedSfxSound } from "../src/sfx-pack";
import { TimeMap } from "../src/timemap";
import type { Segment, Transcript } from "../src/schema";

/**
 * 2026-11-08 audit: the cover, the --clip length and the SFX plan all
 * measured the SOURCE clock, so each could reach for footage or speech the
 * cut removed. Each now takes the cut timeline.
 */

const speak = (text: string, step = 0.5): Transcript => ({
  language: "en",
  words: text.split(/\s+/).map((t, i) => ({ text: t, start: i * step, end: i * step + 0.4 })),
});

describe("coverSampleTimes", () => {
  it("spreads samples over the OUTPUT opening and maps each to its source instant", () => {
    // 10s blooper at the head is cut: output 0 = source 10.
    const map = new TimeMap([
      { srcIn: 0, srcOut: 10, kind: "remove", reason: "retake" },
      { srcIn: 10, srcOut: 30, kind: "keep" },
    ]);
    const { window, times } = coverSampleTimes(map.outputDuration, {
      samples: 4,
      toSource: (t) => map.toSource(t),
    });
    expect(window).toBe(4); // 20% of the 20s output
    expect(times.map((t) => t.srcSec)).toEqual([10.5, 11.5, 12.5, 13.5]);
    expect(times.every((t) => t.srcSec >= 10)).toBe(true);
  });

  it("without a map, samples the source as before", () => {
    const { times } = coverSampleTimes(20, { samples: 2 });
    expect(times.map((t) => t.srcSec)).toEqual([1, 3]);
  });
});

describe("--clip length is the CUT runtime", () => {
  it("keptSecondsBetween subtracts the removals inside the span", () => {
    const cut: Segment[] = [
      { srcIn: 0, srcOut: 2, kind: "keep" },
      { srcIn: 2, srcOut: 5, kind: "remove", reason: "retake" },
      { srcIn: 5, srcOut: 10, kind: "keep" },
    ];
    expect(keptSecondsBetween(cut, 1, 8)).toBe(4);
    expect(keptSecondsBetween(undefined, 1, 8)).toBe(7);
  });

  it("refuses a window that is long in source seconds but under half the target once cut", () => {
    // 40 words over ~20s of source; 14s of it is a cut retake → ~6s kept.
    const t = speak(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ") + ".");
    const cutlist: Segment[] = [
      { srcIn: 0, srcOut: 3, kind: "keep" },
      { srcIn: 3, srcOut: 17, kind: "remove", reason: "retake" },
      { srcIn: 17, srcOut: 20, kind: "keep" },
    ];
    const highlight = { startWord: 0, endWord: 39, reason: "r" };
    expect(() => resolveClipWindow(t, highlight, 20)).not.toThrow();
    expect(() => resolveClipWindow(t, highlight, 20, cutlist)).toThrow(/under half/);
  });

  it("does not trim a window whose source span is over the cap but whose cut runtime fits", () => {
    const t = speak(Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ") + ".");
    // ~30s source, 10s cut → ~20s kept, target 20s: no trim.
    const cutlist: Segment[] = [
      { srcIn: 0, srcOut: 10, kind: "keep" },
      { srcIn: 10, srcOut: 20, kind: "remove", reason: "pause" },
      { srcIn: 20, srcOut: 30, kind: "keep" },
    ];
    const highlight = { startWord: 0, endWord: 59, reason: "r" };
    expect(resolveClipWindow(t, highlight, 20).window.endWord).toBeLessThan(59);
    expect(resolveClipWindow(t, highlight, 20, cutlist).window.endWord).toBe(59);
  });
});

describe("SFX planning on the cut timeline", () => {
  const sound = (id: string): LoadedSfxSound => ({
    id,
    kind: "sound",
    file: `${id}.mp3`,
    whenToUse: `use ${id}`,
    tags: [],
    gain: 1,
    absPath: `/packs/starter/${id}.mp3`,
    packName: "ossclip-starter",
  });
  const sounds = [sound("ding"), sound("boom")];
  const sheet: BeatSheet = { hook: "h", coverText: "c", moments: [] };
  // 20 words, 1s apart (0..19.4). Words 5-14 are a cut retake.
  const t = speak(Array.from({ length: 20 }, (_, i) => `w${i}`).join(" "), 1);
  const map = new TimeMap([
    { srcIn: 0, srcOut: 4.9, kind: "keep" },
    { srcIn: 4.9, srcOut: 14.9, kind: "remove", reason: "retake" },
    { srcIn: 14.9, srcOut: 19.4, kind: "keep" },
  ]);

  it("sizes the budget on the output runtime", () => {
    expect(sfxBudget(t, "meme").runtimeSec).toBeCloseTo(19.4);
    expect(sfxBudget(t, "meme", map).runtimeSec).toBeCloseTo(9.4);
  });

  it("marks cut words in the prompt", () => {
    const p = buildSfxUserPrompt(t, sheet, sounds, "normal", map);
    expect(p).toContain("[5]⟦w5⟧");
    expect(p).toContain("[4]w4 ");
    expect(p).toContain("never anchor an effect on one");
    expect(buildSfxUserPrompt(t, sheet, sounds, "normal")).not.toContain("⟦");
  });

  it("drops a cut anchor and measures spacing on the output clock", () => {
    const plan = {
      placements: [
        { soundId: "ding", word: 4 },
        { soundId: "boom", word: 8 }, // inside the cut
        { soundId: "boom", word: 15 }, // source 11s after word 4; output ~1s after
      ],
    };
    const { plan: out, issues } = normalizeSfxPlan(plan, t, sounds, "meme", sheet, map);
    expect(out.placements.map((p) => p.word)).toEqual([4]);
    expect(issues.map((i) => i.reason).sort()).toEqual(["cut word", "too close"]);
    // Source clock alone keeps both kept-word placements.
    const src = normalizeSfxPlan(plan, t, sounds, "meme", sheet);
    expect(src.plan.placements.map((p) => p.word)).toEqual([4, 8, 15]);
  });
});
