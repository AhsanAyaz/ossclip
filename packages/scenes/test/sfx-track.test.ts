import { describe, expect, it } from "vitest";
import { SFX_MAX_VOLUME, sfxCuesFor, visibleSfxCues } from "../src/sfx-track";

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
