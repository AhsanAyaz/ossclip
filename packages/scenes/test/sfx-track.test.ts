import { describe, expect, it } from "vitest";
import {
  SFX_FALLBACK_DURATION_SEC,
  SFX_MAX_VOLUME,
  sfxCuesFor,
  visibleSfxCues,
} from "../src/sfx-track";

/**
 * The `--sfx` track's props gate and frame math. Pure, so the matrix runs
 * without Remotion or a DOM — the component itself is a `map` over these two
 * functions (SfxTrack.tsx).
 */

describe("sfxCuesFor", () => {
  it("accepts a well-formed cue list", () => {
    expect(sfxCuesFor([{ soundFile: "sfx/ding.mp3", atSec: 1.5, gain: 0.8 }])).toEqual([
      { soundFile: "sfx/ding.mp3", atSec: 1.5, gain: 0.8 },
    ]);
  });

  it("reads an absent key as silence, not as an empty track", () => {
    // Every pre-feature render-props.json — the compatibility claim.
    expect(sfxCuesFor(undefined)).toEqual([]);
    expect(sfxCuesFor(null)).toEqual([]);
    expect(sfxCuesFor("sfx/ding.mp3")).toEqual([]);
  });

  it("drops the bad ENTRY, never the whole track", () => {
    const cues = sfxCuesFor([
      { soundFile: "sfx/a.mp3", atSec: 0 },
      { soundFile: "", atSec: 1 },
      { atSec: 2 },
      { soundFile: "sfx/b.mp3", atSec: "3" },
      { soundFile: "sfx/c.mp3", atSec: Number.NaN },
      { soundFile: "sfx/d.mp3", atSec: -1 },
      { soundFile: "sfx/e.mp3", atSec: 4, gain: "loud" },
      { soundFile: "sfx/f.mp3", atSec: 5 },
    ]);
    expect(cues.map((c) => c.soundFile)).toEqual(["sfx/a.mp3", "sfx/f.mp3"]);
    // An absent gain plays the sound as staged; a MANGLED one is refused
    // rather than defaulted — a wrong level is audible and silent about it.
    expect(cues[0]!.gain).toBe(1);
  });

  it("clamps the volume, because HTMLMediaElement THROWS above 1", () => {
    // The editor's preview sets `audio.volume` directly (IndexSizeError above
    // 1) while the render would happily amplify — preview and render must
    // agree, so the clamp is here, on the one path both take.
    expect(sfxCuesFor([{ soundFile: "a.mp3", atSec: 0, gain: 4 }])[0]!.gain).toBe(SFX_MAX_VOLUME);
    expect(sfxCuesFor([{ soundFile: "a.mp3", atSec: 0, gain: -2 }])[0]!.gain).toBe(0);
  });
});

describe("visibleSfxCues", () => {
  it("rounds the instant to a frame", () => {
    // Math.round, matching frameWindow's start (FINDINGS §115): 1.51s at 30fps
    // is frame 45, and 1.50s is too.
    expect(visibleSfxCues([{ soundFile: "a.mp3", atSec: 1.51, gain: 1 }], 30, 300)[0]!.from).toBe(45);
    expect(visibleSfxCues([{ soundFile: "a.mp3", atSec: 0, gain: 1 }], 30, 300)[0]!.from).toBe(0);
  });

  it("drops a cue past the last frame instead of piling it onto the end", () => {
    const cues = [
      { soundFile: "in.mp3", atSec: 9.9, gain: 1 },
      { soundFile: "edge.mp3", atSec: 10, gain: 1 },
      { soundFile: "past.mp3", atSec: 30, gain: 1 },
    ];
    // 300 frames at 30fps = the last frame is 299; a cue at exactly 10s has no
    // frame to fire on.
    expect(visibleSfxCues(cues, 30, 300).map((c) => c.soundFile)).toEqual(["in.mp3"]);
  });

  it("keeps two effects that land on the same frame", () => {
    // Different sounds on one beat is a legal plan; the component keys on
    // index as well as frame precisely because of it.
    const cues = [
      { soundFile: "a.mp3", atSec: 2, gain: 1 },
      { soundFile: "b.mp3", atSec: 2.01, gain: 1 },
    ];
    expect(visibleSfxCues(cues, 30, 300).map((c) => c.from)).toEqual([60, 60]);
  });
});

describe("the cue's Sequence length (field report 2026-09-18)", () => {
  it("bounds a cue with a declared length", () => {
    // The pack's own `durationSec`, which is what stops the `<Audio>` staying
    // mounted for the rest of the composition.
    const cues = sfxCuesFor([{ soundFile: "a.mp3", atSec: 1, gain: 1, durationSec: 2.5 }]);
    expect(cues[0]!.durationSec).toBe(2.5);
    expect(visibleSfxCues(cues, 30, 900)[0]!.durationInFrames).toBe(75);
  });

  it("bounds a cue with NO declared length — the old props files", () => {
    // Every render-props.json written before this fix, including the one that
    // took the editor down. They must stop leaking tags without a re-produce,
    // so the fallback applies to the parsed cue, not to a re-planned one.
    const cues = sfxCuesFor([{ soundFile: "a.mp3", atSec: 1, gain: 1 }]);
    expect(cues[0]!.durationSec).toBeUndefined();
    expect(visibleSfxCues(cues, 30, 3000)[0]!.durationInFrames).toBe(
      SFX_FALLBACK_DURATION_SEC * 30,
    );
  });

  it("refuses a mangled length but keeps the cue", () => {
    // A cue is a sound; a length is bookkeeping with a fallback. Dropping the
    // whoosh over an unreadable number would be the worse trade.
    for (const bad of ["2", Number.NaN, 0, -1]) {
      const cues = sfxCuesFor([{ soundFile: "a.mp3", atSec: 1, gain: 1, durationSec: bad }]);
      expect(cues.map((c) => c.soundFile)).toEqual(["a.mp3"]);
      expect(cues[0]!.durationSec).toBeUndefined();
    }
  });

  it("clamps at the composition's end instead of asking for frames past it", () => {
    // Remotion truncates the tail anyway; a Sequence that runs to the last
    // frame is the same mounted-forever tag the bound exists to retire.
    const cues = sfxCuesFor([{ soundFile: "a.mp3", atSec: 9, gain: 1, durationSec: 5 }]);
    expect(visibleSfxCues(cues, 30, 300)[0]!.durationInFrames).toBe(30);
  });
});
