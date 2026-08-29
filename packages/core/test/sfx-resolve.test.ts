import { describe, expect, it } from "vitest";
import { resolveSfxCues, sfxStagedFile } from "../src/assemble";
import { TimeMap } from "../src/timemap";
import type { Segment, Transcript } from "../src/schema";
import type { LoadedSfxSound } from "../src/sfx-pack";
import type { SfxPlacement } from "../src/producer/sfx";

/**
 * The word→output-time half of `--sfx` (the assembleScenes contract for a
 * track of instants). Every case here is one the pipeline actually produces:
 * a cut that took the anchor word, a pack deleted between planning and a
 * re-render, a plan reloaded against a library that has moved on.
 *
 * Pure: the filesystem arrives as the injected `exists` seam, so the whole
 * matrix runs without writing a single mp3.
 */

/** 10 words, 0.5 s each: word i covers [i*0.5, i*0.5+0.4]. */
const transcript: Transcript = {
  language: "en",
  words: Array.from({ length: 10 }, (_, i) => ({
    text: `w${i}`,
    start: i * 0.5,
    end: i * 0.5 + 0.4,
  })),
};

const identity = new TimeMap([{ srcIn: 0, srcOut: 5, kind: "keep" } satisfies Segment]);

const sound = (id: string, gain: number, file = `${id}.mp3`): LoadedSfxSound => ({
  id,
  kind: "sound",
  file,
  whenToUse: `use ${id}`,
  tags: [],
  gain,
  absPath: `/packs/starter/${file}`,
  packName: "ossclip-starter",
});

const sounds = [sound("ding", 1), sound("boom", 0.5)];

const place = (soundId: string, word: number, gain?: number): SfxPlacement => ({
  soundId,
  word,
  ...(gain === undefined ? {} : { gain }),
});

describe("sfxStagedFile", () => {
  it("names the file by ID, under sfx/, with a POSIX separator", () => {
    // The ID, not the pack's own filename: two packs may both ship a
    // `whoosh.mp3`, and the plan references ids.
    expect(sfxStagedFile({ id: "whoosh-soft", file: "sounds/whoosh.mp3" })).toBe(
      "sfx/whoosh-soft.mp3",
    );
    // A served URL, never a filesystem path — a Windows `\` would be served
    // verbatim (produce's sideImageDestRel lesson).
    expect(sfxStagedFile({ id: "pop", file: "pop.wav" })).toBe("sfx/pop.wav");
    expect(sfxStagedFile({ id: "bare", file: "bare" })).toBe("sfx/bare");
  });
});

describe("resolveSfxCues", () => {
  it("maps a word anchor to the word's OUTPUT start", () => {
    const { cues, dropped } = resolveSfxCues([place("ding", 4)], transcript, identity, sounds);
    expect(dropped).toEqual([]);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.atSec).toBeCloseTo(2.0, 5);
    expect(cues[0]!.soundFile).toBe("sfx/ding.mp3");
  });

  it("multiplies the sound's gain by the placement's, once, here", () => {
    const { cues } = resolveSfxCues(
      [place("boom", 2, 1.5), place("ding", 6)],
      transcript,
      identity,
      sounds,
    );
    // 0.5 × 1.5 — the renderer receives a number and does no mixing
    // arithmetic of its own.
    expect(cues[0]!.gain).toBeCloseTo(0.75, 6);
    // No placement gain means the sound's own level, not a coerced 1.
    expect(cues[1]!.gain).toBe(1);
  });

  it("drops a placement whose anchor word the cut removed", () => {
    // The word-4 anchor sits at 2.0–2.4s, entirely inside the removed span.
    const map = new TimeMap([
      { srcIn: 0, srcOut: 1, kind: "keep" },
      { srcIn: 1, srcOut: 3, kind: "remove", reason: "user" },
      { srcIn: 3, srcOut: 5, kind: "keep" },
    ] satisfies Segment[]);
    const { cues, dropped } = resolveSfxCues(
      [place("ding", 4), place("boom", 8)],
      transcript,
      map,
      sounds,
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ placement: 0, reason: "cut word" });
    // The survivor is re-timed into the SHORTENED clock, not left at its
    // source instant: word 8 starts at 4.0s source, 2.0s output.
    expect(cues).toHaveLength(1);
    expect(cues[0]!.atSec).toBeCloseTo(2.0, 5);
  });

  it("drops a placement whose sound file is gone, naming the path", () => {
    const { cues, dropped } = resolveSfxCues(
      [place("boom", 2)],
      transcript,
      identity,
      sounds,
      { exists: (p) => p !== "/packs/starter/boom.mp3" },
    );
    expect(cues).toEqual([]);
    expect(dropped[0]).toMatchObject({ placement: 0, reason: "missing file" });
    expect(dropped[0]!.issue).toContain("/packs/starter/boom.mp3");
  });

  it("drops a sound the library no longer has, distinctly from a missing file", () => {
    const { cues, dropped } = resolveSfxCues([place("vine-boom", 2)], transcript, identity, sounds);
    expect(cues).toEqual([]);
    expect(dropped[0]).toMatchObject({ placement: 0, reason: "unknown sound" });
  });

  it("drops an anchor past the end of the transcript", () => {
    // Reachable without a hallucination: a re-transcribe can shorten the word
    // list under a plan that was normalized against the longer one.
    const { cues, dropped } = resolveSfxCues([place("ding", 99)], transcript, identity, sounds);
    expect(cues).toEqual([]);
    expect(dropped[0]).toMatchObject({ placement: 0, reason: "outside transcript" });
  });

  it("reports the drop against the PLAN's own index, so warnings name the entry", () => {
    const { cues, dropped } = resolveSfxCues(
      [place("ding", 0), place("nope", 2), place("boom", 4)],
      transcript,
      identity,
      sounds,
    );
    expect(cues).toHaveLength(2);
    expect(dropped[0]!.placement).toBe(1);
  });

  it("returns cues in time order", () => {
    const { cues } = resolveSfxCues(
      [place("ding", 8), place("boom", 1), place("ding", 4)],
      transcript,
      identity,
      sounds,
    );
    expect(cues.map((c) => c.atSec)).toEqual([...cues.map((c) => c.atSec)].sort((a, b) => a - b));
  });

  it("assumes files are present when no `exists` is injected", () => {
    // The pure default (the defaultProviderName seam): a caller that cannot
    // see a filesystem has no basis for dropping anything.
    const { cues } = resolveSfxCues([place("ding", 2)], transcript, identity, sounds);
    expect(cues).toHaveLength(1);
  });
});
